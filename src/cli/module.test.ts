import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { Graph } from '../graph/graph.js';
import { retire } from '../hygiene/hygiene.js';
import { ratify } from '../init/ratify.js';
import { propose } from '../record/propose.js';
import { walk } from '../walker/walk.js';
import { run as moduleCmd } from './module.js';

const GRAPH = `M src/** L:src
M ** L:repo
L L:repo Repo
L L:src Source
E L:src in L:repo
K G src.pure L:src no side effects at import
K E repo.typed L:repo exported functions are typed test:test/typed.test.ts
`;

describe('modules: giving paths their own module, and the delegated ratifier', () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const w = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, '..'), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const graphText = () => readFileSync(join(repo, '.ctx/graph.ctx'), 'utf8');
  const cmd = async (positional: string[], flags: Record<string, string | boolean>) => {
    const out: string[] = [];
    const err: string[] = [];
    const [log, error] = [console.log, console.error];
    console.log = (s: string) => out.push(s);
    console.error = (s: string) => err.push(s);
    try {
      const code = await moduleCmd({ cmd: 'module', positional, flags: { repo, ...flags } }, { json: true });
      return { code, out: out.join('\n'), err: err.join('\n') };
    } finally {
      [console.log, console.error] = [log, error];
    }
  };
  const delegate = (kinds: string[]) =>
    w('.ctx/config.toml', `[repo]\nratifiers = ["warren"]\n\n[delegate]\nratifier = "sidequest-lead"\nmay_ratify = ${JSON.stringify(kinds)}\n`);

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-module-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'warren@example.com');
    git('config', 'user.name', 'Warren');
    w('.ctx/graph.ctx', GRAPH);
    w('.ctx/config.toml', '[repo]\nratifiers = ["warren"]\n');
    w('src/billing/invoice.ts', 'export const total = 1;\n');
    w('src/a.ts', 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('gap 1: ctx module gives paths their own module, ahead of the mappings that claimed them', async () => {
    const r = await cmd(['L:billing'], { paths: 'src/billing/**', name: 'Billing' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ module: 'L:billing', parent: 'L:src', edge: 'proposed' });
    const text = graphText();
    expect(text.indexOf('M src/billing/** L:billing')).toBeLessThan(text.indexOf('M src/** L:src'));
    expect(text).toContain('L L:billing Billing');
    const g = openRepo({ repo }).graph!;
    expect(g.mapPath('src/billing/invoice.ts')?.logical).toBe('L:billing');
    expect(g.mapPath('src/a.ts')?.logical).toBe('L:src');
    // A rule proposed for a billing file now lands on billing alone, not on everything in src.
    const p = propose(openRepo({ repo }), { target: 'src/billing/invoice.ts', text: 'Money is integer cents' });
    expect(p).toMatchObject({ record: { attachedTo: 'L:billing' } });
    const rules = (path: string) => walk(openRepo({ repo }).graph!, path).constraints.map((k) => k.text);
    expect(rules('src/billing/invoice.ts')).toContain('Money is integer cents');
    expect(rules('src/a.ts')).not.toContain('Money is integer cents');
  });

  it("gap 2: a new module's proposed containment edge keeps its parent's rules on its files", async () => {
    await cmd(['L:billing'], { paths: 'src/billing/**' });
    const w1 = walk(openRepo({ repo }).graph!, 'src/billing/invoice.ts');
    expect(w1.chain).toEqual(['L:billing', 'L:src', 'L:repo']);
    expect(w1.constraints.map((k) => k.id)).toEqual(expect.arrayContaining(['src.pure', 'repo.typed']));
    // An agreed edge wins over a proposed one.
    const g = Graph.fromRecords([
      { kind: 'L', id: 'L:a', name: 'a', line: 0 },
      { kind: 'L', id: 'L:b', name: 'b', line: 0 },
      { kind: 'L', id: 'L:c', name: 'c', line: 0 },
      { kind: 'E', from: 'L:a', rel: 'in', to: 'L:b', proposed: true, line: 0 },
      { kind: 'E', from: 'L:a', rel: 'in', to: 'L:c', line: 0 },
    ]);
    expect(g.parentsOf('L:a')).toEqual(['L:c']);
  });

  it('gap 1 and 2: the delegated ratifier adds a module agreed, only where may_ratify includes modules', async () => {
    delegate(['guidance']);
    const refused = await cmd(['L:billing'], { paths: 'src/billing/**', delegated: true, reason: 'billing has its own rules' });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('not modules');
    expect(graphText()).not.toContain('L:billing');
    delegate(['guidance', 'modules']);
    const agreed = await cmd(['L:billing'], { paths: 'src/billing/**', delegated: true, reason: 'billing has its own rules' });
    expect(agreed.code).toBe(0);
    expect(JSON.parse(agreed.out)).toMatchObject({ edge: 'agreed', trailer: 'Ctx-Ratified-By: sidequest-lead (delegated)' });
    expect(graphText()).toMatch(/^E L:billing in L:src$/m);
  });

  it("gap 2: the delegated ratifier may ratify a module's proposed containment edge, but no other edge", async () => {
    await cmd(['L:billing'], { paths: 'src/billing/**' });
    w('.ctx/proposals.ctx', 'E L:billing dep L:repo proposed since:2026-10-07\n');
    delegate(['modules']);
    const r = ratify(openRepo({ repo }), ['L:billing in L:src'], { delegated: { reason: 'billing sits in src' } });
    expect(r.ratified).toEqual(['L:billing in L:src']);
    expect(graphText()).toMatch(/^E L:billing in L:src$/m);
    expect(() => ratify(openRepo({ repo }), ['L:billing dep L:repo'], { delegated: { reason: 'x' } })).toThrow(/a person ratifies these/);
  });

  it('refuses a mapped glob, an unknown parent and a malformed id', async () => {
    expect((await cmd(['L:again'], { paths: 'src/**' })).err).toContain('already mapped');
    expect((await cmd(['L:billing'], { paths: 'src/billing/**', in: 'L:nowhere' })).err).toContain("isn't a module");
    expect((await cmd(['billing'], { paths: 'src/billing/**' })).err).toContain("isn't a module id");
  });

  it('gap 3: the delegated ratifier retires under its own name, within its kinds', () => {
    delegate(['guidance', 'retirements']);
    const r = retire(openRepo({ repo }), 'src.pure', 'superseded by the lint rule', undefined, { delegated: true });
    expect(r.record.who).toBe('sidequest-lead/delegated');
    expect(graphText()).toMatch(/^Z src\.pure \S+ sidequest-lead\/delegated superseded by the lint rule$/m);
    delegate(['guidance']);
    expect(() => retire(openRepo({ repo }), 'repo.typed', 'x', undefined, { delegated: true })).toThrow(/not retirements/);
    const byPerson = retire(openRepo({ repo }), 'repo.typed', 'replaced', undefined);
    expect(byPerson.record.who).toBe('warren/human');
  });
});

