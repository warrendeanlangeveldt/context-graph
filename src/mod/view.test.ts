import { describe, expect, it } from 'vitest';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { NO_GRAPH, bandLine, contextPane, followedPath } from '../../adapters/claude-code/hooks/mod/view.mjs';

/** Stand-ins for the elements `$.ui.resolve` gives the mod. */
type Node = { type: string; props: Record<string, unknown>; children: Node[] | string[] };
const make = (type: string) => (props: Record<string, unknown>): Node => ({ type, props, children: (props.children as Node[]) ?? [] });
const els = { Box: make('Box'), Text: make('Text'), Button: make('Button'), Input: make('Input') };
const texts = (n: Node | string): string[] => (typeof n === 'string' ? [n] : n.type === 'Text' ? (n.children as string[]) : (n.children as Node[]).flatMap(texts));
const keys = (n: Node | string): string[] => (typeof n === 'string' ? [] : [...(n.props.key ? [String(n.props.key)] : []), ...(n.type === 'Text' ? [] : (n.children as Node[]).flatMap(keys))]);
const none = { onRatify: () => {}, onDrop: () => {}, onLanes: () => {} };

const file = {
  path: 'src/a.ts',
  chain: ['L:src', 'L:repo'],
  card: { text: 'Holds a.', fresh: true },
  rules: [
    { id: 'src.pure', mode: 'G', text: 'no side effects', test: null },
    { id: 'src.typed', mode: 'G', text: 'typed exports', test: 'node t.mjs' },
  ],
  decisions: [{ id: 'd-0003', date: '2026-10-03', who: 'warren/claude', text: 'keep a constant' }],
  understood: { ok: false, missing: [{ path: 'src/b.ts', why: 'imported' }] },
  tools: { lines: [], requirements: [] },
};

describe('the Context Graph mod: what it draws', () => {
  it('FILE-1 follows files inside the repository, by the tools that read and write them', () => {
    expect(followedPath({ tool: 'Read', file_path: '/repo/src/a.ts' }, '/repo')).toBe('src/a.ts');
    expect(followedPath({ tool: 'Edit', file_path: '/repo/src/b.ts' }, '/repo/')).toBe('src/b.ts');
    expect(followedPath({ tool: 'Read', file_path: '/elsewhere/x.ts' }, '/repo')).toBeNull();
    expect(followedPath({ tool: 'Bash', command: 'cat src/a.ts' }, '/repo')).toBeNull();
  });

  it('FILE-2 and FILE-3 show the card, rules, chain, decisions and what is still to read', () => {
    const shown = texts(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: 'web-engineer' }, file, proposals: [], agents: [] }, els, none));
    expect(shown).toEqual(expect.arrayContaining(['FILE', 'last touched by web-engineer', 'Path', 'src/a.ts']));
    expect(shown).toContain('Holds a.');
    expect(shown).toEqual(expect.arrayContaining(['src.pure', 'no side effects', '(guidance)', 'src.typed', '(enforced)']));
    expect(shown).toContain('L:src › L:repo');
    expect(shown).toContain('2026-10-03  keep a constant  (warren/claude)');
    expect(shown).toContain('✗ not yet: still to read src/b.ts');
    const bare = texts(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file: { ...file, card: null, decisions: [] }, proposals: [], agents: [] }, els, none));
    expect(bare).toContain('No card yet. /context-graph:cards writes one.');
    expect(bare).toContain('last touched by the main session');
    expect(bare).toContain('none recorded yet');
  });

  it('FILE-4 shows what code-kit says of the file, with Lanes, only when code-kit is there', () => {
    const withKit = { ...file, tools: { lines: ['code-kit  lane web · layer ui · WEB-1'], requirements: ['WEB-1'] } };
    const pane = contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file: withKit, proposals: [], agents: [] }, els, none);
    expect(texts(pane)).toContain('lane web · layer ui · WEB-1');
    expect(keys(pane)).toContain('open-lanes');
    expect(keys(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file, proposals: [], agents: [] }, els, none))).not.toContain('open-lanes');
  });

  it('FILE-5 without a graph it says how to start one', () => {
    expect(texts(contextPane({ kind: 'none' }, els, none))).toEqual([NO_GRAPH]);
    expect(NO_GRAPH).toBe('No graph here yet: run /context-graph:init');
  });

  it('RAT-1 and RAT-2 list proposals with their evidence, and count them for the band', () => {
    const proposals = [
      { id: 'src.small', kind: 'guidance', module: 'L:src', text: 'keep modules small', served: 3, overridden: 1, violations: null },
      { id: 'C:events', kind: 'concepts', module: null, text: 'Change goes through events', served: 0, overridden: 0, violations: null },
    ];
    const pane = contextPane({ kind: 'graph', followed: null, file: null, proposals, agents: [] }, els, none);
    expect(texts(pane)).toContain('Evidence: served by 3 decisions, overridden by 1 decision');
    expect(texts(pane)).toContain('Evidence: no decision has cited it yet');
    expect(texts(pane)).toContain('rule (guidance) on L:src');
    expect(keys(pane)).toEqual(expect.arrayContaining(['ratify-src.small', 'drop-src.small', 'ratify-C:events']));
    expect(bandLine(proposals)).toEqual({ text: '2 proposals to ratify' });
    expect(bandLine([])).toBeNull();
  });

  it('COV-1 and COV-3 give each agent its counts, and mark an edit made without understanding', () => {
    const agents = [
      { agent: 'main', agentType: null, read: ['a', 'b'], searched: [], edited: [], cardsOwed: [] },
      {
        agent: 'agent-1',
        agentType: 'web-engineer',
        read: ['a', 'b', 'c', 'd'],
        searched: ['e', 'f', 'g'],
        edited: [
          { path: 'src/a.ts', understood: true, missing: [] },
          { path: 'src/c.ts', understood: false, missing: ['src/d.ts', 'src/e.ts'] },
        ],
        cardsOwed: ['src/a.ts'],
      },
    ];
    const shown = texts(contextPane({ kind: 'graph', followed: null, file: null, proposals: [], agents }, els, none));
    expect(shown).toEqual(expect.arrayContaining(['agent', 'read', 'searched', 'edited', 'cards owed']));
    const row = (who: string) => shown.slice(shown.indexOf(who), shown.indexOf(who) + 5);
    expect(row('web-engineer')).toEqual(['web-engineer', '4', '3', '2', '1']);
    expect(row('main session')).toEqual(['main session', '2', '0', '0', '0']);
    expect(shown).toContain('✓ web-engineer edited src/a.ts, understood first');
    expect(shown).toContain('✗ web-engineer edited src/c.ts without understanding it: src/d.ts, src/e.ts unread');
  });
});
