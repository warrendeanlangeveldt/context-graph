import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { packageRoot } from '../util/root.js';
import { Graph } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import { formatRecord } from '../graph/write.js';
import type { CoverageRecord } from '../observe/coverage.js';
import type { DRecord } from '../graph/records.js';
import type { Envelope, Touch } from '../observe/event.js';
import { ObservationStore } from '../observe/store.js';
import { git } from '../util/git.js';
import { ctxHome, repoHash } from '../util/paths.js';
import type { Task } from './corpus.js';

/**
 * Benchmark runner (design spec §20.6). For each task, arm, and run: a fresh worktree at the
 * task's base commit, a graph snapshot cut at that commit, the harness run headless with the
 * plugin loaded, the hidden check executed, and every metric collected from the observation
 * store the hooks wrote. Arms: A no graph, B whole graph in the instruction file, C slices.
 */
export type Arm = 'A' | 'B' | 'C';
export type Harness = 'claude' | 'codex' | 'command';

export interface RunOptions {
  arms: Arm[];
  runs: number;
  harness: Harness;
  command?: string;
  tasks?: string[];
  timeoutMs?: number;
  outDir?: string;
  log?: (s: string) => void;
  keepWorktrees?: boolean;
}

export interface RunRecord {
  task: string;
  stratum: string;
  arm: Arm;
  harness: Harness;
  run: number;
  startedAt: string;
  durationMs: number;
  passed: boolean | null;
  checkExit: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  turns: number | null;
  toolCalls: number;
  reads: number;
  edits: number;
  rework: number;
  testFailures: number;
  slicesInjected: number;
  callersLoaded: number;
  callersTotal: number;
  darkTotal: number;
  reach: number;
  decisions: { id: string; node: string; serves: string; overrides?: string }[];
  session: string | null;
  harnessError: string | null;
}

export async function runBench(ctx: RepoContext, tasks: Task[], opts: RunOptions): Promise<{ dir: string; records: RunRecord[] }> {
  const log = opts.log ?? (() => undefined);
  const root = ctx.root;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = opts.outDir ?? join(ctx.graphDir && !ctx.graphDir.startsWith(root) ? ctx.graphDir : join(root, '.ctx'), 'bench', 'results', stamp);
  mkdirSync(dir, { recursive: true });
  const runsFile = join(dir, 'runs.jsonl');
  const selected = opts.tasks?.length ? tasks.filter((t) => opts.tasks!.includes(t.id)) : tasks;
  if (!selected.length) throw new Error('no tasks selected');
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ startedAt: new Date().toISOString(), repo: root, harness: opts.harness, arms: opts.arms, runs: opts.runs, tasks: selected.map((t) => t.id) }, null, 2));
  const records: RunRecord[] = [];
  const wtRoot = join(ctxHome(), 'bench', repoHash(root));
  mkdirSync(wtRoot, { recursive: true });

  for (const task of selected) {
    for (const arm of opts.arms) {
      for (let run = 1; run <= opts.runs; run++) {
        const label = `${task.id} ${arm} #${run}`;
        const wt = join(wtRoot, `${task.id}-${arm}-${run}`);
        rmWorktree(root, wt);
        log(`${label}: worktree at ${task.base}`);
        execFileSync('git', ['worktree', 'add', '--detach', '-f', wt, task.base], { cwd: root, stdio: 'ignore' });
        const started = Date.now();
        const rec: RunRecord = { task: task.id, stratum: task.stratum, arm, harness: opts.harness, run, startedAt: new Date(started).toISOString(), durationMs: 0, passed: null, checkExit: null, tokensIn: null, tokensOut: null, turns: null, toolCalls: 0, reads: 0, edits: 0, rework: 0, testFailures: 0, slicesInjected: 0, callersLoaded: 0, callersTotal: 0, darkTotal: 0, reach: 0, decisions: [], session: null, harnessError: null };
        try {
          const env = prepareArm(ctx, task, arm, wt, opts.harness);
          const session = `bench-${task.id}-${arm}-${run}-${stamp}`;
          env.CTX_SESSION = session;
          const h = runHarness(opts, task, wt, env, session, log);
          rec.session = h.session;
          rec.tokensIn = h.tokensIn; rec.tokensOut = h.tokensOut; rec.turns = h.turns; rec.harnessError = h.error;
          const check = spawnSync('sh', ['-c', task.check], { cwd: wt, encoding: 'utf8', timeout: opts.timeoutMs ?? 10 * 60_000, env: { ...process.env, CI: '1' } });
          rec.checkExit = check.status;
          rec.passed = check.status === 0;
          writeFileSync(join(dir, `${task.id}-${arm}-${run}.check.log`), `${check.stdout ?? ''}\n${check.stderr ?? ''}`);
          if (h.session) collectMetrics(rec, new ObservationStore(wt, h.session).readAll().length ? new ObservationStore(wt, h.session) : new ObservationStore(root, h.session));
        } catch (e) {
          rec.harnessError = (e as Error).message;
        } finally {
          rec.durationMs = Date.now() - started;
          records.push(rec);
          appendFileSync(runsFile, JSON.stringify(rec) + '\n');
          log(`${label}: ${rec.passed === null ? 'no result' : rec.passed ? 'PASS' : 'FAIL'} in ${Math.round(rec.durationMs / 1000)}s${rec.harnessError ? ` (${rec.harnessError})` : ''}`);
          if (!opts.keepWorktrees) rmWorktree(root, wt);
        }
      }
    }
  }
  return { dir, records };
}

