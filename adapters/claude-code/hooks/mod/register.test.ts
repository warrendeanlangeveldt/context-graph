// The Context Graph mod end to end through Claude Code's harness: `claude plugin test adapters/claude-code`
// (Claude Code 2.1.287 or later). The ctx CLI is stubbed with the JSON it prints; the CLI itself is tested
// in src/cli/present.test.ts, and the drawing in src/mod/view.test.ts.
import { expect, mock, test } from 'claude-code/testing';

const PANE = 'context-graph';
const DROP = 'context-graph-drop';

function project() {
  return {
    info: { root: '/work', graphDir: '/work/.ctx', branch: 'feature', person: 'warren' } as any,
    proposals: [
      { id: 'src.small', kind: 'guidance', module: 'L:src', text: 'keep modules small', served: 3, overridden: 1, violations: null },
      { id: 'C:events', kind: 'concepts', module: null, text: 'Change goes through events', served: 0, overridden: 0, violations: null },
    ] as any[],
    files: {
      'src/a.ts': {
        path: 'src/a.ts',
        mapped: true,
        chain: ['L:src', 'L:repo'],
        card: { text: 'Holds a.', fresh: true, date: '2026-10-06', who: 'warren/claude' },
        rules: [{ id: 'src.pure', mode: 'G', text: 'no side effects', test: null }],
        decisions: [],
        understood: { ok: false, missing: [{ path: 'src/b.ts', why: 'imported' }] },
        tools: { lines: [], requirements: [] },
      },
      'src/b.ts': {
        path: 'src/b.ts',
        mapped: true,
        chain: ['L:src', 'L:repo'],
        card: null,
        rules: [],
        decisions: [],
        understood: { ok: true, missing: [] },
        tools: { lines: [], requirements: [] },
      },
    } as Record<string, any>,
    agents: [] as any[],
    running: [{ id: 'agent-web', type: 'web-engineer', status: 'running' }] as any[],
    ratifyExit: 0,
    ratifyOut: 'ratified src.small\ncommitted abc1234 with Ctx-Ratified-By: warren',
    dropExit: 0,
    answer: 'Accept',
    acts: [] as string[][],
    fileAsks: [] as string[][],
    open: new Set<string>(),
    opened: [] as string[],
    commands: [] as string[],
    prompts: [] as string[],
    settings: [
      { key: 'card_writer', value: false, default: false, about: 'Writes the cards owed in the background' },
      { key: 'card_writer_model', value: '', default: '', about: "The card writer's model" },
      { key: 'pause_at_percent', value: 80, default: 80, about: 'The pause point' },
    ] as any[],
    setExit: 0,
    cards: { fresh: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], stale: ['j'], missing: [] } as any,
    editRefusal: '',
    changed: { fresh: [], stale: [], missing: [] } as any,
    recent: { fresh: [], stale: [], missing: [] } as any, // `ctx cards --recent`
    moduleCards: { fresh: [], stale: [], missing: [] } as any,
    registered: [] as any[],
    limits: [] as any[],
    hygiene: [] as any[],
    agentsThrow: false,
    backfill: { scope: 'active', files: [] as string[], inScope: 0 } as any,
    map: [
      { id: 'L:src', name: 'Source', depth: 0, parents: [], rules: { agreed: 2, proposed: 0 }, decisions: [], files: [{ path: 'src/a.ts', card: 'current' }] },
      {
        id: 'L:billing',
        name: 'Billing',
        depth: 1,
        parents: ['L:src'],
        rules: { agreed: 1, proposed: 1 },
        decisions: ['2026-10-08', '2026-10-09'],
        files: [
          ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ path: `src/billing/${x}.ts`, card: 'current' })),
          { path: 'src/billing/g.ts', card: 'stale' },
          { path: 'src/billing/h.ts', card: 'stale' },
          { path: 'src/billing/i.ts', card: 'missing' },
          { path: 'src/billing/j.ts', card: 'missing' },
        ],
      },
    ] as any[],
    whys: {
      'src/a.ts': {
        node: 'src/a.ts',
        card: { text: 'Holds a.' },
        constraints: [{ id: 'src.pure', mode: 'G', text: 'no side effects' }],
        decisions: [{ id: 'd-0003', date: '2026-10-03', who: 'warren/claude', text: 'keep a constant' }],
      },
    } as Record<string, any>,
    asked: [] as any[],
    reply: { isAnswered: true, text: 'Because of [src.pure]: a stays pure.', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } } as any,
    sent: [] as { to: any; text: string }[],
    // The card writer's and the curator's own requests (spec 04 and 05), and what they read.
    sources: { 'src/a.ts': 'export const a = b + 1;\n', 'src/b.ts': 'export const b = 1;\n' } as Record<string, string>,
    cardReplies: {} as Record<string, any>, // path → the model's reply for its card; a card by default
    curation: { isAnswered: true, text: '{"rules": []}', usage: null } as any,
    history: {} as Record<string, any>, // `ctx history <module> --json`
    cardExit: 0,
    neighbours: {
      'src/a.ts': { path: 'src/a.ts', card: 'current', breaks: [], imports: [{ path: 'src/b.ts', card: 'missing', breaks: [] }], importers: [] },
      'src/b.ts': { path: 'src/b.ts', card: 'missing', breaks: [], imports: [], importers: [{ path: 'src/a.ts', card: 'current', breaks: [] }] },
    } as Record<string, any>,
  };
}
type World = ReturnType<typeof project>;

