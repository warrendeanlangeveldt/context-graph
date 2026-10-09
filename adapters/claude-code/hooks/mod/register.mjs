// The Context Graph mod: the graph in the session, for the person. It shows and acts, and never
// enforces: the settings hooks beside it do that, in every session and harness. Claude Code before
// 2.1.287 doesn't load this module and runs those hooks as before.
//
// Everything it shows comes from the ctx CLI's JSON (`info`, `file`, `proposals`, `agents`), run in the
// session's folder; what it draws is built by the pure functions in view.mjs. It acts only on the
// person's presses: ratifying with a commit, and dropping a proposal. The hooks refuse both commands
// from every agent, so no agent reaches them.
import { DROP_ID, NO_GRAPH, PANE_ID, bandLine, contextPane, dropPane, followedPath, parseJson } from './view.mjs';
import { SETTINGS_ID, settingsView } from './views/settings.mjs';

let model = {
  kind: null,
  root: null,
  proposals: [],
  file: null,
  agents: [],
  types: {},
  notice: null,
};
let followed = null; // the file the pane follows: { path, agentId }
let activity = 0; // tool calls seen: coverage changes with them
let dropping = null; // the open Drop confirmation: { proposal, reason, error }
let act = null; // the session's actions, made at session start
let settingRows = []; // the harness settings, from `ctx settings --json`
let pendingSetting = null; // a change waiting for the person's reason: { key, value, reason, error }