// ---- arms ---------------------------------------------------------------------------------

function prepareArm(ctx: RepoContext, task: Task, arm: Arm, wt: string, harness: Harness): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: wt };
  delete env.CTX_GRAPH_DIR;
  const inTree = join(wt, '.ctx');
  if (arm === 'A') {
    if (existsSync(inTree)) rmSync(inTree, { recursive: true, force: true });
    env.CTX_GRAPH_DIR = '';
    delete env.CTX_GRAPH_DIR;
    // Observe-only: the hooks still record; without a graph nothing is injected.
    return env;
  }
  // Temporal cut (design spec §20.5): only what existed at the base commit.
  const snapshotDir = join(wt, '.ctx-bench');
  mkdirSync(snapshotDir, { recursive: true });
  const graphDir = existsSync(join(inTree, 'graph.ctx')) ? inTree : ctx.graphDir;
  if (!graphDir) throw new Error('no graph to snapshot for arm ' + arm);
  const baseDate = git(ctx.root, ['show', '-s', '--format=%cI', task.base]) ?? '';
  if (!baseDate) throw new Error(`cannot date base commit ${task.base}`);
  const cut = new Date(baseDate).getTime();
  for (const f of ['graph.ctx', 'aliases.ctx', 'proposals.ctx']) if (existsSync(join(graphDir, f))) copyFileSync(join(graphDir, f), join(snapshotDir, f));
  const decisionsFile = join(graphDir, 'decisions.ctx');
  const kept: string[] = [];
  let dropped = 0;
  if (existsSync(decisionsFile)) {
    const recs = parseText(readFileSync(decisionsFile, 'utf8'), decisionsFile);
    const keptIds = new Set<string>();
    for (const r of recs) {
      if (r.kind === 'D') {
        const after = new Date(r.date + 'T23:59:59Z').getTime() > cut || r.sha.startsWith(task.sha.slice(0, 7)) || task.sha.startsWith(r.sha);
        if (after) { dropped++; continue; }
        keptIds.add(r.id);
        kept.push(formatRecord(r));
      } else if (r.kind === 'S') { if (keptIds.has(r.newId) && keptIds.has(r.oldId)) kept.push(formatRecord(r)); }
      else kept.push(formatRecord(r));
    }
  }
  writeFileSync(join(snapshotDir, 'decisions.ctx'), `# temporal cut at ${task.base} (${baseDate}); ${dropped} later decision(s) excluded\n` + kept.join('\n') + (kept.length ? '\n' : ''));
  const cfg = existsSync(join(graphDir, 'config.toml')) ? readFileSync(join(graphDir, 'config.toml'), 'utf8') : '';
  const sliceOn = arm === 'C';
  writeFileSync(join(snapshotDir, 'config.toml'), cfg.replace(/^\s*enabled\s*=.*$/m, '') + `\n[slice]\nenabled = ${sliceOn}\n`, 'utf8');
  env.CTX_GRAPH_DIR = snapshotDir;
  if (existsSync(inTree)) rmSync(inTree, { recursive: true, force: true });
  if (arm === 'B') {
    const g = Graph.load(snapshotDir);
    const file = join(wt, harness === 'codex' ? 'AGENTS.md' : 'CLAUDE.md');
    const prior = existsSync(file) ? readFileSync(file, 'utf8') : '';
    writeFileSync(file, prior + '\n\n' + renderWholeGraph(g), 'utf8');
  }
  return env;
}

/** Arm B: the whole graph as prose in the instruction file, loaded once at session start. */
export function renderWholeGraph(g: Graph): string {
  const lines = ['# Engineering context (whole graph)', ''];
  lines.push('## Modules');
  for (const l of g.logicals.values()) lines.push(`- ${l.id}: ${l.name}`);
  lines.push('', '## Concepts');
  for (const c of g.concepts.values()) if (!c.proposed) lines.push(`- ${c.id}: ${c.name}${c.adr ? ` (ADR ${c.adr})` : ''}`);
  lines.push('', '## Constraints');
  for (const k of g.constraints.values()) if (!g.isRetired(k.id) && (k.mode === 'E' || k.mode === 'G')) lines.push(`- [${k.mode}] ${k.id} on ${k.attachedTo}: ${k.text}`);
  lines.push('', '## Decisions');
  for (const d of g.decisions.values()) if (g.isActiveDecision(d)) lines.push(`- ${d.date} ${d.who} on ${d.node} -> ${d.serves}${d.overrides ? ` !${d.overrides}` : ''}: ${d.text}`);
  return lines.join('\n') + '\n';
}

// ---- harness drivers ------------------------------------------------------------------------

