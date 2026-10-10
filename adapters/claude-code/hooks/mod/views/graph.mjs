// The module graph (docs/specs/08-graph-explorer.md, MAP-4): the Map tab's first view. Each module is a
// node with its rules and card coverage, joined to the modules it contains; a module where a decision
// was just recorded pulses, and one whose rule hygiene flags as overridden is outlined red. Pure: the
// mod passes `ctx map --json`, the flagged rules, the waiting proposals and the selection.
//
// Two drawings of one layout: an Svg on the remote surfaces (desktop, VS Code, mobile), with the
// coverage as a ring and the import edges dashed; and, in the terminal, where there is no Svg, a grid
// of characters (box-drawing nodes and edges) drawn as rows of coloured Text runs.
import { spark } from './proposals.mjs';

/** A node's size in character cells: a bordered box three lines tall. */
const NODE_H = 3;
/** The rows between two nodes in a column, and the columns between two depths, where edges run. */
const ROW_GAP = 1;
const COL_GAP = 4;

/** A module's card coverage: { carded, total }. */
export const coverageOf = (m) => ({ carded: m.files.filter((f) => f.card === 'current').length, total: m.files.length });

/** A module's counts as its node's second line reads them: "2r +1? 13/14". */
export function countsLine(m) {
  const { carded, total } = coverageOf(m);
  return `${m.rules.agreed}r${m.rules.proposed ? ` +${m.rules.proposed}?` : ''} ${carded}/${total}`;
}

/** A node's label: the module's id without its `L:` and any parent's prefix ("L:adapters.parsers" → "parsers"); its name is in the detail. */
export const shortName = (m) => m.id.replace(/^L:/, '').split(/[./]/).at(-1);

/**
 * The layout, in character cells: a tidy tree, read left to right. Modules sit in columns by depth; a
 * module's first child shares its row, and each later child starts below everything drawn before it,
 * so every subtree has rows of its own and no two parents' edges share a stretch of line. A module
 * whose parent isn't one column back starts a new row, like a root. `width` is the drawing's width in
 * columns; a node's width shrinks to fit (at least 12).
 * Returns { nodes: [{ id, index, col, row, x, y, w, h }], width, height, nodeW }.
 */
export function graphLayout(map, { width = 96 } = {}) {
  const cols = map.length ? Math.max(...map.map((m) => m.depth)) + 1 : 0;
  const nodeW = cols ? Math.max(12, Math.min(22, Math.floor((width - COL_GAP * (cols - 1)) / cols))) : 0;
  const placed = new Map();
  const hasChild = new Set();
  let nextRow = 0;
  const nodes = map.map((m, index) => {
    const parent = m.parents.map((p) => placed.get(p)).find((p) => p && p.col === m.depth - 1);
    const first = parent && !hasChild.has(parent.id);
    const row = first ? parent.row : nextRow;
    if (parent) hasChild.add(parent.id);
    nextRow = Math.max(nextRow, row + 1);
    const node = { id: m.id, index, col: m.depth, row, x: m.depth * (nodeW + COL_GAP), y: row * (NODE_H + ROW_GAP), w: nodeW, h: NODE_H };
    placed.set(m.id, node);
    return node;
  });
  return { nodes, nodeW, width: cols ? cols * nodeW + (cols - 1) * COL_GAP : 0, height: nextRow ? nextRow * (NODE_H + ROW_GAP) - ROW_GAP : 0 };
}

/**
 * The containment edges the drawing shows: from a parent to a child one depth on. A child with
 * another parent elsewhere keeps the edge to the first; the detail names the rest.
 */
export function containmentEdges(map, layout) {
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const edges = [];
  for (const m of map) {
    const child = at.get(m.id);
    const parent = m.parents.map((p) => at.get(p)).find((p) => p && p.col === child.col - 1);
    if (parent) edges.push({ from: parent.id, to: child.id });
  }
  return edges;
}

/** The module-to-module import edges, from each module's `imports` ([{ to, n }]), within the map. */
export function importEdges(map) {
  const ids = new Set(map.map((m) => m.id));
  return map.flatMap((m) => (m.imports ?? []).filter((i) => ids.has(i.to) && i.to !== m.id).map((i) => ({ from: m.id, to: i.to, n: i.n })));
}

/** Each module's flagged rules: Map(module id → [{ rule, n, evidence, proposal }]), from hygiene's flags and the map's rules. */
export function flaggedByModule(map, flagged = []) {
  const out = new Map();
  for (const f of flagged) {
    const m = map.find((x) => (x.ruleList ?? []).some((r) => r.id === f.rule));
    if (!m) continue;
    out.set(m.id, [...(out.get(m.id) ?? []), { rule: f.rule, n: f.evidence.length, evidence: f.evidence, proposal: f.proposal }]);
  }
  return out;
}

