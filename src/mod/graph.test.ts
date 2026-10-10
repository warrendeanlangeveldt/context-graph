import { describe, expect, it } from 'vitest';
import {
  containmentEdges,
  countsLine,
  flaggedByModule,
  graphGrid,
  graphLayout,
  graphSvg,
  grewDecisions,
  importEdges,
  moduleGraph,
  // @ts-expect-error: the mod is plain JavaScript beside the bundled CLI, outside the TypeScript build
} from '../../adapters/claude-code/hooks/mod/views/graph.mjs';

type Node = { type: string; props: Record<string, unknown>; children: Node[] | string[] };
const make = (type: string) => (props: Record<string, unknown>): Node => ({ type, props, children: (props.children as Node[]) ?? [] });
const els = { Box: make('Box'), Text: make('Text'), Button: make('Button'), Svg: make('Svg') };
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

describe('the module graph (MAP-4)', () => {
  it('lays modules out by depth, a child no higher than its parent, with no two nodes overlapping', () => {
    const layout = graphLayout(MAP, { width: 96 });
    expect(layout.nodes.map((n: { col: number }) => n.col)).toEqual([0, 1, 1, 1, 2, 2, 0]);
    const at = new Map(layout.nodes.map((n: { id: string }) => [n.id, n]));
    expect((at.get('L:parsers') as { row: number }).row).toBeGreaterThanOrEqual((at.get('L:adapters') as { row: number }).row);
    for (const a of layout.nodes)
      for (const b of layout.nodes) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart, `${a.id} overlaps ${b.id}`).toBe(true);
      }
    expect(layout.width).toBeLessThanOrEqual(96);
  });

  it('draws every module once in the terminal, its counts inside, and an edge from each parent to its child', () => {
    const layout = graphLayout(MAP, { width: 96 });
    const rows = graphGrid(MAP, layout, {}).map((runs: [string, unknown][]) => runs.map(([t]) => t).join(''));
    for (const m of MAP) expect(rows.filter((r: string) => r.includes(`┌ ${m.name} `)).length, m.id).toBe(1);
    expect(rows.join('\n')).toContain(countsLine(MAP[1]));
    expect(countsLine(MAP[1])).toBe('3r +1? 1/2');
    // Each containment edge leaves its parent's right side on the parent's middle line, and enters the child's left.
    for (const { from, to } of containmentEdges(MAP, layout)) {
      const a = layout.nodes.find((n: { id: string }) => n.id === from);
      const b = layout.nodes.find((n: { id: string }) => n.id === to);
      expect(rows[a.y + 1][a.x + a.w], `${from} → ${to} leaves`).toMatch(/[─┐┬┤┼]/);
      expect(rows[b.y + 1][b.x - 1], `${from} → ${to} arrives`).toMatch(/[─└┴├┼]/);
    }
    expect(containmentEdges(MAP, layout)).toHaveLength(5);
  });

  it("marks a module whose rule is overridden red, the selected one cyan, and a pulsing one blue", () => {
    const flagged = flaggedByModule(MAP, [{ rule: 'parsers.no-io', evidence: ['d-1 …', 'd-2 …', 'd-3 …'], proposal: 'Reword it' }]);
    expect([...flagged.keys()]).toEqual(['L:parsers']);
    expect(flagged.get('L:parsers')[0]).toMatchObject({ rule: 'parsers.no-io', n: 3 });
    const layout = graphLayout(MAP, { width: 96 });
    const grid = graphGrid(MAP, layout, { selected: 1, flagged, pulsing: new Set(['L:db']) });
    const colorOf = (name: string) => grid.flat().find(([t]: [string]) => t.includes(`┌ ${name}`) || t.includes(`┌ ›${name}`))?.[1]?.color;
    expect(colorOf('parsers')).toBe('red');
    expect(colorOf('domain')).toBe('cyan');
    expect(colorOf('db')).toBe('blue');
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

  it('draws an Svg on the remote surfaces: a box and ring per module, edges, a red outline and an SMIL pulse', () => {
    const layout = graphLayout(MAP, { width: 96 });
    const flagged = flaggedByModule(MAP, [{ rule: 'parsers.no-io', evidence: ['d-1'], proposal: 'x' }]);
    const svg = graphSvg(MAP, layout, { flagged, pulsing: new Set(['L:db']) });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg.length).toBeLessThan(131072);
    expect(svg.match(/<rect [^>]*rx="5"/g)).toHaveLength(MAP.length);
    expect(svg).toContain('stroke="#e06a6a"');
    expect(svg).toContain('<animate attributeName="opacity"');
    expect(svg).toContain('parsers.no-io overridden 1×');
    expect(svg.match(/stroke-dasharray="3 3"/g)).toHaveLength(2);
    const tab = moduleGraph(MAP, els, { surface: 'desktop', pulsing: new Set(['L:db']) });
    const drawn = tab.flatMap((n: Node) => (n.type === 'Box' ? (n.children as Node[]) : [n])).find((n: Node) => n.type === 'Svg');
    expect(drawn.props).toMatchObject({ isInteractive: true });
    expect(String(drawn.props.alt)).toContain('L:parsers 1r 1/2');
  });

  it("shows the selected module's detail: its rules, imports, an overridden rule's text and proposal, and its proposals' acts", () => {
    const acted: string[] = [];
    const tab = moduleGraph(
      MAP,
      els,
      {
        surface: 'terminal',
        selected: 4,
        flagged: [{ rule: 'parsers.no-io', evidence: ['d-1', 'd-2'], proposal: 'Reword: a parser reads the bytes it is given.' }],
        proposals: [{ id: 'parsers.bytes', module: 'L:parsers', text: 'A parser reads only the bytes it is given' }, { id: 'other', module: 'L:db', text: 'x' }],
      },
      { onRatify: (p: { id: string }) => acted.push(`accept ${p.id}`), onDrop: () => {}, onDefer: () => {} },
    );
    const shown = tab.flatMap(texts);
    expect(shown).toEqual(expect.arrayContaining(['parsers (L:parsers)', 'imports application', 'parsers.no-io overridden 2×', 'A parser never touches the file system', 'Reword: a parser reads the bytes it is given.']));
    const k = tab.flatMap(keys);
    expect(k).toEqual(expect.arrayContaining(['graph-accept-parsers.bytes', 'graph-reject-parsers.bytes', 'graph-later-parsers.bytes']));
    expect(k).not.toContain('graph-accept-other');
  });
});
