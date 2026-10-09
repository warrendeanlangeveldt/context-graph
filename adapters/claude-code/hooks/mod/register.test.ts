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
    answer: 'Ratify',
    acts: [] as string[][],
    fileAsks: [] as string[][],
    open: new Set<string>(),
    opened: [] as string[],
    commands: [] as string[],
    prompts: [] as string[],
    settings: [
      { key: 'card_writer', value: false, default: false, about: 'A background agent that writes the cards owed' },
      { key: 'card_writer_model', value: '', default: '', about: "The card writer's model" },
      { key: 'pause_at_percent', value: 80, default: 80, about: 'The pause point' },
    ] as any[],
    setExit: 0,
    cards: { fresh: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], stale: ['j'], missing: [] } as any,
    editRefusal: '',
    changed: { fresh: [], stale: [], missing: [] } as any,
    moduleCards: { fresh: [], stale: [], missing: [] } as any,
    registered: [] as any[],
    limits: [] as any[],
    hygiene: [] as any[],
    sent: [] as { to: any; text: string }[],
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
    if (sub === 'info') return ran(0, JSON.stringify(w.info));
    if (sub === 'hygiene') return ran(0, JSON.stringify(w.hygiene));
    if (sub === 'proposals') return ran(0, JSON.stringify(w.proposals));
    if (sub === 'cards' && argv.includes('--changed')) return ran(0, JSON.stringify(w.changed));
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
  on('agent.list', () => ({ value: w.running }));
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
  expect(await ui.find({ type: 'Text', text: 'src/b.ts' })).toBeDefined();
  await ui.unmount();
});

test('FILE-3 the pane says what the agent still has to read', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: '✗ not yet: still to read src/b.ts' })).toBeDefined();
  await ui.unmount();
});

test("FILE-4 the code-kit section opens code-kit's Lanes pane", async ($, on) => {
  const w = project();
  w.files['src/a.ts'] = { ...w.files['src/a.ts'], tools: { lines: ['code-kit  lane web · layer ui · WEB-1'], requirements: ['WEB-1'] } };
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
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

test('RAT-1 and RAT-2 the proposals show their evidence, and the band counts them', async ($, on) => {
  const w = project();
  await start($, on, w);
  const band = await bandUi($);
  expect(await band.find({ type: 'Text', text: '☀ 90% carded · 0 owed · 2 proposals' })).toBeDefined();
  await press($, 'band-context');
  expect(w.opened).toContain(PANE);
  await band.unmount();
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect(await ui.find({ type: 'Text', text: 'Evidence: served by 3 decisions, overridden by 1 decision' })).toBeDefined();
  await ui.unmount();
});

test('RAT-3 Ratify confirms, then ratifies and commits as the person', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  await press($, 'ratify-src.small', PANE);
  expect(w.acts).toEqual([['ratify', 'src.small', '--commit']]);
  expect(await ui.find({ type: 'Text', text: /Ratified src.small: committed abc1234 with Ctx-Ratified-By: warren/ })).toBeDefined();
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
  expect(await ui.find({ type: 'Text', text: /Nothing ratified: main is protected. Switch to a branch/ })).toBeDefined();
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
  expect(await ui.find({ type: 'Text', text: 'Dropped src.small: not how we work' })).toBeDefined();
  await ui.unmount();
});

test('COV-1 and COV-2 coverage per agent rises within 2 seconds of a read', async ($, on) => {
  const w = project();
  const clock = await start($, on, w);
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: ['src/a.ts'], searched: [], edited: [], cardsOwed: [] }];
  await ctx($);
  const before = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(shownIn(await before.find({ key: 'agent-agent-web' }))).toEqual(['web-engineer', '1', '0', '0', '0']);
  await before.unmount();
  w.agents = [{ ...w.agents[0], read: ['src/a.ts', 'src/b.ts'] }];
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/work/src/b.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  const after = await mountPane($, PANE);
  expect(shownIn(await after.find({ key: 'agent-agent-web' }))).toEqual(['web-engineer', '2', '0', '0', '0']);
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
  expect(await ui.find({ type: 'Text', text: '✗ web-engineer edited src/a.ts without understanding it: src/b.ts unread' })).toBeDefined();
  await ui.unmount();
});

test('Cards: Write card and Cards for this module ask the lead, who may write them or hand them on', async ($, on) => {
  const w = project();
  w.files['src/b.ts'] = { ...w.files['src/b.ts'], card: null };
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/b.ts' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
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
  const header = await ui.find({ type: 'Text', text: '⛅ 90% carded · 1 owed · 0 proposals' });
  expect(header?.props.color).toBe('yellow');
  await ui.unmount();
  const band = await bandUi($);
  expect((await band.find({ type: 'Text', text: '⛅ 90% carded · 1 owed · 0 proposals' }))?.props.color).toBe('yellow');
  await band.unmount();
});

