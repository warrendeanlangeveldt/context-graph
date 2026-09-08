import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { claudeProfile } from '../adapters/claude-code/hook.js';
import { codexProfile } from '../adapters/codex/hook.js';
import { readRepoFile, type HarnessProfile, type ToolContext } from '../adapters/core.js';
import { openRepo, type RepoContext } from '../core/context.js';
import { callersOf, loadOrBuildImportIndex } from '../index/imports.js';
import { gitPerson } from '../util/git.js';
import { toRepoRelative } from '../util/paths.js';
import { walk } from '../walker/walk.js';
import { computeCoverage } from './coverage.js';
import { isEditMode, type CompactPayload, type Envelope, type SessionPayload, type Touch } from './event.js';
import { ObservationStore } from './store.js';

/**
 * Offline observation from harness transcripts (design spec §15.1 and §15.2, transcript adapters).
 * Reconstructs touches, edits, compaction, and coverage for sessions that ran before the plugin,
 * or on machines without hooks. Claude Code's JSONL is documented as stable; Codex's rollout
 * format is not, so the parser records the CLI version and warns when it cannot find one.
 */
export interface ReplayResult {
  harness: string;
  session: string;
  file: string;
  events: number;
  edits: number;
  coverage: number;
  cliVersion?: string;
  warnings: string[];
}

interface Call { ts: string; tool: string; input: Record<string, unknown>; origin: 'main' | 'subagent'; agent?: string; cwd?: string }
interface Parsed { harness: 'claude-code' | 'codex'; session: string; cwd?: string; branch?: string; cliVersion?: string; calls: Call[]; compacts: string[]; firstTs?: string; warnings: string[] }

export async function replayTranscript(file: string, opts: { repo?: string; graph?: string; harness?: string; agent?: string } = {}): Promise<ReplayResult> {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  const parsed = detectAndParse(lines, file, opts.harness);
  const ctx = openRepo({ ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.graph ? { graph: opts.graph } : {}), ...(parsed.cwd ? { cwd: parsed.cwd } : {}) });
  const profile: HarnessProfile = parsed.harness === 'codex' ? codexProfile(opts.agent ?? 'codex') : claudeProfile(opts.agent ?? 'claude');
  const root = ctx.root;
  const cwd = parsed.cwd ?? root;
  const tc: ToolContext = { root, cwd, shellCwd: cwd, shellParsing: ctx.config.shellParsing, rel: (p) => toRepoRelative(root, p, cwd), readFile: (p) => readRepoFile(root, p) };

  let session = parsed.session;
  let store = new ObservationStore(root, session);
  if (existsSync(store.file)) { session = `${session}-replay`; store = new ObservationStore(root, session); }
  const meta = { session, who: `${gitPerson(root)}/${profile.agent}`, branch: parsed.branch ?? 'unknown', harness: `${parsed.harness}-replay` };
  const env = <T>(t: Envelope['t'], ts: string, p: T): Envelope<T> => ({ t, ts, ...meta, p });

  const start: SessionPayload = { kind: 'start', cwd, arm: 'off', reason: 'replay' };
  store.append(env('session', parsed.firstTs ?? new Date().toISOString(), start));
  const emitted: Envelope[] = [];
  let edits = 0;
  let coverage = 0;
  const compactSet = new Set(parsed.compacts);
  const index = ctx.graph ? loadOrBuildImportIndex(root) : undefined;

  for (const call of parsed.calls) {
    if (compactSet.has(call.ts)) {
      const paths = new Set<string>();
      for (const e of emitted) if ((e.t === 'touch' || e.t === 'edit') && (e.p as Touch).origin === 'main') { const p = e.p as Touch; if (p.mode === 'full' || p.mode === 'range' || p.mode === 'edit' || p.mode === 'write') paths.add(p.path); }
      const c = env<CompactPayload>('compact', call.ts, { paths: [...paths] });
      store.append(c); emitted.push(c); compactSet.delete(call.ts);
      continue;
    }
    const callTc = call.cwd ? { ...tc, cwd: call.cwd, rel: (p: string) => toRepoRelative(root, p, call.cwd) } : tc;
    for (const t of profile.touches(call.tool, call.input, callTc)) {
      const touch: Touch = { path: t.path, mode: t.mode, tool: call.tool, origin: call.origin };
      if (t.range) touch.range = t.range;
      if (t.unparsed) touch.unparsed = true;
      if (call.agent) touch.agent = call.agent;
      const e = env(isEditMode(t.mode) ? 'edit' : 'touch', call.ts, touch);
      store.append(e); emitted.push(e);
      if (isEditMode(t.mode) && call.origin === 'main' && ctx.graph && index && !t.path.startsWith('/') && t.path !== '.') {
        edits++;
        const w = walk(ctx.graph, t.path, { maxDecisions: ctx.config.maxDecisions });
        const cov = computeCoverage(emitted, w, callersOf(index, t.path), false);
        store.append(env('coverage', call.ts, cov));
        coverage++;
      } else if (isEditMode(t.mode)) edits++;
    }
  }
  for (const ts of compactSet) store.append(env<CompactPayload>('compact', ts, { paths: [] }));

  const result: ReplayResult = { harness: parsed.harness, session, file: store.file, events: emitted.length, edits, coverage, warnings: parsed.warnings };
  if (parsed.cliVersion) result.cliVersion = parsed.cliVersion;
  return result;
}

