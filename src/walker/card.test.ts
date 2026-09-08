import { describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import { renderCard } from './card.js';
import { demandsDecision, walk } from './walk.js';

const GRAPH = `
M api/src/core/** L:core
L L:core Engine
C C:pure Engine never depends on impls
E L:core impl C:pure
K E core.pure L:core core never imports integrations or teams; integrations never import teams test:api/boundary.test.ts
K G core.reuse L:core extend the existing credential, tool-registry, LLM-config, blackboard, or Dapr layer before adding a parallel one
K G? core.guess-one L:core a proposed rule with a fairly long explanatory text so that it costs tokens to carry around
K G? core.guess-two L:core another proposed rule with a fairly long explanatory text so that it costs tokens to carry around
K R core.note L:core a note that never appears on a card
`;

describe('who owes a decision', () => {
  const G = `
M api/src/core/** L:core
M web/** L:web
M ** L:repo
L L:core Engine
L L:web Web
L L:repo Repo
E L:core in L:repo
E L:web in L:repo
K G? repo.global L:repo a bootstrap guess pinned to the root
K G? core.local L:core a proposal about the engine
K E core.pure L:core enforced test:api/src/core/pure.test.ts
`;
  it('a root-pinned proposal taxes nobody; a module proposal asks; a test file owes nothing unless it enforces a rule', () => {
    const g = Graph.fromRecords(parseText(G, 'd'));
    expect(demandsDecision(walk(g, 'web/page.tsx'))).toBe(false);
    expect(demandsDecision(walk(g, 'api/src/core/x.ts')).toBe(true);
    expect(demandsDecision(walk(g, 'api/src/core/x.test.ts')).toBe(false);
    expect(demandsDecision(walk(g, 'api/src/core/pure.test.ts')).toBe(true);
  });
});

describe('module card', () => {
  it('names the module, lists rules enforced first, and points at hydrate', () => {
    const g = Graph.fromRecords(parseText(GRAPH, 'card'));
    const card = renderCard(g, walk(g, 'api/src/core/x.ts'), { maxTokens: 400 })!;
    const lines = card.text.split('\n');
    expect(lines[0]).toBe('module L:core  Engine  impl C:pure');
    expect(lines[1]).toContain('[E core.pure]');
    expect(lines[2]).toContain('[G core.reuse]');
    expect(lines[3]).toContain('[G? core.guess-one proposed]');
    expect(card.text).not.toContain('core.note');
    expect(lines[lines.length - 1]).toBe('  hydrate L:core for callers, history, and what this session already holds');
    expect(card.dropped).toEqual([]);
  });

  it('under budget drops proposed rules first, then guided text, and never the enforced rule', () => {
    const g = Graph.fromRecords(parseText(GRAPH, 'card'));
    const card = renderCard(g, walk(g, 'api/src/core/x.ts'), { maxTokens: 60 })!;
    expect(card.dropped).toEqual(['proposed', 'proposed', 'guided text']);
    expect(card.text).toContain('core never imports integrations or teams');
    expect(card.text).toContain('  must   [G core.reuse]');
    expect(card.text).not.toContain('guess-one');
  });
});
