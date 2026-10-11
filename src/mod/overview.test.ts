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
    expect(shown).toEqual(expect.arrayContaining(['WHAT IT KNOWS', '7 modules · 14 files', 'module', 'files explained', 'rules', 'decisions', 'last decision']));
    expect(shown).toContain('    domain');
    expect(shown).toContain('      parsers');
    expect(shown).toContain('  1 of 2   ███░░');
    expect(shown).toContain('3 + 1 proposed');
    expect(shown).toContain('today');
    expect(shown).toContain('j/k choose a module; Enter lists its files.');
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

  it("shows what's being written now, under the table", () => {
    const shown = overview(MAP, els, { working: [els.Text({ children: ['Card writer: explaining 2 files (a.ts, b.ts)'] })] }).flatMap(texts);
    expect(shown).toEqual(expect.arrayContaining(['WORKING NOW', 'Card writer: explaining 2 files (a.ts, b.ts)']));
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
  it("shows the selected module's detail: its rules, imports, an overridden rule's text and proposal, and its proposals' acts", () => {
    const acted: string[] = [];
    const tab = overview(
      MAP,
      els,
      {
        selected: 4,
        flagged: [{ rule: 'parsers.no-io', evidence: ['d-1', 'd-2'], proposal: 'Reword: a parser reads the bytes it is given.' }],
        proposals: [{ id: 'parsers.bytes', module: 'L:parsers', text: 'A parser reads only the bytes it is given' }, { id: 'other', module: 'L:db', text: 'x' }],
      },
      { onRatify: (p: { id: string }) => acted.push(`accept ${p.id}`), onDrop: () => {}, onDefer: () => {} },
    );
    const shown = tab.flatMap(texts);
    expect(shown).toEqual(expect.arrayContaining(['parsers (L:parsers)', 'uses application', 'rule: A parser never touches the file system', 'parsers.no-io overridden 2×', 'A parser never touches the file system', 'Reword: a parser reads the bytes it is given.']));
    const k = tab.flatMap(keys);
    expect(k).toEqual(expect.arrayContaining(['graph-accept-parsers.bytes', 'graph-reject-parsers.bytes', 'graph-later-parsers.bytes']));
    expect(k).not.toContain('graph-accept-other');
  });
});
