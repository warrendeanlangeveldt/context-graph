import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
}

export interface SessionStateData {
  pending: Record<string, PendingEntry>;
  blocks: number;
  lastPendingKey: string;
  arm: 'on' | 'off';
  /** Whether the arm was decided for this session; random assignment happens once. */
  armSet?: boolean;
  /** The session has been told a graph exists; set at start, or on the first hook after a mid-session bootstrap. */
  graphAnnounced?: boolean;
  delegations: Record<string, { agentType?: string; since: string }>;
}

/** Small mutable per-session state for the recorder: pending nodes and the Stop loop guard. */
export class SessionState {
  readonly file: string;
  data: SessionStateData;

  constructor(readonly root: string, readonly session: string) {
    const dir = join(ctxHome(), 'state', repoHash(root));
    this.file = join(dir, `${sanitize(session)}.json`);
    this.data = { pending: {}, blocks: 0, lastPendingKey: '', arm: 'on', delegations: {} };
    if (existsSync(this.file)) {
      try { this.data = { ...this.data, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<SessionStateData>) }; } catch { /* start fresh */ }
    }
  }

  save(): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
  }
}

function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}
