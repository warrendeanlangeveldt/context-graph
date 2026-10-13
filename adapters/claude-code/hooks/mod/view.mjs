// What the Context Graph mod shows, as pure functions of the ctx CLI's JSON: the mod's hooks run the CLI
// and pass its output here, with the elements `$.ui.resolve` gives them. Nothing here touches the mods
// API, files or processes, so it is tested with vitest (src/mod/view.test.ts) as well as with
// `claude plugin test`.

import { DEFAULT_UI, frame, healthOf } from './views/frame.mjs';
import { proposalsQueue, queueKeys } from './views/proposals.mjs';
import { progressText } from './views/assist.mjs';
import { heatMap } from './views/map.mjs';
import { overview } from './views/overview.mjs';

export const PANE_ID = 'context-graph';
export const DROP_ID = 'context-graph-drop';
export const NO_GRAPH = 'No graph here yet: run /context-graph:init';

/** A CLI run's stdout as JSON, or null when it printed none. */
export function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The tools whose calls move the pane to a file (FILE-1). */
export const FOLLOWED_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

/** A tool call's file, relative to the repository, or null when it names none inside it. */
export function followedPath(call, root) {
  if (!FOLLOWED_TOOLS.has(call?.tool)) return null;
  const path = call.file_path ?? call.notebook_path;
  if (typeof path !== 'string' || !path) return null;
  if (!path.startsWith('/')) return path;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : null;
}

// The pane's layout: a heading per section, then rows of a fixed-width label and its value.
const LABEL = 16;

function layout({ Box, Text }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  const heading = (title, aside) =>
    Box({
      flexDirection: 'row',
      columnGap: 2,
      children: [text(title.toUpperCase(), { bold: true, color: 'cyan' }), ...(aside ? [text(aside, { dimColor: true })] : [])],
    });
  // One labelled row; the value is a node, or a string drawn in `style`.
  const row = (label, value, style = {}) =>
    Box({
      flexDirection: 'row',
      children: [
        Box({ width: LABEL, children: [text(label, { dimColor: true })] }),
        Box({ flexDirection: 'column', children: [typeof value === 'string' ? text(value, style) : value] }),
      ],
    });
  return { text, heading, row };
}

/** A rule's kind, in the words the pane uses (VIEW-2): agreed and checked, agreed as guidance, or proposed. */
const ruleKind = (r) => (r.mode === 'G?' ? 'proposed' : r.test ? 'enforced' : 'guidance');
const RULE_WORDS = { enforced: 'agreed, edits that break it are refused', guidance: 'agreed, agents are told it', proposed: 'proposed, not agreed yet' };
const RULE_COLOR = { enforced: 'red', guidance: 'green', proposed: 'yellow' };
/** A neighbour's card as a glyph (VIEW-2), readable without colour. */
const CARD_GLYPH = { current: '●', stale: '◐', missing: '○', exempt: '·' };
const CARD_WORDS = { current: '', stale: ' (out of date)', missing: ' (not explained)', exempt: '' };

/** VIEW-2: what the file uses and what uses it, each a press away; unexplained and rule-breaking ones marked. */
function neighbourhood(n, els, onNeighbour) {
  const { Box, Button, Text } = els;
  const side = (title, list, key) =>
    Box({
      key,
      flexDirection: 'column',
      children: [
        Text({ dimColor: true, children: [title] }),
        ...(list.length
          ? list.map((x) =>
              Button({
                key: `${key}-${x.path}`,
                label: `${CARD_GLYPH[x.card]} ${x.path}${CARD_WORDS[x.card]}${x.breaks.length ? ` ✗ breaks ${x.breaks.join(', ')}` : ''}`,
                plain: true,
                ...(x.card === 'current' && !x.breaks.length ? { dimColor: true } : {}),
                onPress: () => onNeighbour(x.path),
              }),
            )
          : [Text({ dimColor: true, children: ['nothing'] })]),
      ],
    });
  return Box({
    key: 'neighbours',
    flexDirection: 'row',
    columnGap: 4,
    children: [side('uses', n.imports, 'imports'), side('used by', n.importers, 'importers')],
  });
}