function stub(on: any, w: World) {
  on('process.run', ($: any, e: any) => {
    const argv: readonly string[] = e.argv;
    const ran = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr } });
    const sub = argv[2];
    if (argv[0] === 'git' && argv[1] === 'log' && argv.includes('-3')) return ran(0, `ST-4 ${argv.at(-1)} for the booking form\n`);
    if (argv[0] === 'git') return ran(0, '');
    if (sub === 'info') return ran(0, JSON.stringify(w.info));
    if (sub === 'card' || sub === 'propose') {
      w.acts.push([...argv.slice(2)]);
      return sub === 'card' && w.cardExit ? ran(1, '', `${argv[3]} isn't code`) : ran(0, '');
    }
    if (sub === 'history') return w.history[argv[3]] ? ran(0, JSON.stringify(w.history[argv[3]])) : ran(1, '', 'ctx history <node>');
    if (sub === 'hygiene') return ran(0, JSON.stringify(w.hygiene));
    if (sub === 'map') return ran(0, JSON.stringify(w.map));
    if (sub === 'why') return w.whys[argv[3]] ? ran(0, JSON.stringify(w.whys[argv[3]])) : ran(1, '', `ctx why <node>`);
    if (sub === 'proposals') return ran(0, JSON.stringify(w.proposals));
    if (sub === 'cards' && argv.includes('--backfill')) return ran(0, JSON.stringify(w.backfill));
    if (sub === 'cards' && argv.includes('--changed')) return ran(0, JSON.stringify(w.changed));
    if (sub === 'cards' && argv.includes('--recent')) return ran(0, JSON.stringify(w.recent));
    if (sub === 'cards' && argv.includes('--module')) return ran(0, JSON.stringify(w.moduleCards));
    if (sub === 'cards') return ran(0, JSON.stringify(w.cards));
    if (sub === 'neighbours') return ran(0, JSON.stringify(w.neighbours[argv[3]] ?? null));
    if (sub === 'agents') return ran(0, JSON.stringify(w.agents));
    if (sub === 'file') {
      w.fileAsks.push([...argv.slice(3)]);
      return ran(0, JSON.stringify(w.files[argv[3]]));
    }
    if (sub === 'ratify') {
      w.acts.push([...argv.slice(2)]);
      return ran(
        w.ratifyExit,
        w.ratifyExit ? '' : w.ratifyOut,
        w.ratifyExit ? 'main is protected. Switch to a branch, then ratify or drop there.' : '',
      );
    }
    if (sub === 'drop') {
      w.acts.push([...argv.slice(2)]);
      return ran(w.dropExit, w.dropExit ? '' : `dropped ${argv[3]}`, w.dropExit ? 'main is protected.' : '');
    }
    if (sub === 'settings' && argv[3] === 'set') {
      w.acts.push([...argv.slice(2)]);
      if (w.setExit) return ran(1, '', 'pause_at_percent must be a percentage from 1 to 100. Nothing was changed.');
      const row = w.settings.find((s) => s.key === argv[4]);
      row.value = argv[5] === 'true' ? true : argv[5] === 'false' ? false : /^\d+$/.test(argv[5]) ? Number(argv[5]) : argv[5];
      return ran(0, `Set [harness] ${argv[4]}.`);
    }
    if (sub === 'settings') return ran(0, JSON.stringify(w.settings));
    return ran(1, '', `unexpected ${argv.join(' ')}`);
  });
  on('session.start', () => ({ cwd: '/work' }));
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }));
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: {} } }));
  on('tool.call', { tool: 'Edit' }, () => (w.editRefusal ? { deny: w.editRefusal } : { result: {} }));
  on('model.fork', ($: any, e: any) => {
    w.asked.push({ fork: true, prompt: e.prompt });
    return { value: w.reply };
  });
  on('model.complete', ($: any, e: any) => {
    w.asked.push({ model: e.model, prompt: e.prompt });
    const card = /^Write the Context Graph card for (\S+):/.exec(e.prompt)?.[1];
    if (card)
      return { value: w.cardReplies[card] ?? { isAnswered: true, text: `Card for ${card}: what it is for and what it keeps true.`, usage: null } };
    if (e.prompt.startsWith("You are Context Graph's curator")) return { value: w.curation };
    return { value: w.reply };
  });
  on('fs.read', ($: any, e: any) => {
    const path = String(e.path).replace(/^\/work\//, '');
    if (w.sources[path] === undefined) throw new Error(`ENOENT: ${path}`);
    return { value: w.sources[path] };
  });
  on('agent.register', ($: any, e: any) => {
    w.registered.push(e);
    return { value: { agent: `context-graph:${e.name}` } };
  });
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: w.limits } }));
  on('session.measure', ($: any, e: any) => ({ changed: e.changed }));
  on('turn.start', ($: any, e: any) => e);
  on('turn.complete', () => ({ text: '' }));
  on('session.send', ($: any, e: any) => {
    w.sent.push({ to: e.to, text: e.text });
    return { isDelivered: true };
  });
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => ({
    result: { questions: e.questions, answers: { [e.questions[0].question]: w.answer } },
  }));
  on('command.run', { command: 'lanes' }, () => {
    w.commands.push('lanes');
    return { text: '' };
  });
  on('prompt.submit', ($: any, e: any) => {
    w.prompts.push(e.text);
    return { text: e.text };
  });
  on('agent.list', () => {
    if (w.agentsThrow) throw new Error('no session is bound in this process');
    return { value: w.running };
  });
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 1, isLink: false } }));
  on('session.cwd', () => ({ value: '/work' }));
  on('session.id', () => ({ value: 's1' }));
  on('command.register', () => ({ value: undefined }));
  on('ui.log', () => ({ value: undefined }));
  on('ui.panes', () => ({ value: [...w.open].map((id) => ({ id, title: id, isShown: true })) }));
  on('ui.open', ($: any, e: any) => {
    w.opened.push(e.id);
    w.open.add(e.id);
    return { value: { isPlaced: true } };
  });
  on('ui.close', ($: any, e: any) => {
    w.open.delete(e.id);
    return { value: undefined };
  });
}

async function start($: any, on: any, w: World) {
  stub(on, w);
  const clock = mock.clock(on);
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true });
  await clock.advance(2000);
  return clock;
}
const mountPane = ($: any, requestId: string) =>
  $.ui.mount({
    plugin: 'context-graph',
    component: 'Pane',
    requestId,
    surface: 'terminal',
    viewport: { columns: 120, rows: 50 },
    props: { title: requestId, isFocused: true, bodyColumns: 80 },
  });
const bandUi = ($: any) =>
  $.ui.mount({
    plugin: 'context-graph',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100 },
  });
const press = ($: any, key: string, requestId?: string) =>
  $.ui.press({ plugin: 'context-graph', key, ...(requestId ? { requestId } : {}) });
/** The text an element shows, its children's in order. */
const shownIn = (node: any): string[] =>
  !node ? [] : typeof node === 'string' ? [node] : (node.children ?? []).flatMap((c: any) => shownIn(c));
const ctx = ($: any) => $.command.run({ command: 'graph', args: '' });

test('FILE-1 /graph opens the pane on the file an agent read, naming the agent', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  expect(w.opened).toEqual([PANE]);
  expect(w.fileAsks.at(-1)).toEqual(['src/a.ts', '--session', 's1', '--agent', 'agent-web', '--json']);
  const ui = await mountPane($, PANE);
  // It opens on the Overview; This file follows the agents.
  expect((await ui.find({ key: 'tab-map' }))?.props.variant).toBe('primary');
  await press($, 'tab-file', PANE);
  expect(await ui.find({ type: 'Text', text: 'last touched by web-engineer' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined();
  await ui.unmount();
});

test('FILE-1 the pane moves to the file an agent edits next, within 2 seconds', async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 'e1',
    file_path: '/work/src/b.ts',
    agentId: 'agent-web',
    old_string: 'a',
    new_string: 'b',
  } as any);
  await clock.advance(2000);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect(await ui.find({ type: 'Text', text: 'src/b.ts' })).toBeDefined();
  await ui.unmount();
});

test('FILE-3 the pane says what the agent still has to read', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect(await ui.find({ type: 'Text', text: '✗ web-engineer still has to read src/b.ts' })).toBeDefined();
  await ui.unmount();
});

test("FILE-4 the code-kit section opens code-kit's Lanes pane", async ($, on) => {
  const w = project();
  w.files['src/a.ts'] = { ...w.files['src/a.ts'], tools: { lines: ['code-kit  lane web · layer ui · WEB-1'], requirements: ['WEB-1'] } };
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect(await ui.find({ type: 'Text', text: /lane web/ })).toBeDefined();
  await press($, 'open-lanes', PANE);
  expect(w.commands).toEqual(['lanes']);
  await ui.unmount();
});

