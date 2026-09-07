import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promptScopes } from '../adapters/core.js';
import { openRepo } from '../core/context.js';
import { envelope } from '../observe/event.js';
import { ObservationStore } from '../observe/store.js';
import { hydrate, referenceLines } from './hydrate.js';

const GRAPH = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
L L:orch Orchestration
L L:core Engine
C C:pure Engine never depends on impls
E L:orch in L:core
E L:core impl C:pure
K G orch.events L:orch state changes go through blackboard events
K E core.pure   L:core core never imports integrations  test:api/src/core/boundary.test.ts
K R core.note   L:core a note nobody enforces
`;

const DECISIONS = [
  'D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events events carry the verdict',
  'D d-0002 2026-08-20 w/c - main api/src/core/orch/retention.ts ->K orch.events !K orch.events legacy: predates orch.events; plain state.set',
  'D d-0003 2026-08-21 w/c bbbb main api/src/core/orch/bb.ts ->K orch.events etag on every save',
].join('\n') + '\n';

describe('hydrate', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID };
  const g = (a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-hydrate-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_SESSION_ID;
    g(['init', '-q', '-b', 'main']);
    mkdirSync(join(repo, 'api/src/core/orch'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, '.ctx/decisions.ctx'), DECISIONS);
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), 'export class Blackboard { apply(): void {} }\nexport function openBoard(): Blackboard { return new Blackboard(); }\n');
    writeFileSync(join(repo, 'api/src/core/orch/retention.ts'), "import { openBoard } from './bb.js';\n\nexport function archive(): void {\n  const b = openBoard();\n  b.apply();\n}\n");
    writeFileSync(join(repo, 'api/src/core/orch/sla.ts'), "import { Blackboard as Board } from './bb.js';\n// Board comment\nexport function check(b: Board): void {\n  b.apply();\n}\n");
    writeFileSync(join(repo, 'api/src/core/x.ts'), "import { archive } from './orch/retention.js';\nexport const run = archive;\n");
    writeFileSync(join(repo, 'api/src/core/boundary.test.ts'), 'export {};\n');
    g(['add', '-A']);
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('reads the lines in a caller that import and use the target', () => {
    const lines = referenceLines(repo, 'api/src/core/orch/sla.ts', 'api/src/core/orch/bb.ts');
    expect(lines.map((l) => l.n)).toEqual([1, 3]);
    expect(lines[1]!.text).toContain('Board');
  });

  it('briefs a file: slice, callers with usage lines, rules with history, session state; and records what it returned', async () => {
    const ctx = openRepo({ cwd: repo });
    const session = 's-1';
    const store = new ObservationStore(repo, session);
    const meta = { session, who: 'w/c', branch: 'main', harness: 'claude-code' };
    store.append(envelope('touch', meta, { path: 'api/src/core/orch/retention.ts', mode: 'full', tool: 'Read', origin: 'main' }));
    store.append(envelope('compact', meta, { paths: ['api/src/core/orch/retention.ts'], trigger: 'auto' }));

    const h = await hydrate(ctx, 'api/src/core/orch/bb.ts', { session, who: 'w/c', branch: 'main', harness: 'test' });
    expect(h.files).toEqual(['api/src/core/orch/bb.ts']);
    expect(h.text).toContain('hydrate api/src/core/orch/bb.ts');
    expect(h.text).toContain('2 callers of …/core/orch/bb.ts, 1 not in context this session');
    expect(h.text).toContain('api/src/core/orch/retention.ts  (in context)');
    expect(h.text).toContain(':4  const b = openBoard();');
    expect(h.text).toContain('api/src/core/orch/sla.ts');
    expect(h.text).toContain(':3  export function check(b: Board): void {');
    expect(h.text).not.toContain('Board comment');
    expect(h.text).toContain('[G orch.events]');
    expect(h.text).toContain('[E core.pure]');
    expect(h.text).toContain('decisions behind the rules above:');
    expect(h.text).toContain('orch.events  served 2: d-0003 08-21 bb.ts "etag on every save"; d-0001 08-01 bb.ts "events carry the verdict"; overridden 1, all legacy: retention.ts');
    expect(h.text).not.toContain('core.pure  served');
    expect(h.text).toContain('…/core/orch/bb.ts: not read this session');
    expect(h.text).toContain('context compacted at');
    expect(h.tokens).toBeLessThanOrEqual(1500);

    const events = store.readAll();
    const reach = events.find((e) => e.t === 'reach');
    expect(reach).toBeDefined();
    expect((reach!.p as { nodes: string[] }).nodes).toContain('api/src/core/orch/bb.ts');
    const ranges = events.filter((e) => e.t === 'touch' && (e.p as { tool?: string }).tool === 'hydrate').map((e) => e.p as { path: string; range: [number, number] });
    expect(ranges.map((r) => r.path).sort()).toEqual(['api/src/core/orch/retention.ts', 'api/src/core/orch/sla.ts']);
    expect(ranges.find((r) => r.path === 'api/src/core/orch/sla.ts')!.range).toEqual([1, 3]);
  });

  it('briefs a module, most connected file first, with one slice per distinct chain, and a task description by the files it names or matches', async () => {
    const ctx = openRepo({ cwd: repo });
    const m = await hydrate(ctx, 'L:orch', { session: 's-2', record: false });
    expect(m.files[0]).toBe('api/src/core/orch/bb.ts');
    expect(m.files).toHaveLength(3);
    expect(m.text).toContain('(3 files: most connected of 3 under L:orch)');
    expect(m.text.match(/^edit /gm)).toHaveLength(1);
    expect(m.text).toContain('edit …/core/orch/bb.ts, …/core/orch/retention.ts, …/core/orch/sla.ts  (same chain and rules)');
    expect(m.text).toContain('  last   bb.ts  d-0003 08-21 w/c  etag on every save  (bbbb)');
    expect(m.text).toContain('  last   retention.ts  d-0002 08-20 w/c  !orch.events  legacy: predates orch.events; plain state.set  (main provisional)');

    const named = await hydrate(ctx, 'fix the etag handling in api/src/core/orch/retention.ts before the sla work', { session: 's-2', record: false });
    expect(named.files).toEqual(['api/src/core/orch/retention.ts']);
    expect(named.reason).toBe('the files the task names');

    const guessed = await hydrate(ctx, 'the retention archive path', { session: 's-2', record: false });
    expect(guessed.files).toEqual(['api/src/core/orch/retention.ts']);
    expect(guessed.reason).toBe('files whose names match "retention archive"');

    await expect(hydrate(ctx, 'nothing here at all', { session: 's-2', record: false })).rejects.toThrow(/nothing in the repository matches/);
  });

  it('drops hints, callee lists, and older decisions before it ever drops a rule', async () => {
    const ctx = openRepo({ cwd: repo });
    const h = await hydrate(ctx, 'api/src/core/orch/bb.ts', { session: 's-3', record: false, budget: 120 });
    expect(h.dropped).toContain('callee list');
    expect(h.dropped).toContain('older decisions');
    expect(h.text).toContain('[G orch.events]');
    expect(h.text).toContain('[E core.pure]');
    expect(h.text).toContain('orch.events  served 2: d-0003');
  });

  it('finds the files and module ids a prompt names outright, and nothing else', () => {
    const ctx = openRepo({ cwd: repo });
    expect(promptScopes(ctx, 'audit L:orch and api/src/core/x.ts, then fix the retention path', repo)).toEqual(['L:orch', 'api/src/core/x.ts']);
    expect(promptScopes(ctx, 'look at ./orch/bb.ts', join(repo, 'api/src/core'))).toEqual(['api/src/core/orch/bb.ts']);
    expect(promptScopes(ctx, 'see https://example.com/a.ts and L:nope', repo)).toEqual([]);
  });
});
