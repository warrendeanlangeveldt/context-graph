// What the Context Graph mod shows, as pure functions of the ctx CLI's JSON: the mod's hooks run the CLI
// and pass its output here, with the elements `$.ui.resolve` gives them. Nothing here touches the mods
// API, files or processes, so it is tested with vitest (src/mod/view.test.ts) as well as with
// `claude plugin test`.

import { DEFAULT_UI, frame, healthOf } from './views/frame.mjs';
import { proposalsQueue, queueKeys } from './views/proposals.mjs';
import { progressText } from './views/assist.mjs';

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

const who = (agentType) => agentType ?? 'the main session';

// The pane's layout: a heading per section, then rows of a fixed-width label and its value.
const LABEL = 12;

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

const ruleKind = (r) => (r.mode === 'G?' ? 'proposed' : r.test ? 'enforced' : 'guidance');

/** FILE-2 to FILE-4: the followed file. */
/** Each rule kind's chip (VIEW-2): its word on a background colour. */
const CHIP = { enforced: 'red', guidance: 'blue', proposed: 'yellow' };
/** A neighbour's card as a glyph (VIEW-2), readable without colour. */
const CARD_GLYPH = { current: '●', stale: '◐', missing: '○', exempt: '·' };

/** VIEW-2: what the file imports and what imports it, each a press away, uncarded and rule-breaking ones marked. */
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
                label: `${CARD_GLYPH[x.card]} ${x.path}${x.breaks.length ? ` ✗ ${x.breaks.join(', ')}` : ''}`,
                plain: true,
                ...(x.card === 'current' && !x.breaks.length ? { dimColor: true } : {}),
                onPress: () => onNeighbour(x.path),
              }),
            )
          : [Text({ dimColor: true, children: ['none'] })]),
      ],
    });
  return Box({
    key: 'neighbours',
    flexDirection: 'row',
    columnGap: 2,
    children: [
      side('imports', n.imports, 'imports'),
      Text({ children: [`→ ${n.path} ←`] }),
      side('imported by', n.importers, 'importers'),
    ],
  });
}

function fileSection(followed, file, els, { onLanes, onWriteCard, onModuleCards, onNeighbour = () => {} }, near = null) {
  const { Box, Button } = els;
  const { text, heading, row } = layout(els);
  const by = followed ? `${followed.agentType ? `last touched by ${followed.agentType}` : 'last touched by the main session'}` : null;
  if (!followed) return [heading('File'), text('No file yet. The pane follows the file an agent last reads or edits.', { dimColor: true })];
  if (!file) return [heading('File', by), row('Path', followed.path, { bold: true }), text('Reading it…', { dimColor: true })];
  const rows = [heading('File', by), row('Path', file.path, { bold: true })];
  // A card to write, or one gone stale, is a press away: the lead runs the cards skill on the file.
  const cardButton = (label) => Button({ key: 'write-card', label, onPress: () => onWriteCard(file.path) });
  rows.push(
    file.card?.fresh
      ? row('Card', els.Markdown ? els.Markdown({ key: 'card', text: file.card.text }) : text(file.card.text))
      : row(
          'Card',
          Box({
            flexDirection: 'column',
            children: [
              file.card
                ? text(`${file.card.text}  (stale: the file changed since)`, { color: 'yellow' })
                : text('No card yet.', { dimColor: true }),
              cardButton(file.card ? 'Update card' : 'Write card'),
            ],
          }),
        ),
  );
  rows.push(
    file.understood.ok
      ? row('Understood', '✓ yes', { color: 'green' })
      : row('Understood', `✗ not yet: still to read ${file.understood.missing.map((m) => m.path).join(', ')}`, { color: 'yellow' }),
  );
  if (file.chain.length)
    rows.push(
      row(
        'Module',
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            text(file.chain.join(' › ')),
            Button({ key: 'module-cards', label: 'Cards for this module', plain: true, onPress: () => onModuleCards(file.chain[0]) }),
          ],
        }),
      ),
    );
  rows.push(
    row(
      'Rules',
      file.rules.length
        ? Box({
            flexDirection: 'column',
            children: file.rules.map((r) =>
              Box({
                flexDirection: 'row',
                columnGap: 1,
                children: [
                  text(` ${ruleKind(r)} `, { backgroundColor: CHIP[ruleKind(r)], color: 'black' }),
                  text(r.id, { bold: true }),
                  text(r.text),
                ],
              }),
            ),
          })
        : 'none',
      { dimColor: true },
    ),
  );
  rows.push(
    row(
      'Decisions',
      file.decisions.length
        ? Box({ flexDirection: 'column', children: file.decisions.map((d) => text(`${d.date}  ${d.text}  (${d.who})`)) })
        : 'none recorded yet',
      { dimColor: true },
    ),
  );
  if (near?.path === file.path)
    rows.push(row('Neighbours', neighbourhood(near, els, onNeighbour)));
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

