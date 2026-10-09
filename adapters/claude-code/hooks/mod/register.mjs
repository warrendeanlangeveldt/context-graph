// The Context Graph mod: the graph in the session, for the person. It shows and acts, and never
// enforces: the settings hooks beside it do that, in every session and harness. Claude Code before
// 2.1.287 doesn't load this module and runs those hooks as before.
//
// Everything it shows comes from the ctx CLI's JSON (`info`, `file`, `proposals`, `agents`), run in the
// session's folder; what it draws is built by the pure functions in view.mjs. It acts only on the
// person's presses: ratifying with a commit, and dropping a proposal. The hooks refuse both commands
// from every agent, so no agent reaches them.
import { DROP_ID, NO_GRAPH, PANE_ID, contextPane, dropPane, followedPath, parseJson } from './view.mjs';
import { SETTINGS_ID, settingsView } from './views/settings.mjs';
import { DEFAULT_UI, bandHealth, closeGoesBack, healthOf, moved } from './views/frame.mjs';
import { assistCard, editTag, readingList, readingMessage } from './views/assist.mjs';
import { BATCH, cardJobs, cardWriterLine, cardWriterSpec, pausedAt, startCardWriterPrompt } from './card-writer.mjs';
import { curatorDue, curatorLine, curatorSpec, flaggedRules, startCuratorPrompt } from './curator.mjs';
import { WHY_ID, sourcesOf, targetsOf, whyPane, whyPrompt } from './why.mjs';