test('FILE-5 without a graph, /graph says how to start one and there is no band', async ($, on) => {
  const w = project();
  w.info = { ...w.info, graphDir: null };
  await start($, on, w);
  const res = await ctx($);
  expect(res.text).toBe('No graph here yet: run /context-graph:init');
  expect(w.opened).toEqual([]);
  const band = await bandUi($);
  expect(await band.find({ type: 'Text', text: /to ratify/ })).toBeUndefined();
  await band.unmount();
});

test('RAT-1 and RAT-2 the proposals show their evidence in the pane, and never call for the person in the band', async ($, on) => {
  const w = project();
  await start($, on, w);
  const band = await bandUi($);
  // Suggestions wait quietly: Context Graph runs in the background.
  expect(await band.find({ key: 'band-context-graph' })).toBeUndefined();
  await band.unmount();
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect(await ui.find({ type: 'Text', text: 'Evidence: served by 3 decisions, overridden by 1 decision' })).toBeDefined();
  await ui.unmount();
});

test('RAT-3 Ratify confirms, then ratifies and commits as the person', async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  await press($, 'ratify-src.small', PANE);
  expect(w.acts).toEqual([['ratify', 'src.small', '--commit']]);
  const accepted = 'Accepted: keep modules small. Agents are held to it from now on; committed on this branch (abc1234).';
  expect(await ui.find({ type: 'Text', text: accepted })).toBeDefined();
  // Said in words, without the trailer's address, and only for a few seconds.
  expect(await ui.find({ type: 'Text', text: /Ctx-Ratified-By/ })).toBeUndefined();
  await clock.advance(16_000);
  await clock.advance(2000);
  expect(await ui.find({ type: 'Text', text: accepted })).toBeUndefined();
  await ui.unmount();
});

test('RAT-3 on a protected branch nothing changes, and the pane says to switch', async ($, on) => {
  const w = project();
  w.ratifyExit = 1;
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  await press($, 'ratify-src.small', PANE);
  expect(await ui.find({ type: 'Text', text: /Nothing accepted: main is protected. Switch to a branch/ })).toBeDefined();
  await ui.unmount();
});

test('RAT-3 cancelling the confirmation ratifies nothing', async ($, on) => {
  const w = project();
  w.answer = 'Cancel';
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  await press($, 'ratify-src.small', PANE);
  expect(w.acts).toEqual([]);
  await ui.unmount();
});

test('RAT-4 Drop asks why, needs a reason, and drops it with that reason', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  await press($, 'drop-src.small', PANE);
  expect(w.opened).toContain(DROP);
  const dialog = await mountPane($, DROP);
  await $.ui.input({ plugin: 'context-graph', key: 'drop-reason', text: '  ' });
  expect(w.acts).toEqual([]);
  expect(await dialog.find({ type: 'Text', text: /Give a reason/ })).toBeDefined();
  await $.ui.input({ plugin: 'context-graph', key: 'drop-reason', text: 'not how we work' });
  expect(w.acts).toEqual([['drop', 'src.small', '--reason', 'not how we work', '--commit']]);
  expect(w.open.has(DROP)).toBe(false);
  await dialog.unmount();
  expect(await ui.find({ type: 'Text', text: 'Rejected: keep modules small. The graph keeps your reason: not how we work' })).toBeDefined();
  await ui.unmount();
});

test('COV-1 and COV-2 each agent\'s changes, and how many it understood first, rise within 2 seconds of an edit', async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: ['src/a.ts'], searched: [], edited: [], cardsOwed: [] }];
  await ctx($);
  const before = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(shownIn(await before.find({ key: 'agent-agent-web' }))).toEqual(['web-engineer', '0', '-', '0']);
  await before.unmount();
  w.agents = [{ ...w.agents[0], edited: [{ path: 'src/a.ts', understood: true, missing: [] }] }];
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  const after = await mountPane($, PANE);
  expect(shownIn(await after.find({ key: 'agent-agent-web' }))).toEqual(['web-engineer', '1', '1  ✓', '0']);
  await after.unmount();
});

test('COV-3 an edit made without understanding is marked, with what was unread', async ($, on) => {
  const w = project();
  w.agents = [
    {
      agent: 'agent-web',
      agentType: 'web-engineer',
      read: ['src/a.ts'],
      searched: [],
      edited: [{ path: 'src/a.ts', understood: false, missing: ['src/b.ts'] }],
      cardsOwed: [],
    },
  ];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(await ui.find({ type: 'Text', text: '✗ web-engineer changed src/a.ts without reading src/b.ts' })).toBeDefined();
  await ui.unmount();
});

test('Cards: Write card and Cards for this module ask the lead, who may write them or hand them on', async ($, on) => {
  const w = project();
  w.files['src/b.ts'] = { ...w.files['src/b.ts'], card: null };
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/b.ts' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  await press($, 'write-card', PANE);
  expect(w.prompts.at(-1)).toBe(
    'Write the Context Graph card for src/b.ts: run /context-graph:cards src/b.ts, or ask the agent working on src/b.ts to.',
  );
  await press($, 'module-cards', PANE);
  expect(w.prompts.at(-1)).toContain('/context-graph:cards L:src');
  expect(await ui.find({ type: 'Text', text: /Asked the lead for the cards for the files in L:src/ })).toBeDefined();
  await ui.unmount();
});

// --- the harness settings ---------------------------------------------------------------------------

const SETTINGS = 'context-graph-settings';

test('VIEW-6 /graph-settings shows each setting with a control, and a change asks for a reason first', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.command.run({ command: 'graph-settings', args: '' });
  expect(w.opened).toContain(SETTINGS);
  const ui = await mountPane($, SETTINGS);
  expect((await ui.find({ key: 'set-card_writer' }))?.props.value).toBe('false');
  await $.ui.select({ plugin: 'context-graph', key: 'set-card_writer', value: 'true', requestId: SETTINGS });
  expect(w.acts).toEqual([]);
  expect(await ui.find({ type: 'Text', text: 'Set card_writer to on?' })).toBeDefined();
  await $.ui.input({ plugin: 'context-graph', key: 'settings-reason', text: ' ' });
  expect(await ui.find({ type: 'Text', text: /Give a reason/ })).toBeDefined();
  await $.ui.input({ plugin: 'context-graph', key: 'settings-reason', text: 'cards keep falling behind' });
  expect(w.acts).toEqual([['settings', 'set', 'card_writer', 'true', '--reason', 'cards keep falling behind', '--via', 'pane']]);
  expect((await ui.find({ key: 'set-card_writer' }))?.props.value).toBe('true');
  expect(await ui.find({ key: 'settings-confirm' })).toBeUndefined();
  await ui.unmount();
});