/** COV-1 and COV-3: each agent's coverage as a table, with edits made without understanding marked; the selected agent marked (VIEW-5). */
function coverageSection(agents, types, els, selected = -1, assists = []) {
  const { Box } = els;
  const { text, heading } = layout(els);
  if (!agents.length && !assists.length) return [heading('Coverage'), text('Nothing read or edited yet this session.', { dimColor: true })];
  const name = (a) => (a.agent === 'main' ? 'main session' : (a.agentType ?? types[a.agent] ?? a.agent));
  const width = Math.max(14, ...agents.map((a) => name(a).length + 2));
  const cells = (values, style = {}) =>
    Box({
      flexDirection: 'row',
      children: values.map((v, i) => Box({ width: i === 0 ? width : 10, children: [text(String(v), style)] })),
    });
  // Every edit with its state; one made without understanding stands out, with what was unread (COV-3).
  const marked = agents.flatMap((a) =>
    a.edited.map((e) =>
      e.understood
        ? text(`✓ ${name(a)} edited ${e.path}, understood first`, { dimColor: true })
        : text(`✗ ${name(a)} edited ${e.path} without understanding it: ${e.missing.join(', ')} unread`, { color: 'yellow' }),
    ),
  );
  return [
    heading('Coverage', 'this session'),
    cells(['agent', 'read', 'searched', 'edited', 'cards owed'], { dimColor: true }),
    ...agents.map((a, i) =>
      Box({
        key: `agent-${a.agent}`,
        children: [cells([`${i === selected ? '› ' : ''}${name(a)}`, a.read.length, a.searched.length, a.edited.length, a.cardsOwed.length], i === selected ? { color: 'cyan' } : {})],
      }),
    ),
    ...marked,
    // ASSIST-2: each reading list a refused edit gave, with the agent's progress through it.
    ...assists.map((x) =>
      text(`${progressText(x, x.missing) === 'understood' ? '✓' : '…'} ${x.agentId ? (types[x.agentId] ?? x.agentId) : 'main session'} reading to edit ${x.edit}: ${progressText(x, x.missing)}`, {
        key: `reading-${x.id}`,
        ...(progressText(x, x.missing) === 'understood' ? { dimColor: true } : { color: 'yellow' }),
      }),
    ),
  ];
}

/**
 * The Context pane (spec 09): the graph's health, the tabs (the followed file, the proposals, each
 * agent's coverage) and the keys. `model.ui` is the pane's own state; `model.health` is healthOf's.
 */
export function contextPane(model, els, handlers) {
  const { Text } = els;
  if (!model || model.kind === 'none') return Text({ dimColor: true, children: [NO_GRAPH] });
  const ui = model.ui ?? DEFAULT_UI;
  const body = (tab) =>
    tab === 'proposals'
      ? proposalsQueue(model.proposals, els, handlers, { selected: ui.selected, deferred: model.deferred ?? new Set(), now: model.now })
      : tab === 'coverage'
        ? coverageSection(model.agents, model.types ?? {}, els, ui.selected, model.assists ?? [])
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
        children: [`Drop ${dropping.proposal.id}: ${dropping.proposal.text}`],
      }),
      Text({
        children: ["Why is it turned down? The graph keeps the reason, so it isn't proposed again blindly."],
      }),
      Input({
        key: 'drop-reason',
        label: 'Reason',
        value: dropping.reason,
        placeholder: 'not how we work',
        submitLabel: 'Drop',
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
            label: 'Drop',
            onPress: () => onSubmit(dropping.reason),
          }),
          Button({ key: 'drop-cancel', label: 'Cancel', onPress: onCancel }),
        ],
      }),
    ],
  });
}
