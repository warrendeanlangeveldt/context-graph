// The Context Graph mod: the graph in the session, for the person. It shows and acts, and never
// enforces: the settings hooks beside it do that, in every session and harness. Claude Code before
// 2.1.287 doesn't load this module and runs those hooks as before.
//
// Everything it shows comes from the ctx CLI's JSON (`snapshot`, with `map` and `file` for what the pane opens), run in the
// session's folder; what it draws is built by the pure functions in view.mjs. It acts only on the
// person's presses: ratifying with a commit, and dropping a proposal. The hooks refuse both commands
// from every agent, so no agent reaches them.
import { DROP_ID, NO_GRAPH, PANE_ID, contextPane, dropPane, followedPath, parseJson } from './view.mjs';
import { SETTINGS_ID, settingsView } from './views/settings.mjs';
import { DEFAULT_UI, bandHealth, closeGoesBack, healthOf, moved } from './views/frame.mjs';
import { grewDecisions } from './views/overview.mjs';
import { assistCard, editTag, readingList, readingMessage } from './views/assist.mjs';
import { DEFAULT_MODEL as CARD_MODEL, RETRY_MS, SETTLE_MS, cardJobs, cardPrompt, explainStatus, pausedAt, readCardReply } from './card-writer.mjs';
import { CITES, DEFAULT_MODEL as CURATOR_MODEL, curatorDue, curatorLine, curatorPrompt, flaggedRules, readCuration } from './curator.mjs';
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
// The card writer (spec 04), run by the mod itself: the file it's writing, why its last request failed
// and when, and what the person asked for. Nothing it does reaches the lead.
const cardWriter = { running: false, writing: [], error: null, failedAt: -Infinity };
const declined = new Set(); // files it found aren't code: skipped this session, until the person offers them again
const writtenAt = {}; // path → when it last wrote the file's card: not written again until the file changes
const asked = []; // paths queued for the card writer from the pane (CARDW-4)
let backfillPaused = false; // the person paused the backfill for this session, from the Map tab
// The curator (spec 05), run by the mod itself: whether it's running, and the decision count at its last run.
const curator = { running: false, baseline: null, asked: false };
let asking = null; // the side question in its pane (spec 07): { question, sources, answer?, error?, ms?, usage?, pending }
const editedAt = {}; // path → when an agent last edited it: a file still moving waits (CARDW-1)
let settingRowsNow = []; // ctx settings --json, read on each refresh
let rateLimits = []; // the session's limits, as session.measure last gave them (CARDW-5)
const pulseUntil = new Map(); // MAP-4: module id → when its pulse ends, after a decision is recorded on it
const PULSE_MS = 8000;
/** How long the person's last act is said at the top of the pane. */
const NOTICE_MS = 15000;
/** A harness setting in force, from ctx settings --json; the pause point the one a tool sets, if any. */
const setting = (key, fallback) => {
  const row = settingRowsNow.find((x) => x.key === key);
  return row ? (row.inForce ?? row.value) : fallback;
};
/** The tool whose paused loop holds the background agents (code-kit's band's Pause), or null. */
const heldBy = () => settingRowsNow.find((x) => x.pausedBy)?.pausedBy ?? null;
let activity = 0; // tool calls seen: coverage changes with them
let editCount = 0; // edits agents made: what's owed a card changes with them (COST-1)
/** COST-1: with nothing changed, the 2-second ticks between refreshes, with the pane open and closed. */
const IDLE_OPEN_TICKS = 30;
const IDLE_CLOSED_TICKS = 150;
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
    let session = await $.session.id();
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
    // A ratify's commit, in words: the short hash, without the trailer's address.
    const committed = (ran) => {
      const hash = /committed ([0-9a-f]{7,})/.exec(ran.stdout)?.[1];
      return hash ? `; committed on this branch (${hash})` : '';
    };

    act = {
      // Everything the pane and the band show, read again.
      reload: async () => {
        // The session's id now: a resumed or cleared session has a new one, and its coverage is recorded under it.
        session = (await $.session.id().catch(() => null)) ?? session;
        // COST-2: everything a refresh shows, from one process with the graph loaded once.
        const snap = await json(
          'snapshot',
          ...(session ? ['--session', session] : []),
          ...(followed ? ['--file', followed.path, ...(followed.agentId ? ['--agent', followed.agentId] : [])] : []),
        );
        const info = snap?.info;
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
        for (const a of await $.agent.list().catch(() => [])) types[a.id] = a.type;
        const proposals = snap.proposals ?? [];
        // VIEW-1: the share of files with a current card.
        const cards = snap.cards ?? null;
        // CUR-2: the rules hygiene flags as overridden.
        const flagged = flaggedRules(snap.hygiene ?? null);
        // Spec 04: the harness settings. With the card writer on in the session that runs it for this
        // checkout (COST-4): the branch's changed files without a current card, what merged in from the
        // lanes' worktrees lately (CARDW-7), and the backfill's files, leaves first.
        settingRowsNow = snap.settings ?? settingRowsNow;
        const changed = snap.changed ?? null;
        const recent = snap.recent ?? null;
        const backfill = snap.backfill ?? null;
        const agents = snap.agents ?? [];
        const file = snap.file ?? null;
        // MAP-1: the modules, read while the Map tab shows them.
        const map = paneUi.tab === 'map' ? await json('map') : (model.map ?? null);
        // MAP-4: a module whose decisions grew since the last read pulses for a few seconds.
        if (map && model.map) {
          const at = await $.clock.now();
          for (const id of grewDecisions(model.map, map)) pulseUntil.set(id, at + PULSE_MS);
        }
        // VIEW-2: what the followed file imports and what imports it.
        const neighbours = snap.neighbours ?? null;
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
          recent,
          backfill,
          writer: snap.writer ?? null,
          flagged,
          decisions: info.counts?.decisions ?? 0,
          map,
          unmapped: info.unmapped ?? [],
        };
        // CUR-1: decisions are counted from the session's start.
        if (curator.baseline === null) curator.baseline = model.decisions;
        // The batch the card writer took is done with a file once its card is current.
        $.ui.invalidate('ui.render');
      },
      // COST-1: what a refresh waits on: the graph's files, the followed file and the edits agents make,
      // and, only while the pane shows the coverage they change, every other tool call.
      fingerprint: async (paneOpen = false) => {
        const dir = model.graphDir ?? `${cwd}/.ctx`;
        const files = ['graph.ctx', 'proposals.ctx', 'decisions.ctx', 'cards.ctx', 'config.toml'];
        const stamps = [];
        for (const f of files) stamps.push(await stamp(`${dir}/${f}`));
        return [...stamps, followed?.path ?? '', followed?.agentId ?? '', editCount, paneOpen ? activity : ''].join('\n');
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
      // CUR-1, CUR-3, CUR-4: after 10 new decisions (or when the person asks), below the plan's pause point
      // and with code-kit's loop running, the curator reads the decisions on each module and adds, as
      // guidance, the conventions three or more of them show. In the background: nothing reaches the lead.
      curate: async () => {
        if (curator.running || model.kind !== 'graph') return false;
        if (heldBy() || pausedAt(rateLimits, setting('pause_at_percent', 80)).paused) return false;
        const due = curatorDue({ on: setting('curator', false), running: false, decisions: model.decisions ?? 0, baseline: curator.baseline ?? 0, asked: curator.asked });
        if (!due) return false;
        curator.running = true;
        curator.asked = false;
        $.ui.invalidate('ui.render');
        try {
          const modules = [];
          for (const m of ((await json('map')) ?? []).filter((x) => (x.decisions?.length ?? 0) >= CITES)) {
            const h = await json('history', m.id);
            if (h?.decisions?.length >= CITES)
              modules.push({ id: m.id, rules: (h.constraints ?? []).map((c) => c.text), decisions: h.decisions.slice(-40).map((d) => ({ id: d.id, text: d.text })) });
          }
          if (!modules.length) return true;
          const reply = await $.model
            .complete({ model: setting('curator_model', '') || CURATOR_MODEL, prompt: curatorPrompt({ modules, proposed: model.proposals ?? [] }), maxTokens: 1500 })
            .catch((err) => ({ isAnswered: false, reason: String(err?.message ?? err) }));
          if (!reply.isAnswered) return true;
          const added = [];
          for (const r of readCuration(reply.text, modules)) {
            const ran = await $.process.run(['node', cli, 'propose', r.module, r.rule], { cwd });
            if (ran.exitCode === 0) added.push(`${r.rule} (${r.module}, from ${r.cites.join(', ')})`);
          }
          if (added.length) model = { ...model, notice: { ok: true, text: `The curator added ${added.length === 1 ? 'a rule' : `${added.length} rules`} as guidance: ${added.join('; ')}` } };
          return true;
        } finally {
          curator.running = false;
          curator.baseline = model.decisions ?? curator.baseline;
          await act.reload();
        }
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
        model = { ...model, notice: { ok: true, text: 'The curator runs now, in the background.' } };
        $.ui.invalidate('ui.render');
        await act.curate();
      },
      // CARDW-1 to CARDW-7: the next card, written by the mod itself in the background, a file at a time:
      // not while code-kit's loop or the backfill is paused, past the plan's pause point, or within a minute
      // of a failed request. Nothing it does reaches the lead.
      writeNext: async () => {
        if (cardWriter.running || model.kind !== 'graph') return false;
        // COST-4: another session runs the card writer for this checkout.
        if (model.writer && !model.writer.mine) return false;
        const backfilling = setting('backfill', 'off') !== 'off' && !backfillPaused;
        if (!(setting('card_writer', false) || backfilling)) return false;
        if (heldBy() || pausedAt(rateLimits, setting('pause_at_percent', 80)).paused) return false;
        const now = await $.clock.now();
        if (now - cardWriter.failedAt < RETRY_MS) return false;
        const [job] = act.cardJobsNow(now);
        if (!job) return false;
        cardWriter.running = true;
        cardWriter.writing = [job.path];
        const at = asked.indexOf(job.path);
        if (at >= 0) asked.splice(at, 1);
        $.ui.invalidate('ui.render');
        try {
          await act.writeCard(job);
        } finally {
          cardWriter.running = false;
          cardWriter.writing = [];
          await act.reload();
        }
        return true;
      },
      // CARDW-2, CARDW-7: one file's card from the file in full, what it imports (by its current card, or
      // its source), what imports it, and for a changed file its last commits and diff. A file the model
      // finds isn't code is skipped for the session (CARDW-6).
      writeCard: async ({ path, reason }) => {
        const failed = async (why) => {
          cardWriter.error = why;
          cardWriter.failedAt = await $.clock.now();
        };
        const text = await $.fs.read(`${cwd}/${path}`).catch(() => null);
        if (typeof text !== 'string' || text.slice(0, 8000).includes('\0')) {
          declined.add(path);
          return;
        }
        const around = await json('neighbours', path);
        const imports = [];
        for (const i of (around?.imports ?? []).slice(0, 8)) {
          const card = i.card === 'current' ? (await json('file', i.path))?.card?.text : null;
          imports.push(card ? { path: i.path, card } : { path: i.path, text: await $.fs.read(`${cwd}/${i.path}`).catch(() => '') });
        }
        const git = async (...args) => (await $.process.run(['git', ...args], { cwd }).catch(() => null))?.stdout ?? '';
        const commits = await git('log', '-3', '--format=%s%n%b', '--', path);
        const diff = reason === 'backfill' ? '' : (await git('diff', 'HEAD', '--', path)) || (await git('log', '-1', '-p', '--format=', '--', path));
        const prompt = cardPrompt({ path, text, imports, importers: (around?.importers ?? []).map((i) => i.path), commits, diff });
        const reply = await $.model
          .complete({ model: setting('card_writer_model', '') || CARD_MODEL, prompt, maxTokens: 800 })
          .catch((err) => ({ isAnswered: false, reason: String(err?.message ?? err) }));
        if (!reply.isAnswered) return failed(`${reply.reason}${reply.status ? ` ${reply.status}` : ''}`);
        const read = readCardReply(reply.text);
        if (!read) return failed('the reply held no card');
        if (read.skip) {
          declined.add(path);
          return;
        }
        const ran = await $.process.run(['node', cli, 'card', path, '--text', read.card, '--agent', 'card-writer'], { cwd });
        if (ran.exitCode !== 0) {
          // ctx refused it (the file isn't text, or it's gone): it isn't offered again this session.
          declined.add(path);
          return;
        }
        cardWriter.error = null;
        writtenAt[path] = await $.clock.now();
      },
      cardJobsNow: (now) => {
        const writing = setting('card_writer', false);
        // A card just written isn't written again until its file changes (the lists catch up at the next read).
        const settled = (p) => writtenAt[p] !== undefined && !(editedAt[p] > writtenAt[p]) && now - writtenAt[p] < 10 * SETTLE_MS;
        return cardJobs({
          asked: writing ? asked.filter((p) => !declined.has(p)) : [],
          owed: writing ? [...new Set((model.agents ?? []).flatMap((a) => a.cardsOwed ?? []))].filter((p) => !declined.has(p)) : [],
          changed: writing && model.changed ? [...model.changed.stale, ...model.changed.missing].filter((p) => !declined.has(p)) : [],
          recent: writing && model.recent ? [...model.recent.stale, ...model.recent.missing].filter((p) => !declined.has(p)) : [],
          backfill: setting('backfill', 'off') !== 'off' && !backfillPaused ? (model.backfill?.files ?? []).filter((p) => !declined.has(p)) : [],
          editedAt,
          now,
        }).filter((j) => !settled(j.path));
      },
      // MAP-6: folders with code the graph maps only to the whole repository, added as modules on the
      // person's press (init, run again, adds modules and proposes their edges; it ratifies nothing).
      addModules: async () => {
        const ran = await $.process.run(['node', cli, 'init', '--write'], { cwd, timeoutMs: 120000 }).catch((err) => ({ exitCode: 1, stdout: '', stderr: String(err?.message ?? err) }));
        model = {
          ...model,
          notice: ran.exitCode === 0
            ? { ok: true, text: ran.stdout.split('\n').find((l) => l.startsWith('added')) ?? 'The graph already maps every folder that looks like a module.' }
            : { ok: false, text: `Adding the modules failed: ${firstLine(ran)}` },
        };
        await act.reload();
      },
      // The person offers the skipped files again: the card writer looks at them once more.
      offerAgain: async () => {
        declined.clear();
        $.ui.invalidate('ui.render');
        await act.writeNext();
      },
      pauseBackfill: () => {
        backfillPaused = !backfillPaused;
        $.ui.invalidate('ui.render');
      },
      askForCards: async (scope, what) => {
        // CARDW-4: with the card writer on, the files go to it instead of the lead.
        if (setting('card_writer', false)) {
          const files = scope.startsWith('L:') ? ((await json('cards', '--module', scope)) ?? { stale: [], missing: [] }) : null;
          const paths = files ? [...files.stale, ...files.missing] : [scope];
          for (const p of paths) if (!asked.includes(p)) asked.push(p);
          // The person asked for these: a decline earlier in the session doesn't hold them back.
          for (const p of paths) declined.delete(p);
          model = { ...model, notice: { ok: true, text: `Queued the ${what} for the card writer.` } };
          $.ui.invalidate('ui.render');
          await act.writeNext();
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
            `Accept ${proposal.id} as ${proposal.kind === 'concepts' ? 'a concept' : 'a rule'}? Agents are held to it from now on. It's committed on this branch with your name (a Ctx-Ratified-By trailer).`,
            ['Accept', 'Cancel'],
          )
          .catch(() => 'Cancel');
        if (answer !== 'Accept') return;
        const ran = await $.process.run(['node', cli, 'ratify', proposal.id, '--commit'], { cwd });
        model = {
          ...model,
          notice: {
            ok: ran.exitCode === 0,
            text: ran.exitCode === 0 ? `Accepted: ${proposal.text}. Agents are held to it from now on${committed(ran)}.` : `Nothing accepted: ${firstLine(ran)}`,
          },
        };
        await act.reload();
      },
      // RAT-3 for a module: every waiting proposal on it accepted in one commit, after one confirmation.
      ratifyAll: async (module, list) => {
        const answer = await $.ui
          .ask(`Accept all ${list.length} proposed rules on ${module}? Agents are held to them from now on. They're committed on this branch together, with your name.`, ['Accept all', 'Cancel'])
          .catch(() => 'Cancel');
        if (answer !== 'Accept all') return;
        const ran = await $.process.run(['node', cli, 'ratify', ...list.map((p) => p.id), '--commit'], { cwd });
        model = {
          ...model,
          notice: { ok: ran.exitCode === 0, text: ran.exitCode === 0 ? `Accepted ${list.length} rules on ${module}. Agents are held to them from now on${committed(ran)}.` : `Nothing accepted: ${firstLine(ran)}` },
        };
        await act.reload();
      },
      // RAT-4: ask why, then drop it, keeping the reason in the graph.
      drop: async (proposal) => {
        dropping = { proposal, reason: '', error: null };
        await $.ui.open({
          id: DROP_ID,
          title: 'Reject',
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
            error: `Nothing rejected: ${firstLine(ran)}`,
          };
          $.ui.invalidate('ui.render');
          return;
        }
        dropping = null;
        model = {
          ...model,
          notice: {
            ok: true,
            text: `Rejected: ${proposal.text}. The graph keeps your reason: ${reason.trim()}`,
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

    // FILE-1 and COV-2: within 2 seconds of a change; with none, read again every minute while the pane
    // is open and every five minutes otherwise (COST-1).
    let seen = null;
    let quiet = 0;
    let busy = false;
    $.clock.every(2000, async () => {
      if (busy) return;
      busy = true;
      try {
        // MAP-4: while a module pulses, the pane is drawn each beat, and once more as the pulse ends.
        const t = await $.clock.now();
        // VIEW-1: the person's last act is said once, then goes.
        if (model.notice?.at !== undefined && t - model.notice.at > NOTICE_MS) {
          model = { ...model, notice: null };
          $.ui.invalidate('ui.render');
        }
        if (pulseUntil.size) {
          $.ui.invalidate('ui.render');
          for (const [id, until] of pulseUntil) if (until <= t) pulseUntil.delete(id);
        }
        // Spec 04 and 05: the card writer and the curator, in the background; each runs one at a time.
        act.writeNext().catch(() => {});
        act.curate().catch(() => {});
        const paneOpen = (await $.ui.panes().catch(() => [])).some((p) => p.id === PANE_ID);
        const now = await act.fingerprint(paneOpen);
        quiet += 1;
        if (now === seen && quiet < (paneOpen ? IDLE_OPEN_TICKS : IDLE_CLOSED_TICKS)) return;
        quiet = 0;
        await act.reload();
        seen = await act.fingerprint(paneOpen);
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
      editCount += 1;
      if (edits.size > KEPT) edits.delete(edits.keys().next().value);
    }
    return res;
  }).catch(($, e, next) => next(e)); // whatever fails here, the call goes on as it would

  // A compaction a plugin starts (code-kit compacts the lead at a threshold) may not run the classic
  // hooks that tell Context Graph the conversation was compacted. Once one stands in the main session, the
  // same SessionStart(compact) goes to Context Graph's hook, so what was injected and read before it is
  // given again and read again. Claude Code's own compactions (/compact, its threshold) run those hooks.
  on('session.compact', async ($, e, next) => {
    const res = await next(e);
    if (res?.skip || e.trigger !== 'plugin' || e.agentId) return res;
    const cwd = await $.session.cwd().catch(() => null);
    const session = await $.session.id().catch(() => null);
    if (!cwd || !session) return res;
    await $.process
      .run(['node', `${$.plugin.root}/ctx.mjs`, 'hook', '--harness', 'claude-code', '--agent', 'claude'], {
        cwd,
        stdin: JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', session_id: session, cwd }),
        timeoutMs: 10000,
      })
      .catch(() => null);
    return res;
  }).catch(($, e, next) => next(e));

  // CARDW-5: the plan's 5-hour use, as Claude Code measures it.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      rateLimits = e.rateLimits;
      $.ui.invalidate('ui.render');
    }
    return next(e);
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
  const mapModule = () => (model.map ?? []).find((m) => m.id === paneUi.mapModule) ?? null;
  const listLength = (tab) =>
    tab === 'proposals'
      ? model.proposals.length
      : tab === 'coverage'
        ? model.agents.length
        : tab === 'map'
          ? (mapModule()?.files.length ?? (model.map ?? []).length)
          : 0;

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const now = await $.clock.now();
    const plan = pausedAt(rateLimits, setting('pause_at_percent', 80));
    // VIEW-1: a notice's clock starts when it's first drawn; the clock loop takes it away.
    if (model.notice && model.notice.at === undefined) model = { ...model, notice: { ...model.notice, at: now } };
    const view = {
      ...model,
      ui: paneUi,
      deferred,
      curatorLine: curatorLine({
        on: setting('curator', false),
        ...plan,
        heldBy: heldBy(),
        running: curator.running,
        decisions: model.decisions ?? 0,
        baseline: curator.baseline ?? 0,
      }),
      // CARDW-8: how much is explained, and the one thing the card writer is doing about the rest.
      explain: explainStatus({
        cards: model.cards,
        on: setting('card_writer', false) || setting('backfill', 'off') !== 'off',
        backfill: setting('backfill', 'off') !== 'off',
        ...plan,
        heldBy: heldBy(),
        backfillPaused,
        writing: cardWriter.writing,
        error: cardWriter.error,
        elsewhere: Boolean(model.writer && !model.writer.mine),
        waiting: act ? act.cardJobsNow(now).filter((j) => !cardWriter.writing.includes(j.path)).map((j) => j.path) : [],
        skipped: declined.size,
      }),
      assists: [...assists.values()].slice(-10),
      now,
      surface: e.surface,
      pulsing: new Set([...pulseUntil].filter(([, until]) => until > now).map(([id]) => id)),
      beat: Math.floor(now / 1000),
      health: healthNow(),
      followed: followed && {
        ...followed,
        agentType: followed.agentId ? (model.types[followed.agentId] ?? null) : null,
      },
    };
    return contextPane(view, $.ui.resolve(e), {
      onTab: (tab) => {
        paneUi = { ...paneUi, tab, selected: -1, back: [], mapModule: null };
        if (tab === 'map') act.reload();
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
        // MAP-3: Enter opens the selected module's heat map, then a file in the File tab.
        if (paneUi.tab === 'map') {
          const here = { tab: 'map', selected: paneUi.selected, mapModule: paneUi.mapModule };
          const m = mapModule();
          if (!m) {
            const picked = (model.map ?? [])[paneUi.selected];
            if (!picked) return;
            paneUi = { ...paneUi, mapModule: picked.id, selected: -1, back: [...paneUi.back, here] };
            $.ui.invalidate('ui.render');
            return;
          }
          const file = m.files[paneUi.selected];
          if (!file) return;
          followed = { path: file.path, agentId: null, pinned: true };
          paneUi = { ...paneUi, tab: 'file', mapModule: null, back: [...paneUi.back, here] };
          act.reload();
          return;
        }
        if (paneUi.tab !== 'coverage') return;
        const agent = model.agents[paneUi.selected];
        const edit = agent?.edited.find((x) => !x.understood) ?? agent?.edited.at(-1);
        if (!edit) return;
        followed = { path: edit.path, agentId: agent.agent === 'main' ? null : agent.agent, pinned: true };
        paneUi = { ...paneUi, tab: 'file', back: [...paneUi.back, { tab: 'coverage', selected: paneUi.selected }] };
        act.reload();
      },
      onSettings: () => act.settings(),
      onPick: (index) => {
        paneUi = { ...paneUi, selected: index };
        $.ui.invalidate('ui.render');
      },
      onCurate: () => act.curateNow(),
      onOfferAgain: () => act.offerAgain(),
      onAddModules: () => act.addModules(),
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
      onRatifyAll: (module, list) => act.ratifyAll(module, list),
      onLanes: () => act.lanes(),
      onWriteCard: (path) => act.askForCards(path, `card for ${path}`),
      onModuleCards: (module) => act.askForCards(module, `cards for the files in ${module} without a current one`),
      onPauseBackfill: () => act.pauseBackfill(),
    });
  });

  // VIEW-5: Escape goes back to where the person came from, then closes the pane.
  on('ui.close', async ($, e, next) => {
    if (closeGoesBack(e, PANE_ID, paneUi)) {
      const to = paneUi.back.at(-1);
      paneUi = { ...paneUi, tab: to.tab, selected: to.selected, mapModule: to.mapModule ?? null, back: paneUi.back.slice(0, -1) };
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

  // VIEW-1: one line, only when something is wrong, above whatever else the band holds (another
  // plugin's, or Claude Code's own), so the two mods' lines stand together.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Context Graph runs in the background: its band line shows only when something is wrong (rules the
    // agents keep working around). The backfill's progress and its Pause are in the Map tab.
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
