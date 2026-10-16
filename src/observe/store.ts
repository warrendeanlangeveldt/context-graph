import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ctxHome, repoHash } from '../util/paths.js';
import type { Envelope } from './event.js';

/** Append-only per-session observation log under the user's ctx home (design spec §8.3). */
export class ObservationStore {
  readonly dir: string;
  readonly file: string;

  constructor(readonly root: string, readonly session: string) {
    this.dir = join(ctxHome(), 'observations', repoHash(root));
    this.file = join(this.dir, `${sanitize(session)}.jsonl`);
  }

  append(env: Envelope): void {
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.file, JSON.stringify(env) + '\n', 'utf8');
  }

  readAll(): Envelope[] {
    if (!existsSync(this.file)) return [];
    const out: Envelope[] = [];
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as Envelope); } catch { /* a torn line from a concurrent writer; skip */ }
    }
    return out;
  }

  static sessions(root: string): { session: string; file: string; mtime: Date; size: number }[] {
    const dir = join(ctxHome(), 'observations', repoHash(root));
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const st = statSync(join(dir, f));
        return { session: f.replace(/\.jsonl$/, ''), file: join(dir, f), mtime: st.mtime, size: st.size };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  }
}

export interface PendingEntry {
  path: string;
  symbol?: string;
  constraints: string[];
  since: string;
  /** Legacy: the decision id that was next when the edit was noted (numeric ids only). */
  sinceId?: string;
  /** Decisions already on this path when the edit was noted: any other decision on it settles the entry, whoever records it. */
  known?: string[];
  /** The tool call that first noted this edit; if that call fails, the edit never happened. */
  toolUseId?: string;
  /**
   * Noted before the tool ran. It becomes real only when the same call completes: another hook may refuse
   * the call, and then no edit happened. Unconfirmed entries are dropped when the turn ends.
   */
  provisional?: boolean;
}

/** A file this agent edited, which owes its card until the card matches the file's content. */
export interface CardOwed { path: string; since: string }

export interface SessionStateData {
  pending: Record<string, PendingEntry>;
  blocks: number;
  lastPendingKey: string;
  arm: 'on' | 'off';
  /** Whether the arm was decided for this session; random assignment happens once. */
  armSet?: boolean;
  /** The session has been told a graph exists; set at start, or on the first hook after a mid-session bootstrap. */
  graphAnnounced?: boolean;
  /** Modules whose card this session has already seen, by id. */
  modulesAnnounced?: string[];
  /** Files whose decision history this session has been shown, by path. */
  filesAnnounced?: string[];
  /** The context last injected before an edit of each file, by path, as a hash: the same again isn't. */
  slicesShown?: Record<string, string>;
  /** The pending set this session has already been nudged about, so the ask is not repeated on every tool call. */
  nudgedKey?: string;
  /** Ancestor pids of the hook process, so the MCP server and shell commands under the same harness can find this session. */
  pids?: number[];
  /** Where the harness's shell currently is, when it keeps its working directory between calls. */
  shellCwd?: string;
  delegations: Record<string, { agentType?: string; since: string }>;
  /** Tool calls whose reads were recorded when the call started, so completion does not record them twice. */
  readsRecorded?: string[];
  /** Files edited by this agent whose card is not yet written or brought up to date. */
  cardsOwed?: Record<string, CardOwed>;
}

/**
 * Small mutable state for the recorder: pending nodes, the Stop loop guard, and what has been shown.
 * One file per agent: the main session's, and one per subagent. Parallel agents each have their own
 * context window, so each is owed its own cards and histories, owes its own decisions, and never
 * overwrites another's state. A subagent takes the session's arm, which is decided once.
 */
export class SessionState {
  readonly file: string;
  data: SessionStateData;
  /** The state as this hook loaded it, so a save writes back only what this hook changed. */
  private loaded: Record<string, unknown>;

  constructor(readonly root: string, readonly session: string, readonly agent?: string) {
    const dir = join(ctxHome(), 'state', repoHash(root));
    this.file = join(dir, `${sanitize(session)}${agent ? `@${sanitize(agent)}` : ''}.json`);
    this.data = { pending: {}, blocks: 0, lastPendingKey: '', arm: 'on', delegations: {} };
    const load = (file: string): Partial<SessionStateData> | undefined => {
      if (!existsSync(file)) return undefined;
      try { return JSON.parse(readFileSync(file, 'utf8')) as Partial<SessionStateData>; } catch { return undefined; }
    };
    const own = load(this.file);
    if (own) this.data = { ...this.data, ...own };
    else if (agent) {
      const main = load(join(dir, `${sanitize(session)}.json`));
      if (main?.armSet) { this.data.arm = main.arm ?? 'on'; this.data.armSet = true; }
    }
    this.loaded = JSON.parse(JSON.stringify(this.data)) as Record<string, unknown>;
  }

  /**
   * Writes back what this hook changed since it loaded, onto the state as it is now. A session's hooks run
   * at once (an asynchronous completion hook beside the next call's, the lead's beside its lanes'), so a
   * whole-file write would undo another hook's change: a flag saying the graph was announced, or a file
   * whose history was shown, and the session would be told again. The file is replaced in one rename, so
   * no hook ever reads half of it.
   */
  save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    let now: Record<string, unknown> = {};
    try { now = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>; } catch { now = {}; }
    // A key the file doesn't have yet (a new file, a default) stands as this hook loaded it.
    const merged = mergeState(this.loaded, this.data as unknown as Record<string, unknown>, { ...this.loaded, ...now });
    const tmp = `${this.file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
    renameSync(tmp, this.file);
    this.data = merged as unknown as SessionStateData;
    this.loaded = JSON.parse(JSON.stringify(merged)) as Record<string, unknown>;
  }
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A three-way merge of session state: `base` as this hook loaded it, `mine` as it leaves it, `theirs` as it
 * is on disk now. What this hook left unchanged keeps the disk's value. A list takes the disk's, less what
 * this hook removed, plus what it added; a map does the same key by key; anything else takes this hook's.
 */
export function mergeState(base: Record<string, unknown>, mine: Record<string, unknown>, theirs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...theirs };
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    const b = base[key];
    const m = mine[key];
    if (same(b, m)) continue;
    const t = theirs[key];
    if (Array.isArray(m) && (Array.isArray(t) || t === undefined)) {
      const before = Array.isArray(b) ? b : [];
      const removed = before.filter((x) => !m.some((y) => same(x, y)));
      const added = m.filter((x) => !before.some((y) => same(x, y)));
      const kept = (Array.isArray(t) ? t : []).filter((x) => !removed.some((y) => same(x, y)));
      out[key] = [...kept, ...added.filter((x) => !kept.some((y) => same(x, y)))];
    } else if (isRecord(m) && (isRecord(t) || t === undefined)) {
      out[key] = mergeState(isRecord(b) ? b : {}, m, isRecord(t) ? t : {});
    } else if (m === undefined) delete out[key];
    else out[key] = m;
  }
  return out;
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}