test('VIEW-6 a value the CLI refuses shows why, and Cancel leaves it', async ($, on) => {
  const w = project();
  w.setExit = 1;
  await start($, on, w);
  await $.command.run({ command: 'graph-settings', args: '' });
  const ui = await mountPane($, SETTINGS);
  await $.ui.input({ plugin: 'context-graph', key: 'set-pause_at_percent', text: '150' });
  await $.ui.input({ plugin: 'context-graph', key: 'settings-reason', text: 'later' });
  expect(await ui.find({ type: 'Text', text: /must be a percentage/ })).toBeDefined();
  await $.ui.press({ plugin: 'context-graph', key: 'settings-cancel', requestId: SETTINGS });
  expect(await ui.find({ key: 'settings-confirm' })).toBeUndefined();
  await ui.unmount();
});

// --- panes v2: the health header, tabs and keys -----------------------------------------------------

test("VIEW-1 the header and the band sum up the graph's health: carded share, cards owed and proposals", async ($, on) => {
  const w = project();
  w.proposals = [];
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [], cardsOwed: ['src/a.ts'] }];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'Context Graph' })).toBeDefined();
  const header = await ui.find({ type: 'Text', text: '90% of files explained · 1 file to explain from this session' });
  expect(header?.props.color).toBe('yellow');
  await ui.unmount();
  // Cards owed are the agents' work: the band says nothing of them.
  const band = await bandUi($);
  expect(await band.find({ key: 'band-context-graph' })).toBeUndefined();
  await band.unmount();
});

test('VIEW-1 the band speaks only when something is wrong: rules the agents keep working around', async ($, on) => {
  const w = project();
  w.hygiene = [{ signal: 'overridden-in-practice', target: 'src.small', evidence: 'overridden by 3 decisions', proposal: 'reword it' }];
  await start($, on, w);
  const band = await bandUi($);
  expect((await band.find({ type: 'Text', text: '1 rule the agents keep working around' }))?.props.color).toBe('yellow');
  await press($, 'band-context');
  expect(w.opened).toContain(PANE);
  await band.unmount();
});

test('VIEW-1 with nothing waiting and the graph healthy there is no band line', async ($, on) => {
  const w = project();
  w.proposals = [];
  w.cards = { fresh: ['a', 'b'], stale: [], missing: [] };
  await start($, on, w);
  const band = await bandUi($);
  expect(await band.find({ type: 'Text', text: /files explained/ })).toBeUndefined();
  await band.unmount();
});

test('VIEW-5 tabs on 1 to 4; j/k select an agent and Enter opens the file it edited without understanding', async ($, on) => {
  const w = project();
  w.agents = [
    { agent: 'main', agentType: null, read: [], searched: [], edited: [], cardsOwed: [] },
    { agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [{ path: 'src/a.ts', understood: false, missing: ['src/b.ts'] }], cardsOwed: [] },
  ];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect((await ui.find({ key: 'tab-coverage' }))?.props.hotkey).toBe('4');
  await press($, 'tab-coverage', PANE);
  await press($, 'move-prev', PANE);
  expect((await ui.find({ key: 'agent-agent-web' }))?.text).toMatch(/^› web-engineer/);
  expect((await ui.find({ key: 'open-selected' }))?.props.hotkey).toBe('o');
  await press($, 'open-selected', PANE);
  expect(w.fileAsks.at(-1)).toEqual(['src/a.ts', '--session', 's1', '--agent', 'agent-web', '--json']);
  expect((await ui.find({ key: 'tab-file' }))?.props.variant).toBe('primary');
  expect(await ui.find({ type: 'Text', text: 'Esc: back' })).toBeDefined();
  await ui.unmount();
});

test("/graph <path> opens the pane on that file, and keeps it there while agents read others", async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  await $.command.run({ command: 'graph', args: 'src/b.ts' });
  expect(w.opened).toContain(PANE);
  expect(w.fileAsks.at(-1)?.[0]).toBe('src/b.ts');
  await $.tool.call({ tool: 'Read', tool_use_id: 'r9', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  expect(w.fileAsks.at(-1)?.[0]).toBe('src/b.ts');
});

// --- the file view ----------------------------------------------------------------------------------

test('VIEW-2 the File tab draws the card as Markdown and the neighbourhood, and a neighbour opens in its place', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Holds a.');
  expect((await ui.find({ key: 'imports-src/b.ts' }))?.props.label).toBe('○ src/b.ts (not explained)');
  await press($, 'imports-src/b.ts', PANE);
  expect(w.fileAsks.at(-1)?.[0]).toBe('src/b.ts');
  expect((await ui.find({ key: 'importers-src/a.ts' }))?.props.label).toBe('● src/a.ts');
  expect(await ui.find({ type: 'Text', text: 'Esc: back' })).toBeDefined();
  await ui.unmount();
});

// --- the proposals queue ----------------------------------------------------------------------------

test('VIEW-3 a proposal with evidence has its sparklines; a accepts, r rejects and l puts off the selected one', async ($, on) => {
  const w = project();
  w.proposals[0] = { ...w.proposals[0], servedOn: ['2026-10-01', '2026-10-02', '2026-10-03'], overriddenOn: ['2026-10-03'] };
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect((await ui.find({ key: 'spark-src.small' }))?.text).toMatch(/served\s+▁+.*overridden\s*▁+/);
  await press($, 'move-next', PANE);
  expect((await ui.find({ key: 'key-defer' }))?.props.hotkey).toBe('l');
  expect((await ui.find({ key: 'key-ratify' }))?.props.hotkey).toBe('a');
  expect((await ui.find({ key: 'key-drop' }))?.props.hotkey).toBe('r');
  await press($, 'key-defer', PANE);
  // Deferred, src.small goes to the back: C:events is first now.
  const order = (await ui.findAll({ type: 'Text' })).map((x) => x.text).filter((x) => x === 'keep modules small' || x === 'Change goes through events');
  expect(order).toEqual(['Change goes through events', 'keep modules small']);
  expect(await ui.find({ type: 'Text', text: 'later' })).toBeDefined();
  // No evidence yet, no sparkline: C:events has none.
  expect(await ui.find({ key: 'spark-C:events' })).toBeUndefined();
  expect((await ui.find({ key: 'key-ratify' }))?.props.label).toBe('Accept C:events');
  await press($, 'key-ratify', PANE);
  expect(w.acts).toEqual([['ratify', 'C:events', '--commit']]);
  await ui.unmount();
});

// --- read-assist and transcript tags ----------------------------------------------------------------

const unread =
  'Context Graph: read before you edit.\nBefore editing src/a.ts, its context has to be in this agent\'s context:\n  - src/b.ts: it has no card yet, so read it in full\n  - src/c.ts: it has no card yet, so read it in full\nRead those, then make the edit again.';
const row = ($: any, component: 'ToolUse' | 'ToolResult', id: string, tool = 'Edit') =>
  $.ui.mount({
    plugin: 'context-graph',
    component,
    requestId: id,
    surface: 'terminal',
    viewport: { columns: 120, rows: 40 },
    props:
      component === 'ToolUse'
        ? { tool_use_id: id, tool, input: {}, isRunning: false, isErrored: true, isInterrupted: false, output: null }
        : { tool_use_id: id, tool, output: null, isErrored: true },
  });

