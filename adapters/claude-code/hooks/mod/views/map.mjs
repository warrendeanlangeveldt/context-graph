// The graph explorer (docs/specs/08-graph-explorer.md): the Context pane's Map tab. The modules as a
// tree with their rules, decision activity and card coverage (MAP-1), and within a module a coverage
// heat map, a cell per file (MAP-2). Pure: the mod passes `ctx map --json`, the files owed a card this
// session, and the selection.
import { spark } from './proposals.mjs';

/** Each file cell's state: its glyph, readable without colour, and its colour (MAP-2). */
export const HEAT = {
  current: { glyph: '●', color: 'green', words: 'current' },
  stale: { glyph: '◐', color: 'yellow', words: 'stale' },
  missing: { glyph: '○', color: 'red', words: 'missing' },
  owed: { glyph: '✱', color: 'magenta', words: 'owed this session' },
};

/** A file's cell: owed this session wins over its card's state. */
export const heatOf = (file, owed) => (owed.has(file.path) ? 'owed' : file.card);

/** The share of a module's files with a current card, as a bar of ten cells and words. */
export function coverageBar(files) {
  if (!files.length) return { bar: '', words: 'no files' };
  const current = files.filter((f) => f.card === 'current').length;
  const full = Math.round((current / files.length) * 10);
  return { bar: `${'█'.repeat(full)}${'░'.repeat(10 - full)}`, words: `${current}/${files.length} carded` };
}

/** MAP-1: the module tree, each row its name, rules, proposals, a 30-day decision sparkline and its coverage. */
export function mapTree(map, { Box, Text }, { selected = -1, now }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!map?.length) return [text('No modules in the graph yet.', { dimColor: true })];
  return [
    text('MODULES', { bold: true, color: 'cyan' }),
    ...map.map((m, i) => {
      const cov = coverageBar(m.files);
      return Box({
        key: `module-${m.id}`,
        flexDirection: 'row',
        columnGap: 2,
        children: [
          text(`${i === selected ? '›' : ' '} ${'  '.repeat(m.depth)}${m.name}`, i === selected ? { color: 'cyan', bold: true } : { bold: true }),
          text(m.id, { dimColor: true }),
          text(`${m.rules.agreed} rule${m.rules.agreed === 1 ? '' : 's'}`, { dimColor: true }),
          ...(m.rules.proposed ? [text(`◆ ${m.rules.proposed} proposed`, { color: 'yellow' })] : []),
          text(spark(m.decisions, now, 10, 3), { color: 'blue' }),
          ...(cov.bar ? [text(cov.bar, { color: 'green' })] : []),
          text(cov.words, { dimColor: true }),
        ],
      });
    }),
    text('Decisions: the last 30 days, three days a bar. Enter opens a module.', { dimColor: true }),
  ];
}

/**
 * MAP-2: a module's files as cells coloured current, stale, missing or owed, a legend counting them,
 * and the selected file (Enter opens it in the File tab). `on.onPick(index)` for the list's pointer.
 */
export function heatMap(module, owed, { Box, Text, Select }, { selected = -1 }, on) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const cells = module.files.map((f) => ({ ...f, heat: heatOf(f, owed) }));
  const legend = Object.entries(HEAT)
    .map(([state, h]) => ({ state, ...h, n: cells.filter((c) => c.heat === state).length }))
    .filter((h) => h.n > 0);
  const picked = cells[selected] ?? null;
  return [
    text(`${module.name} (${module.id})`, { bold: true, color: 'cyan' }),
    Box({
      key: 'heat-legend',
      flexDirection: 'row',
      columnGap: 2,
      children: legend.map((h) => text(`${h.glyph} ${h.n} ${h.words}`, { color: h.color })),
    }),
    Box({
      key: 'heat-cells',
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: cells.map((c, i) =>
        // Keyed by its Box: a Text keeps no key of its own.
        Box({
          key: `cell-${c.path}`,
          children: [text(HEAT[c.heat].glyph, { color: HEAT[c.heat].color, ...(i === selected ? { inverse: true, bold: true } : {}) })],
        }),
      ),
    }),
    ...(cells.length
      ? [
          Select({
            key: 'heat-select',
            label: 'File',
            value: picked?.path ?? cells[0].path,
            options: cells.map((c) => ({ value: c.path, label: `${HEAT[c.heat].glyph} ${c.path}` })),
            onSelect: (path) => on.onPick(cells.findIndex((c) => c.path === path)),
          }),
        ]
      : [text('No files map to it.', { dimColor: true })]),
    ...(picked ? [text(`${picked.path} · ${HEAT[picked.heat].words}. Enter opens it.`, { key: 'heat-picked' })] : []),
  ];
}