test('VIEW-1 with nothing waiting and the graph healthy there is no band line', async ($, on) => {
  const w = project();
  w.proposals = [];
  w.cards = { fresh: ['a', 'b'], stale: [], missing: [] };
  await start($, on, w);
  const band = await bandUi($);
  expect(await band.find({ type: 'Text', text: /carded/ })).toBeUndefined();
  await band.unmount();
});

test('VIEW-5 tabs on 1 to 3; j/k select an agent and Enter opens the file it edited without understanding', async ($, on) => {
  const w = project();
  w.agents = [
    { agent: 'main', agentType: null, read: [], searched: [], edited: [], cardsOwed: [] },
    { agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [{ path: 'src/a.ts', understood: false, missing: ['src/b.ts'] }], cardsOwed: [] },
  ];
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect((await ui.find({ key: 'tab-coverage' }))?.props.hotkey).toBe('3');
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
  expect((await ui.find({ type: 'Markdown' }))?.props.text).toBe('Holds a.');
  expect((await ui.find({ key: 'imports-src/b.ts' }))?.props.label).toBe('○ src/b.ts');
  await press($, 'imports-src/b.ts', PANE);
  expect(w.fileAsks.at(-1)?.[0]).toBe('src/b.ts');
  expect((await ui.find({ key: 'importers-src/a.ts' }))?.props.label).toBe('● src/a.ts');
  expect(await ui.find({ type: 'Text', text: 'Esc: back' })).toBeDefined();
  await ui.unmount();
});

// --- the proposals queue ----------------------------------------------------------------------------

test('VIEW-3 each proposal has its sparklines; r ratifies, d drops and f defers the selected one', async ($, on) => {
  const w = project();
  w.proposals[0] = { ...w.proposals[0], servedOn: ['2026-10-01', '2026-10-02', '2026-10-03'], overriddenOn: ['2026-10-03'] };
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect((await ui.find({ key: 'spark-src.small' }))?.text).toMatch(/served\s+▁+.*overridden\s*▁+/);
  await press($, 'move-next', PANE);
  expect((await ui.find({ key: 'key-defer' }))?.props.hotkey).toBe('f');
  await press($, 'key-defer', PANE);
  // Deferred, src.small goes to the back: C:events is first now.
  const order = (await ui.findAll({ type: 'Text' })).map((x) => x.text).filter((x) => x === 'src.small' || x === 'C:events');
  expect(order).toEqual(['C:events', 'src.small']);
  expect(await ui.find({ type: 'Text', text: 'deferred' })).toBeDefined();
  expect((await ui.find({ key: 'key-ratify' }))?.props.label).toBe('Ratify C:events');
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
  expect(await pane.find({ type: 'Text', text: /reading to edit src\/a\.ts: 1 of 2 read/ })).toBeDefined();
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
const leadTurn = async ($: any, clock: any, id = 't-1') => {
  await $.turn.start({ turnId: id, text: '' } as any);
  await $.turn.complete({ turnId: id, answer: '', durationMs: 1, isAborted: false } as any);
  for (let i = 0; i < 3; i++) await clock.advance(1);
};

test('CARDW-1 and CARDW-2 with the lead idle, the lead starts the card writer on the cards owed and missing', async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  expect(w.registered[0]).toMatchObject({ name: 'card-writer', model: 'haiku', disallowedTools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] });
  expect(w.registered[0].prompt).toMatch(/Read it in full, with what it imports/);
  await leadTurn($, clock);
  expect(w.prompts).toEqual([
    'Start Context Graph\'s card writer in the background: use the Agent tool with subagent_type "context-graph:card-writer", run_in_background true, description "Write 2 cards (Context Graph)", and the prompt "Write the cards for: src/a.ts, src/b.ts." Then carry on; it only writes cards.',
  ]);
  // One batch at a time: the next lead turn starts no second card writer.
  await leadTurn($, clock, 't-2');
  expect(w.prompts).toHaveLength(1);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(await ui.find({ type: 'Text', text: 'Card writer: writing 2 (src/a.ts, src/b.ts)' })).toBeDefined();
  await ui.unmount();
});

test('CARDW-1 a file an agent edited in the last 2 minutes waits', async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await leadTurn($, clock);
  expect(w.prompts[0]).toMatch(/"Write the cards for: src\/b\.ts\."/);
});