/** FILE-2 to FILE-4 and FILE-6: the followed file: why it exists, its rules, decisions, what editing it takes, and what it's connected to. */
function fileSection(followed, file, els, { onLanes, onWriteCard, onModuleCards, onNeighbour = () => {}, onWhy = null }, near = null) {
  const { Box, Button } = els;
  const { text, heading, row } = layout(els);
  const who = followed?.agentType ?? 'the main session';
  if (!followed)
    return [heading('This file'), text('No file yet. This tab follows the file an agent last read or changed, and shows what the graph knows about it.', { dimColor: true })];
  if (!file) return [heading('This file', `last touched by ${who}`), row('Path', followed.path, { bold: true }), text('Reading it…', { dimColor: true })];
  const rows = [
    heading('This file', `last touched by ${who}`),
    Box({
      key: 'file-path',
      flexDirection: 'row',
      columnGap: 2,
      children: [
        text(file.path, { bold: true }),
        ...(file.worktree ? [text(`in ${file.worktree}`, { dimColor: true })] : []),
        // ASKQ: a side question on the file in view.
        ...(onWhy ? [Button({ key: 'why-file', label: 'Ask why', hotkey: 'w', plain: true, onPress: () => onWhy(file.path) })] : []),
      ],
    }),
  ];
  // Its card is its why: written, or out of date, a press away from the card writer or the lead.
  const cardButton = (label) => Button({ key: 'write-card', label, onPress: () => onWriteCard(file.path) });
  rows.push(
    file.card?.fresh
      ? row('Why it exists', Box({ flexDirection: 'column', children: [els.Markdown ? els.Markdown({ key: 'card', text: file.card.text }) : text(file.card.text), text('up to date', { color: 'green' })] }))
      : row(
          'Why it exists',
          Box({
            flexDirection: 'column',
            children: [
              file.card
                ? text(`${file.card.text}  (out of date: the file changed since it was written)`, { color: 'yellow' })
                : text('Not explained yet: no card says what this file is for.', { color: 'yellow' }),
              cardButton(file.card ? 'Update its card' : 'Explain this file'),
            ],
          }),
        ),
  );
  rows.push(
    row(
      'Rules here',
      file.rules.length
        ? Box({
            flexDirection: 'column',
            children: file.rules.map((r) =>
              Box({
                key: `rule-${r.id}`,
                flexDirection: 'column',
                children: [text(`● ${r.text}`, { color: RULE_COLOR[ruleKind(r)] }), text(`  ${RULE_WORDS[ruleKind(r)]} · ${r.id}`, { dimColor: true })],
              }),
            ),
          })
        : 'none apply to it yet',
      { dimColor: true },
    ),
  );
  rows.push(
    row(
      'Decisions',
      file.decisions.length
        ? Box({ flexDirection: 'column', children: file.decisions.map((d) => text(`${d.date}  ${d.text}  (${d.who})`, { key: `decision-${d.id}` })) })
        : 'none recorded about it yet',
      { dimColor: true },
    ),
  );
  // FILE-3: what an agent has to have read before it may change the file.
  rows.push(
    file.understood.ok
      ? row('Before editing', `✓ ${who} understood it first: a current card, or a full read with what it imports`, { color: 'green' })
      : row('Before editing', `✗ ${who} still has to read ${file.understood.missing.map((m) => m.path).join(', ')}`, { color: 'yellow' }),
  );
  if (file.chain.length)
    rows.push(
      row(
        'Part of',
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            text(file.chain.map((id) => id.replace(/^L:/, '')).join(' › ')),
            Button({ key: 'module-cards', label: "Explain the module's files", plain: true, onPress: () => onModuleCards(file.chain[0]) }),
          ],
        }),
      ),
    );
  if (near?.path === file.path) rows.push(row('Connected to', neighbourhood(near, els, onNeighbour)));
  // FILE-4: what a tool sharing the repository says of the file (code-kit: lane, layer, requirement).
  if (file.tools?.lines?.length)
    rows.push(
      row(
        'code-kit',
        Box({
          key: 'tools',
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Box({ flexDirection: 'column', children: file.tools.lines.map((l) => text(l.replace(/^code-kit\s+/, ''))) }),
            Button({ key: 'open-lanes', label: 'Open Lanes', onPress: onLanes }),
          ],
        }),
      ),
    );
  return rows;
}

