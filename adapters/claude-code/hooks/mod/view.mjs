// What the Context Graph mod shows, as pure functions of the ctx CLI's JSON: the mod's hooks run the CLI
// and pass its output here, with the elements `$.ui.resolve` gives them. Nothing here touches the mods
// API, files or processes, so it is tested with vitest (src/mod/view.test.ts) as well as with
// `claude plugin test`.

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

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const who = (agentType) => agentType ?? 'the main session';

/** The band's line (RAT-2): proposals waiting, or nothing. */
export function bandLine(proposals) {
  const n = proposals?.length ?? 0;
  return n ? { text: `${plural(n, 'proposal', 'proposals')} to ratify` } : null;
}

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
const evidence = (p) => {
  const parts = [];
  if (p.served) parts.push(`served by ${plural(p.served, 'decision', 'decisions')}`);
  if (p.overridden) parts.push(`overridden by ${plural(p.overridden, 'decision', 'decisions')}`);
  if (p.violations) parts.push(`${plural(p.violations, 'file breaks', 'files break')} it now`);
  else if (p.violations === 0) parts.push('no file breaks it');
  return parts.length ? parts.join(', ') : 'no decision has cited it yet';
};

/** FILE-2 to FILE-4: the followed file. */
function fileSection(followed, file, els, { onLanes, onWriteCard, onModuleCards }) {
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
      ? row('Card', file.card.text)
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
                  text(r.id, { bold: true }),
                  text(r.text),
                  text(`(${ruleKind(r)})`, ruleKind(r) === 'proposed' ? { color: 'yellow' } : { dimColor: true }),
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

/** RAT-1: every proposal with its evidence, and Ratify and Drop. */
function proposalsSection(proposals, els, { onRatify, onDrop }) {
  const { Box, Button } = els;
  const { text, heading } = layout(els);
  if (!proposals.length) return [heading('Proposals'), text('None waiting.', { dimColor: true })];
  return [
    heading('Proposals', `${plural(proposals.length, 'waits', 'wait')} for you to ratify or drop`),
    ...proposals.map((p) =>
      Box({
        key: `proposal-${p.id}`,
        flexDirection: 'column',
        borderStyle: 'round',
        paddingX: 1,
        children: [
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              text(p.id, { bold: true }),
              text(`${p.kind === 'concepts' ? 'concept' : `rule (${p.kind})`}${p.module ? ` on ${p.module}` : ''}`, { dimColor: true }),
            ],
          }),
          text(p.text),
          text(`Evidence: ${evidence(p)}`, { dimColor: true }),
          Box({
            flexDirection: 'row',
            columnGap: 2,
            children: [
              Button({ key: `ratify-${p.id}`, label: 'Ratify', onPress: () => onRatify(p) }),
              Button({ key: `drop-${p.id}`, label: 'Drop…', onPress: () => onDrop(p) }),
            ],
          }),
        ],
      }),
    ),
  ];
}

/** COV-1 and COV-3: each agent's coverage as a table, with edits made without understanding marked. */
function coverageSection(agents, types, els) {
  const { Box } = els;
  const { text, heading } = layout(els);
  if (!agents.length) return [heading('Coverage'), text('Nothing read or edited yet this session.', { dimColor: true })];
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
    ...agents.map((a) =>
      Box({
        key: `agent-${a.agent}`,
        children: [cells([name(a), a.read.length, a.searched.length, a.edited.length, a.cardsOwed.length])],
      }),
    ),
    ...marked,
  ];
}

/** The Context pane: the followed file, proposals, coverage, and what the person's last act did. */
export function contextPane(model, els, handlers) {
  const { Box, Text } = els;
  if (!model || model.kind === 'none') return Text({ dimColor: true, children: [NO_GRAPH] });
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      ...(model.notice ? [Text({ color: model.notice.ok ? 'green' : 'red', children: [model.notice.text] })] : []),
      Box({ key: 'file', flexDirection: 'column', children: fileSection(model.followed, model.file, els, handlers) }),
      Box({ key: 'proposals', flexDirection: 'column', children: proposalsSection(model.proposals, els, handlers) }),
      Box({ key: 'coverage', flexDirection: 'column', children: coverageSection(model.agents, model.types ?? {}, els) }),
      Text({ dimColor: true, children: ['Esc or /graph closes the pane.'] }),
    ],
  });
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
