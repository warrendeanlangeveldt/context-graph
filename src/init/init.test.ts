import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { Graph } from '../graph/graph.js';
import { formatRecord } from '../graph/write.js';
import { bootstrap, newRecordsOnly } from './bootstrap.js';
import { conformanceFindings, conformanceReport, violationsFor } from './conformance.js';
import { detectBindings, exportPack, instantiate, loadPacks } from './packs.js';
import { ratify } from './ratify.js';

describe('bootstrap, packs, conformance, ratify', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const g = (a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const w = (p: string, c: string): void => { mkdirSync(join(repo, p, '..'), { recursive: true }); writeFileSync(join(repo, p), c); };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-init-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 'tester@example.com']);
    g(['config', 'user.name', 'Tester']);
    w('src/domain/order.ts', 'export class Order {}\n');
    w('src/domain/bad.ts', "import { db } from '../infrastructure/db.js';\nexport const bad = db;\n");
    w('src/application/place-order.ts', "import { Order } from '../domain/order.js';\nexport const place = (): Order => new Order();\n");
    w('src/infrastructure/db.ts', "import { Order } from '../domain/order.js';\nexport const db = { save: (o: Order) => o };\n");
    w('src/infrastructure/repo.ts', "import { db } from './db.js';\nimport { Order } from '../domain/order.js';\nexport const repo = { db, Order };\n");
    w('src/application/cancel-order.ts', "import { Order } from '../domain/order.js';\nexport const cancel = (o: Order): Order => o;\n");
    w('test/architecture.test.ts', "it('domain never imports infrastructure', () => {});\nit('application stays thin', () => {});\n");
    w('AGENTS.md', '# Rules\n\n- Never commit secrets to the repository, use the resolver.\n- Code under src/domain/ must not import infrastructure.\n- Prefer small pull requests.\n');
    w('CONTRIBUTING.md', '# Contributing\n\n- Always run the linter before pushing.\n');
    w('docs/adr/0001-record-decisions.md', '# ADR-0001: Record architecture decisions\n\nStatus: Accepted\n');
    w('docs/adr/0002-old-layering.md', '# ADR-0002: Old layering\n\n**Status:** Superseded by ADR-0003\n');
    w('docs/adr/0003-new-layering.md', '# ADR-0003: New layering\n\nStatus: Accepted\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'seed']);
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('derives modules, edges, constraints, and concepts from the tree', () => {
    const ctx = openRepo({ repo });
    const r = bootstrap(ctx, { minFiles: 1, today: '2026-09-07' });
    const ids = r.logicals.map((l) => l.id);
    expect(ids).toEqual(expect.arrayContaining(['L:domain', 'L:application', 'L:infrastructure', 'L:repo']));
    expect(r.mappings.find((m) => m.logical === 'L:domain')?.glob).toBe('src/domain/**');
    expect(r.mappings[r.mappings.length - 1]).toMatchObject({ glob: '**', logical: 'L:repo' });
    const contain = r.edges.filter((e) => e.rel === 'in').map((e) => `${e.from}>${e.to}`);
    expect(contain).toContain('L:domain>L:src');
    expect(contain).toContain('L:src>L:repo');
    const arch = r.constraints.filter((k) => k.id.startsWith('arch.'));
    expect(arch.map((k) => k.text)).toEqual(['domain never imports infrastructure', 'application stays thin']);
    expect(arch[0]).toMatchObject({ mode: 'G?', test: 'test/architecture.test.ts', since: '2026-09-07' });
    const agent = r.constraints.filter((k) => k.id.startsWith('agent.'));
    expect(agent.map((k) => [k.text, k.attachedTo])).toEqual([['[AGENTS.md:4] Code under src/domain/ must not import infrastructure.', 'L:domain'], ['[CONTRIBUTING.md:3] Always run the linter before pushing.', 'L:repo']]);
    expect(r.notes).toContain('AGENTS.md: 1 imperative line(s) proposed as guided constraints; 1 global line(s) left where the harness already injects them');
    expect(r.concepts.map((c) => c.id).sort()).toEqual(['C:adr-0001', 'C:adr-0002', 'C:adr-0003']);
    expect(r.concepts.find((c) => c.id === 'C:adr-0002')).toMatchObject({ adr: '0002', proposed: true, name: 'Old layering' });
    expect(r.notes.some((n) => n.includes('Superseded'))).toBe(true);
    expect(newRecordsOnly(r, undefined).length).toBe(r.mappings.length + r.logicals.length + r.edges.length + r.concepts.length + r.constraints.length);
  });

  it('names colliding leaves by their enclosing module, treats src as a convention, takes rules from negative tests, and keeps header rationale as notes', () => {
    w('app/web/src/app/page.tsx', 'export default 1;\n');
    w('app/web/src/app/layout.tsx', 'export default 2;\n');
    w('app/mobile/src/app/index.tsx', 'export default 3;\n');
    w('app/api/src/services/scan.ts', '/**\n * The canonical scan writer. One writer, because two of them drifted for a year and\n * nobody could say which row was right.\n */\nexport const scan = 1;\n');
    w('app/api/src/services/plain.ts', '/** Helpers for scans. */\nexport const plain = 1;\n');
    w('app/api/src/services/__tests__/no-auto-diagnosis.test.ts', '/**\n * P0-02 negative test — a scan must never create a chronic condition.\n *\n * The removed code wrote isActive onto a condition whenever a detection cleared 0.8.\n */\ndescribe("P0-02 scans cannot create a diagnosis", () => { it("never calls createUserCondition", () => {}); });\ndescribe("P0-02 the documented policy is stated in one place", () => {});\n');
    w('app/api/src/services/__tests__/observation-contract.test.ts', 'describe("the observation schema", () => { it("parses a printed range", () => {}); });\n');
    g(['add', '-A']);
    const ctx = openRepo({ repo });
    const r = bootstrap(ctx, { minFiles: 1, today: '2026-09-07' });
    const globs = Object.fromEntries(r.mappings.map((m) => [m.glob, m.logical]));
    expect(globs['app/web/src/app/**']).toBe('L:web-app');
    expect(globs['app/mobile/src/app/**']).toBe('L:mobile-app');
    expect(globs['app/api/src/services/**']).toBe('L:services');
    expect(globs['app/web/**']).toBe('L:web');
    expect(globs['app/api/src/**']).toBeUndefined();
    expect(globs['src/**']).toBe('L:src');
    const arch = r.constraints.filter((k) => k.id.startsWith('arch.') && k.test?.includes('app/api'));
    expect(arch.map((k) => k.text)).toEqual(['P0-02 scans cannot create a diagnosis', 'P0-02 the documented policy is stated in one place']);
    expect(arch[0]).toMatchObject({ mode: 'G?', attachedTo: 'L:services', test: 'app/api/src/services/__tests__/no-auto-diagnosis.test.ts' });
    const notes = r.constraints.filter((k) => k.mode === 'R');
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ id: 'hdr.app-api-src-services-scan', attachedTo: 'app/api/src/services/scan.ts' });
    expect(notes[0]!.text).toBe('The canonical scan writer. One writer, because two of them drifted for a year and nobody could say which row was right.');
    expect(Graph.fromRecords(newRecordsOnly(r, undefined)).validate().filter((f) => f.level === 'error')).toEqual([]);
  });

  it('leaves a curated graph its modules and attaches new rules to them', () => {
    w('.ctx/graph.ctx', 'M src/domain/** L:dom\nM ** L:root\nL L:dom Domain, curated\nL L:root Root\nE L:dom in L:root\n');
    w('src/domain/__tests__/no-infra.test.ts', 'describe("domain never reaches infrastructure", () => { it("x", () => {}); });\n');
    g(['add', '-A']);
    const ctx = openRepo({ repo });
    const r = bootstrap(ctx, { minFiles: 1, today: '2026-09-07' });
    // Its modules stand: nothing is proposed for the folder L:dom maps.
    expect(r.mappings.some((m) => m.glob === 'src/domain/**')).toBe(false);
    expect(r.logicals.some((l) => l.id === 'L:dom')).toBe(false);
    // Folders only the root mapping claims are proposed as new modules, each with a proposed containment edge.
    expect(r.mappings.length).toBeGreaterThan(0);
    expect(r.mappings.every((m) => m.glob !== '**')).toBe(true);
    expect(r.edges.filter((e) => e.rel === 'in').every((e) => e.proposed && e.since === '2026-09-07')).toBe(true);
    expect(r.notes.some((n) => n.includes('already defines 2 modules') && n.includes('proposed as new modules'))).toBe(true);
    const arch = r.constraints.filter((k) => k.id.startsWith('arch.'));
    expect(arch.map((k) => [k.text, k.attachedTo])).toContainEqual(['domain never reaches infrastructure', 'L:dom']);
    expect(arch.find((k) => k.test === 'test/architecture.test.ts')?.attachedTo).toBe('L:root');
    expect(r.constraints.find((k) => k.id.startsWith('agent.'))?.attachedTo).toBe('L:dom');
  });

  it('binds the ports-and-adapters pack, counts violations, ratifies with legacy decisions, and exports', () => {
    const ctx = openRepo({ repo });
    const r = bootstrap(ctx, { minFiles: 1, today: '2026-09-07' });
    const graph = Graph.fromRecords(newRecordsOnly(r, undefined));
    const packs = loadPacks(['ports-and-adapters']);
    expect(packs).toHaveLength(1);
    const pack = packs[0]!;
    const { bindings, unbound } = detectBindings(pack, graph, r.files);
    expect(unbound).toEqual([]);
    expect(bindings.map((b) => `${b.role}=${b.logical}`)).toEqual(['domain=L:domain', 'app=L:application', 'infra=L:infrastructure']);
    const inst = instantiate(pack, bindings, unbound, '2026-09-07');
    const pure = inst.records.find((x) => x.kind === 'K' && x.id === 'hex.domain-pure');
    expect(pure).toMatchObject({ mode: 'G?', attachedTo: 'L:domain', rule: 'noimport:L:domain:L:infrastructure', from: 'ports-and-adapters@1' });
    expect(inst.records.some((x) => x.kind === 'C' && x.id === 'C:ports-and-adapters' && x.proposed)).toBe(true);

    const all = Graph.fromRecords([...newRecordsOnly(r, undefined), ...inst.records]);
    const vs = violationsFor(all, pure as never, r.index);
    expect(vs.map((v) => v.detail)).toEqual(['src/domain/bad.ts imports src/infrastructure/db.ts']);

    // Write the proposed graph and ratify the pure rule.
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), [...newRecordsOnly(r, undefined), ...inst.records].map(formatRecord).join('\n') + '\n');
    const ctx2 = openRepo({ repo });
    const res = ratify(ctx2, ['hex.domain-pure', 'C:ports-and-adapters'], { today: '2026-09-07' });
    expect(res.ratified).toEqual(['C:ports-and-adapters', 'hex.domain-pure']);
    expect(res.legacy).toHaveLength(1);
    expect(res.legacy[0]).toMatchObject({ node: 'src/domain/bad.ts', serves: 'hex.domain-pure', overrides: 'hex.domain-pure' });
    expect(res.legacy[0]!.text).toMatch(/^legacy: predates hex.domain-pure/);
    expect(res.trailer).toBe('Ctx-Ratified-By: tester');
    const after = Graph.load(join(repo, '.ctx'));
    expect(after.constraints.get('hex.domain-pure')?.mode).toBe('G');
    expect(after.concepts.get('C:ports-and-adapters')?.proposed).toBeUndefined();
    expect(after.decisions.size).toBe(1);
    expect(after.validate(repo).filter((f) => f.level === 'error')).toEqual([]);

    // Conformance now excludes the legacy exception.
    const ctx3 = openRepo({ repo });
    const report = conformanceReport(ctx3);
    expect(report.get('hex.domain-pure')?.length).toBe(1);
    expect(conformanceFindings(ctx3)).toEqual([]);

    const exported = exportPack(after, 'acme-style');
    expect(exported).toContain('R {domain} dir:domain');
    expect(exported).toContain('K G hex.domain-pure {domain}');
    expect(exported).toContain('rule:noimport:{domain}:{infrastructure}');
    expect(exported).not.toContain('D d-');
    expect(readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8')).toContain('legacy: predates hex.domain-pure');
  });
});