/** CUR-2: the agreed rules overridden again and again, with the decisions that overrode them, to reword or retire. */
function overriddenSection(flagged, els) {
  const { Box } = els;
  const { text, heading } = layout(els);
  if (!flagged.length) return [];
  return [
    heading('Overridden', 'agreed rules the team keeps overriding: reword or retire them'),
    ...flagged.map((f) =>
      Box({
        key: `flagged-${f.rule}`,
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: 'yellow',
        paddingX: 1,
        children: [text(f.rule, { bold: true }), ...f.evidence.map((e) => text(e, { dimColor: true })), text(f.proposal, { color: 'yellow' })],
      }),
    ),
  ];
}

/**
 * COV-1 and COV-3: did each agent understand code before changing it? A row per agent: the files it
 * changed, how many it understood first, and cards it still owes; then each change made without
 * understanding, with what was unread. The selected agent marked (VIEW-5).
 */
function agentsSection(agents, types, els, selected = -1, assists = []) {
  const { Box } = els;
  const { text, heading } = layout(els);
  const intro = text('An agent understands a file before changing it when it has a current card, or reads it in full with what it imports.', { dimColor: true });
  if (!agents.length && !assists.length) return [heading('Agents', 'this session'), intro, text('No agent has read or changed anything yet this session.', { dimColor: true })];
  const name = (a) => (a.agent === 'main' ? 'main session' : (a.agentType ?? types[a.agent] ?? a.agent));
  const width = Math.max(18, ...agents.map((a) => name(a).length + 4));
  const cells = (values, style = {}) =>
    Box({
      flexDirection: 'row',
      children: values.map((v, i) => Box({ width: i === 0 ? width : 18, children: [text(String(v), style)] })),
    });
  const blind = agents.flatMap((a) => a.edited.filter((e) => !e.understood).map((e) => ({ a, e })));
  return [
    heading('Agents', 'this session: did they understand code before changing it?'),
    intro,
    cells(['agent', 'files changed', 'understood first', 'cards owed'], { dimColor: true }),
    ...agents.map((a, i) => {
      const ok = a.edited.filter((e) => e.understood).length;
      const missed = a.edited.length - ok;
      return Box({
        key: `agent-${a.agent}`,
        children: [
          cells(
            [`${i === selected ? '› ' : ''}${name(a)}`, a.edited.length, a.edited.length ? (missed ? `${ok}  ✗ ${missed} not` : `${ok}  ✓`) : '-', a.cardsOwed.length],
            i === selected ? { color: 'cyan' } : missed ? { color: 'yellow' } : {},
          ),
        ],
      });
    }),
    // COV-3: each change made without understanding, with what was unread.
    ...blind.map(({ a, e }) => text(`✗ ${name(a)} changed ${e.path} without reading ${e.missing.join(', ')}`, { key: `blind-${a.agent}-${e.path}`, color: 'yellow' })),
    // ASSIST-2: each reading list a refused edit gave, with the agent's progress through it.
    ...assists.map((x) =>
      text(`${progressText(x, x.missing) === 'understood' ? '✓' : '…'} ${x.agentId ? (types[x.agentId] ?? x.agentId) : 'main session'} reading to change ${x.edit}: ${progressText(x, x.missing)}`, {
        key: `reading-${x.id}`,
        ...(progressText(x, x.missing) === 'understood' ? { dimColor: true } : { color: 'yellow' }),
      }),
    ),
  ];
}