test("CARDW-3 a batch's cards are done once current, and the writer's own end frees it for the next", async ($, on) => {
  const w = writing();
  const clock = await start($, on, w);
  await leadTurn($, clock);
  w.cards = { fresh: ['src/a.ts', 'src/b.ts'], stale: [], missing: [] };
  w.agents = [{ ...w.agents[0], cardsOwed: [] }];
  w.changed = { fresh: ['src/b.ts'], stale: [], missing: [] };
  w.running = [{ id: 'cw1', type: 'context-graph:card-writer', status: 'completed' }];
  await $.turn.complete({ turnId: 't-cw', agentId: 'cw1', answer: 'written', durationMs: 1, isAborted: false } as any);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(await ui.find({ type: 'Text', text: 'Card writer: nothing owed' })).toBeDefined();
  await ui.unmount();
});

test('CARDW-4 with the card writer on, Cards for this module queue its files for it, not for the lead', async ($, on) => {
  const w = writing();
  w.agents = [];
  w.changed = { fresh: [], stale: [], missing: [] };
  w.moduleCards = { fresh: ['src/a.ts'], stale: ['src/b.ts'], missing: ['src/c.ts'] };
  const clock = await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts' } as any);
  await clock.advance(2000);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'module-cards', PANE);
  expect(w.prompts).toEqual([expect.stringMatching(/"Write the cards for: src\/b\.ts, src\/c\.ts\."/)]);
  expect(await ui.find({ type: 'Text', text: /Queued the cards for the files in L:src/ })).toBeDefined();
  await ui.unmount();
});

test("CARDW-5 past the pause point (code-kit's, when it sets one) no batch starts", async ($, on) => {
  const w = writing();
  w.limits = [{ kind: 'five_hour', percentUsed: 75 }];
  const clock = await start($, on, w);
  await leadTurn($, clock);
  expect(w.prompts).toEqual([]);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-coverage', PANE);
  expect(await ui.find({ type: 'Text', text: 'Card writer: paused, the plan at 75%' })).toBeDefined();
  await ui.unmount();
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

test('CUR-1 and CUR-3 after 10 new decisions, the lead starts the curator, which only proposes', async ($, on) => {
  const w = curating(5);
  const clock = await start($, on, w);
  expect(w.registered.find((s) => s.name === 'curator')).toMatchObject({ disallowedTools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'] });
  expect(w.registered.find((s) => s.name === 'curator').prompt).toMatch(/never edit files, ratify, drop, retire or change settings/);
  await moreDecisions($, w, clock, 14);
  await leadTurn($, clock);
  expect(w.prompts).toEqual([]);
  await moreDecisions($, w, clock, 15);
  await leadTurn($, clock, 't-2');
  expect(w.prompts).toEqual([
    'Start Context Graph\'s curator in the background: use the Agent tool with subagent_type "context-graph:curator", run_in_background true, description "Curate the graph (Context Graph)", and the prompt "Review the 10 decisions recorded since you last ran and the graph\'s evidence; propose the rules they show." Then carry on; it only proposes.',
  ]);
  // Its report ends its run; the next counts from there.
  w.running = [{ id: 'cu1', type: 'context-graph:curator', status: 'completed' }];
  await $.turn.complete({ turnId: 't-cu', agentId: 'cu1', answer: 'proposed one', durationMs: 1, isAborted: false } as any);
  await leadTurn($, clock, 't-3');
  expect(w.prompts).toHaveLength(1);
});

test('CUR-1 the card writer goes first when both are due; the curator the turn after', async ($, on) => {
  const w = curating(5);
  w.settings.push({ key: 'card_writer', value: true, default: false, about: '' });
  w.agents = [{ agent: 'agent-web', agentType: 'web-engineer', read: [], searched: [], edited: [], cardsOwed: ['src/a.ts'] }];
  const clock = await start($, on, w);
  await moreDecisions($, w, clock, 20);
  await leadTurn($, clock);
  expect(w.prompts).toHaveLength(1);
  expect(w.prompts[0]).toMatch(/card writer/);
  await leadTurn($, clock, 't-2');
  expect(w.prompts[1]).toMatch(/curator/);
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

test('CUR-1 Curate now runs it at the next idle turn; CUR-4 not past the pause point', async ($, on) => {
  const w = curating(5);
  const clock = await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
  await press($, 'tab-proposals', PANE);
  expect(await ui.find({ type: 'Text', text: 'Curator: runs after 10 more decisions' })).toBeDefined();
  await press($, 'curate-now', PANE);
  await ui.unmount();
  w.limits = [{ kind: 'five_hour', percentUsed: 90 }];
  await $.session.measure({ context: {} as any, rateLimits: w.limits, changed: ['rateLimits'] });
  await leadTurn($, clock);
  expect(w.prompts).toEqual([]);
  await $.session.measure({ context: {} as any, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }], changed: ['rateLimits'] });
  await leadTurn($, clock, 't-2');
  expect(w.prompts[0]).toMatch(/curator.*Review the latest decisions/);
});
