import { describe, expect, it } from 'vitest';
import { Graph } from './graph.js';
import { parseText } from './parse.js';

const FIXTURE = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
M api/src/**           L:api
L L:orch Orchestration
L L:core Engine
L L:api  API
C C:pure Engine never depends on impls adr:0012
E L:orch in L:core
E L:core in L:api
E L:core impl C:pure
K E boundary.core L:core core never imports impls test:api/boundary.test.ts
K G orch.events  L:orch  state via events only
K R history.note L:api   old note
K G retired.rule L:orch  an old rule
Z retired.rule 2026-09-01 warren/human no longer true
D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first
D d-0002 2026-08-02 w/c bbbb main api/src/core/orch/bb.ts ->K orch.events second
D d-0003 2026-08-03 w/c - feature/x L:orch ->C pure on the module
D d-0004 2026-08-04 w/c cccc main api/src/core/orch/bb.ts ->K retired.rule orphaned
S d-0002 d-0001
A bb api/src/core/orch/bb.ts
`;

describe('Graph', () => {
  const g = Graph.fromRecords(parseText(FIXTURE, 'fixture'));

  it('maps paths by first matching glob', () => {
    expect(g.mapPath('api/src/core/orch/bb.ts')?.logical).toBe('L:orch');
    expect(g.mapPath('api/src/core/x.ts')?.logical).toBe('L:core');
    expect(g.mapPath('api/src/routes/y.ts')?.logical).toBe('L:api');
    expect(g.mapPath('web/app/page.tsx')).toBeUndefined();
  });

  it('resolves aliases and containment', () => {
    expect(g.resolve('bb')).toBe('api/src/core/orch/bb.ts');
    expect(g.aliasFor('api/src/core/orch/bb.ts')).toBe('bb');
    expect(g.parentsOf('L:orch')).toEqual(['L:core']);
    expect(g.conceptsOf('L:core')).toEqual(['C:pure']);
  });

  it('excludes retired constraints from the active set', () => {
    expect(g.constraintsOn('L:orch').map((k) => k.id)).toEqual(['orch.events']);
    expect(g.activeConstraint('retired.rule')).toBeUndefined();
    expect(g.isRetired('retired.rule')).toBe(true);
  });

  it('drops superseded decisions and orphaned bases, newest first', () => {
    const ids = g.decisionsOn(['api/src/core/orch/bb.ts', 'L:orch']).map((d) => d.id);
    expect(ids).toEqual(['d-0003', 'd-0002']);
    expect(g.allDecisionsOn('api/src/core/orch/bb.ts').map((d) => d.id)).toEqual(['d-0001', 'd-0002', 'd-0004']);
    expect(g.nextDecisionId()).toBe('d-0005');
  });

  it('validates references', () => {
    const findings = g.validate();
    const rules = findings.map((f) => f.rule);
    expect(rules).toContain('orphaned-basis');
    expect(findings.filter((f) => f.level === 'error')).toHaveLength(0);
  });

  it('reports broken references', () => {
    const bad = Graph.fromRecords(parseText(`
M a/** L:a
L L:a A
K G k.one L:missing text here
D d-0001 2026-01-01 w/c - main a/x.ts ->K k.nope why
D d-0002 2026-01-01 w/c - main a/x.ts ->K k.one !k.one why
S d-0009 d-0001
A dup a/x.ts
A dup a/y.ts
`));
    const rules = bad.validate().map((f) => f.rule).sort();
    expect(rules).toEqual(expect.arrayContaining(['attach', 'arrow-target', 'supersession', 'alias-unique']));
  });

  it('answers a rule\'s why with the decisions that serve or override it, wherever they were recorded', () => {
    const g = Graph.fromRecords(parseText(`
M api/** L:api
L L:api API
K G k.one L:api a rule
K G k.two L:api another
D d-0001 2026-09-01 w/c aaaaaaa main api/a.ts ->K k.one served early
D d-0002 2026-09-08 w/c bbbbbbb main L:api ->K k.one served on the module itself
D d-0003 2026-09-05 w/c ccccccc main api/b.ts ->K k.two !k.one broke it here
S d-0003 d-0001
`, 'g'));
    expect(g.decisionsFor('k.one').map((d) => d.id)).toEqual(['d-0002', 'd-0003']);
    expect(g.decisionsFor('k.one', { includeSuperseded: true }).map((d) => d.id)).toEqual(['d-0002', 'd-0003', 'd-0001']);
    expect(g.decisionsFor('k.two').map((d) => d.id)).toEqual(['d-0003']);
    expect(g.decisionsOn(['k.one'])).toEqual([]);
  });
});
