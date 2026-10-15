// The Overview tab (docs/specs/08-graph-explorer.md, MAP-4): how much of the code is explained and what
// the card writer is doing about the rest (CARDW-8), then the modules: a row per module with how many of
// its files are explained, its rules and its decisions, or one line when the graph has only the whole
// repository. A module where a decision was just recorded is drawn blue, and one whose rule the team
// keeps overriding red. Pure: the mod passes `ctx map --json`, the flagged rules, the waiting proposals,
// the explain status and the selection.
import { spark } from './proposals.mjs';

const DAY = 24 * 3600000;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** A module's files explained: { carded, total }. */
export const coverageOf = (m) => ({ carded: m.files.filter((f) => f.card === 'current').length, total: m.files.length });

/** A module's name as the table shows it: its id without `L:` and any parent's prefix ("L:adapters.parsers" → "parsers"). */
export const shortName = (m) => m.id.replace(/^L:/, '').split(/[./]/).at(-1);

/** The share explained as a bar of `cells` cells (five in the table). */
export const bar = (carded, total, cells = 5) => {
  const full = total ? Math.round((carded / total) * cells) : 0;
  return '█'.repeat(full) + '░'.repeat(cells - full);
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

const TONE = { busy: { color: 'cyan' }, waiting: {}, held: { color: 'yellow' }, quiet: { dimColor: true } };
const ACT_LABEL = { pause: 'Pause', resume: 'Resume', settings: 'Settings' };

/**
 * CARDW-8: the Overview's first section: how much of the code is explained, as one count and a bar, and
 * the one thing the card writer is doing about the rest, with its button; files it skipped as not code
 * are counted beneath, with Offer them again. `status` is explainStatus's. Handlers: onPauseBackfill,
 * onOfferAgain, onSettings.
 */
export function explainSection(status, els, handlers = {}) {
  const { Box, Text, Button } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!status) return [];
  const { explained, total } = status;
  const share = total ? Math.round((explained / total) * 100) : 0;
  const press = {
    pause: handlers.onPauseBackfill,
    resume: handlers.onPauseBackfill,
    settings: handlers.onSettings,
  }[status.act];
  const row = (key, children) => Box({ key, flexDirection: 'row', columnGap: 2, children });
  return [
    row('explain-count', [
      text('FILES EXPLAINED', { bold: true, color: 'cyan' }),
      text(`${explained} of ${total}`, { bold: true }),
      text(`${bar(explained, total, 10)} ${share}%`, { dimColor: true }),
    ]),
    row('explain-now', [
      text(status.line, TONE[status.tone] ?? {}),
      ...(press ? [Button({ key: `explain-${status.act}`, label: ACT_LABEL[status.act], plain: true, onPress: press })] : []),
    ]),
    ...(status.skipped
      ? [
          row('explain-skipped', [
            text(`Skipped ${status.skipped === 1 ? "1 file that isn't code" : `${status.skipped} files that aren't code`} this session.`, { dimColor: true }),
            ...(handlers.onOfferAgain ? [Button({ key: 'offer-again', label: 'Offer them again', plain: true, onPress: handlers.onOfferAgain })] : []),
          ]),
        ]
      : []),
  ];
}

/**
 * MAP-6: folders with code the graph maps only to the whole repository, with Add them as modules.
 */
function unmappedLine(unmapped, { Box, Text, Button }, onAddModules) {
  if (!unmapped.length) return [];
  const one = unmapped.length === 1;
  const names = `${unmapped.slice(0, 3).join(', ')}${unmapped.length > 3 ? ', …' : ''}`;
  return [
    Box({
      key: 'unmapped',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        Text({ color: 'yellow', children: [`${one ? 'A folder' : 'Folders'} with code that could be ${one ? 'a module' : 'modules'}: ${names}.`] }),
        ...(onAddModules ? [Button({ key: 'add-modules', label: one ? 'Add it as a module' : 'Add them as modules', plain: true, onPress: onAddModules })] : []),
      ],
    }),
  ];
}

/**
 * MAP-4: the Overview: how much is explained and what's being done about it (CARDW-8), then the
 * modules. With one module (the whole repository) there's no table to read, so it says so in a line,
 * with the folders that could be modules (MAP-6); with more, a row per module, indented under its
 * parent, and the selected one's detail. `view`: { selected, flagged (hygiene's), pulsing (Set),
 * proposals, now, explain (explainStatus's), unmapped }. Handlers: onAddModules, onTab, and
 * explainSection's.
 */
export function overview(map, els, view = {}, handlers = {}) {
  const { Box, Text } = els;
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const { selected = -1, pulsing = new Set(), proposals = [], now = Date.now(), explain = null, unmapped = [] } = view;
  const heading = (title, aside) =>
    Box({ key: `h-${title}`, flexDirection: 'row', columnGap: 2, children: [text(title, { bold: true, color: 'cyan' }), ...(aside ? [text(aside, { dimColor: true })] : [])] });
  const decisions = map.reduce((n, m) => n + m.decisions.length, 0);
  const lastAny = lastDecision(map.flatMap((m) => m.decisions), now);
  const flagged = flaggedByModule(map, view.flagged ?? []);
  const cells = (values, style = {}, key) =>
    Box({ key, flexDirection: 'row', children: values.map((v, i) => Box({ key: `c${i}`, width: COLS[i].width, children: [text(String(v), { ...style, wrap: 'truncate-end' })] })) });
  const modules =
    map.length <= 1
      ? [
          text(
            map.length
              ? `The graph treats the whole repository as one module, so every rule and decision applies everywhere. ${rulesWords(map[0]) === 'none' ? 'No rules' : `Rules: ${rulesWords(map[0])}`} · ${plural(decisions, 'decision', 'decisions')}${decisions ? `, the last ${lastAny}` : ''}.`
              : 'No modules in the graph yet.',
            { dimColor: true },
          ),
        ]
      : [
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
          ...(map[selected] ? moduleDetail(map[selected], map, { flagged: flagged.get(map[selected].id) ?? [], proposals: proposals.filter((p) => p.module === map[selected].id), now }, els) : []),
        ];
  return [
    ...explainSection(explain, els, handlers),
    heading('MODULES', map.length > 1 ? `${plural(map.length, 'module', 'modules')} · ${plural(decisions, 'decision', 'decisions')}; j/k choose one, o opens its files` : null),
    ...modules,
    ...unmappedLine(unmapped, els, handlers.onAddModules),
  ];
}

/** The selected module's detail under the table: its rules in words, its decisions, its neighbours, an overridden rule; proposals are counted, and reviewed in their tab. */
function moduleDetail(m, map, { flagged, proposals, now }, { Box, Text }) {
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
        ...(proposals.length ? [text(`${plural(proposals.length, 'proposed rule', 'proposed rules')} on it, in Rules to review (3)`, { color: 'yellow' })] : []),
      ],
    }),
  ];
}