interface HarnessResult { session: string | null; tokensIn: number | null; tokensOut: number | null; turns: number | null; error: string | null }

function adapterDir(name: string): string {
  const dir = join(packageRoot(), 'adapters', name);
  if (!existsSync(dir)) throw new Error(`adapter directory not found at ${dir}; the benchmark needs the full package or a clone`);
  return dir;
}

function runHarness(opts: RunOptions, task: Task, wt: string, env: NodeJS.ProcessEnv, session: string, log: (s: string) => void): HarnessResult {
  const timeout = opts.timeoutMs ?? 20 * 60_000;
  if (opts.harness === 'command') {
    if (!opts.command) throw new Error('--command is required with --harness command');
    const r = spawnSync('sh', ['-c', opts.command], { cwd: wt, encoding: 'utf8', timeout, env: { ...env, CTX_TASK_SHA: task.sha, CTX_TASK_BASE: task.base, CTX_TASK_PROMPT: task.prompt, CTX_SESSION: session } });
    return { session, tokensIn: null, tokensOut: null, turns: null, error: r.status === 0 ? null : `command exited ${r.status}: ${(r.stderr ?? '').slice(-300)}` };
  }
  if (opts.harness === 'claude') {
    const args = ['-p', task.prompt, '--permission-mode', 'acceptEdits', '--plugin-dir', adapterDir('claude-code'), '--output-format', 'json'];
    log(`  claude ${args.slice(0, 1).join(' ')} ... (${task.prompt.split('\n')[0]?.slice(0, 60)})`);
    const r = spawnSync('claude', args, { cwd: wt, encoding: 'utf8', timeout, env, maxBuffer: 64 * 1024 * 1024 });
    if (r.error) return { session: null, tokensIn: null, tokensOut: null, turns: null, error: r.error.message };
    try {
      const j = JSON.parse(r.stdout) as { session_id?: string; usage?: { input_tokens?: number; output_tokens?: number }; num_turns?: number; is_error?: boolean; result?: string };
      return { session: j.session_id ?? null, tokensIn: j.usage?.input_tokens ?? null, tokensOut: j.usage?.output_tokens ?? null, turns: j.num_turns ?? null, error: j.is_error ? (j.result ?? 'error').slice(0, 300) : r.status === 0 ? null : `exit ${r.status}` };
    } catch {
      return { session: null, tokensIn: null, tokensOut: null, turns: null, error: `unparseable claude output (exit ${r.status}): ${(r.stderr || r.stdout).slice(-300)}` };
    }
  }
  // codex: hooks come from the user-level install (ctx install codex); the session id is the thread id.
  const r = spawnSync('codex', ['exec', '--json', '-s', 'workspace-write', '-C', wt, task.prompt], { cwd: wt, encoding: 'utf8', timeout, env, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { session: null, tokensIn: null, tokensOut: null, turns: null, error: r.error.message };
  let thread: string | null = null;
  let tokensIn = 0, tokensOut = 0, turns = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    try {
      const j = JSON.parse(line) as { type?: string; thread_id?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      if (j.type === 'thread.started' && j.thread_id) thread = j.thread_id;
      if (j.type === 'turn.completed') { turns++; tokensIn += j.usage?.input_tokens ?? 0; tokensOut += j.usage?.output_tokens ?? 0; }
    } catch { /* not json */ }
  }
  return { session: thread, tokensIn: thread ? tokensIn : null, tokensOut: thread ? tokensOut : null, turns: thread ? turns : null, error: r.status === 0 ? null : `exit ${r.status}: ${(r.stderr ?? '').slice(-300)}` };
}

// ---- metrics from the observation store ------------------------------------------------------

export function collectMetrics(rec: RunRecord, store: ObservationStore): void {
  const events: Envelope[] = store.readAll();
  const firstEdit = new Map<string, number>();
  events.forEach((e, i) => {
    if (e.t === 'touch') { rec.toolCalls++; rec.reads++; }
    if (e.t === 'edit') {
      rec.toolCalls++; rec.edits++;
      const p = (e.p as Touch).path;
      if (firstEdit.has(p)) rec.rework++; else firstEdit.set(p, i);
    }
    if (e.t === 'finding' && (e.p as { rule: string }).rule === 'test-failed') rec.testFailures++;
    if (e.t === 'coverage') {
      const c = e.p as CoverageRecord;
      if (c.slice_injected) rec.slicesInjected++;
      rec.callersLoaded += c.callers_loaded;
      rec.callersTotal += c.callers_total;
      rec.darkTotal += c.dark.length;
    }
    if (e.t === 'reach') rec.reach++;
    if (e.t === 'decision') { const d = e.p as DRecord; rec.decisions.push({ id: d.id, node: d.node, serves: d.serves, ...(d.overrides ? { overrides: d.overrides } : {}) }); }
  });
}

function rmWorktree(root: string, wt: string): void {
  if (!existsSync(wt)) return;
  try { execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: root, stdio: 'ignore' }); } catch { rmSync(wt, { recursive: true, force: true }); }
  try { execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'ignore' }); } catch { /* ignore */ }
}
