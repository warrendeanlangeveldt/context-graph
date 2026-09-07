import { describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import { renderSlice } from './slice.js';
import { demandsDecision, walk } from './walk.js';

const FIXTURE = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
M api/src/**           L:api
L L:orch Orchestration
L L:core Engine
L L:api  API
C C:pure Engine never depends on impls adr:0012
C C:agnostic Every mechanism generalises
E L:orch in L:core
E L:core in L:api
E L:core impl C:pure
E L:api impl C:agnostic
K G orch.events  L:orch  state via events only
K E boundary.core L:core core never imports impls test:api/boundary.test.ts
K R history.note L:api   an old note
K G? proposed.one L:orch a proposed rule
K G file.rule api/src/core/orch/bb.ts this file must stay small
K G sym.rule api/src/core/orch/bb.ts#applyEvent applyEvent must be idempotent
D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first
D d-0002 2026-08-02 w/c bbbb main api/src/core/orch/bb.ts ->K orch.events second
D d-0003 2026-08-03 w/c - feature/x L:orch ->C pure module level
D d-0004 2026-08-04 w/c cccc main api/src/core/orch/bb.ts ->K file.rule !orch.events fourth with override
D d-0005 2026-08-05 w/c dddd main api/src/core/orch/bb.ts ->K file.rule fifth
A bb api/src/core/orch/bb.ts
`;

describe('walk', () => {
  const g = Graph.fromRecords(parseText(FIXTURE, 'fixture'));

  it('builds the chain, concepts, and ordered constraints', () => {
    const w = walk(g, 'api/src/core/orch/bb.ts');
    expect(w.chain).toEqual(['L:orch', 'L:core', 'L:api']);
    expect(w.concepts).toEqual(['C:pure', 'C:agnostic']);
    expect(w.nodes).toEqual(['api/src/core/orch/bb.ts', 'L:orch', 'L:core', 'L:api', 'C:pure', 'C:agnostic']);
    expect(w.constraints.map((k) => k.id)).toEqual(['file.rule', 'orch.events', 'proposed.one', 'boundary.core', 'history.note']);
    expect(w.mapped).toBe(true);
    expect(demandsDecision(w)).toBe(true);
  });

  it('includes symbol-level nodes and resolves aliases', () => {
    const w = walk(g, 'bb', { symbol: 'applyEvent' });
    expect(w.path).toBe('api/src/core/orch/bb.ts');
    expect(w.nodes[0]).toBe('api/src/core/orch/bb.ts#applyEvent');
    expect(w.constraints[0]?.id).toBe('sym.rule');
  });

  it('caps decisions newest first', () => {
    const w = walk(g, 'bb', { maxDecisions: 2 });
    expect(w.decisions.map((d) => d.id)).toEqual(['d-0005', 'd-0004']);
    expect(walk(g, 'bb').decisions.map((d) => d.id)).toEqual(['d-0005', 'd-0004', 'd-0003', 'd-0002']);
  });

  it('reports unmapped paths without constraints', () => {
    const w = walk(g, 'web/app/page.tsx');
    expect(w.mapped).toBe(false);
    expect(w.chain).toEqual([]);
    expect(w.constraints).toEqual([]);
    expect(demandsDecision(w)).toBe(false);
  });
});

describe('renderSlice', () => {
  const g = Graph.fromRecords(parseText(FIXTURE, 'fixture'));

  it('renders in fixed order with modes and provenance', () => {
    const s = renderSlice(g, walk(g, 'bb'));
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('edit bb');
    expect(lines[1]).toBe('  chain  L:orch > L:core > L:api  impl C:pure C:agnostic');
    expect(lines[2]).toBe('  must   core never imports impls  [E boundary.core]');
    expect(lines[3]).toBe('  must   this file must stay small  [G file.rule]');
    expect(lines[4]).toBe('  must   state via events only  [G orch.events]');
    expect(lines[5]).toBe('  must?  a proposed rule  [G? proposed.one proposed]');
    expect(lines[6]).toBe('  note   an old note  [R history.note]');
    expect(lines[7]).toBe('  last   d-0005 08-05 w/c  fifth  (dddd)');
    expect(lines[8]).toBe('  last   d-0004 08-04 w/c  !orch.events  fourth with override  (cccc)');
    expect(lines[9]).toBe('  last   d-0003 08-03 w/c  module level  (feature/x provisional)');
    expect(s.tokens).toBeGreaterThan(50);
    expect(s.dropped).toEqual([]);
  });

  it('drops hints, then oldest decisions, then notes under budget, never must lines', () => {
    const w = walk(g, 'bb');
    const s = renderSlice(g, w, { maxTokens: 90, hints: ['docs/x.md 0.8 "envelope debate"'] });
    expect(s.dropped[0]).toMatch(/^hint:/);
    expect(s.text).not.toContain('hint');
    expect(s.text).toContain('[E boundary.core]');
    expect(s.text).toContain('[G orch.events]');
    expect(s.text.split('\n').filter((l) => l.startsWith('  last')).length).toBeLessThan(4);
    const tiny = renderSlice(g, w, { maxTokens: 10 });
    expect(tiny.warnings).toHaveLength(1);
    expect(tiny.text).toContain('[E boundary.core]');
  });

  it('says so when nothing maps', () => {
    const s = renderSlice(g, walk(g, 'web/app/page.tsx'));
    expect(s.text).toBe('edit web/app/page.tsx\n  chain  (no mapping covers this path)');
  });
});
