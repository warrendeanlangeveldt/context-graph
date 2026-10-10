// The Proposals queue (docs/specs/09-panes.md, VIEW-3): one card per proposal, grouped by module, with
// its evidence in words and, once decisions cite it, a sparkline of those that served and overrode it.
// The pane says Accept, Reject and Later for ctx's ratify and drop; the selected one is accepted on a,
// rejected on r and put off on l; later ones wait at the back.

const BARS = '▁▂▃▄▅▆▇█';
const DAY = 24 * 3600000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * A sparkline of `dates` (YYYY-MM-DD) over `bars` spans of `days` days up to `now`, oldest first (a
 * week a bar unless told): each bar's height its span's count against the busiest span's. Spans with
 * none are the lowest bar.
 */
export function spark(dates, now, bars = 8, days = 7) {
  const counts = new Array(bars).fill(0);
  for (const d of dates ?? []) {
    const age = Math.floor((now - Date.parse(`${d}T12:00:00Z`)) / (days * DAY));
    if (age >= 0 && age < bars) counts[bars - 1 - age] += 1;
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

/**
 * The queue's order: waiting ones grouped by module, in the order their modules first come, then the
 * ones put off till later. Concepts, which have no module, group together.
 */
export function queueOrder(proposals, deferred) {
  const waiting = proposals.filter((p) => !deferred.has(p.id));
  const modules = [...new Set(waiting.map((p) => p.module ?? ''))];
  return [...modules.flatMap((m) => waiting.filter((p) => (p.module ?? '') === m)), ...proposals.filter((p) => deferred.has(p.id))];
}

const what = (p) => (p.kind === 'concepts' ? 'concept' : `rule (${p.kind})`);
const hasEvidence = (p) => Boolean(p.servedOn?.length || p.overriddenOn?.length);

/**
 * The queue (VIEW-3), in plain words: Accept (`ctx ratify`) holds agents to a rule; Reject (`ctx drop`)
 * removes it, keeping the reason; Later puts it to the back for the session. Grouped by module, each
 * group with Accept all. `selected` is the index in queue order, or -1.
 * Handlers: onRatify(p), onDrop(p), onDefer(p), onRatifyAll(module, proposals).
 */
export function proposalsQueue(proposals, els, { onRatify, onDrop, onDefer, onRatifyAll }, { selected = -1, deferred = new Set(), now = Date.now() } = {}) {
  const { Box, Text, Button } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!proposals.length) return [text('PROPOSALS', { bold: true, color: 'cyan' }), text('None waiting.', { dimColor: true })];
  const queue = queueOrder(proposals, deferred);
  const card = (p, i) => {
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
          children: [text(p.id, { bold: true, dimColor: later }), text(`${what(p)}${p.module ? ` on ${p.module}` : ''}`, { dimColor: true }), ...(later ? [text('later', { color: 'yellow' })] : [])],
        }),
        text(p.text, { dimColor: later }),
        text(`Evidence: ${evidence(p)}`, { dimColor: true }),
        // A sparkline only says something once decisions have cited it.
        ...(hasEvidence(p)
          ? [
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
            ]
          : []),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Button({ key: `ratify-${p.id}`, label: 'Accept', onPress: () => onRatify(p) }),
            Button({ key: `drop-${p.id}`, label: 'Reject…', onPress: () => onDrop(p) }),
            Button({ key: `defer-${p.id}`, label: later ? 'Bring back' : 'Later', onPress: () => onDefer(p) }),
          ],
        }),
      ],
    });
  };
  // Each module's group, headed with its count and Accept all; then those put off till later.
  const nodes = [];
  let group = null;
  queue.forEach((p, i) => {
    const key = deferred.has(p.id) ? 'later' : (p.module ?? '');
    if (key !== group) {
      group = key;
      const members = key === 'later' ? [] : queue.filter((q) => !deferred.has(q.id) && (q.module ?? '') === key);
      nodes.push(
        Box({
          key: `group-${key || 'concepts'}`,
          flexDirection: 'row',
          columnGap: 2,
          children: [
            text(key === 'later' ? 'Later' : key || 'Concepts', { bold: true }),
            ...(members.length ? [text(`${members.length} waiting`, { dimColor: true })] : []),
            ...(members.length > 1 && key && onRatifyAll
              ? [Button({ key: `accept-all-${key}`, label: `Accept all ${members.length} on ${key}`, plain: true, onPress: () => onRatifyAll(key, members) })]
              : []),
          ],
        }),
      );
    }
    nodes.push(card(p, i));
  });
  const waiting = queue.length - deferred.size;
  return [
    text('PROPOSALS', { bold: true, color: 'cyan' }),
    text(
      `${waiting} ${waiting === 1 ? 'rule waits' : 'rules wait'} for you${deferred.size ? `, ${deferred.size} put off till later` : ''}. Context Graph found them in your code and decisions. Accept one and agents are held to it from now on; reject it to remove it.`,
      { dimColor: true },
    ),
    ...nodes,
  ];
}

/** VIEW-3's keys for the selected proposal: a accepts, r rejects, l puts it off till later. */
export function queueKeys(proposals, { Button }, { onRatify, onDrop, onDefer }, { selected = -1, deferred = new Set() } = {}) {
  const p = queueOrder(proposals, deferred)[selected];
  if (!p) return [];
  return [
    Button({ key: 'key-ratify', label: `Accept ${p.id}`, hotkey: 'a', plain: true, onPress: () => onRatify(p) }),
    Button({ key: 'key-drop', label: 'Reject', hotkey: 'r', plain: true, onPress: () => onDrop(p) }),
    Button({ key: 'key-defer', label: deferred.has(p.id) ? 'Bring back' : 'Later', hotkey: 'l', plain: true, onPress: () => onDefer(p) }),
  ];
}
