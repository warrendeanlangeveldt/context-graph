// The graph explorer (docs/specs/08-graph-explorer.md): within a module of the Map tab's graph
// (views/graph.mjs, MAP-4), a coverage heat map, a cell per file (MAP-2). Pure: the mod passes the
// module from `ctx map --json`, the files owed a card this session, and the selection.

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
  if (!files.length) return { filled: '', empty: '', words: 'no files' };
  const current = files.filter((f) => f.card === 'current').length;
  const full = Math.round((current / files.length) * 10);
  return { filled: '█'.repeat(full), empty: '░'.repeat(10 - full), words: `${current}/${files.length} have their why` };
}

/**
 * MAP-2: a module's files as cells coloured current, stale, missing or owed, a legend counting them,
 * and the selected file (Enter opens it in the File tab). `on.onPick(index)` for the list's pointer.
 */
export function heatMap(module, owed, { Box, Text, Select, Button }, { selected = -1 }, on) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const cells = module.files.map((f) => ({ ...f, heat: heatOf(f, owed) }));
  const legend = Object.entries(HEAT)
    .map(([state, h]) => ({ state, ...h, n: cells.filter((c) => c.heat === state).length }))
    .filter((h) => h.n > 0);
  const picked = cells[selected] ?? null;
  return [
    Box({
      key: 'heat-head',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        text(`${module.name} (${module.id})`, { bold: true, color: 'cyan' }),
        // Its files without a current card: to the card writer when it's on, else to the lead.
        ...(cells.some((c) => c.card !== 'current') && on.onModuleCards
          ? [Button({ key: 'module-write-cards', label: 'Write cards for this module', hotkey: 'c', plain: true, onPress: () => on.onModuleCards(module.id) })]
          : []),
      ],
    }),
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
