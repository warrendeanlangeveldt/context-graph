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
  };
}
type World = ReturnType<typeof project>;

function stub(on: any, w: World) {
  on('process.run', ($: any, e: any) => {
    const argv: readonly string[] = e.argv;
    const ran = (exitCode: number, stdout: string, stderr = '') => ({ value: { exitCode, stdout, stderr } });
    const sub = argv[2];
    if (sub === 'info') return ran(0, JSON.stringify(w.info));
    if (sub === 'proposals') return ran(0, JSON.stringify(w.proposals));
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
    return ran(1, '', `unexpected ${argv.join(' ')}`);
  });
  on('session.start', () => ({ cwd: '/work' }));
  on('ui.render', () => ({ type: 'Box', props: {}, children: [] }));
  on('tool.call', { tool: 'Read' }, () => ({ result: { type: 'text', file: {} } }));
  on('tool.call', { tool: 'Edit' }, () => ({ result: {} }));
  on('tool.call', { tool: 'AskUserQuestion' }, ($: any, e: any) => ({
    result: { questions: e.questions, answers: { [e.questions[0].question]: w.answer } },
  }));
  on('command.run', { command: 'lanes' }, () => {
    w.commands.push('lanes');
    return { text: '' };
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
const ctx = ($: any) => $.command.run({ command: 'ctx', args: '' });

test('FILE-1 /ctx opens the pane on the file an agent read, naming the agent', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  expect(w.opened).toEqual([PANE]);
  expect(w.fileAsks.at(-1)).toEqual(['src/a.ts', '--session', 's1', '--agent', 'agent-web', '--json']);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'src/a.ts · web-engineer' })).toBeDefined();
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
  expect(await ui.find({ type: 'Text', text: 'src/b.ts · web-engineer' })).toBeDefined();
  await ui.unmount();
});

test('FILE-3 the pane says what the agent still has to read', async ($, on) => {
  const w = project();
  await start($, on, w);
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/src/a.ts', agentId: 'agent-web' } as any);
  await ctx($);
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'Not understood yet: still to read src/b.ts' })).toBeDefined();
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

test('FILE-5 without a graph, /ctx says how to start one and there is no band', async ($, on) => {
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
  expect(await band.find({ type: 'Text', text: '2 proposals to ratify' })).toBeDefined();
  await press($, 'band-context');
  expect(w.opened).toContain(PANE);
  await band.unmount();
  const ui = await mountPane($, PANE);
  expect(await ui.find({ type: 'Text', text: 'served 3, overridden 1' })).toBeDefined();
  await ui.unmount();
});

test('RAT-3 Ratify confirms, then ratifies and commits as the person', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
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
  await press($, 'ratify-src.small', PANE);
  expect(w.acts).toEqual([]);
  await ui.unmount();
});

test('RAT-4 Drop asks why, needs a reason, and drops it with that reason', async ($, on) => {
  const w = project();
  await start($, on, w);
  await ctx($);
  const ui = await mountPane($, PANE);
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
  expect(await before.find({ type: 'Text', text: 'web-engineer: read 1, searched 0, edited 0' })).toBeDefined();
  await before.unmount();
  w.agents = [{ ...w.agents[0], read: ['src/a.ts', 'src/b.ts'] }];
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/work/src/b.ts', agentId: 'agent-web' } as any);
  await clock.advance(2000);
  const after = await mountPane($, PANE);
  expect(await after.find({ type: 'Text', text: 'web-engineer: read 2, searched 0, edited 0' })).toBeDefined();
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
  expect(await ui.find({ type: 'Text', text: '  ! edited src/a.ts without understanding: unread src/b.ts' })).toBeDefined();
  await ui.unmount();
});