/** Which modules pulse: those whose decisions grew between two reads of the map. */
export function grewDecisions(before, after) {
  const was = new Map((before ?? []).map((m) => [m.id, m.decisions.length]));
  return (after ?? []).filter((m) => was.has(m.id) && m.decisions.length > was.get(m.id)).map((m) => m.id);
}

// --- the terminal's drawing ---------------------------------------------------------------------

const N = 1, E = 2, S = 4, W = 8;
const LINE = { [E | W]: '─', [N | S]: '│', [S | W]: '┐', [N | W]: '┘', [N | E]: '└', [E | S]: '┌', [N | S | E]: '├', [N | S | W]: '┤', [E | W | S]: '┬', [E | W | N]: '┴', [N | E | S | W]: '┼', [E]: '─', [W]: '─', [N]: '│', [S]: '│' };

/** A node's style: overridden red, selected cyan and bold, pulsing blue (bold on alternate beats). */
function nodeStyle({ selected, flagged, pulsing, beat }) {
  if (selected) return { color: 'cyan', bold: true };
  if (pulsing) return { color: 'blue', bold: beat % 2 === 0 };
  if (flagged) return { color: 'red' };
  return {};
}

/**
 * The terminal's drawing: rows of runs, each run [text, style], consecutive cells of one style joined.
 * `state`: { selected (module index), flagged (Map of flaggedByModule), pulsing (Set of ids), beat }.
 */
export function graphGrid(map, layout, state = {}) {
  const { selected = -1, flagged = new Map(), pulsing = new Set(), beat = 0 } = state;
  const grid = Array.from({ length: layout.height }, () => Array.from({ length: layout.width }, () => ({ ch: ' ', style: null, bits: 0 })));
  const put = (x, y, ch, style) => {
    if (grid[y]?.[x]) grid[y][x] = { ch, style, bits: 0, node: true };
  };
  const link = (x, y, bits) => {
    const c = grid[y]?.[x];
    if (c && !c.node) c.bits |= bits;
  };
  // Edges first, as direction bits per cell; the nodes are drawn over them.
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  for (const { from, to } of containmentEdges(map, layout)) {
    const a = at.get(from), b = at.get(to);
    const y1 = a.y + 1, y2 = b.y + 1;
    const x1 = a.x + a.w, x2 = b.x - 1, xm = a.x + a.w + Math.floor(COL_GAP / 2) - 1;
    for (let x = x1; x < xm; x++) link(x, y1, E | W);
    if (y1 === y2) {
      for (let x = xm; x <= x2; x++) link(x, y1, E | W);
      continue;
    }
    link(xm, y1, W | S);
    for (let y = y1 + 1; y < y2; y++) link(xm, y, N | S);
    link(xm, y2, N | E);
    for (let x = xm + 1; x <= x2; x++) link(x, y2, E | W);
  }
  for (const row of grid) for (const c of row) if (c.bits) Object.assign(c, { ch: LINE[c.bits] ?? '┼', style: { dimColor: true } });
  for (const n of layout.nodes) {
    const m = map[n.index];
    const style = nodeStyle({ selected: n.index === selected, flagged: flagged.has(m.id), pulsing: pulsing.has(m.id), beat });
    const inner = n.w - 2;
    const name = ` ${n.index === selected ? '›' : ''}${shortName(m)} `.slice(0, inner);
    const top = `┌${name}${'─'.repeat(inner - name.length)}┐`;
    const counts = ` ${countsLine(m)}`.slice(0, inner).padEnd(inner);
    const rows = [top, `│${counts}│`, `└${'─'.repeat(inner)}┘`];
    rows.forEach((r, dy) => [...r].forEach((ch, dx) => put(n.x + dx, n.y + dy, ch, style)));
    // The counts' text in the node's own colour only when it marks something; otherwise plain.
    if (!flagged.has(m.id) && n.index !== selected && !pulsing.has(m.id)) [...counts].forEach((ch, dx) => put(n.x + 1 + dx, n.y + 1, ch, { dimColor: false }));
  }
  const same = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});
  return grid.map((row) => {
    const runs = [];
    for (const c of row) {
      const last = runs.at(-1);
      if (last && same(last[1], c.style)) last[0] += c.ch;
      else runs.push([c.ch, c.style]);
    }
    // Trailing spaces are dropped: a row is only as wide as what it draws.
    while (runs.length && !runs.at(-1)[0].trim()) runs.pop();
    if (runs.length) runs[runs.length - 1][0] = runs.at(-1)[0].replace(/\s+$/, '');
    return runs;
  });
}