/**
 * The Context pane (spec 09): what Context Graph is for, then its tabs: the Overview (how much is
 * explained and what's being done about the rest, then the modules), This file, Rules to review, and Agents.
 * `model.ui` is the pane's own state; `model.health` is healthOf's.
 */
export function contextPane(model, els, handlers) {
  const { Text } = els;
  if (!model || model.kind === 'none') return Text({ dimColor: true, children: [NO_GRAPH] });
  const ui = model.ui ?? DEFAULT_UI;
  const owed = new Set((model.agents ?? []).flatMap((a) => a.cardsOwed ?? []));
  const inMap = (tab) => (tab === 'map' && ui.mapModule ? (model.map ?? []).find((m) => m.id === ui.mapModule) : null);
  const body = (tab) =>
    tab === 'map'
      ? inMap(tab)
        ? heatMap(inMap(tab), owed, els, { selected: ui.selected }, handlers)
        : overview(
            model.map ?? [],
            els,
            {
              selected: ui.selected,
              flagged: model.flagged ?? [],
              pulsing: model.pulsing ?? new Set(),
              proposals: model.proposals ?? [],
              now: model.now,
              explain: model.explain ?? null,
              unmapped: model.unmapped ?? [],
            },
            handlers,
          )
      : tab === 'proposals'
        ? [
            ...proposalsQueue(model.proposals, els, handlers, { selected: ui.selected, deferred: model.deferred ?? new Set(), now: model.now }),
            ...overriddenSection(model.flagged ?? [], els),
            ...(model.curatorLine
              ? [
                  els.Box({
                    key: 'curator',
                    flexDirection: 'row',
                    columnGap: 2,
                    children: [
                      els.Text({ dimColor: true, children: [model.curatorLine] }),
                      ...(handlers.onCurate && !/off|reviewing/.test(model.curatorLine)
                        ? [els.Button({ key: 'curate-now', label: 'Curate now', plain: true, onPress: handlers.onCurate })]
                        : []),
                    ],
                  }),
                ]
              : []),
          ]
        : tab === 'coverage'
          ? agentsSection(model.agents, model.types ?? {}, els, ui.selected, model.assists ?? [])
          : fileSection(model.followed, model.file, els, handlers, model.neighbours ?? null);
  const keys =
    ui.tab === 'proposals' ? queueKeys(model.proposals, els, handlers, { selected: ui.selected, deferred: model.deferred ?? new Set() }) : [];
  return frame(
    { health: model.health ?? healthOf({ proposals: model.proposals.length }), notice: model.notice, ui, body, keys },
    els,
    handlers,
  );
}

/** RAT-4: the reason a proposal is dropped for, typed by the person. */
export function dropPane(dropping, { Box, Text, Input, Button }, { onInput, onSubmit, onCancel }) {
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      Text({
        bold: true,
        children: [`Reject ${dropping.proposal.id}: ${dropping.proposal.text}`],
      }),
      Text({
        children: ["Why isn't it a rule? It's removed, and the graph keeps your reason so it isn't proposed again blindly."],
      }),
      Input({
        key: 'drop-reason',
        label: 'Reason',
        value: dropping.reason,
        placeholder: 'not how we work',
        submitLabel: 'Reject',
        autoFocus: true,
        onInput,
        onSubmit,
      }),
      ...(dropping.error ? [Text({ color: 'red', children: [dropping.error] })] : []),
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: [
          Button({
            key: 'drop-confirm',
            label: 'Reject',
            onPress: () => onSubmit(dropping.reason),
          }),
          Button({ key: 'drop-cancel', label: 'Cancel', onPress: onCancel }),
        ],
      }),
    ],
  });
}