// ---- format detection and parsing ---------------------------------------------------

function detectAndParse(lines: string[], file: string, forced?: string): Parsed {
  let first: Record<string, unknown> | undefined;
  for (const l of lines) { try { first = JSON.parse(l) as Record<string, unknown>; break; } catch { /* skip */ } }
  if (!first) throw new Error('transcript has no parseable JSON lines');
  const harness = forced && forced !== 'auto' ? forced : detect(first);
  if (harness === 'claude-code') return parseClaude(lines, file);
  if (harness === 'codex') return 'payload' in first ? parseCodexRollout(lines, file) : parseCodexExec(lines, file);
  throw new Error(`cannot tell which harness wrote ${file}; pass --harness claude-code|codex`);
}

function detect(first: Record<string, unknown>): string {
  if ('sessionId' in first || (typeof first.type === 'string' && ['user', 'assistant', 'system', 'summary'].includes(first.type) && 'uuid' in first)) return 'claude-code';
  if ('payload' in first && 'timestamp' in first) return 'codex';
  if (typeof first.type === 'string' && /^(thread|turn|item)\./.test(first.type)) return 'codex';
  return 'unknown';
}

function parseClaude(lines: string[], file: string): Parsed {
  const calls: Call[] = [];
  const compacts: string[] = [];
  const warnings: string[] = [];
  let session = basename(file).replace(/\.jsonl$/, '');
  let cwd: string | undefined;
  let branch: string | undefined;
  let firstTs: string | undefined;
  for (const l of lines) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(l) as Record<string, unknown>; } catch { continue; }
    if (typeof j.sessionId === 'string' && j.sessionId) session = j.sessionId;
    if (typeof j.cwd === 'string' && !cwd) cwd = j.cwd;
    if (typeof j.gitBranch === 'string' && !branch) branch = j.gitBranch;
    const ts = typeof j.timestamp === 'string' ? j.timestamp : new Date().toISOString();
    if (!firstTs && typeof j.timestamp === 'string') firstTs = j.timestamp;
    if (j.type === 'system' && j.subtype === 'compact_boundary') { compacts.push(ts); calls.push({ ts, tool: '', input: {}, origin: 'main' }); continue; }
    if (j.type !== 'assistant') continue;
    const msg = j.message as { content?: unknown } | undefined;
    const content = Array.isArray(msg?.content) ? (msg!.content as { type: string; name?: string; input?: Record<string, unknown> }[]) : [];
    for (const block of content) {
      if (block.type !== 'tool_use' || !block.name) continue;
      const call: Call = { ts, tool: block.name, input: block.input ?? {}, origin: j.isSidechain === true ? 'subagent' : 'main' };
      if (j.isSidechain === true) call.agent = typeof j.agentId === 'string' ? j.agentId : 'sidechain';
      if (typeof j.cwd === 'string') call.cwd = j.cwd;
      calls.push(call);
    }
  }
  const out: Parsed = { harness: 'claude-code', session, calls, compacts, warnings };
  if (cwd) out.cwd = cwd;
  if (branch) out.branch = branch;
  if (firstTs) out.firstTs = firstTs;
  return out;
}