describe('gap 4: init on a curated graph proposes modules for folders it has grown', () => {
  it('writes them ahead of the root mapping, their containment edges proposed', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-regrow-')));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    const w = (rel: string, body: string) => {
      mkdirSync(join(repo, rel, '..'), { recursive: true });
      writeFileSync(join(repo, rel), body);
    };
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'warren@example.com');
    git('config', 'user.name', 'Warren');
    w('.ctx/graph.ctx', 'M src/** L:src\nM ** L:repo\nL L:repo Repo\nL L:src Source\nE L:src in L:repo\n');
    w('.ctx/config.toml', '[repo]\nratifiers = ["warren"]\n');
    w('src/a.ts', 'export const a = 1;\n');
    for (const f of ['handlers.ts', 'routes.ts', 'server.ts']) w(`api/${f}`, `export const x = '${f}';\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
    const { run } = await import('../init/cli.js');
    const log = console.log;
    console.log = () => {};
    try {
      expect(await run({ cmd: 'init', positional: [], flags: { repo, write: true, 'min-files': '1', packs: 'none' } }, { json: false, usage: '' })).toBe(0);
    } finally {
      console.log = log;
    }
    const text = readFileSync(join(repo, '.ctx/graph.ctx'), 'utf8');
    expect(text.indexOf('M api/** L:api')).toBeGreaterThan(-1);
    expect(text.indexOf('M api/** L:api')).toBeLessThan(text.indexOf('M ** L:repo'));
    expect(text).toMatch(/^E L:api in L:repo since:\S+ proposed$/m);
    const g = openRepo({ repo }).graph!;
    expect(g.mapPath('api/routes.ts')?.logical).toBe('L:api');
    expect(walk(g, 'api/routes.ts').chain).toEqual(['L:api', 'L:repo']);
    expect(g.mappings.filter((m) => m.glob === 'src/**')).toHaveLength(1);
  });
});
