// The Overview tab (docs/specs/08-graph-explorer.md, MAP-4): what the graph knows about the codebase, a
// row per module: how many of its files are explained (have a current card), its rules, and its
// decisions. The selected module's detail sits under the table; a module where a decision was just
// recorded is drawn blue, and one whose rule the team keeps overriding red. Pure: the mod passes
// `ctx map --json`, the flagged rules, the waiting proposals and the selection.
import { spark } from './proposals.mjs';

const DAY = 24 * 3600000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A module's files explained: { carded, total }. */
export const coverageOf = (m) => ({ carded: m.files.filter((f) => f.card === 'current').length, total: m.files.length });

/** A module's name as the table shows it: its id without `L:` and any parent's prefix ("L:adapters.parsers" → "parsers"). */
export const shortName = (m) => m.id.replace(/^L:/, '').split(/[./]/).at(-1);

/** The share explained as a bar of five cells. */
export const bar = (carded, total) => {
  const full = total ? Math.round((carded / total) * 5) : 0;
  return '█'.repeat(full) + '░'.repeat(5 - full);
};

/** When a module's last decision was, in words: "today", "yesterday", "3 days ago", or "none". */
export function lastDecision(dates, now) {
  if (!dates?.length) return 'none';
  const last = [...dates].sort().at(-1);
  const days = Math.floor((now - Date.parse(`${last}T12:00:00Z`)) / DAY + 0.5);
  return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
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

/** Which modules light up: those whose decisions grew between two reads of the map. */
export function grewDecisions(before, after) {
  const was = new Map((before ?? []).map((m) => [m.id, m.decisions.length]));
  return (after ?? []).filter((m) => was.has(m.id) && m.decisions.length > was.get(m.id)).map((m) => m.id);
}

/** A module's rules in words: "3", "3 + 1 proposed", "none". */
export const rulesWords = (m) => (m.rules.agreed || m.rules.proposed ? `${m.rules.agreed}${m.rules.proposed ? ` + ${m.rules.proposed} proposed` : ''}` : 'none');

const COLS = [
  { title: 'module', width: 22 },
  { title: 'files explained', width: 18 },
  { title: 'rules', width: 15 },
  { title: 'decisions', width: 11 },
  { title: 'last decision', width: 14 },
];

/**
 * MAP-4: the Overview: what the graph knows, a row per module (indented under its parent), the
 * selected one's detail, and the background work (the card writer and the backfill). `view`:
 * { selected, flagged (hygiene's), pulsing (Set), proposals, now, working: [nodes] }.
 * Handlers: onRatify(p), onDrop(p), onDefer(p).
 */
export function overview(map, els, view = {}, handlers = {}) {
  const { Box, Text } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const { selected = -1, pulsing = new Set(), proposals = [], now = Date.now(), working = [] } = view;
  const heading = (title, aside) =>
    Box({ key: `h-${title}`, flexDirection: 'row', columnGap: 2, children: [text(title, { bold: true, color: 'cyan' }), ...(aside ? [text(aside, { dimColor: true })] : [])] });
  const cells = (values, style = {}, key) =>
    Box({ key, flexDirection: 'row', children: values.map((v, i) => Box({ key: `c${i}`, width: COLS[i].width, children: [text(String(v), { ...style, wrap: 'truncate-end' })] })) });
  const files = map.reduce((n, m) => n + m.files.length, 0);
  const flagged = flaggedByModule(map, view.flagged ?? []);
  const table = map.length
    ? [
        cells(COLS.map((c) => c.title), { dimColor: true }, 'overview-head'),
        ...map.map((m, i) => {
          const { carded, total } = coverageOf(m);
          const style = i === selected ? { color: 'cyan', bold: true } : pulsing.has(m.id) ? { color: 'blue', bold: true } : flagged.has(m.id) ? { color: 'red' } : {};
          return cells(
            [
              `${i === selected ? '› ' : '  '}${'  '.repeat(m.depth)}${shortName(m)}`,
              total ? `${String(carded).padStart(3)} of ${String(total).padEnd(4)}${bar(carded, total)}` : 'no files',
              rulesWords(m),
              m.decisions.length,
              lastDecision(m.decisions, now),
            ],
            style,
            `module-${m.id}`,
          );
        }),
      ]
    : [text('No modules in the graph yet.', { dimColor: true })];
  const m = map[selected] ?? null;
  const detail = m ? moduleDetail(m, map, { flagged: flagged.get(m.id) ?? [], proposals: proposals.filter((p) => p.module === m.id), now }, els, handlers) : [];
  return [
    heading('WHAT IT KNOWS', `${plural(map.length, 'module', 'modules')} · ${plural(files, 'file', 'files')}`),
    text("A file is explained when it has a current card: what it's for, what it relies on and what must stay true.", { dimColor: true }),
    ...table,
    ...detail,
    text(m ? 'Enter lists its files.' : 'j/k choose a module; Enter lists its files.', { dimColor: true }),
    ...(working.length ? [heading('WORKING NOW'), ...working] : []),
  ];
}

/** The selected module's detail under the table. */
function moduleDetail(m, map, { flagged, proposals, now }, { Box, Text, Button }, { onRatify, onDrop, onDefer }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const { carded, total } = coverageOf(m);
  const name = (id) => shortName(map.find((x) => x.id === id) ?? { id });
  const imports = importEdges(map).filter((e) => e.from === m.id);
  const importedBy = importEdges(map).filter((e) => e.to === m.id);
  const agreed = (m.ruleList ?? []).filter((r) => r.mode !== 'G?');
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
            text(`${shortName(m)} (${m.id})`, { bold: true }),
            text(`${carded} of ${total} files explained`, { dimColor: true }),
            ...(m.decisions.length ? [text(`${plural(m.decisions.length, 'decision', 'decisions')} ${spark(m.decisions, now, 10, 3)}`, { color: 'blue' })] : []),
          ],
        }),
        ...agreed.map((r) => text(`rule: ${r.text}`, { key: `rule-${r.id}`, wrap: 'truncate-end' })),
        ...(m.parents.length > 1 ? [text(`part of ${m.parents.map(name).join(', ')}`, { dimColor: true })] : []),
        ...(imports.length ? [text(`uses ${imports.map((e) => name(e.to)).join(', ')}`, { dimColor: true, wrap: 'truncate-end' })] : []),
        ...(importedBy.length ? [text(`used by ${importedBy.map((e) => name(e.from)).join(', ')}`, { dimColor: true, wrap: 'truncate-end' })] : []),
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
              text(`proposed: ${p.text}`, { wrap: 'truncate-end' }),
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
