import { describe, expect, it } from 'vitest';
import {
  bar,
  flaggedByModule,
  grewDecisions,
  importEdges,
  lastDecision,
  overview,
  rulesWords,
  // @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
} from '../../adapters/claude-code/hooks/mod/views/overview.mjs';

type Node = { type: string; props: Record<string, unknown>; children: Node[] | string[] };
const make = (type: string) => (props: Record<string, unknown>): Node => ({ type, props, children: (props.children as Node[]) ?? [] });
const els = { Box: make('Box'), Text: make('Text'), Button: make('Button') };
const texts = (n: Node | string): string[] => (typeof n === 'string' ? [n] : n.type === 'Text' ? (n.children as string[]) : (n.children as Node[]).flatMap(texts));
const keys = (n: Node | string): string[] => (typeof n === 'string' ? [] : [...(n.props.key ? [String(n.props.key)] : []), ...(n.type === 'Text' ? [] : (n.children as Node[]).flatMap(keys))]);

const file = (path: string, card = 'current') => ({ path, card });
const mod = (id: string, depth: number, parents: string[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id.slice(2),
  depth,
  parents,
  rules: { agreed: 1, proposed: 0 },
  ruleList: [],
  imports: [],
  decisions: [],
  files: [file(`${id}/a.ts`), file(`${id}/b.ts`, 'missing')],
  ...extra,
});
// The book editor's shape: src holds domain, application and adapters; adapters holds parsers and db.
const MAP = [
  mod('L:src', 0, []),
  mod('L:domain', 1, ['L:src'], { rules: { agreed: 3, proposed: 1 } }),
  mod('L:application', 1, ['L:src'], { imports: [{ to: 'L:domain', n: 4 }] }),
  mod('L:adapters', 1, ['L:src']),
  mod('L:parsers', 2, ['L:adapters'], { ruleList: [{ id: 'parsers.no-io', text: 'A parser never touches the file system', mode: 'G' }], imports: [{ to: 'L:application', n: 2 }] }),
  mod('L:db', 2, ['L:adapters']),
  mod('L:e2e', 0, []),
];

describe('the Overview (MAP-4): what the graph knows, a row per module', () => {
  const NOW = Date.parse('2026-10-12T12:00:00Z');
  it('a row per module, indented under its parent: files explained, rules, decisions and the last one', () => {
    const map = MAP.map((m) => (m.id === 'L:domain' ? { ...m, decisions: ['2026-10-10', '2026-10-12'] } : m));
    const shown = overview(map, els, { now: NOW }).flatMap(texts);
    expect(shown).toEqual(expect.arrayContaining(['MODULES', '7 modules · 2 decisions; j/k choose one, o opens its files', 'module', 'files explained', 'rules', 'decisions', 'last decision']));
    expect(shown).toContain('    domain');
    expect(shown).toContain('      parsers');
    expect(shown).toContain('  1 of 2   ███░░');
    expect(shown).toContain('3 + 1 proposed');
    expect(shown).toContain('today');
  });

  it('says in words how much is explained, the rules, and when the last decision was', () => {
    expect(bar(0, 4)).toBe('░░░░░');
    expect(bar(4, 4)).toBe('█████');
    expect(rulesWords({ rules: { agreed: 0, proposed: 0 } })).toBe('none');
    expect(rulesWords({ rules: { agreed: 2, proposed: 0 } })).toBe('2');
    expect(lastDecision([], NOW)).toBe('none');
    expect(lastDecision(['2026-10-11'], NOW)).toBe('yesterday');
    expect(lastDecision(['2026-10-01', '2026-10-09'], NOW)).toBe('3 days ago');
  });

  it('CARDW-8 opens on how much is explained and the one thing being done about it, with its button', () => {
    const pressed: string[] = [];
    const explain = { explained: 38, total: 595, line: '550 files queued, written in the background one at a time.', tone: 'waiting', act: 'pause', skipped: 10 };
    const tab = overview(MAP, els, { explain }, { onPauseBackfill: () => pressed.push('pause'), onOfferAgain: () => pressed.push('again') });
    const shown = tab.flatMap(texts);
    expect(shown.slice(0, 4)).toEqual(['FILES EXPLAINED', '38 of 595', '█░░░░░░░░░ 6%', explain.line]);
    expect(shown).toContain("Skipped 10 files that aren't code this session.");
    expect(tab.flatMap(keys)).toEqual(expect.arrayContaining(['explain-pause', 'offer-again']));
    // Only one line says what the card writer is doing: no second, contradicting one.
    expect(shown.filter((t: string) => /queued|Explaining/.test(t))).toEqual([explain.line]);
  });

  it('MAP-4 with only the whole repository as a module, a line in words instead of a one-row table', () => {
    const repo = [{ ...mod('L:repo', 0, []), rules: { agreed: 0, proposed: 1 }, decisions: ['2026-10-12', '2026-10-01'] }];
    const tab = overview(repo, els, { now: NOW, unmapped: ['services', 'packages'] }, { onAddModules: () => {} });
    const shown = tab.flatMap(texts);
    expect(shown).toContain('The graph treats the whole repository as one module, so every rule and decision applies everywhere. Rules: 0 + 1 proposed · 2 decisions, the last today.');
    expect(shown).toContain('Folders with code that could be modules: services, packages.');
    expect(shown).not.toContain('module');
    expect(tab.flatMap(keys)).toContain('add-modules');
  });

  it('finds the modules whose decisions grew between two reads, and the import edges within the map', () => {
    const after = MAP.map((m) => (m.id === 'L:db' ? { ...m, decisions: ['2026-10-10'] } : m));
    expect(grewDecisions(MAP, after)).toEqual(['L:db']);
    expect(grewDecisions(null, after)).toEqual([]);
    expect(importEdges(MAP)).toEqual([
      { from: 'L:application', to: 'L:domain', n: 4 },
      { from: 'L:parsers', to: 'L:application', n: 2 },
    ]);
  });
  it("shows the selected module's detail: its rules, imports, an overridden rule's text and proposal, and counts its proposals for their tab", () => {
    const tab = overview(
      MAP,
      els,
      {
        selected: 4,
        flagged: [{ rule: 'parsers.no-io', evidence: ['d-1', 'd-2'], proposal: 'Reword: a parser reads the bytes it is given.' }],
        proposals: [{ id: 'parsers.bytes', module: 'L:parsers', text: 'A parser reads only the bytes it is given' }, { id: 'other', module: 'L:db', text: 'x' }],
      },
    );
    const shown = tab.flatMap(texts);
    expect(shown).toEqual(expect.arrayContaining(['parsers (L:parsers)', 'uses application', 'rule: A parser never touches the file system', 'parsers.no-io overridden 2×', 'A parser never touches the file system', 'Reword: a parser reads the bytes it is given.']));
    expect(shown).toContain('1 proposed rule on it, in Rules to review (3)');
    // Accepting is done in Rules to review, not here too.
    expect(tab.flatMap(keys).filter((k: string) => k.startsWith('graph-accept'))).toEqual([]);
  });
});