test('ASSIST-1 an edit refused for unread files is drawn as its reading list, and the agent is told what to read', async ($, on) => {
  const w = project();
  w.editRefusal = unread;
  await start($, on, w);
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  expect(w.sent).toEqual([{ to: 'agent-web', text: 'Read src/b.ts and src/c.ts in full, then edit src/a.ts again.' }]);
  const card = await row($, 'ToolResult', 'e1');
  expect((await card.find({ key: 'assist-e1' }))?.text).toMatch(/Read before editing src\/a\.ts\s*0 of 2 read○ src\/b\.ts○ src\/c\.ts/);
  await card.unmount();
  const use = await row($, 'ToolUse', 'e1');
  expect(await use.find({ type: 'Text', text: '  not understood' })).toBeDefined();
  await use.unmount();
});

test("ASSIST-2 and ASSIST-3 progress follows the agent's own reads, as ctx judges them, to understood", async ($, on) => {
  const w = project();
  w.editRefusal = unread;
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  w.files['src/a.ts'] = { ...w.files['src/a.ts'], understood: { ok: false, missing: [{ path: 'src/c.ts', why: 'imported' }] } };
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/b.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  let card = await row($, 'ToolResult', 'e1');
  expect((await card.find({ key: 'assist-e1' }))?.text).toMatch(/1 of 2 read✓ src\/b\.ts○ src\/c\.ts/);
  await card.unmount();
  await ctx($);
  const pane = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(await pane.find({ type: 'Text', text: /reading to change src\/a\.ts: 1 of 2 read/ })).toBeDefined();
  await pane.unmount();
  w.files['src/a.ts'] = { ...w.files['src/a.ts'], understood: { ok: true, missing: [] } };
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/work/src/c.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  card = await row($, 'ToolResult', 'e1');
  expect((await card.find({ key: 'assist-e1' }))?.text).toMatch(/understood/);
  await card.unmount();
  expect(w.acts).toEqual([]);
});

test('VIEW-4 an edit that owes a card carries the tag on its row while it does', async ($, on) => {
  const w = project();
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [], cardsOwed: ['src/a.ts'] }];
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  let use = await row($, 'ToolUse', 'e2');
  expect(await use.find({ type: 'Text', text: '  card owed' })).toBeDefined();
  await use.unmount();
  w.agents = [{ ...w.agents[0], cardsOwed: [] }];
  await $.tool.call({ tool: 'Read', tool_use_id: 'r3', file_path: '/work/src/b.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  use = await row($, 'ToolUse', 'e2');
  expect(await use.find({ type: 'Text', text: '  card owed' })).toBeUndefined();
  await use.unmount();
});

// --- the card writer --------------------------------------------------------------------------------

/** A project with the card writer on, src/a.ts owed a card and src/b.ts changed on the branch without one. */
function writing() {
  const w = project();
  w.settings = [
    { key: 'card_writer', value: true, default: false, about: '' },
    { key: 'card_writer_model', value: 'haiku', default: '', about: '' },
    { key: 'pause_at_percent', value: 80, default: 80, about: '', inForce: 70, from: 'code-kit' },
  ];
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [], cardsOwed: ['src/a.ts'] }];
  w.changed = { fresh: [], stale: ['src/b.ts'], missing: [] };
  return w;
}
/** The cards the mod wrote: `ctx card <path> --text … --agent card-writer`, by path. */
const cardsWritten = (w: any) => w.acts.filter((a: string[]) => a[0] === 'card').map((a: string[]) => a[1]);
/** The model requests the card writer made, by path. */
const cardAsks = (w: any) =>
  w.asked.map((a: any) => /^Write the Context Graph card for (\S+):/.exec(a.prompt)?.[1]).filter(Boolean);

test('CARDW-1 and CARDW-2 the mod writes the cards owed and missing itself, in the background, a file at a time, and never prompts the lead', async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual(['src/a.ts', 'src/b.ts']);
  expect(w.prompts).toEqual([]);
  expect(w.registered).toEqual([]);
  const a = w.acts.find((x: string[]) => x[0] === 'card' && x[1] === 'src/a.ts');
  expect(a).toEqual(['card', 'src/a.ts', '--text', 'Card for src/a.ts: what it is for and what it keeps true.', '--agent', 'card-writer']);
  // Its request: the setting's model, the file in full, what it imports, its last commits.
  const asked = w.asked.find((x: any) => x.prompt.startsWith('Write the Context Graph card for src/a.ts'));
  expect(asked.model).toBe('haiku');
  expect(asked.prompt).toContain('export const a = b + 1;');
  expect(asked.prompt).toContain('- src/b.ts:');
  expect(asked.prompt).toContain('ST-4 src/a.ts for the booking form');
  // Written, a card isn't asked for again while its file stands still.
  await clock.advance(10000);
  expect(cardAsks(w)).toEqual(['src/a.ts', 'src/b.ts']);
});

test("CARDW-7 files merged in lately from the lanes come after the branch's own", async ($, on) => {
  const w = writing();
  w.recent = { fresh: [], stale: ['packages/design/src/contrast.ts'], missing: ['apps/web/src/form.ts'] };
  w.sources['packages/design/src/contrast.ts'] = 'export const contrast = 4.5;\n';
  w.sources['apps/web/src/form.ts'] = 'export const form = 1;\n';
  const clock = await start($, on, w);
  await clock.advance(10000);
  expect(cardsWritten(w)).toEqual(['src/a.ts', 'src/b.ts', 'packages/design/src/contrast.ts', 'apps/web/src/form.ts']);
});

test('CARDW-1 a file an agent edited in the last 2 minutes waits', async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual(['src/b.ts']);
  await clock.advance(2 * 60000);
  expect(cardsWritten(w)).toEqual(['src/b.ts', 'src/a.ts']);
});

test('CARDW-3 once the cards are current, the Overview says every file is explained', async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await clock.advance(6000);
  w.cards = { fresh: ['src/a.ts', 'src/b.ts'], stale: [], missing: [] };
  w.agents = [{ ...w.agents[0], cardsOwed: [] }];
  w.changed = { fresh: ['src/b.ts'], stale: [], missing: [] };
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'Every file is explained.' })).toBeDefined();
  await ui.unmount();
});

test('CARDW-4 with the card writer on, Cards for this module queue its files for it, not for the lead', async ($, on) => {
  const w = writing();
  w.agents = [];
  w.changed = { fresh: [], stale: [], missing: [] };
  w.moduleCards = { fresh: ['src/a.ts'], stale: ['src/b.ts'], missing: ['src/c.ts'] };
  w.sources['src/c.ts'] = 'export const c = 3;\n';
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  await press($, 'module-cards', PANE);
  expect(await ui.find({ type: 'Text', text: /Queued the cards for the files in L:src/ })).toBeDefined();
  await ui.unmount();
  await clock.advance(4000);
  expect(cardsWritten(w)).toEqual(['src/b.ts', 'src/c.ts']);
  expect(w.prompts).toEqual([]);
});