// --- the remote surfaces' drawing ---------------------------------------------------------------

const PX = { cell: 8, line: 18 };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The Svg drawing: the same layout at 8 px a column and 18 px a line. Each node a rounded box with its
 * coverage as a ring, its name and counts; containment edges solid, import edges dashed; a pulsing
 * module ringed in blue with an SMIL pulse; an overridden one outlined red.
 */
export function graphSvg(map, layout, state = {}) {
  const { selected = -1, flagged = new Map(), pulsing = new Set() } = state;
  const w = layout.width * PX.cell + 16;
  const h = layout.height * PX.line + 16;
  const at = new Map(layout.nodes.map((n) => [n.id, n]));
  const box = (n) => ({ x: n.x * PX.cell + 8, y: n.y * PX.line + 8, w: n.w * PX.cell, h: n.h * PX.line - 6 });
  const parts = [];
  for (const { from, to } of containmentEdges(map, layout)) {
    const a = box(at.get(from)), b = box(at.get(to));
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, mx = (x1 + x2) / 2;
    parts.push(`<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}" fill="none" stroke="#5b6b70" stroke-width="1.2"/>`);
  }
  for (const { from, to } of importEdges(map)) {
    if (!at.has(from) || !at.has(to)) continue;
    const a = box(at.get(from)), b = box(at.get(to));
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    parts.push(`<path d="M${x1},${y1} C${x1},${y1 + 30} ${x2},${y2 - 30} ${x2},${y2}" fill="none" stroke="#7a8a8f" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/>`);
  }
  for (const n of layout.nodes) {
    const m = map[n.index];
    const b = box(n);
    const { carded, total } = coverageOf(m);
    const share = total ? carded / total : 0;
    const isFlagged = flagged.has(m.id);
    const stroke = n.index === selected ? '#5fd7ff' : isFlagged ? '#e06a6a' : '#3b4c50';
    if (pulsing.has(m.id))
      parts.push(
        `<rect x="${b.x - 4}" y="${b.y - 4}" width="${b.w + 8}" height="${b.h + 8}" rx="8" fill="none" stroke="#8fb8ff" stroke-width="2"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" repeatCount="indefinite"/></rect>`,
      );
    parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="5" fill="#0f1618" stroke="${stroke}" stroke-width="${isFlagged || n.index === selected ? 2 : 1}"/>`);
    // The coverage ring: a grey circle, the carded share in green from the top.
    const r = 8, cx = b.x + 14, cy = b.y + b.h / 2;
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#233235" stroke-width="3"/>`);
    if (share >= 1) parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#78c98a" stroke-width="3"/>`);
    else if (share > 0) {
      const a = share * 2 * Math.PI;
      parts.push(`<path d="M${cx},${cy - r} A${r},${r} 0 ${a > Math.PI ? 1 : 0} 1 ${(cx + r * Math.sin(a)).toFixed(2)},${(cy - r * Math.cos(a)).toFixed(2)}" fill="none" stroke="#78c98a" stroke-width="3"/>`);
    }
    parts.push(`<text x="${cx + 14}" y="${b.y + 15}" fill="#cfd9da" font-family="monospace" font-size="12">${esc(shortName(m))}</text>`);
    parts.push(`<text x="${cx + 14}" y="${b.y + 29}" fill="#6e8286" font-family="monospace" font-size="10">${esc(countsLine(m))}</text>`);
    for (const f of flagged.get(m.id) ?? [])
      parts.push(`<text x="${b.x}" y="${b.y + b.h + 12}" fill="#e06a6a" font-family="monospace" font-size="10">${esc(`${f.rule} overridden ${f.n}×`)}</text>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join('')}</svg>`;
}

// --- the tab ------------------------------------------------------------------------------------

/**
 * MAP-4: the Map tab's module graph: the drawing for the surface, a legend, and the selected module's
 * detail (its rules, decisions, coverage, what it imports, its overridden rules and the proposals on
 * it with Accept, Reject… and Later). `view`: { surface, selected, flagged (hygiene's), pulsing (Set),
 * beat, proposals, now, backfill, width }. Handlers: onRatify(p), onDrop(p), onDefer(p).
 */
export function moduleGraph(map, els, view = {}, handlers = {}) {
  const { Box, Text, Button } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const { surface = 'terminal', selected = -1, pulsing = new Set(), beat = 0, proposals = [], now = Date.now(), backfill = null, width = 96 } = view;
  if (!map?.length) return [text('No modules in the graph yet.', { dimColor: true })];
  const flagged = flaggedByModule(map, view.flagged ?? []);
  const layout = graphLayout(map, { width });
  const state = { selected, flagged, pulsing, beat };
  const alt = `The module graph: ${map.map((m) => `${m.id} ${countsLine(m)}`).join('; ')}`;
  const drawing =
    surface !== 'terminal' && els.Svg
      ? [els.Svg({ key: 'module-graph', source: graphSvg(map, layout, state), alt, isInteractive: pulsing.size > 0 })]
      : graphGrid(map, layout, state).map((runs, y) =>
          Box({
            key: `graph-row-${y}`,
            flexDirection: 'row',
            children: runs.length ? runs.map(([t, style], i) => Text({ key: `r${i}`, ...(style ?? {}), wrap: 'truncate-end', children: [t] })) : [text(' ')],
          }),
        );
  const m = map[selected] ?? null;
  const detail = m ? moduleDetail(m, map, { flagged: flagged.get(m.id) ?? [], proposals: proposals.filter((p) => p.module === m.id), now }, els, handlers) : [];
  return [
    text('MODULES', { bold: true, color: 'cyan' }),
    ...(backfill ? [text(backfill, { key: 'map-backfill', color: 'yellow' })] : []),
    Box({ key: 'graph', flexDirection: 'column', children: drawing }),
    text('r rules · +n? proposed · carded/files · red: a rule overridden · blue: a decision just recorded', { key: 'graph-legend', dimColor: true }),
    ...detail,
    text(m ? 'Enter opens its files.' : 'j/k select a module; Enter opens its files.', { dimColor: true }),
  ];
}

/** The selected module's detail under the graph. */
function moduleDetail(m, map, { flagged, proposals, now }, { Box, Text, Button }, { onRatify, onDrop, onDefer }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const { carded, total } = coverageOf(m);
  const name = (id) => map.find((x) => x.id === id)?.name ?? id;
  const imports = importEdges(map).filter((e) => e.from === m.id);
  const importedBy = importEdges(map).filter((e) => e.to === m.id);
  return [
    Box({
      key: 'module-detail',
      flexDirection: 'column',
      borderStyle: 'round',
      ...(flagged.length ? { borderColor: 'red' } : {}),
      paddingX: 1,
      children: [
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            text(`${m.name} (${m.id})`, { bold: true }),
            text(`${m.rules.agreed} rule${m.rules.agreed === 1 ? '' : 's'}${m.rules.proposed ? `, ${m.rules.proposed} proposed` : ''}`, { dimColor: true }),
            text(`${carded}/${total} carded`, { dimColor: true }),
            ...(m.decisions.length ? [text(`decisions ${spark(m.decisions, now, 10, 3)}`, { color: 'blue' })] : []),
          ],
        }),
        ...(m.parents.length > 1 ? [text(`in ${m.parents.map(name).join(', ')}`, { dimColor: true })] : []),
        ...(imports.length ? [text(`imports ${imports.map((e) => name(e.to)).join(', ')}`, { dimColor: true, wrap: 'truncate-end' })] : []),
        ...(importedBy.length ? [text(`imported by ${importedBy.map((e) => name(e.from)).join(', ')}`, { dimColor: true, wrap: 'truncate-end' })] : []),
        ...flagged.flatMap((f) => [
          text(`${f.rule} overridden ${f.n}×`, { key: `overridden-${f.rule}`, color: 'red', bold: true }),
          text((m.ruleList ?? []).find((r) => r.id === f.rule)?.text ?? '', { dimColor: true }),
          text(f.proposal, { color: 'yellow' }),
        ]),
        ...proposals.map((p) =>
          Box({
            key: `module-proposal-${p.id}`,
            flexDirection: 'row',
            columnGap: 2,
            children: [
              text(`${p.id}: ${p.text}`, { wrap: 'truncate-end' }),
              ...(onRatify ? [Button({ key: `graph-accept-${p.id}`, label: 'Accept', plain: true, onPress: () => onRatify(p) })] : []),
              ...(onDrop ? [Button({ key: `graph-reject-${p.id}`, label: 'Reject…', plain: true, onPress: () => onDrop(p) })] : []),
              ...(onDefer ? [Button({ key: `graph-later-${p.id}`, label: 'Later', plain: true, onPress: () => onDefer(p) })] : []),
            ],
          }),
        ),
      ],
    }),
  ];
}
