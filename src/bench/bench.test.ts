import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { formatCorpus, parseCorpus, proposeCorpus } from './corpus.js';
import { buildReport, formatReport } from './report.js';
import { renderWholeGraph, runBench, type RunRecord } from './runner.js';
import { Graph } from '../graph/graph.js';

describe('benchmark', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CTX_GRAPH_DIR: process.env.CTX_GRAPH_DIR };
  const g = (a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const w = (p: string, c: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), c); };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-bench-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CTX_GRAPH_DIR;
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 'T']);
    w('src/a.ts', 'export const a = "broken";\n');
    w('src/a.test.ts', 'test("a", () => {});\n');
    w('.ctx/graph.ctx', 'M src/** L:src\nL L:src Source\nK G src.rule L:src keep a fixed\n');
    w('.ctx/decisions.ctx', 'D d-0001 2020-01-01 w/c aaaa main src/a.ts ->K src.rule early decision\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'chore: base']);
    w('src/a.ts', 'export const a = "fixed";\n');
    w('src/a.test.ts', 'test("a fixed", () => {});\n');
    w('.ctx/decisions.ctx', 'D d-0001 2020-01-01 w/c aaaa main src/a.ts ->K src.rule early decision\nD d-0002 2099-01-01 w/c bbbb main src/a.ts ->K src.rule the answer, from the future\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'fix(a): make a fixed\n\nThe value must read fixed.']);
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('proposes tasks from history and round-trips the corpus format', () => {
    const ctx = openRepo({ repo });
    const { tasks, skipped } = proposeCorpus(ctx, { limit: 5, testCommand: 'grep -q fixed src/a.ts # {tests}' });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ stratum: 'single-file', check: 'grep -q fixed src/a.ts # src/a.test.ts' });
    expect(tasks[0]!.prompt).toBe('fix(a): make a fixed\nThe value must read fixed.');
    expect(skipped.map((s) => s.reason)).toEqual(['no test touched']);
    const text = formatCorpus(tasks);
    expect(parseCorpus(text)).toEqual(tasks);
  });

  it('runs arms A and C with a command harness, applies the temporal cut, and reports', async () => {
    const ctx = openRepo({ repo });
    const { tasks } = proposeCorpus(ctx, { limit: 5, testCommand: 'grep -q fixed src/a.ts' });
    const logs: string[] = [];
    const r = await runBench(ctx, tasks, {
      arms: ['A', 'B', 'C'], runs: 1, harness: 'command',
      command: 'test -n "$CTX_TASK_SHA" && git cherry-pick --no-commit "$CTX_TASK_SHA" && if [ -n "$CTX_GRAPH_DIR" ]; then cp "$CTX_GRAPH_DIR/decisions.ctx" cut.txt; fi; if [ -f CLAUDE.md ]; then cp CLAUDE.md whole.txt; fi',
      keepWorktrees: true,
      outDir: join(home, 'results'),
      log: (s) => logs.push(s),
    });
    expect(r.records).toHaveLength(3);
    expect(r.records.every((x) => x.passed === true)).toBe(true);
    expect(r.records.map((x) => x.arm)).toEqual(['A', 'B', 'C']);
    const wt = join(home, 'bench');
    // .ctx is tracked, so the worktree carries the graph exactly as it was at the base commit: git itself is the cut.
    const cutC = readFileSync(join(findWorktree(wt, '-C-1'), 'cut.txt'), 'utf8');
    expect(cutC).toContain('d-0001');
    expect(cutC).not.toContain('d-0002');
    expect(cutC).toContain('0 later decision(s) excluded');
    const wholeB = readFileSync(join(findWorktree(wt, '-B-1'), 'whole.txt'), 'utf8');
    expect(wholeB).toContain('# Engineering context (whole graph)');
    expect(wholeB).toContain('src.rule');
    expect(readFileSync(join(r.dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(3);
    const report = buildReport(r.records);
    expect(report.arms.map((a) => `${a.arm}:${a.passRate}`)).toEqual(['A:1', 'B:1', 'C:1']);
    expect(report.paired[0]).toMatchObject({ task: tasks[0]!.id, deltaPass: 0 });
    const md = formatReport(report);
    expect(md).toContain('| A | 1 | 100% |');
    expect(md).toContain('hidden tests pass more under C: DOES NOT HOLD');
    expect(logs.some((l) => l.includes('PASS'))).toBe(true);
  });

  it('cuts a linked graph by date when the repository does not track .ctx', async () => {
    // A second repository with no .ctx in the tree; the graph lives outside it with a decision from after the base commit.
    const repo2 = mkdtempSync(join(tmpdir(), 'ctx-bench2-'));
    const g2 = (a: string[]): string => execFileSync('git', a, { cwd: repo2, encoding: 'utf8' }).trim();
    g2(['init', '-q', '-b', 'main']); g2(['config', 'user.email', 't@example.com']); g2(['config', 'user.name', 'T']);
    mkdirSync(join(repo2, 'src'));
    writeFileSync(join(repo2, 'src/a.ts'), 'export const a = "broken";\n');
    writeFileSync(join(repo2, 'src/a.test.ts'), 'test("a", () => {});\n');
    g2(['add', '-A']); g2(['commit', '-q', '-m', 'chore: base']);
    writeFileSync(join(repo2, 'src/a.ts'), 'export const a = "fixed";\n');
    writeFileSync(join(repo2, 'src/a.test.ts'), 'test("a fixed", () => {});\n');
    g2(['add', '-A']); g2(['commit', '-q', '-m', 'fix(a): make a fixed']);
    const external = mkdtempSync(join(tmpdir(), 'ctx-graph-'));
    writeFileSync(join(external, 'graph.ctx'), 'M src/** L:src\nL L:src Source\nK G src.rule L:src keep a fixed\n');
    writeFileSync(join(external, 'decisions.ctx'), 'D d-0001 2020-01-01 w/c aaaa main src/a.ts ->K src.rule early decision\nD d-0002 2099-01-01 w/c bbbb main src/a.ts ->K src.rule the answer, from the future\n');
    const ctx = openRepo({ repo: repo2, graph: external });
    const { tasks } = proposeCorpus(ctx, { limit: 5, testCommand: 'grep -q fixed src/a.ts' });
    const r = await runBench(ctx, tasks, { arms: ['C'], runs: 1, harness: 'command', command: 'git cherry-pick --no-commit "$CTX_TASK_SHA" && cp "$CTX_GRAPH_DIR/decisions.ctx" cut.txt', keepWorktrees: true, outDir: join(home, 'results2') });
    expect(r.records[0]?.passed).toBe(true);
    const cut = readFileSync(join(findWorktree(join(home, 'bench'), '-C-1'), 'cut.txt'), 'utf8');
    expect(cut).toContain('d-0001');
    expect(cut).not.toContain('d-0002');
    expect(cut).toContain('1 later decision(s) excluded');
  });

  it('renders the whole graph for arm B and reports contradictions between runs', () => {
    const graph = Graph.load(join(repo, '.ctx'));
    const text = renderWholeGraph(graph);
    expect(text).toContain('- L:src: Source');
    expect(text).toContain('[G] src.rule on L:src: keep a fixed');
    const rec = (run: number, decisions: RunRecord['decisions']): RunRecord => ({ task: 't-1', stratum: 'single-file', arm: 'C', harness: 'command', run, startedAt: '', durationMs: 1000, passed: true, checkExit: 0, tokensIn: 10, tokensOut: 5, turns: 2, toolCalls: 3, reads: 2, edits: 1, rework: 0, testFailures: 0, slicesInjected: 1, callersLoaded: 1, callersTotal: 2, darkTotal: 0, reach: 0, decisions, session: 's', harnessError: null });
    const report = buildReport([
      rec(1, [{ id: 'd-1', node: 'src/a.ts', serves: 'src.rule' }]),
      rec(2, [{ id: 'd-2', node: 'src/a.ts', serves: 'other', overrides: 'src.rule' }]),
      rec(3, [{ id: 'd-3', node: 'src/a.ts', serves: 'src.rule' }]),
    ]);
    expect(report.contradictions[0]).toMatchObject({ task: 't-1', pairs: 3, contradictions: 2 });
    expect(report.arms[0]).toMatchObject({ arm: 'C', n: 3, callersRatio: 0.5, slicesPerEdit: 1 });
  });
});

function findWorktree(root: string, suffix: string): string {
  for (const hash of readdirSync(root)) for (const d of readdirSync(join(root, hash))) if (d.endsWith(suffix)) return join(root, hash, d);
  throw new Error(`no worktree ending ${suffix} under ${root}`);
}