export function register(on) {
  on('session.start', async ($, e, next) => {
    // A name another command already holds is refused; the rest of the mod goes on without it.
    await $.command
      .register({
        name: 'graph',
        description: 'Context Graph: the file being worked on, proposals to ratify, coverage per agent',
        immediate: true,
      })
      .catch((err) => $.ui.log(`Context Graph: /graph isn't available in this session: ${err?.message ?? err}`));
    await $.command
      .register({ name: 'graph-settings', description: "Context Graph's harness: the card writer, curator and side questions", immediate: true })
      .catch((err) => $.ui.log(`Context Graph: /graph-settings isn't available in this session: ${err?.message ?? err}`));
    const cli = `${$.plugin.root}/ctx.mjs`;
    const cwd = e.cwd ?? (await $.session.cwd());
    const session = await $.session.id();
    const json = async (...args) => {
      const ran = await $.process.run(['node', cli, ...args, '--json'], {
        cwd,
      });
      return ran.exitCode === 0 ? parseJson(ran.stdout) : null;
    };
    const stamp = async (path) => {
      const s = await $.fs.stat(path).catch(() => null);
      return s ? `${path}@${s.mtimeMs}` : `${path}-`;
    };
    const firstLine = (ran) => `${ran.stdout}\n${ran.stderr}`.trim().split('\n').filter(Boolean).at(-1) ?? '';

    act = {
      // Everything the pane and the band show, read again.
      reload: async () => {
        const info = await json('info');
        if (!info?.graphDir) {
          model = {
            ...model,
            kind: 'none',
            root: info?.root ?? cwd,
            proposals: [],
            file: null,
            agents: [],
          };
          $.ui.invalidate('ui.render');
          return;
        }
        const types = {};
        for (const a of await $.agent.list()) types[a.id] = a.type;
        const proposals = (await json('proposals')) ?? [];
        const agents = (await json('agents', '--session', session)) ?? [];
        const file = followed
          ? await json('file', followed.path, '--session', session, ...(followed.agentId ? ['--agent', followed.agentId] : []))
          : null;
        model = {
          ...model,
          kind: 'graph',
          root: info.root,
          graphDir: info.graphDir,
          proposals,
          agents,
          file,
          types,
        };
        $.ui.invalidate('ui.render');
      },
      // What a refresh waits on: the graph's files, the followed file, and the session's tool calls.
      fingerprint: async () => {
        const dir = model.graphDir ?? `${cwd}/.ctx`;
        const files = ['graph.ctx', 'proposals.ctx', 'decisions.ctx', 'cards.ctx', 'config.toml'];
        const stamps = [];
        for (const f of files) stamps.push(await stamp(`${dir}/${f}`));
        return [...stamps, followed?.path ?? '', followed?.agentId ?? '', activity].join('\n');
      },
      // FILE-1: /graph opens the pane, or close it when it's open.
      toggle: async () => {
        if ((await $.ui.panes()).some((p) => p.id === PANE_ID)) {
          await $.ui.close({ id: PANE_ID });
          return {};
        }
        await act.reload();
        if (model.kind === 'none') return { text: NO_GRAPH };
        await $.ui.open({
          id: PANE_ID,
          title: 'Context',
          focus: true,
          closeOnEscape: true,
        });
        return {};
      },
      open: async () => {
        await act.reload();
        await $.ui.open({
          id: PANE_ID,
          title: 'Context',
          focus: true,
          closeOnEscape: true,
        });
      },
      // FILE-4: code-kit's Lanes pane, when code-kit's mod is there.
      lanes: async () => {
        await $.command.run({ command: 'lanes', args: '' }).catch(() => null);
      },
      // Cards: asked of the lead, which writes them with the cards skill or hands them to the agent
      // working on those files. Not a person's act: any agent may write a card, and the hooks ask the
      // agent that edits a file for its card anyway.
      askForCards: async (scope, what) => {
        await $.prompt.submit({
          text: `Write the Context Graph ${what}: run /context-graph:cards ${scope}, or ask the agent working on ${scope} to.`,
        });
        model = { ...model, notice: { ok: true, text: `Asked the lead for the ${what}.` } };
        $.ui.invalidate('ui.render');
      },
      // RAT-3: confirm, then ratify and commit only the graph with the person's trailer.
      ratify: async (proposal) => {
        const answer = await $.ui
          .ask(
            `Ratify ${proposal.id}? It becomes an agreed ${proposal.kind === 'concepts' ? 'concept' : 'rule'}, committed on this branch with your Ctx-Ratified-By trailer.`,
            ['Ratify', 'Cancel'],
          )
          .catch(() => 'Cancel');
        if (answer !== 'Ratify') return;
        const ran = await $.process.run(['node', cli, 'ratify', proposal.id, '--commit'], { cwd });
        model = {
          ...model,
          notice: {
            ok: ran.exitCode === 0,
            text: ran.exitCode === 0 ? `Ratified ${proposal.id}: ${firstLine(ran)}` : `Nothing ratified: ${firstLine(ran)}`,
          },
        };
        await act.reload();
      },
      // RAT-4: ask why, then drop it, keeping the reason in the graph.
      drop: async (proposal) => {
        dropping = { proposal, reason: '', error: null };
        await $.ui.open({
          id: DROP_ID,
          title: 'Drop',
          focus: true,
          closeOnEscape: true,
        });
        $.ui.invalidate('ui.render');
      },
      confirmDrop: async (reason) => {
        if (!dropping) return;
        if (!reason.trim()) {
          dropping = {
            ...dropping,
            error: 'Give a reason: the graph keeps it.',
          };
          $.ui.invalidate('ui.render');
          return;
        }
        const { proposal } = dropping;
        const ran = await $.process.run(['node', cli, 'drop', proposal.id, '--reason', reason.trim(), '--commit'], { cwd });
        if (ran.exitCode !== 0) {
          dropping = {
            ...dropping,
            error: `Nothing dropped: ${firstLine(ran)}`,
          };
          $.ui.invalidate('ui.render');
          return;
        }
        dropping = null;
        model = {
          ...model,
          notice: {
            ok: true,
            text: `Dropped ${proposal.id}: ${reason.trim()}`,
          },
        };
        await $.ui.close({ id: DROP_ID });
        await act.reload();
      },
      // VIEW-6: the harness settings; a change is the person's, confirmed with a reason.
      settings: async () => {
        if ((await $.ui.panes()).some((p) => p.id === SETTINGS_ID)) {
          await $.ui.close({ id: SETTINGS_ID });
          return {};
        }
        await act.reload();
        if (model.kind === 'none') return { text: NO_GRAPH };
        settingRows = (await json('settings')) ?? [];
        await $.ui.open({ id: SETTINGS_ID, title: 'Graph harness', focus: true, closeOnEscape: true });
        $.ui.invalidate('ui.render');
        return {};
      },
      chooseSetting: (key, value) => {
        const row = settingRows.find((x) => x.key === key);
        if (row && String(row.value) === value) return;
        pendingSetting = { key, value, reason: '', error: null };
        $.ui.invalidate('ui.render');
      },
      confirmSetting: async (reason) => {
        if (!pendingSetting) return;
        if (!reason?.trim()) {
          pendingSetting = { ...pendingSetting, error: 'Give a reason: it goes with the change.' };
          $.ui.invalidate('ui.render');
          return;
        }
        const ran = await $.process.run(['node', cli, 'settings', 'set', pendingSetting.key, pendingSetting.value, '--reason', reason.trim(), '--via', 'pane'], { cwd });
        if (ran.exitCode !== 0) {
          pendingSetting = { ...pendingSetting, error: firstLine(ran) };
          $.ui.invalidate('ui.render');
          return;
        }
        pendingSetting = null;
        settingRows = (await json('settings')) ?? settingRows;
        await act.reload();
      },
      cancelSetting: () => {
        pendingSetting = null;
        $.ui.invalidate('ui.render');
      },
      cancelDrop: async () => {
        dropping = null;
        await $.ui.close({ id: DROP_ID });
      },
    };

    // FILE-1 and COV-2: within 2 seconds of a change; with none, read again every minute.
    let seen = null;
    let quiet = 0;
    let busy = false;
    $.clock.every(2000, async () => {
      if (busy) return;
      busy = true;
      try {
        const now = await act.fingerprint();
        quiet += 1;
        if (now === seen && quiet < 30) return;
        quiet = 0;
        await act.reload();
        seen = await act.fingerprint();
      } finally {
        busy = false;
      }
    });
    return next(e);
  });

  on('command.run', { command: 'graph-settings' }, async ($, e) =>
    act ? act.settings() : { text: 'Context Graph is still starting; try /graph-settings again in a moment.' },
  );

  on('command.run', { command: 'graph' }, async ($, e) =>
    act
      ? act.toggle()
      : {
          text: 'Context Graph is still starting; try /graph again in a moment.',
        },
  );

  // FILE-1: the pane follows the file an agent last read, edited or wrote. It only watches.
  on('tool.call', async ($, e, next) => {
    const res = await next(e);
    activity += 1;
    const path = model.root ? followedPath(e, model.root) : null;
    if (path) followed = { path, agentId: e.agentId ?? null };
    return res;
  }).catch(($, e, next) => next(e)); // whatever fails here, the call goes on as it would

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const view = {
      ...model,
      followed: followed && {
        ...followed,
        agentType: followed.agentId ? (model.types[followed.agentId] ?? null) : null,
      },
    };
    return contextPane(view, $.ui.resolve(e), {
      onRatify: (p) => act.ratify(p),
      onDrop: (p) => act.drop(p),
      onLanes: () => act.lanes(),
      onWriteCard: (path) => act.askForCards(path, `card for ${path}`),
      onModuleCards: (module) => act.askForCards(module, `cards for the files in ${module} without a current one`),
    });
  });

  on('ui.render', { component: 'Pane', requestId: SETTINGS_ID }, async ($, e) =>
    settingsView(settingRows, pendingSetting, $.ui.resolve(e), {
      onChoose: (key, value) => act.chooseSetting(key, value),
      onReason: (value) => {
        if (pendingSetting) pendingSetting = { ...pendingSetting, reason: value };
        $.ui.invalidate('ui.render');
      },
      onConfirm: (reason) => act.confirmSetting(reason),
      onCancel: () => act.cancelSetting(),
    }),
  );

  on('ui.render', { component: 'Pane', requestId: DROP_ID }, async ($, e) => {
    const { Text } = $.ui.resolve(e);
    if (!dropping) return Text({ dimColor: true, children: ['Nothing to drop.'] });
    return dropPane(dropping, $.ui.resolve(e), {
      onInput: (value) => {
        dropping = { ...dropping, reason: value };
        $.ui.invalidate('ui.render');
      },
      onSubmit: (value) => act.confirmDrop(value),
      onCancel: () => act.cancelDrop(),
    });
  });

  // RAT-2: one line while proposals wait, above whatever else the band holds (another plugin's, or
  // Claude Code's own), so the two mods' lines stand together.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const line = model.kind === 'graph' ? bandLine(model.proposals) : null;
    if (!line || !act) return next(e);
    const { Box, Text, Button } = $.ui.resolve(e);
    const below = await next(e);
    return Box({
      flexDirection: 'column',
      children: [
        Box({
          key: 'band-context-graph',
          flexDirection: 'row',
          columnGap: 2,
          children: [
            Text({ color: 'cyan', children: ['Context Graph'] }),
            Text({ children: [line.text] }),
            Button({
              key: 'band-context',
              label: 'Context',
              onPress: () => act.open(),
            }),
          ],
        }),
        ...(below ? [below] : []),
      ],
    });
  });
}
