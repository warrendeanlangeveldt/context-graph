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

/** FILE-2 to FILE-4: the followed file. */
function fileSection(followed, file, { Box, Text, Button }, { onLanes }) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!followed)
    return [
      text('No file yet: the pane follows the files agents read and edit.', {
        dimColor: true,
      }),
    ];
  if (!file) return [text(`${followed.path} · ${who(followed.agentType)}`, { bold: true }), text('Reading it…', { dimColor: true })];
  const rows = [text(`${file.path} · ${who(followed.agentType)}`, { bold: true })];
  rows.push(
    file.card
      ? text(`Card (${file.card.fresh ? 'current' : 'stale'}): ${file.card.text}`, file.card.fresh ? {} : { color: 'yellow' })
      : text('No card yet', { dimColor: true }),
  );
  rows.push(
    file.understood.ok
      ? text('Understood: yes', { color: 'green' })
      : text(`Not understood yet: still to read ${file.understood.missing.map((m) => m.path).join(', ')}`, { color: 'yellow' }),
  );
  if (file.chain.length) rows.push(text(`Module: ${file.chain.join(' › ')}`, { dimColor: true }));
  for (const r of file.rules)
    rows.push(text(`Rule ${r.id} (${r.mode === 'G?' ? 'proposed' : r.test ? 'enforced' : 'guidance'}): ${r.text}`));
  for (const d of file.decisions) rows.push(text(`${d.date} ${d.who}: ${d.text}`, { dimColor: true }));
  // FILE-4: what a tool sharing the repository says of the file (code-kit: lane, layer, requirement).
  if (file.tools?.lines?.length)
    rows.push(
      Box({
        key: 'tools',
        flexDirection: 'column',
        children: [
          ...file.tools.lines.map((l) => text(l, { dimColor: true })),
          Button({
            key: 'open-lanes',
            label: 'Lanes',
            plain: true,
            onPress: onLanes,
          }),
        ],
      }),
    );
  return rows;
}

/** RAT-1: every proposal with its evidence, and Ratify and Drop. */
function proposalsSection(proposals, { Box, Text, Button }, { onRatify, onDrop }) {
  if (!proposals.length) return [Text({ dimColor: true, children: ['No proposals waiting.'] })];
  return proposals.map((p) =>
    Box({
      key: `proposal-${p.id}`,
      flexDirection: 'column',
      children: [
        Text({
          children: [`${p.id} (${p.kind}${p.module ? `, ${p.module}` : ''}): ${p.text}`],
        }),
        Box({
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({
              dimColor: true,
              children: [
                `served ${p.served}, overridden ${p.overridden}${p.violations !== null ? `, ${plural(p.violations, 'violation', 'violations')}` : ''}`,
              ],
            }),
            Button({
              key: `ratify-${p.id}`,
              label: 'Ratify',
              onPress: () => onRatify(p),
            }),
            Button({
              key: `drop-${p.id}`,
              label: 'Drop',
              onPress: () => onDrop(p),
            }),
          ],
        }),
      ],
    }),
  );
}

/** COV-1 and COV-3: each agent's coverage, with edits made without understanding marked. */
function coverageSection(agents, types, { Box, Text }) {
  if (!agents.length)
    return [
      Text({
        dimColor: true,
        children: ['Nothing read or edited yet this session.'],
      }),
    ];
  return agents.map((a) =>
    Box({
      key: `agent-${a.agent}`,
      flexDirection: 'column',
      children: [
        Text({
          children: [
            `${a.agent === 'main' ? 'the main session' : (a.agentType ?? types[a.agent] ?? a.agent)}: read ${a.read.length}, searched ${a.searched.length}, edited ${a.edited.length}${a.cardsOwed.length ? `, ${plural(a.cardsOwed.length, 'card', 'cards')} owed` : ''}`,
          ],
        }),
        ...a.edited.map((e) =>
          e.understood
            ? Text({
                dimColor: true,
                children: [`  edited ${e.path}, understood first`],
              })
            : Text({
                color: 'yellow',
                children: [`  ! edited ${e.path} without understanding: unread ${e.missing.join(', ')}`],
              }),
        ),
      ],
    }),
  );
}

/** The Context pane: the followed file, proposals, coverage, and what the person's last act did. */
export function contextPane(model, els, handlers) {
  const { Box, Text } = els;
  if (!model || model.kind === 'none') return Text({ dimColor: true, children: [NO_GRAPH] });
  const heading = (value) => Text({ bold: true, children: [value] });
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      ...(model.notice
        ? [
            Text({
              color: model.notice.ok ? 'green' : 'red',
              children: [model.notice.text],
            }),
          ]
        : []),
      Box({
        key: 'file',
        flexDirection: 'column',
        children: fileSection(model.followed, model.file, els, handlers),
      }),
      Box({
        key: 'proposals',
        flexDirection: 'column',
        children: [heading('Proposals'), ...proposalsSection(model.proposals, els, handlers)],
      }),
      Box({
        key: 'coverage',
        flexDirection: 'column',
        children: [heading('Coverage'), ...coverageSection(model.agents, model.types ?? {}, els)],
      }),
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
