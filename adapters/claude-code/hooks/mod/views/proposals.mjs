// The Proposals queue (docs/specs/09-panes.md, VIEW-3): one card per proposal, with its evidence in
// words and a sparkline of the decisions that served and overrode it over the last weeks. The
// selected one is ratified on r, dropped on d and deferred on f; deferred ones wait at the back.

const BARS = '▁▂▃▄▅▆▇█';
const DAY = 24 * 3600000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A sparkline of `dates` (YYYY-MM-DD) over the `weeks` weeks up to `now`, oldest first: a bar per
 * week, its height the week's count against the busiest week's. Weeks with none are the lowest bar.
 */
export function spark(dates, now, weeks = 8) {
  const counts = new Array(weeks).fill(0);
  for (const d of dates ?? []) {
    const age = Math.floor((now - Date.parse(`${d}T12:00:00Z`)) / (7 * DAY));
    if (age >= 0 && age < weeks) counts[weeks - 1 - age] += 1;
  }
  const top = Math.max(...counts);
  return counts.map((c) => (top ? BARS[Math.round((c / top) * (BARS.length - 1))] : BARS[0])).join('');
}

/** The evidence a person decides on, in words. */
export function evidence(p) {
  const parts = [];
  if (p.served) parts.push(`served by ${plural(p.served, 'decision', 'decisions')}`);
  if (p.overridden) parts.push(`overridden by ${plural(p.overridden, 'decision', 'decisions')}`);
  if (p.violations) parts.push(`${plural(p.violations, 'file breaks', 'files break')} it now`);
  else if (p.violations === 0) parts.push('no file breaks it');
  return parts.length ? parts.join(', ') : 'no decision has cited it yet';
}

/** The queue's order: waiting ones as they come, deferred ones after them. */
export const queueOrder = (proposals, deferred) => [
  ...proposals.filter((p) => !deferred.has(p.id)),
  ...proposals.filter((p) => deferred.has(p.id)),
];

/**
 * The queue: `selected` is the index in queue order (or -1), `deferred` the ids put back this session,
 * `now` the clock. Handlers: onRatify(p), onDrop(p), onDefer(p).
 */
export function proposalsQueue(proposals, els, { onRatify, onDrop, onDefer }, { selected = -1, deferred = new Set(), now = Date.now() } = {}) {
  const { Box, Text, Button } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!proposals.length) return [text('PROPOSALS', { bold: true, color: 'cyan' }), text('None waiting.', { dimColor: true })];
  const queue = queueOrder(proposals, deferred);
  return [
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [
        text('PROPOSALS', { bold: true, color: 'cyan' }),
        text(`${plural(queue.length - deferred.size, 'waits', 'wait')} for you to ratify or drop${deferred.size ? `, ${deferred.size} deferred` : ''}`, { dimColor: true }),
      ],
    }),
    ...queue.map((p, i) => {
      const later = deferred.has(p.id);
      return Box({
        key: `proposal-${p.id}`,
        flexDirection: 'column',
        borderStyle: i === selected ? 'bold' : 'round',
        ...(i === selected ? { borderColor: 'cyan' } : {}),
        paddingX: 1,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              text(p.id, { bold: true, dimColor: later }),
              text(`${p.kind === 'concepts' ? 'concept' : `rule (${p.kind})`}${p.module ? ` on ${p.module}` : ''}`, { dimColor: true }),
              ...(later ? [text('deferred', { color: 'yellow' })] : []),
            ],
          }),
          text(p.text, { dimColor: later }),
          text(`Evidence: ${evidence(p)}`, { dimColor: true }),
          Box({
            key: `spark-${p.id}`,
            flexDirection: 'row',
            columnGap: 1,
            children: [
              text('served    ', { dimColor: true }),
              text(spark(p.servedOn, now), { color: 'green' }),
              text('  overridden', { dimColor: true }),
              text(spark(p.overriddenOn, now), { color: 'red' }),
              text('  8 weeks', { dimColor: true }),
            ],
          }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({ key: `ratify-${p.id}`, label: 'Ratify', onPress: () => onRatify(p) }),
              Button({ key: `drop-${p.id}`, label: 'Drop…', onPress: () => onDrop(p) }),
              Button({ key: `defer-${p.id}`, label: later ? 'Bring back' : 'Defer', onPress: () => onDefer(p) }),
            ],
          }),
        ],
      });
    }),
  ];
}

/** VIEW-3's keys for the selected proposal: r ratifies, d drops, f defers. */
export function queueKeys(proposals, { Button }, { onRatify, onDrop, onDefer }, { selected = -1, deferred = new Set() } = {}) {
  const p = queueOrder(proposals, deferred)[selected];
  if (!p) return [];
  return [
    Button({ key: 'key-ratify', label: `Ratify ${p.id}`, hotkey: 'r', plain: true, onPress: () => onRatify(p) }),
    Button({ key: 'key-drop', label: 'Drop', hotkey: 'd', plain: true, onPress: () => onDrop(p) }),
    Button({ key: 'key-defer', label: deferred.has(p.id) ? 'Bring back' : 'Defer', hotkey: 'f', plain: true, onPress: () => onDefer(p) }),
  ];
}
