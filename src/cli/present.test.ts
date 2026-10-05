import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeHook, type HookInput } from '../adapters/claude-code/hook.js';
import { writeCard } from '../cards/cards.js';
import { openRepo } from '../core/context.js';
import { runGate } from '../gate/gate.js';
import { Graph } from '../graph/graph.js';
import { ratify } from '../init/ratify.js';
import { isPersonsGraphAct } from './person-acts.js';
import { agentCoverage, commitGraph, commitRefusal, fileContext, proposals } from './present.js';
import { run } from './present.js';

const GRAPH = `M src/** L:src
M ** L:repo
L L:repo Repo
L L:src Source
E L:src in L:repo
K G src.pure L:src no side effects at import
K G? src.small L:src keep modules small
C C:events Change goes through events proposed
`;

describe('what the Context Graph pane shows, and the person\'s acts', () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CODE_KIT_CLI: process.env.CODE_KIT_CLI };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const base = (extra: Partial<HookInput> = {}) => ({ session_id: 's1', cwd: repo, ...extra });
  const read = (rel: string, extra: Partial<HookInput> = {}) =>
    runClaudeHook({ ...base(extra), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, rel) } });
  const grep = (pattern: string, extra: Partial<HookInput> = {}) =>
    runClaudeHook({ ...base(extra), hook_event_name: 'PostToolUse', tool_name: 'Grep', tool_input: { pattern, path: join(repo, 'src') }, tool_response: { filenames: [join(repo, 'src/c.ts')] } });
  const edit = (rel: string, extra: Partial<HookInput> = {}) =>
    runClaudeHook({ ...base(extra), hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, rel), old_string: 'x', new_string: 'y' } });
  const lane = { agent_id: 'agent-web', agent_type: 'web-engineer' };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-present-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    process.env.CODE_KIT_CLI = join(repo, 'no-code-kit');
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'warren@example.com');
    git('config', 'user.name', 'Warren');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, '.ctx/config.toml'), '[repo]\nratifiers = ["warren"]\n');
    writeFileSync(join(repo, '.ctx/decisions.ctx'), 'D d-0001 2026-10-01 warren/claude - main src/a.ts ->K src.pure a stays a constant\n');
    writeFileSync(join(repo, 'src/a.ts'), "import { b } from './b.js';\nexport const a = b + 1;\n");
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'src/c.ts'), 'export const c = 3;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('FILE-2 shows a file\'s card, rules, chain and newest decisions', () => {
    writeCard(Graph.load(join(repo, '.ctx')), repo, { path: 'src/a.ts', text: 'Holds a.', who: 'warren/claude', date: '2026-10-06' });
    const f = fileContext(openRepo({ repo }), 'src/a.ts');
    expect(f.card).toMatchObject({ text: 'Holds a.', fresh: true });
    expect(f.chain).toEqual(['L:src', 'L:repo']);
    expect(f.rules.map((r) => r.id)).toContain('src.pure');
    expect(f.decisions[0]).toMatchObject({ id: 'd-0001', text: 'a stays a constant' });
  });

  it('FILE-3 says whether an agent understood the file, and what it still has to read', async () => {
    await read('src/a.ts', lane);
    const ctx = openRepo({ repo });
    const before = fileContext(ctx, 'src/a.ts', { session: 's1', agent: 'agent-web' });
    expect(before.understood.ok).toBe(false);
    expect(before.understood.missing.map((m) => m.path)).toEqual(['src/b.ts']);
    await read('src/b.ts', lane);
    expect(fileContext(openRepo({ repo }), 'src/a.ts', { session: 's1', agent: 'agent-web' }).understood.ok).toBe(true);
    // Another agent's reads never count for this one.
    expect(fileContext(openRepo({ repo }), 'src/a.ts', { session: 's1', agent: 'agent-api' }).understood.ok).toBe(false);
  });

  it('COV-1 gives each agent\'s reads, searches and edits, and whether each edit was understood', async () => {
    await read('src/a.ts', lane);
    await read('src/b.ts', lane);
    await grep('const', lane);
    await edit('src/a.ts', lane);
    await edit('src/c.ts', { agent_id: 'agent-api', agent_type: 'api-engineer' });
    const list = agentCoverage(openRepo({ repo }), 's1');
    const web = list.find((a) => a.agent === 'agent-web')!;
    expect(web.read).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts']));
    expect(web.edited).toEqual([{ path: 'src/a.ts', understood: true, missing: [] }]);
    const api = list.find((a) => a.agent === 'agent-api')!;
    expect(api.edited[0]).toMatchObject({ path: 'src/c.ts', understood: false });
  });

  it('RAT-1 lists proposals with the evidence a person decides on', () => {
    writeFileSync(join(repo, '.ctx/decisions.ctx'), readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8') + 'D d-0002 2026-10-02 warren/claude - main src/a.ts ->K src.small small\nD d-0003 2026-10-03 warren/claude - main src/b.ts ->K src.pure !K src.small too small to split\n');
    const list = proposals(openRepo({ repo }));
    expect(list.find((p) => p.id === 'src.small')).toMatchObject({ kind: 'guidance', served: 1, overridden: 1 });
    expect(list.find((p) => p.id === 'C:events')).toMatchObject({ kind: 'concepts' });
  });

  it('RAT-3 ratifies and commits only the graph with the person\'s trailer, on a branch, which the gate accepts', () => {
    expect(commitRefusal(openRepo({ repo }))).toMatch(/main is protected/);
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'src/c.ts'), 'export const c = 4;\n'); // unrelated work stays uncommitted
    const ctx = openRepo({ repo });
    expect(commitRefusal(ctx)).toBeUndefined();
    ratify(ctx, ['C:events']);
    commitGraph(ctx, 'Ratify C:events');
    expect(git('log', '-1', '--format=%B')).toContain('Ctx-Ratified-By: warren');
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').every((f) => f.startsWith('.ctx/'))).toBe(true);
    expect(git('status', '--porcelain')).toContain('src/c.ts');
    const report = runGate(openRepo({ repo }), { base: 'main' });
    expect(report.findings.filter((f) => f.rule === 'unratified')).toEqual([]);
  });

  it('RAT-3 refuses a person who isn\'t a ratifier, before changing anything', () => {
    git('checkout', '-q', '-b', 'feature');
    git('config', 'user.email', 'someone@example.com');
    expect(commitRefusal(openRepo({ repo }))).toMatch(/isn't among the ratifiers/);
  });

  it('RAT-4 drops a proposal, keeping the reason in its history', async () => {
    git('checkout', '-q', '-b', 'feature');
    const code = await run({ cmd: 'drop', positional: ['src.small'], flags: { reason: 'not how we work', commit: true } }, { json: true });
    expect(code).toBe(0);
    const g = openRepo({ repo }).graph!;
    expect(g.isRetired('src.small')).toBe(true);
    expect(proposals(openRepo({ repo })).some((p) => p.id === 'src.small')).toBe(false);
    expect(readFileSync(join(repo, '.ctx/graph.ctx'), 'utf8')).toContain('dropped proposal: not how we work');
    expect(git('log', '-1', '--format=%B')).toContain('Ctx-Ratified-By: warren');
  });

  it('RAT-5 the hook refuses the person\'s acts from agents', async () => {
    expect(isPersonsGraphAct('ctx ratify C:events --commit')).toBe(true);
    expect(isPersonsGraphAct('node "/x/ctx.mjs" drop src.small --reason no')).toBe(true);
    expect(isPersonsGraphAct('ctx ratify C:events')).toBe(false);
    expect(isPersonsGraphAct('ctx ratify C:events --delegated --reason x')).toBe(false);
    expect(isPersonsGraphAct('cd src && ctx drop src.small --reason no')).toBe(true);
    // Mentioning the command is not running it: documentation written through a heredoc, or an echo.
    expect(isPersonsGraphAct("cat > README.md <<'EOF'\n- **`ctx drop <id> --reason`** turns a proposal down\nEOF")).toBe(false);
    expect(isPersonsGraphAct("echo 'ctx ratify C:events --commit'")).toBe(false);
    const out = await runClaudeHook({ ...base(lane), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ctx ratify C:events --commit' } });
    const decision = JSON.parse(out.stdout ?? '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    expect(decision.hookSpecificOutput?.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain("the person's own acts");
  });
});