function parseCodexRollout(lines: string[], file: string): Parsed {
  const calls: Call[] = [];
  const compacts: string[] = [];
  const warnings: string[] = [];
  let session = basename(file).replace(/\.jsonl$/, '');
  let cwd: string | undefined;
  let branch: string | undefined;
  let cliVersion: string | undefined;
  let subagent = false;
  let firstTs: string | undefined;
  for (const l of lines) {
    let j: { timestamp?: string; type?: string; payload?: Record<string, unknown> };
    try { j = JSON.parse(l) as typeof j; } catch { continue; }
    const ts = j.timestamp ?? new Date().toISOString();
    if (!firstTs && j.timestamp) firstTs = j.timestamp;
    const p = j.payload ?? {};
    if (j.type === 'session_meta') {
      const id = (p.id ?? p.session_id) as string | undefined;
      if (id) session = id;
      if (typeof p.cwd === 'string') cwd = p.cwd;
      if (typeof p.cli_version === 'string') cliVersion = p.cli_version;
      const gitInfo = p.git as { branch?: string } | undefined;
      if (gitInfo?.branch) branch = gitInfo.branch;
      if (p.parent_thread_id) subagent = true;
      continue;
    }
    if (j.type === 'compacted') { compacts.push(ts); calls.push({ ts, tool: '', input: {}, origin: 'main' }); continue; }
    if (j.type === 'turn_context' && typeof p.cwd === 'string') { cwd = p.cwd; continue; }
    if (j.type !== 'response_item') continue;
    const origin: Call['origin'] = subagent ? 'subagent' : 'main';
    const kind = p.type as string | undefined;
    if (kind === 'function_call') {
      const name = String(p.name ?? '');
      let args: Record<string, unknown> = {};
      try { args = typeof p.arguments === 'string' ? (JSON.parse(p.arguments) as Record<string, unknown>) : ((p.arguments as Record<string, unknown>) ?? {}); } catch { args = {}; }
      const cmd = args.cmd ?? args.command;
      if (/exec_command|shell|container\.exec/.test(name) && cmd !== undefined) {
        const call: Call = { ts, tool: 'Bash', input: { command: Array.isArray(cmd) ? cmd.map(String).join(' ') : String(cmd) }, origin };
        if (typeof args.workdir === 'string') call.cwd = args.workdir;
        else if (cwd) call.cwd = cwd;
        calls.push(call);
      } else if (name === 'apply_patch' && typeof args.input === 'string') {
        calls.push({ ts, tool: 'apply_patch', input: { command: args.input }, origin, ...(cwd ? { cwd } : {}) });
      }
      continue;
    }
    if (kind === 'local_shell_call') {
      const action = p.action as { command?: string[] } | undefined;
      if (action?.command) calls.push({ ts, tool: 'Bash', input: { command: action.command.join(' ') }, origin, ...(cwd ? { cwd } : {}) });
      continue;
    }
    if (kind === 'custom_tool_call' && String(p.name ?? '') === 'apply_patch') {
      const input = typeof p.input === 'string' ? p.input : '';
      calls.push({ ts, tool: 'apply_patch', input: { command: input }, origin, ...(cwd ? { cwd } : {}) });
    }
  }
  if (!cliVersion) warnings.push('rollout has no session_meta.cli_version; the rollout format is not a stable interface, so results may be incomplete');
  const out: Parsed = { harness: 'codex', session, calls, compacts, warnings };
  if (cwd) out.cwd = cwd;
  if (branch) out.branch = branch;
  if (cliVersion) out.cliVersion = cliVersion;
  if (firstTs) out.firstTs = firstTs;
  return out;
}

function parseCodexExec(lines: string[], file: string): Parsed {
  const calls: Call[] = [];
  let session = basename(file).replace(/\.jsonl?$/, '');
  for (const l of lines) {
    let j: { type?: string; thread_id?: string; item?: Record<string, unknown> };
    try { j = JSON.parse(l) as typeof j; } catch { continue; }
    const ts = new Date().toISOString();
    if (j.type === 'thread.started' && j.thread_id) { session = j.thread_id; continue; }
    if (j.type !== 'item.completed' || !j.item) continue;
    const it = j.item;
    if (it.type === 'command_execution' && typeof it.command === 'string') calls.push({ ts, tool: 'Bash', input: { command: it.command }, origin: 'main' });
    if (it.type === 'file_change' && Array.isArray(it.changes)) {
      const patch = (it.changes as { path: string; kind: string }[]).map((c) => `*** ${c.kind === 'add' ? 'Add' : c.kind === 'delete' ? 'Delete' : 'Update'} File: ${c.path}`).join('\n');
      calls.push({ ts, tool: 'apply_patch', input: { command: `*** Begin Patch\n${patch}\n*** End Patch` }, origin: 'main' });
    }
  }
  return { harness: 'codex', session, calls, compacts: [], warnings: ['codex exec output carries no timestamps or cwd; touches are stamped at replay time'] };
}

export type { RepoContext };