let model = {
  kind: null,
  root: null,
  proposals: [],
  file: null,
  agents: [],
  types: {},
  notice: null,
};
let followed = null; // the file the pane follows: { path, agentId, pinned? }; pinned by /graph <path>
let paneUi = { ...DEFAULT_UI }; // the pane's tab, selection, and where Esc goes back to (VIEW-5)
const deferred = new Set(); // proposals the person put to the back of the queue this session (VIEW-3)
// Read-assist (spec 06): edits refused for unread files, by the refused call's id, with the agent's progress.
const assists = new Map(); // tool_use_id → { id, agentId, edit, files, missing }
const edits = new Map(); // tool_use_id → { path, agentId }: edits that went through, for their card-owed tag (VIEW-4)
const KEPT = 200;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
// The card writer (spec 04): its registered agent, the batch it's writing, and what the person asked for.
const cardWriter = { agent: null, model: null, writing: [], agentId: null };
const asked = []; // paths queued for the card writer from the pane (CARDW-4)
// The curator (spec 05): its agent, whether it's running, and the decision count at its last run.
const curator = { agent: null, model: null, running: false, baseline: null, asked: false };
let asking = null; // the side question in its pane (spec 07): { question, sources, answer?, error?, ms?, usage?, pending }
const editedAt = {}; // path → when an agent last edited it: a file still moving waits (CARDW-1)
let settingRowsNow = []; // ctx settings --json, read on each refresh
let rateLimits = []; // the session's limits, as session.measure last gave them (CARDW-5)
let leadTurn = null; // the lead's running turn
/** A harness setting in force, from ctx settings --json; the pause point the one a tool sets, if any. */
const setting = (key, fallback) => {
  const row = settingRowsNow.find((x) => x.key === key);
  return row ? (row.inForce ?? row.value) : fallback;
};
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
      .register({ name: 'why', description: 'Ask Context Graph why: a path, a module, a rule or a question, answered beside the conversation', argumentHint: '<path, module, rule or question>', immediate: true })
      .catch((err) => $.ui.log(`Context Graph: /why isn't available in this session: ${err?.message ?? err}`));
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
    rateLimits = (await $.session.usage().catch(() => null))?.rateLimits ?? [];
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
        // VIEW-1: the share of files with a current card.
        const cards = await json('cards');
        // CUR-2: the rules hygiene flags as overridden.
        const flagged = flaggedRules(await json('hygiene'));
        // Spec 04: the harness settings, and the branch's changed files without a current card.
        settingRowsNow = (await json('settings')) ?? settingRowsNow;
        const changed = setting('card_writer', false) ? await json('cards', '--changed') : null;
        const agents = (await json('agents', '--session', session)) ?? [];
        const file = followed
          ? await json('file', followed.path, '--session', session, ...(followed.agentId ? ['--agent', followed.agentId] : []))
          : null;
        // VIEW-2: what the followed file imports and what imports it.
        const neighbours = followed ? await json('neighbours', followed.path) : null;
        // ASSIST-2: each open reading list's progress, from the agent's own reads as ctx judges them.
        for (const a of [...assists.values()].slice(-20)) {
          if (a.missing && !a.files.some((f) => a.missing.includes(f))) continue;
          const f = await json('file', a.edit, '--session', session, ...(a.agentId ? ['--agent', a.agentId] : []));
          if (f?.understood) a.missing = f.understood.missing.map((m) => m.path);
        }
        model = {
          ...model,
          kind: 'graph',
          root: info.root,
          graphDir: info.graphDir,
          proposals,
          agents,
          file,
          types,
          cards,
          neighbours,
          changed,
          flagged,
          decisions: info.counts?.decisions ?? 0,
        };
        // CUR-1: decisions are counted from the session's start.
        if (curator.baseline === null) curator.baseline = model.decisions;
        // The batch the card writer took is done with a file once its card is current.
        if (cards) cardWriter.writing = cardWriter.writing.filter((p) => !cards.fresh.includes(p));
        await act.registerCardWriter();
        await act.registerCurator();
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
      // FILE-1: /graph opens the pane, or close it when it's open. /graph <path> opens it on that file
      // (code-kit's combined view asks for this), kept there until the person follows the agents again.
      toggle: async (path = '') => {
        const asked = path.trim().replace(/^\.\//, '');
        if (asked) {
          followed = { path: asked, agentId: null, pinned: true };
          paneUi = { ...paneUi, tab: 'file', back: [] };
          await act.open();
          return {};
        }
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
      // CARDW-2: the card writer's agent, registered again when its model changes.
      registerCardWriter: async () => {
        const wanted = setting('card_writer_model', '');
        if (cardWriter.model === wanted) return;
        cardWriter.model = wanted;
        const spec = cardWriterSpec({ ctx: cli, skill: `${$.plugin.root}/skills/cards/SKILL.md`, model: wanted || undefined });
        cardWriter.agent =
          (
            await $.agent.register(spec).catch((err) => {
              $.ui.log(`Context Graph: the card writer isn't available: ${err?.message ?? err}`);
              return null;
            })
          )?.agent ?? null;
      },
      registerCurator: async () => {
        const wanted = setting('curator_model', '');
        if (curator.model === wanted) return;
        curator.model = wanted;
        curator.agent =
          (
            await $.agent.register(curatorSpec({ ctx: cli, model: wanted || undefined })).catch((err) => {
              $.ui.log(`Context Graph: the curator isn't available: ${err?.message ?? err}`);
              return null;
            })
          )?.agent ?? null;
      },
      // CUR-1, CUR-4: after 10 new decisions (or when the person asks), with the lead idle and the plan
      // below the pause point, the lead is asked to start the curator. True when it asked.
      curatorStep: async () => {
        if (!curator.agent || leadTurn || pausedAt(rateLimits, setting('pause_at_percent', 80)).paused) return false;
        const due = curatorDue({ on: setting('curator', false), running: curator.running, decisions: model.decisions ?? 0, baseline: curator.baseline ?? 0, asked: curator.asked });
        if (!due) return false;
        const since = (model.decisions ?? 0) - (curator.baseline ?? 0);
        curator.running = true;
        curator.asked = false;
        $.ui.invalidate('ui.render');
        $.prompt.submit({ text: startCuratorPrompt({ agent: curator.agent, since: since || 'latest' }) }).catch(() => {
          curator.running = false;
        });
        return true;
      },
      // ASKQ-1 to ASKQ-3: a side question, answered from the graph's records in a pane of its own.
      why: async (question) => {
        const q = question.trim();
        if (!q) return { text: 'Ask with /why <path, module, rule or question>.' };
        if (model.kind !== 'graph') await act.reload();
        if (model.kind === 'none') return { text: NO_GRAPH };
        if (!setting('side_questions', true)) return { text: 'Side questions are off: /graph-settings turns them on.' };
        const found = [];
        for (const target of targetsOf(q)) {
          const r = await json('why', target);
          if (r) found.push(r);
        }
        const sources = sourcesOf(found);
        asking = { question: q, sources, pending: sources.length > 0 };
        await $.ui.open({ id: WHY_ID, title: 'Why', focus: true, closeOnEscape: true });
        if (!sources.length) {
          // ASKQ-3: nothing in the graph names it, so there is nothing to answer from, and no call is made.
          asking = { ...asking, empty: true, error: `The graph holds nothing on ${targetsOf(q).join(', ') || 'that'}: no card, rule or decision names it.` };
          $.ui.invalidate('ui.render');
          return {};
        }
        $.ui.invalidate('ui.render');
        // The side call: over the session's own context (it shares the prompt cache), or the model set.
        const started = await $.clock.now();
        const prompt = whyPrompt(q, sources);
        const chosen = setting('side_questions_model', '');
        const reply = await (chosen ? $.model.complete({ model: chosen, prompt }) : $.model.fork({ prompt })).catch((err) => ({ isAnswered: false, reason: String(err?.message ?? err) }));
        const ms = (await $.clock.now()) - started;
        asking = reply.isAnswered
          ? { ...asking, pending: false, answer: reply.text, usage: reply.usage, ms }
          : { ...asking, pending: false, error: `No answer: ${reply.reason}${reply.status ? ` (${reply.status})` : ''}`, ms };
        $.ui.invalidate('ui.render');
        return {};
      },
      curateNow: async () => {
        curator.asked = true;
        model = { ...model, notice: { ok: true, text: 'The curator runs when the lead is next idle.' } };
        $.ui.invalidate('ui.render');
      },
      // CARDW-1, CARDW-5: with the lead idle, the card writer on and the plan below its pause point,
      // the lead is asked to start it on the next batch.
      cardWriterStep: async () => {
        if (!setting('card_writer', false) || !cardWriter.agent || cardWriter.writing.length || leadTurn) return false;
        if (pausedAt(rateLimits, setting('pause_at_percent', 80)).paused) return false;
        const jobs = act.cardJobsNow(await $.clock.now()).slice(0, BATCH);
        if (!jobs.length) return false;
        cardWriter.writing = jobs.map((j) => j.path);
        for (const j of jobs) {
          const at = asked.indexOf(j.path);
          if (at >= 0) asked.splice(at, 1);
        }
        $.ui.invalidate('ui.render');
        $.prompt.submit({ text: startCardWriterPrompt({ agent: cardWriter.agent, jobs }) }).catch(() => {
          cardWriter.writing = [];
        });
        return true;
      },
      cardJobsNow: (now) =>
        cardJobs({
          asked,
          owed: [...new Set((model.agents ?? []).flatMap((a) => a.cardsOwed ?? []))],
          changed: model.changed ? [...model.changed.stale, ...model.changed.missing] : [],
          editedAt,
          now,
        }),
      askForCards: async (scope, what) => {
        // CARDW-4: with the card writer on, the files go to it instead of the lead.
        if (setting('card_writer', false) && cardWriter.agent) {
          const files = scope.startsWith('L:') ? ((await json('cards', '--module', scope)) ?? { stale: [], missing: [] }) : null;
          const paths = files ? [...files.stale, ...files.missing] : [scope];
          for (const p of paths) if (!asked.includes(p)) asked.push(p);
          model = { ...model, notice: { ok: true, text: `Queued the ${what} for the card writer.` } };
          $.ui.invalidate('ui.render');
          await act.cardWriterStep();
          return;
        }
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

  on('command.run', { command: 'why' }, async ($, e) =>
    act ? act.why(e.args ?? '') : { text: 'Context Graph is still starting; try /why again in a moment.' },
  );

  on('command.run', { command: 'graph-settings' }, async ($, e) =>
    act ? act.settings() : { text: 'Context Graph is still starting; try /graph-settings again in a moment.' },
  );

  on('command.run', { command: 'graph' }, async ($, e) =>
    act
      ? act.toggle(e.args ?? '')
      : {
          text: 'Context Graph is still starting; try /graph again in a moment.',
        },
  );

  // FILE-1: the pane follows the file an agent last read, edited or wrote. It only watches.
  on('tool.call', async ($, e, next) => {
    const res = await next(e);
    activity += 1;
    const path = model.root ? followedPath(e, model.root) : null;
    if (path && !followed?.pinned) followed = { path, agentId: e.agentId ?? null };
    // ASSIST-1: a refusal for unread files: kept for its card, and the agent told what to read.
    const refused = res?.deny ?? (res?.isError ? (res.text ?? '') : null);
    const list = refused ? readingList(refused) : null;
    if (list) {
      assists.set(e.tool_use_id, { id: e.tool_use_id, agentId: e.agentId ?? null, ...list, missing: null });
      if (assists.size > KEPT) assists.delete(assists.keys().next().value);
      if (e.agentId) await $.session.send({ to: { agentId: e.agentId }, text: readingMessage(list) }).catch(() => {});
      $.ui.invalidate('ui.render');
    } else if (!refused && EDIT_TOOLS.has(e.tool) && path) {
      edits.set(e.tool_use_id, { path, agentId: e.agentId ?? null });
      editedAt[path] = await $.clock.now();
      if (edits.size > KEPT) edits.delete(edits.keys().next().value);
    }
    return res;
  }).catch(($, e, next) => next(e)); // whatever fails here, the call goes on as it would

  // CARDW-5: the plan's 5-hour use, as Claude Code measures it.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      rateLimits = e.rateLimits;
      $.ui.invalidate('ui.render');
    }
    return next(e);
  });
  on('turn.start', async ($, e, next) => {
    leadTurn = e.turnId;
    return next(e);
  });
  // The lead is idle: the card writer's next batch, if one is due. A card writer's own last turn ends
  // its batch; what it didn't write waits for the next.
  on('turn.complete', async ($, e, next) => {
    const res = await next(e);
    if (e.agentId) {
      const agent = ((await $.agent.list()) ?? []).find((a) => a.id === e.agentId);
      if (agent && cardWriter.agent && agent.type === cardWriter.agent) cardWriter.writing = [];
      // The curator has reported: its next run counts from here.
      if (agent && curator.agent && agent.type === curator.agent) {
        curator.running = false;
        curator.baseline = model.decisions ?? curator.baseline;
      }
    } else if (!leadTurn || leadTurn === e.turnId) {
      leadTurn = null;
      // One background agent started per idle turn: the card writer's batch first, then the curator.
      if (act && !(await act.cardWriterStep().catch(() => false))) await act.curatorStep().catch(() => {});
    }
    return res;
  });

  // VIEW-4: an edit's tag on its tool row; ASSIST-1: the refused edit's result drawn as its reading list.
  const owedNow = (agentId, path) =>
    (model.agents ?? []).some((a) => (a.agent === (agentId ?? 'main') || (!agentId && a.agentType === null)) && a.cardsOwed?.includes(path));
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const id = e.props.tool_use_id;
    const edit = edits.get(id);
    const tag = editTag(assists.has(id) ? { refused: true } : edit ? { owed: owedNow(edit.agentId, edit.path) } : null, $.ui.resolve(e).Text);
    const row = await next(e);
    return tag ? $.ui.resolve(e).Box({ flexDirection: 'row', children: [row, tag] }) : row;
  });
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const assist = assists.get(e.props.tool_use_id);
    if (!assist) return next(e);
    return assistCard({ ...assist, agentType: assist.agentId ? (model.types?.[assist.agentId] ?? null) : null }, $.ui.resolve(e));
  });

  // VIEW-1: the graph's health from what the mod last read.
  const healthNow = () =>
    healthOf({
      cards: model.cards,
      owed: new Set((model.agents ?? []).flatMap((a) => a.cardsOwed ?? [])).size,
      proposals: (model.proposals ?? []).length,
      flagged: (model.flagged ?? []).length,
    });
  // VIEW-5: how many things the tab's list holds, for j/k.
  const listLength = (tab) => (tab === 'proposals' ? model.proposals.length : tab === 'coverage' ? model.agents.length : 0);

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const now = await $.clock.now();
    const plan = pausedAt(rateLimits, setting('pause_at_percent', 80));
    const view = {
      ...model,
      ui: paneUi,
      deferred,
      curatorLine: curatorLine({
        on: setting('curator', false),
        ...plan,
        running: curator.running,
        decisions: model.decisions ?? 0,
        baseline: curator.baseline ?? 0,
      }),
      cardWriterLine: cardWriterLine({
        on: setting('card_writer', false),
        ...plan,
        writing: cardWriter.writing,
        waiting: act ? act.cardJobsNow(now).filter((j) => !cardWriter.writing.includes(j.path)).map((j) => j.path) : [],
      }),
      assists: [...assists.values()].slice(-10),
      now,
      health: healthNow(),
      followed: followed && {
        ...followed,
        agentType: followed.agentId ? (model.types[followed.agentId] ?? null) : null,
      },
    };
    return contextPane(view, $.ui.resolve(e), {
      onTab: (tab) => {
        paneUi = { ...paneUi, tab, selected: -1, back: [] };
        $.ui.invalidate('ui.render');
      },
      onMove: (step) => {
        const n = listLength(paneUi.tab);
        if (!n) return;
        paneUi = { ...paneUi, selected: moved(paneUi.selected, step, n) };
        $.ui.invalidate('ui.render');
      },
      // Enter on an agent opens the file it last edited, without understanding first if it has one.
      onOpen: () => {
        if (paneUi.tab !== 'coverage') return;
        const agent = model.agents[paneUi.selected];
        const edit = agent?.edited.find((x) => !x.understood) ?? agent?.edited.at(-1);
        if (!edit) return;
        followed = { path: edit.path, agentId: agent.agent === 'main' ? null : agent.agent, pinned: true };
        paneUi = { ...paneUi, tab: 'file', back: [...paneUi.back, { tab: 'coverage', selected: paneUi.selected }] };
        act.reload();
      },
      onSettings: () => act.settings(),
      onCurate: () => act.curateNow(),
      onWhy: (path) => act.why(path),
      // VIEW-3: defer puts a proposal at the back of the queue for the session; again brings it back.
      onDefer: (p) => {
        if (deferred.has(p.id)) deferred.delete(p.id);
        else deferred.add(p.id);
        $.ui.invalidate('ui.render');
      },
      // VIEW-2: a neighbour opens in the File tab; Escape comes back to this file.
      onNeighbour: (path) => {
        const from = followed;
        followed = { path, agentId: null, pinned: true };
        paneUi = { ...paneUi, tab: 'file', back: [...paneUi.back, { tab: 'file', selected: -1, followed: from }] };
        act.reload();
      },
      onFollowAgents: () => {
        followed = followed ? { ...followed, pinned: false } : null;
        $.ui.invalidate('ui.render');
      },
      onRatify: (p) => act.ratify(p),
      onDrop: (p) => act.drop(p),
      onLanes: () => act.lanes(),
      onWriteCard: (path) => act.askForCards(path, `card for ${path}`),
      onModuleCards: (module) => act.askForCards(module, `cards for the files in ${module} without a current one`),
    });
  });

  // VIEW-5: Escape goes back to where the person came from, then closes the pane.
  on('ui.close', async ($, e, next) => {
    if (closeGoesBack(e, PANE_ID, paneUi)) {
      const to = paneUi.back.at(-1);
      paneUi = { ...paneUi, tab: to.tab, selected: to.selected, back: paneUi.back.slice(0, -1) };
      if (to.followed) {
        followed = to.followed;
        act?.reload();
      }
      $.ui.invalidate('ui.render');
      return;
    }
    return next(e);
  });

  // ASKQ-1: the answer's pane; a source that is a file opens in the Context pane.
  on('ui.render', { component: 'Pane', requestId: WHY_ID }, async ($, e) =>
    whyPane(asking, $.ui.resolve(e), {
      onSource: (s) => {
        if (s.kind === 'card') act?.toggle(s.id);
      },
    }),
  );

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
    const line = model.kind === 'graph' ? bandHealth(healthNow()) : null;
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
            Text({ color: line.color, children: [line.text] }),
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
