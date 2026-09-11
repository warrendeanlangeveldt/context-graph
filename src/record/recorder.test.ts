import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { SessionState } from '../observe/store.js';
import { walk } from '../walker/walk.js';
import { RecordError, Recorder } from './recorder.js';

const GRAPH = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
M api/src/other/**     L:other
L L:orch Orchestration
L L:core Engine
L L:other Other
C C:pure Engine never depends on impls
E L:orch in L:core
E L:core impl C:pure
K G orch.events L:orch state via events only
K E boundary.core L:core never imports impls test:api/boundary.test.ts
K G other.rule L:other something about other
M api/src/fresh/** L:fresh
L L:fresh Freshly bootstrapped
K G? fresh.proposed L:fresh a rule the bootstrap guessed
`;

describe('Recorder', () => {
  let dir: string;
  let home: string;
  const prevHome = process.env.CTX_HOME;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-graph-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    writeFileSync(join(dir, 'graph.ctx'), GRAPH);
    writeFileSync(join(dir, 'api-boundary.test.ts'), '');
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.CTX_HOME; else process.env.CTX_HOME = prevHome;
  });

  const setup = (): { g: Graph; r: Recorder; state: SessionState } => {
    const g = Graph.load(dir);
    const state = new SessionState(dir, 's1');
    return { g, r: new Recorder(g, state), state };
  };

  it('tracks pending only for constrained nodes', () => {
    const { g, r } = setup();
    expect(r.notePending(walk(g, 'api/src/core/orch/bb.ts'))).toBe(true);
    expect(r.notePending(walk(g, 'web/page.tsx'))).toBe(false);
    expect(r.pending().map((p) => p.path)).toEqual(['api/src/core/orch/bb.ts']);
    expect(r.pending()[0]?.constraints).toEqual(['orch.events', 'boundary.core']);
  });

  it('asks for a decision under a proposed rule too, and says why', () => {
    const { g, r } = setup();
    expect(r.notePending(walk(g, 'api/src/fresh/thing.ts'))).toBe(true);
    const verdict = r.stopDecision({ maxBlocks: 2, who: 'w/claude', branch: 'main' });
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain('api/src/fresh/thing.ts  [+1 proposed]');
    expect(verdict.reason).toContain('These rules are proposed, not yet ratified.');
  });

  it('a decision recorded by another process on the same path settles the debt before the turn-end demand', () => {
    const { g, r, state } = setup();
    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    expect(r.pending().map((p) => p.path)).toEqual(['api/src/core/orch/bb.ts']);
    // Another process (the MCP server, a shell command) appends to the same decisions file and this hook's graph reloads it.
    const other = new Recorder(Graph.load(g.dir), new SessionState(state.root, 'other-session'));
    other.record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', text: 'recorded elsewhere', who: 'w/claude', branch: 'main' });
    const fresh = new Recorder(Graph.load(g.dir), state);
    expect(fresh.pending()).toEqual([]);
    expect(fresh.stopDecision({ maxBlocks: 2, who: 'w/claude', branch: 'main' })).toMatchObject({ block: false, gaveUp: [] });
  });

  it('asks once on the next call, names ratified rules and counts proposals, and stops asking once recorded', () => {
    const { g, r } = setup();
    expect(r.nudge()).toBeUndefined();
    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    const first = r.nudge()!;
    expect(first).toContain('a file you edited carries rules and owes a decision');
    expect(first).toContain('api/src/core/orch/bb.ts  [orch.events, boundary.core]');
    expect(first).toContain('Record it now with the `record` tool');
    // Asked once for the same set, not on every tool call.
    expect(r.nudge()).toBeUndefined();
    // A new file joins the set, so the ask is made again.
    r.notePending(walk(g, 'api/src/other/thing.ts'));
    expect(r.nudge()).toContain('2 files you edited carry rules');
    r.record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', text: 'why', who: 'w/c', branch: 'main' });
    r.record({ node: 'api/src/other/thing.ts', serves: 'other.rule', text: 'why', who: 'w/c', branch: 'main' });
    expect(r.nudge()).toBeUndefined();
  });

  it('records a decision, appends it, and clears pending', () => {
    const { g, r } = setup();
    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    const res = r.record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', text: 'purge  guard\nadded', who: 'w/c', branch: 'feature/x' });
    expect(res.decision).toMatchObject({ id: 'd-0001', serves: 'orch.events', sha: '-', branch: 'feature/x', text: 'purge guard added' });
    expect(res.outsideApplicable).toBe(false);
    expect(readFileSync(join(dir, 'decisions.ctx'), 'utf8')).toContain('D d-0001');
    expect(r.pending()).toEqual([]);
    const again = Graph.load(dir);
    expect(again.decisionsOn(['api/src/core/orch/bb.ts'])[0]?.id).toBe('d-0001');
    expect(again.nextDecisionId()).toBe('d-0002');
  });

  it('accepts a concept target without its prefix', () => {
    const { r } = setup();
    const res = r.record({ node: 'api/src/core/orch/bb.ts', serves: 'pure', text: 'kept the engine pure', who: 'w/c', branch: 'main' });
    expect(res.decision.serves).toBe('C:pure');
  });

  it('rejects unknown targets with the applicable list, and overrides of enforced constraints', () => {
    const { r } = setup();
    expect(() => r.record({ node: 'api/src/core/orch/bb.ts', serves: 'nope', text: 'x', who: 'w/c', branch: 'main' })).toThrow(RecordError);
    try {
      r.record({ node: 'api/src/core/orch/bb.ts', serves: 'nope', text: 'x', who: 'w/c', branch: 'main' });
    } catch (e) {
      expect((e as RecordError).applicable).toContain('orch.events');
    }
    expect(() => r.record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', overrides: 'boundary.core', text: 'x', who: 'w/c', branch: 'main' })).toThrow(/enforced/);
  });

  it('proposes an edge when the arrow reaches outside the applicable set', () => {
    const { r } = setup();
    const res = r.record({ node: 'api/src/core/orch/bb.ts', serves: 'other.rule', text: 'reached across', who: 'w/c', branch: 'main' });
    expect(res.outsideApplicable).toBe(true);
    expect(res.proposedEdge).toMatchObject({ from: 'L:orch', rel: 'dep', to: 'L:other', proposed: true });
    expect(readFileSync(join(dir, 'proposals.ctx'), 'utf8')).toBe('E L:orch dep L:other proposed\n');
  });

  it('blocks at turn end until decisions are recorded, then gives up with no-decision records', () => {
    const { g, r } = setup();
    const who = 'w/c';
    expect(r.stopDecision({ maxBlocks: 2, who, branch: 'main' })).toMatchObject({ block: false, gaveUp: [] });

    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    const first = r.stopDecision({ maxBlocks: 2, who, branch: 'main' });
    expect(first.block).toBe(true);
    expect(first.reason).toContain('api/src/core/orch/bb.ts');
    expect(first.reason).toContain('orch.events');

    const second = r.stopDecision({ maxBlocks: 2, who, branch: 'main' });
    expect(second.block).toBe(true);

    const third = r.stopDecision({ maxBlocks: 2, who, branch: 'main' });
    expect(third.block).toBe(false);
    expect(third.gaveUp).toHaveLength(1);
    expect(third.gaveUp[0]?.text).toMatch(/^no-decision: unrecorded after 3 prompts/);
    expect(r.pending()).toEqual([]);
  });

  it('honours the harness re-entry flag', () => {
    const { g, r } = setup();
    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    expect(r.stopDecision({ maxBlocks: 2, who: 'w/c', branch: 'main' }).block).toBe(true);
    expect(r.stopDecision({ maxBlocks: 2, who: 'w/c', branch: 'main', stopHookActive: true }).block).toBe(false);
  });

  it('a recorded decision clears the block', () => {
    const { g, r } = setup();
    r.notePending(walk(g, 'api/src/core/orch/bb.ts'));
    expect(r.stopDecision({ maxBlocks: 2, who: 'w/c', branch: 'main' }).block).toBe(true);
    r.record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', text: 'done', who: 'w/c', branch: 'main' });
    expect(r.stopDecision({ maxBlocks: 2, who: 'w/c', branch: 'main' }).block).toBe(false);
  });
});