test("CARDW-5 past the pause point (code-kit's, when it sets one) no card is written", async ($, on) => {
  const w = writing();
  w.limits = [{ kind: 'five_hour', percentUsed: 75 }];
  const clock = await start($, on, w);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual([]);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: "Paused: the plan's 5-hour use is at 75%; it carries on below the pause point." })).toBeDefined();
  await ui.unmount();
});

test("CARDW-6 a file the model finds isn't code is skipped for the session, never put to the lead; Offer them again looks once more", async ($, on) => {
  const w = writing();
  w.agents = [];
  w.changed = { fresh: [], stale: [], missing: ['out/clips/s02/take-1-1.mpx', 'src/b.ts'] };
  w.sources['out/clips/s02/take-1-1.mpx'] = 'ftypisom encoded take';
  w.cardReplies['out/clips/s02/take-1-1.mpx'] = { isAnswered: true, text: 'SKIP: an encoded video take', usage: null };
  const clock = await start($, on, w);
  await clock.advance(8000);
  expect(cardsWritten(w)).toEqual(['src/b.ts']);
  expect(w.prompts).toEqual([]);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: "Skipped 1 file that isn't code this session." })).toBeDefined();
  await press($, 'offer-again', PANE);
  await ui.unmount();
  await clock.advance(2000);
  expect(cardAsks(w).filter((p: string) => p.startsWith('out/'))).toHaveLength(2);
});

test("CARDW-6 a file that isn't text isn't sent to the model at all", async ($, on) => {
  const w = writing();
  w.agents = [];
  w.changed = { fresh: [], stale: [], missing: ['out/take.raw', 'src/b.ts'] };
  w.sources['out/take.raw'] = 'RIFF\u0000\u0000WAVE';
  const clock = await start($, on, w);
  await clock.advance(8000);
  expect(cardAsks(w)).toEqual(['src/b.ts']);
});

test('CARDW-8 a failed request is said on the Overview, and tried again a minute later', async ($, on) => {
  const w = writing();
  w.agents = [];
  w.cardReplies['src/b.ts'] = { isAnswered: false, reason: 'api-error', status: 529 };
  const clock = await start($, on, w);
  await clock.advance(6000);
  expect(cardAsks(w)).toEqual(['src/b.ts']);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: "The last card couldn't be written (api-error 529); it tries again in a minute." })).toBeDefined();
  await ui.unmount();
  delete w.cardReplies['src/b.ts'];
  await clock.advance(60000);
  expect(cardsWritten(w)).toEqual(['src/b.ts']);
});

// --- the curator ------------------------------------------------------------------------------------

function curating(decisions = 5) {
  const w = project();
  w.settings = [
    { key: 'curator', value: true, default: false, about: '' },
    { key: 'curator_model', value: '', default: '', about: '' },
    { key: 'pause_at_percent', value: 80, default: 80, about: '' },
  ];
  w.info = { ...w.info, counts: { decisions, rules: 4 } };
  return w;
}
const moreDecisions = async ($: any, w: any, clock: any, n: number) => {
  w.info = { ...w.info, counts: { ...w.info.counts, decisions: n } };
  await $.tool.call({ tool: 'Read', tool_use_id: `r${n}`, file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
};

/** A module with four decisions on money, for the curator to read. */
const billingHistory = {
  node: 'L:billing',
  card: null,
  constraints: [{ id: 'billing.cents', mode: 'K', text: 'Money is stored as integer cents' }],
  decisions: ['d-1', 'd-2', 'd-3', 'd-4'].map((id) => ({ id, date: '2026-10-09', who: 'w/claude', text: `totals rounded once ${id}` })),
};
const curatorAsks = (w: any) => w.asked.filter((a: any) => a.prompt.startsWith("You are Context Graph's curator"));

test('CUR-1 and CUR-3 after 10 new decisions the mod runs the curator itself, which adds only guidance citing three decisions, and never prompts the lead', async ($, on) => {
  const w = curating(5);
  w.history['L:billing'] = billingHistory;
  w.map = w.map.map((m: any) => (m.id === 'L:billing' ? { ...m, decisions: ['2026-10-09', '2026-10-09', '2026-10-09', '2026-10-09'] } : m));
  w.curation = {
    isAnswered: true,
    text: JSON.stringify({ rules: [{ module: 'L:billing', rule: 'Totals are rounded once, at the end.', cites: ['d-1', 'd-2', 'd-3'] }] }),
    usage: null,
  };
  const clock = await start($, on, w);
  await moreDecisions($, w, clock, 14);
  expect(curatorAsks(w)).toEqual([]);
  await moreDecisions($, w, clock, 15);
  await clock.advance(2000);
  expect(curatorAsks(w)).toHaveLength(1);
  expect(curatorAsks(w)[0].model).toBe('sonnet');
  expect(curatorAsks(w)[0].prompt).toContain('- d-3: totals rounded once d-3');
  expect(curatorAsks(w)[0].prompt).toContain('- Money is stored as integer cents');
  expect(w.acts).toContainEqual(['propose', 'L:billing', 'Totals are rounded once, at the end.']);
  expect(w.prompts).toEqual([]);
  // Its run done, the next counts from here.
  await clock.advance(6000);
  expect(curatorAsks(w)).toHaveLength(1);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: /The curator added a rule as guidance: Totals are rounded once/ })).toBeDefined();
  await ui.unmount();
});

test('CUR-2 a rule overridden again and again is flagged in the pane and the health line, never retired', async ($, on) => {
  const w = curating(5);
  w.hygiene = [
    { signal: 'overridden-since-ratified', target: 'src.small', evidence: ['d-1 2026-10-01 w: split it', 'd-2 2026-10-02 w: split it again', 'd-3 2026-10-03 w: and again'], proposal: 'reword src.small to match how the team works, or retire it (ctx retire src.small --reason ...)', level: 'propose' },
    { signal: 'expired-proposal', target: 'x', evidence: [], proposal: '', level: 'propose' },
  ];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: /1 rule overridden/ })).toBeDefined();
  await press($, 'tab-proposals', PANE);
  expect((await ui.find({ key: 'flagged-src.small' }))?.text).toMatch(/d-3 2026-10-03.*reword src.small/);
  expect(await ui.find({ key: 'flagged-x' })).toBeUndefined();
  await ui.unmount();
  expect(w.acts).toEqual([]);
});

test('CUR-1 Curate now runs it at once, in the background; CUR-4 not past the pause point', async ($, on) => {
  const w = curating(5);
  w.history['L:billing'] = billingHistory;
  w.map = w.map.map((m: any) => (m.id === 'L:billing' ? { ...m, decisions: ['a', 'b', 'c', 'd'] } : m));
  const clock = await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect(await ui.find({ type: 'Text', text: 'Curator: runs after 10 more decisions' })).toBeDefined();
  w.limits = [{ kind: 'five_hour', percentUsed: 90 }];
  await $.session.measure({ context: {} as any, rateLimits: w.limits, changed: ['rateLimits'] });
  await press($, 'curate-now', PANE);
  await ui.unmount();
  await clock.advance(4000);
  expect(curatorAsks(w)).toEqual([]);
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], changed: ['rateLimits'] });
  await clock.advance(2000);
  expect(curatorAsks(w)).toHaveLength(1);
  expect(w.prompts).toEqual([]);
});

