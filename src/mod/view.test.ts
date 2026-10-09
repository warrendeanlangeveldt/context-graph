import { describe, expect, it } from 'vitest';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { NO_GRAPH, contextPane, followedPath } from '../../adapters/claude-code/hooks/mod/view.mjs';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { DEFAULT_UI, bandHealth, closeGoesBack, healthOf, moved } from '../../adapters/claude-code/hooks/mod/views/frame.mjs';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { queueOrder, spark } from '../../adapters/claude-code/hooks/mod/views/proposals.mjs';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { progressText, readingList, readingMessage } from '../../adapters/claude-code/hooks/mod/views/assist.mjs';
import { describeMissing } from '../enforce/read-before-edit.js';
// @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
import { cardJobs, cardWriterLine, pausedAt } from '../../adapters/claude-code/hooks/mod/card-writer.mjs';

/** Stand-ins for the elements `$.ui.resolve` gives the mod. */
type Node = { type: string; props: Record<string, unknown>; children: Node[] | string[] };
const make = (type: string) => (props: Record<string, unknown>): Node => ({ type, props, children: (props.children as Node[]) ?? [] });
const els = { Box: make('Box'), Text: make('Text'), Button: make('Button'), Input: make('Input') };
const texts = (n: Node | string): string[] => (typeof n === 'string' ? [n] : n.type === 'Text' ? (n.children as string[]) : (n.children as Node[]).flatMap(texts));
const keys = (n: Node | string): string[] => (typeof n === 'string' ? [] : [...(n.props.key ? [String(n.props.key)] : []), ...(n.type === 'Text' ? [] : (n.children as Node[]).flatMap(keys))]);
const none = { onRatify: () => {}, onDrop: () => {}, onLanes: () => {}, onWriteCard: () => {}, onModuleCards: () => {} };

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
    expect(shown).toEqual(expect.arrayContaining([' guidance ', 'src.pure', 'no side effects', ' enforced ', 'src.typed']));
    expect(shown).toContain('L:src › L:repo');
    expect(shown).toContain('2026-10-03  keep a constant  (warren/claude)');
    expect(shown).toContain('✗ not yet: still to read src/b.ts');
    const bare = texts(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file: { ...file, card: null, decisions: [] }, proposals: [], agents: [] }, els, none));
    expect(bare).toContain('No card yet.');
    const bareKeys = keys(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file: { ...file, card: null }, proposals: [], agents: [] }, els, none));
    expect(bareKeys).toEqual(expect.arrayContaining(['write-card', 'module-cards']));
    const current = keys(contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file, proposals: [], agents: [] }, els, none));
    expect(current).not.toContain('write-card');
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
    const pane = contextPane({ kind: 'graph', followed: null, file: null, proposals, agents: [], ui: { ...DEFAULT_UI, tab: 'proposals' } }, els, none);
    expect(texts(pane)).toContain('Evidence: served by 3 decisions, overridden by 1 decision');
    expect(texts(pane)).toContain('Evidence: no decision has cited it yet');
    expect(texts(pane)).toContain('rule (guidance) on L:src');
    expect(keys(pane)).toEqual(expect.arrayContaining(['ratify-src.small', 'drop-src.small', 'ratify-C:events']));
    expect(bandHealth(healthOf({ proposals: proposals.length }))).toEqual({ text: '☀ 0 owed · 2 proposals', color: 'green' });
    expect(bandHealth(healthOf({ proposals: 0 }))).toBeNull();
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
    const shown = texts(contextPane({ kind: 'graph', followed: null, file: null, proposals: [], agents, ui: { ...DEFAULT_UI, tab: 'coverage' } }, els, none));
    expect(shown).toEqual(expect.arrayContaining(['agent', 'read', 'searched', 'edited', 'cards owed']));
    const row = (who: string) => shown.slice(shown.indexOf(who), shown.indexOf(who) + 5);
    expect(row('web-engineer')).toEqual(['web-engineer', '4', '3', '2', '1']);
    expect(row('main session')).toEqual(['main session', '2', '0', '0', '0']);
    expect(shown).toContain('✓ web-engineer edited src/a.ts, understood first');
    expect(shown).toContain('✗ web-engineer edited src/c.ts without understanding it: src/d.ts, src/e.ts unread');
  });

  it("VIEW-1 the graph's health: the carded share, owed cards, proposals and overridden rules, as a glyph and a colour", () => {
    const cards = { fresh: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], stale: ['j'], missing: [] };
    expect(healthOf({ cards, owed: 0, proposals: 0 })).toMatchObject({ carded: 90, level: 'good', text: '☀ 90% carded · 0 owed · 0 proposals' });
    expect(healthOf({ cards, owed: 1, proposals: 1 })).toMatchObject({ level: 'amber', glyph: '⛅' });
    expect(healthOf({ cards: { fresh: ['a'], stale: ['b'], missing: [] }, owed: 0 })).toMatchObject({ carded: 50, level: 'amber' });
    expect(healthOf({ cards, owed: 5 })).toMatchObject({ level: 'red', glyph: '⛈' });
    expect(healthOf({ cards, flagged: 3 }).text).toBe('⛈ 90% carded · 0 owed · 0 proposals · 3 rules overridden');
    expect(bandHealth(healthOf({ cards, owed: 0, proposals: 0 }))).toBeNull();
    expect(bandHealth(healthOf({ cards, owed: 2 }))).toEqual({ text: '⛅ 90% carded · 2 owed · 0 proposals', color: 'yellow' });
  });

  it('VIEW-5 j/k move from nothing selected, and Escape goes back while there is somewhere to go', () => {
    expect(moved(-1, 1, 3)).toBe(0);
    expect(moved(-1, -1, 3)).toBe(2);
    expect(moved(2, 1, 3)).toBe(0);
    expect(moved(0, 1, 0)).toBe(-1);
    const person = { id: 'context-graph', origin: { kind: 'person' } };
    expect(closeGoesBack(person, 'context-graph', { back: [{ tab: 'coverage', selected: 1 }] })).toBe(true);
    expect(closeGoesBack(person, 'context-graph', { back: [] })).toBe(false);
    expect(closeGoesBack({ ...person, origin: { kind: 'plugin' } }, 'context-graph', { back: [{}] })).toBe(false);
  });

  it('VIEW-2 the card as Markdown, the rules as coloured chips, and the neighbourhood with uncarded and rule-breaking files marked', () => {
    const md = { ...els, Markdown: make('Markdown') };
    const near = {
      path: 'src/a.ts',
      card: 'current',
      breaks: [],
      imports: [
        { path: 'src/b.ts', card: 'stale', breaks: [] },
        { path: 'lib/c.ts', card: 'missing', breaks: ['src.no-lib'] },
      ],
      importers: [{ path: 'src/d.ts', card: 'current', breaks: [] }],
    };
    const pane = contextPane({ kind: 'graph', followed: { path: 'src/a.ts', agentType: null }, file, proposals: [], agents: [], neighbours: near }, md, none);
    const find = (n: Node | string, pred: (x: Node) => boolean): Node | undefined =>
      typeof n === 'string' ? undefined : pred(n) ? n : (n.children as Node[]).map((c) => find(c, pred)).find(Boolean);
    expect(find(pane, (n) => n.type === 'Markdown')?.props.text).toBe('Holds a.');
    expect(find(pane, (n) => n.type === 'Text' && (n.children as string[])[0] === ' enforced ')?.props.backgroundColor).toBe('red');
    const labels = (find(pane, (n) => n.props.key === 'neighbours') as Node);
    const buttons: string[] = [];
    const walk = (n: Node | string) => { if (typeof n === 'string') return; if (n.type === 'Button') buttons.push(String(n.props.label)); (n.children as Node[]).forEach(walk); };
    walk(labels);
    expect(buttons).toEqual(['◐ src/b.ts', '○ lib/c.ts ✗ src.no-lib', '● src/d.ts']);
  });

  it('VIEW-3 a sparkline of decisions a week a bar, and deferred proposals at the back of the queue', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    expect(spark([], now)).toBe('▁▁▁▁▁▁▁▁');
    expect(spark(['2026-10-09', '2026-10-08', '2026-10-01', '2026-06-01'], now)).toBe('▁▁▁▁▁▁▅█');
    expect(spark(['2026-09-01'], now, 8)).toBe('▁▁█▁▁▁▁▁');
    const ps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(queueOrder(ps, new Set(['a'])).map((p: { id: string }) => p.id)).toEqual(['b', 'c', 'a']);
  });

  it("ASSIST-1 and ASSIST-2 the reading list read from the hooks' own refusal, the message, and the progress", () => {
    const refusal = describeMissing(
      [{ path: 'src/a.ts', missing: [{ path: 'src/b.ts', rule: 'read-before-edit', why: 'it has no card yet, so read it in full' }, { path: 'src/c.ts', rule: 'dependencies', why: 'imported; it has no fresh card, so read it in full' }], uncheckedImporters: 0 }] as never,
      ['read-before-edit', 'dependencies'],
    );
    const list = readingList(`PreToolUse:Edit hook error: ${refusal}`);
    expect(list).toEqual({ edit: 'src/a.ts', files: ['src/b.ts', 'src/c.ts'] });
    expect(readingMessage(list)).toBe('Read src/b.ts and src/c.ts in full, then edit src/a.ts again.');
    expect(readingMessage({ edit: 'x.ts', files: ['y.ts'] })).toBe('Read y.ts in full, then edit x.ts again.');
    expect(progressText(list, null)).toBe('0 of 2 read');
    expect(progressText(list, ['src/c.ts'])).toBe('1 of 2 read');
    expect(progressText(list, [])).toBe('understood');
    expect(readingList('Context Graph: something else')).toBeNull();
  });

  it('CARDW-1, CARDW-4 and CARDW-5 the card jobs in order, a moving file waiting, and the pause point', () => {
    const now = 10 * 60000;
    const jobs = cardJobs({ asked: ['src/x.ts'], owed: ['src/a.ts', 'src/x.ts'], changed: ['src/b.ts', 'src/a.ts', 'src/c.ts'], editedAt: { 'src/c.ts': now - 60000, 'src/b.ts': now - 3 * 60000 }, now });
    expect(jobs).toEqual([
      { path: 'src/x.ts', reason: 'asked' },
      { path: 'src/a.ts', reason: 'owed' },
      { path: 'src/b.ts', reason: 'changed' },
    ]);
    expect(pausedAt([{ kind: 'five_hour', percentUsed: 81 }], 80)).toEqual({ percent: 81, paused: true });
    expect(pausedAt([{ kind: 'five_hour', percentUsed: 80 }], 80).paused).toBe(false);
    expect(pausedAt([], 80)).toEqual({ percent: null, paused: false });
    expect(cardWriterLine({ on: false })).toMatch(/^Card writer: off/);
    expect(cardWriterLine({ on: true, paused: true, percent: 82 })).toBe('Card writer: paused, the plan at 82%');
    expect(cardWriterLine({ on: true, writing: ['a', 'b', 'c', 'd'], waiting: ['e'] })).toBe('Card writer: writing 4 (a, b, c, …), 1 waiting');
    expect(cardWriterLine({ on: true, waiting: ['e'] })).toBe('Card writer: 1 waiting for the lead to be idle');
  });
});