// --- side questions ---------------------------------------------------------------------------------

const WHY = 'context-graph-why';

test("ASKQ-1 and ASKQ-2 /why answers beside the conversation from the graph's records, with its cost", async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.command.run({ command: 'why', args: 'src/a.ts' });
  expect(w.opened).toContain(WHY);
  expect(w.asked).toHaveLength(1);
  expect(w.asked[0].fork).toBe(true);
  expect(w.asked[0].prompt).toMatch(/- \[src\.pure\] \(rule\) no side effects/);
  expect(w.asked[0].prompt).toMatch(/- \[d-0003\] \(decision\) 2026-10-03 warren\/claude: keep a constant/);
  expect(w.asked[0].prompt).toMatch(/don't guess/);
  const ui = await mountPane($, WHY);
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Because of [src.pure]: a stays pure.');
  expect((await ui.find({ type: 'Text', text: /tokens in/ }))?.text).toMatch(/s · 1,000 tokens in, 20 out \(900 from the cache\)$/);
  expect(await ui.find({ key: 'source-src.pure' })).toBeDefined();
  // A source that is a file opens in the Context pane.
  await press($, 'source-src/a.ts', WHY);
  expect(w.opened).toContain(PANE);
  await ui.unmount();
  // The lead's conversation gains nothing.
  expect(w.prompts).toEqual([]);
});

test('ASKQ-3 when the graph holds nothing on it, it says so, and no call is made', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.command.run({ command: 'why', args: 'why is billing/cents.ts like this?' });
  expect(w.asked).toEqual([]);
  const ui = await mountPane($, WHY);
  expect(await ui.find({ type: 'Text', text: 'The graph holds nothing on billing/cents.ts: no card, rule or decision names it.' })).toBeDefined();
  await ui.unmount();
});

test('ASKQ with a model set the side call is that model; with side questions off, /why says so', async ($, on) => {
  const w = project();
  w.settings = [
    { key: 'side_questions', value: true, default: true, about: '' },
    { key: 'side_questions_model', value: 'haiku', default: '', about: '' },
  ];
  const clock = await start($, on, w);
  await $.command.run({ command: 'why', args: 'src/a.ts' });
  expect(w.asked[0]).toMatchObject({ model: 'haiku' });
  w.settings[0].value = false;
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/b.ts' } as any);
  await clock.advance(2000);
  const said = await $.command.run({ command: 'why', args: 'src/a.ts' });
  expect(String((said as any)?.text)).toMatch(/Side questions are off/);
});

test('ASKQ the file in view has Why? on w', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect((await ui.find({ key: 'why-file' }))?.props.hotkey).toBe('w');
  await press($, 'why-file', PANE);
  expect(w.asked).toHaveLength(1);
  await ui.unmount();
});

// --- the graph explorer -----------------------------------------------------------------------------

test('MAP-4 the Overview is the first tab: what Context Graph is for, then a row per module with its files explained, rules and decisions, under its parent', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect((await ui.find({ key: 'tab-map' }))?.props).toMatchObject({ hotkey: '1', label: 'Overview', variant: 'primary' });
  expect((await ui.find({ key: 'purpose' }))?.text).toMatch(/^The why of your code/);
  expect((await ui.find({ key: 'explain-count' }))?.text).toBe('FILES EXPLAINED9 of 10█████████░ 90%');
  expect(await ui.find({ type: 'Text', text: 'MODULES' })).toBeDefined();
  expect(shownIn(await ui.find({ key: 'module-L:src' }))).toEqual(['  src', '  1 of 1   █████', '2', '0', 'none']);
  expect(shownIn(await ui.find({ key: 'module-L:billing' }))).toEqual(['    billing', '  6 of 10  ███░░', '1 + 1 proposed', '2', expect.any(String)]);
  await press($, 'move-next', PANE);
  await press($, 'move-next', PANE);
  expect((await ui.findAll({ type: 'Text' })).some((t) => t.text === '›   billing' && t.props.color === 'cyan')).toBe(true);
  expect(await ui.find({ type: 'Text', text: 'billing (L:billing)' })).toBeDefined();
  await ui.unmount();
});

test('MAP-4 a module whose rule is overridden is outlined red, and selecting it shows the rule, and counts the proposals on it for Rules to review', async ($, on) => {
  const w = project();
  w.map[1].ruleList = [{ id: 'billing.cents', text: 'Money is held in cents', mode: 'G' }];
  w.hygiene = [{ signal: 'overridden-since-ratified', target: 'billing.cents', evidence: ['d-1 …', 'd-2 …', 'd-3 …'], proposal: 'reword billing.cents to match how the team works', level: 'propose' }];
  w.proposals = [{ id: 'billing.minor', kind: 'guidance', module: 'L:billing', text: 'Money is held in minor units', served: 0, overridden: 0, violations: null, servedOn: [], overriddenOn: [] }];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  expect((await ui.findAll({ type: 'Text' })).some((t) => t.text === '    billing' && t.props.color === 'red')).toBe(true);
  await press($, 'move-next', PANE);
  await press($, 'move-next', PANE);
  expect(await ui.find({ type: 'Text', text: 'billing.cents overridden 3×' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'Money is held in cents' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: 'reword billing.cents to match how the team works' })).toBeDefined();
  expect(await ui.find({ type: 'Text', text: '1 proposed rule on it, in Rules to review (3)' })).toBeDefined();
  expect(await ui.find({ key: 'graph-accept-billing.minor' })).toBeUndefined();
  await ui.unmount();
});

test('MAP-4 a module where a decision was just recorded lights up, then stops', async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  const billingColor = async () => (await ui.findAll({ type: 'Text' })).find((t) => t.text === '    billing')?.props.color;
  expect(await billingColor()).toBeUndefined();
  // A decision is recorded on billing: the next read of the map has one more.
  w.map = w.map.map((m: any) => (m.id === 'L:billing' ? { ...m, decisions: [...m.decisions, '2026-10-10'] } : m));
  await $.tool.call({ tool: 'Read', tool_use_id: 'r9', file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
  expect(await billingColor()).toBe('blue');
  await clock.advance(10_000);
  await clock.advance(2000);
  expect(await billingColor()).toBeUndefined();
  await ui.unmount();
});

test('MAP-2 and MAP-3 Enter opens a module as a heat map of its files, and a file in the File tab', async ($, on) => {
  const w = project();
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [], cardsOwed: ['src/billing/a.ts'] }];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  await press($, 'move-next', PANE);
  await press($, 'move-next', PANE);
  await press($, 'open-selected', PANE);
  // One owed this session shows as owed, over its current card.
  expect((await ui.find({ key: 'heat-legend' }))?.text).toBe('● 5 explained◐ 2 out of date○ 2 not explained yet✱ 1 changed this session, to explain');
  expect((await ui.find({ key: 'cell-src/billing/i.ts' }))?.text).toBe('○');
  await $.ui.select({ plugin: 'context-graph', key: 'heat-select', value: 'src/billing/i.ts', requestId: PANE });
  expect(JSON.stringify((await ui.find({ key: 'cell-src/billing/i.ts' }))?.children)).toMatch(/"inverse":true/);
  await press($, 'open-selected', PANE);
  expect(w.fileAsks.at(-1)?.[0]).toBe('src/billing/i.ts');
  expect((await ui.find({ key: 'tab-file' }))?.props.variant).toBe('primary');
  await ui.unmount();
});

test("with no session bound (claude -p before it mounts), the agent list's failure leaves the pane working", async ($, on) => {
  const w = project();
  w.agentsThrow = true;
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-file', PANE);
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Holds a.');
  await ui.unmount();
});

test('VIEW-3 the queue groups proposals by module, and Accept all accepts a module\'s in one commit', async ($, on) => {
  const w = project();
  w.answer = 'Accept all';
  w.proposals = [
    { id: 'ai.a', kind: 'enforced', module: 'L:ai', text: 'a', served: 0, overridden: 0, violations: null, servedOn: [], overriddenOn: [] },
    { id: 'evals.b', kind: 'enforced', module: 'L:evals', text: 'b', served: 0, overridden: 0, violations: null, servedOn: [], overriddenOn: [] },
    { id: 'ai.c', kind: 'enforced', module: 'L:ai', text: 'c', served: 0, overridden: 0, violations: null, servedOn: [], overriddenOn: [] },
  ];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect(await ui.find({ type: 'Text', text: /Accept one and agents are held to it from now on; reject it to remove it\./ })).toBeDefined();
  const rules = (await ui.findAll({ type: 'Text' })).map((x) => x.text).filter((x) => ['a', 'b', 'c'].includes(x));
  expect(rules).toEqual(['a', 'c', 'b']);
  expect((await ui.find({ key: 'accept-all-L:ai' }))?.props.label).toBe('Accept all 2 in ai');
  expect(await ui.find({ key: 'accept-all-L:evals' })).toBeUndefined();
  await press($, 'accept-all-L:ai', PANE);
  expect(w.acts).toEqual([['ratify', 'ai.a', 'ai.c', '--commit']]);
  await ui.unmount();
});

// --- the backfill: a brownfield project's cards ----------------------------------------------------

function backfilling() {
  const w = project();
  w.proposals = [];
  w.settings = [
    { key: 'card_writer', value: false, default: false, about: '' },
    { key: 'backfill', value: 'active', default: 'off', about: '' },
    { key: 'pause_at_percent', value: 80, default: 80, about: '' },
  ];
  const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, '0')}.ts`);
  w.backfill = { scope: 'active', files: files.slice(2), inScope: 12 };
  return w;
}

test('backfill: the card writer takes the existing code, leaves first, even with the card writer itself off', async ($, on) => {
  const w = backfilling();
  for (const f of w.backfill.files) w.sources[f] = `export const x = '${f}';\n`;
  const clock = await start($, on, w);
  await clock.advance(4000);
  expect(cardsWritten(w)).toEqual(['src/f02.ts', 'src/f03.ts']);
  expect(w.prompts).toEqual([]);
});

test('backfill: it runs in the background, out of the band; the Overview shows its progress with Pause, and paused nothing is written until Resume', async ($, on) => {
  const w = backfilling();
  for (const f of w.backfill.files) w.sources[f] = `export const x = '${f}';\n`;
  w.limits = [{ kind: 'five_hour', percentUsed: 95 }];
  const clock = await start($, on, w);
  const band = await bandUi($);
  expect(await band.find({ type: 'Text', text: /existing code/ })).toBeUndefined();
  await band.unmount();
  await $.session.measure({ context: {} as any, rateLimits: [], changed: ['rateLimits'] });
  await ctx($);
  let ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  expect(await ui.find({ type: 'Text', text: '10 files queued, written in the background one at a time.' })).toBeDefined();
  await press($, 'explain-pause', PANE);
  await ui.unmount();
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual([]);
  ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'Paused by you.' })).toBeDefined();
  expect((await ui.find({ key: 'explain-resume' }))?.props.label).toBe('Resume');
  await press($, 'explain-resume', PANE);
  await ui.unmount();
  await clock.advance(2000);
  expect(cardsWritten(w).length).toBeGreaterThan(0);
});

test("MAP-4 the Overview opens on the backfill's progress, and with one module says so in a line instead of a table", async ($, on) => {
  const w = backfilling();
  w.map = [{ id: 'L:src', name: 'Source', depth: 0, parents: [], rules: { agreed: 1, proposed: 0 }, decisions: [], files: [{ path: 'src/f00.ts', card: 'missing' }] }];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  expect(await ui.find({ key: 'explain-now' })).toBeDefined();
  expect(await ui.find({ key: 'module-L:src' })).toBeUndefined();
  expect(await ui.find({ type: 'Text', text: /^The graph treats the whole repository as one module/ })).toBeDefined();
  await ui.unmount();
});

test('MAP-2 the heat map has Explain the ones not explained on c', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-map', PANE);
  await press($, 'move-next', PANE);
  await press($, 'move-next', PANE);
  await press($, 'open-selected', PANE);
  expect((await ui.find({ key: 'module-write-cards' }))?.props.hotkey).toBe('c');
  await press($, 'module-write-cards', PANE);
  expect(w.prompts).toEqual(['Write the Context Graph cards for the files in L:billing without a current one: run /context-graph:cards L:billing, or ask the agent working on L:billing to.']);
  await ui.unmount();
});

test("with code-kit's loop paused by the person, no card is written, and the pane says why", async ($, on) => {
  const w = writing();
  w.settings = w.settings.map((r: any) => (r.key === 'card_writer' ? { ...r, pausedBy: 'code-kit' } : r));
  const clock = await start($, on, w);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual([]);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: "Paused while code-kit's loop is paused; it carries on when that resumes." })).toBeDefined();
  await ui.unmount();
  // Resumed: it carries on.
  w.settings = w.settings.map((r: any) => ({ ...r, pausedBy: undefined }));
  await $.tool.call({ tool: 'Read', tool_use_id: 'r9', file_path: '/work/src/a.ts' } as any);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual(['src/a.ts', 'src/b.ts']);
});

test("the lead's turns don't hold the card writer up, and nothing it does reaches the lead", async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await $.turn.start({ turnId: 't-1', text: '' } as any);
  await clock.advance(6000);
  expect(cardsWritten(w)).toEqual(['src/a.ts', 'src/b.ts']);
  await $.turn.complete({ turnId: 't-1', answer: '', durationMs: 1, isAborted: false } as any);
  expect(w.prompts).toEqual([]);
});
