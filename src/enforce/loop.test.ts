import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runClaudeHook, type HookInput } from '../adapters/claude-code/hook.js';
import { runCodexHook } from '../adapters/codex/hook.js';
import { contentHash, writeCard } from '../cards/cards.js';
import { openRepo } from '../core/context.js';
import { Graph } from '../graph/graph.js';
import { factsFor } from '../tool-adapters/index.js';

/**
 * The context loop, end to end on a temporary repository with the defaults: a file is understood before
 * it is edited (its fresh card, or read in full with its dependencies), and its card is written after.
 */

const GRAPH = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
M **                   L:repo
L L:repo Repository
L L:orch Orchestration
L L:core Engine
E L:orch in L:core
E L:core in L:repo
K G orch.events L:orch state via events only
`;

const BB = `import { helper } from '../helper.js';

export class Blackboard {
  applyEvent(e: string): void {
    helper(e);
  }
}
`;

type Pre = { hookSpecificOutput: { permissionDecision?: string; permissionDecisionReason?: string; additionalContext?: string } };

describe('the context loop', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CTX_GRAPH_DIR: process.env.CTX_GRAPH_DIR, CODE_KIT_CLI: process.env.CODE_KIT_CLI };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-loop-')));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    process.env.CLAUDE_PROJECT_DIR = repo;
    delete process.env.CTX_GRAPH_DIR;
    process.env.CODE_KIT_CLI = join(repo, 'no-code-kit');
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'tester@example.com');
    git('config', 'user.name', 'Tester');
    mkdirSync(join(repo, 'api/src/core/orch'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), BB);
    writeFileSync(join(repo, 'api/src/core/helper.ts'), 'export const helper = (e: string): void => {};\n');
    writeFileSync(join(repo, 'api/src/core/caller.ts'), "import { Blackboard } from './orch/bb.js';\nnew Blackboard();\n");
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const base = (extra: Partial<HookInput> = {}): Pick<HookInput, 'session_id' | 'cwd'> & Partial<HookInput> => ({ session_id: 's1', cwd: repo, ...extra });
  const bb = (): string => join(repo, 'api/src/core/orch/bb.ts');
  const read = (file: string, extra: Partial<HookInput> = {}, input: Record<string, unknown> = {}): Promise<unknown> =>
    runClaudeHook({ ...base(extra), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: file, ...input } });
  const edit = (file: string, old: string, neu: string, extra: Partial<HookInput> = {}) =>
    runClaudeHook({ ...base(extra), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file, old_string: old, new_string: neu } });
  const pre = (out: { stdout?: string }): Pre => JSON.parse(out.stdout ?? '{"hookSpecificOutput":{}}') as Pre;
  const card = (path: string, text: string): void => {
    const g = Graph.load(join(repo, '.ctx'));
    writeCard(g, repo, { path, text, who: 'tester/claude', date: '2026-09-30' });
  };

  it('refuses an edit of a file that has no card and was not read in full, naming what to read', async () => {
    const out = pre(await edit(bb(), 'helper(e);', 'helper(e); // x'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    const reason = out.hookSpecificOutput.permissionDecisionReason!;
    expect(reason).toContain('api/src/core/orch/bb.ts: it has no card yet, so read it in full');
    expect(reason).toContain('api/src/core/helper.ts: imported by api/src/core/orch/bb.ts');
    // A range read is not the file.
    await read(bb(), {}, { offset: 3, limit: 4 });
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x')).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('allows the edit once the file and what it imports are read in full', async () => {
    await read(bb());
    await read(join(repo, 'api/src/core/helper.ts'));
    const out = pre(await edit(bb(), 'helper(e);', 'helper(e); // x'));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('[G orch.events]');
  });

  it('counts a dependency understood through its fresh card', async () => {
    card('api/src/core/helper.ts', 'the one place events are normalised before any handler sees them');
    await read(bb());
    const out = pre(await edit(bb(), 'helper(e);', 'helper(e); // x'));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('file api/src/core/helper.ts\n  card  the one place events are normalised');
  });

  it('lets a file with a fresh card be edited on its card, and refuses once the card is stale', async () => {
    card('api/src/core/orch/bb.ts', 'applies events to the blackboard; never touches the workspace directly');
    await read(bb(), {}, { offset: 3, limit: 4 });
    const hit = pre(await edit(bb(), 'helper(e);', 'helper(e); // x'));
    expect(hit.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(hit.hookSpecificOutput.additionalContext).toContain('card  applies events to the blackboard');

    writeFileSync(bb(), BB.replace('helper(e);', 'helper(e); // changed by someone else'));
    const stale = pre(await edit(bb(), 'helper(e);', 'helper(e); // y', { session_id: 's2' }));
    expect(stale.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(stale.hookSpecificOutput.permissionDecisionReason).toContain('its card is stale');
  });

  it('shows a file its card the first time it is read, or says it has none', async () => {
    card('api/src/core/helper.ts', 'normalises events');
    const withCard = pre(await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'api/src/core/helper.ts') } }));
    expect(withCard.hookSpecificOutput.additionalContext).toContain('card  normalises events');
    const without = pre(await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bb() } }));
    expect(without.hookSpecificOutput.additionalContext).toContain('no card yet: read it in full');
  });

  it('requires the importers when an edit changes what the file exports', async () => {
    card('api/src/core/orch/bb.ts', 'applies events to the blackboard');
    const out = pre(await edit(bb(), 'export class Blackboard {', 'export class Board {'));
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain('api/src/core/caller.ts: imports api/src/core/orch/bb.ts, and this edit changes `export class Blackboard`');
    // An edit inside a method changes no export: the card is enough.
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x')).hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('counts a read as the call starts, so an edit right after it is not refused while the completion hook is still running', async () => {
    await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: bb() } });
    await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'r2', tool_input: { file_path: join(repo, 'api/src/core/helper.ts') } });
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x')).hookSpecificOutput.permissionDecision).toBeUndefined();
    // The completion does not record the read twice.
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: bb() } });
    const { ObservationStore } = await import('../observe/store.js');
    const reads = new ObservationStore(repo, 's1').readAll().filter((e) => e.t === 'touch' && (e.p as { path: string }).path === 'api/src/core/orch/bb.ts');
    expect(reads).toHaveLength(1);
  });

  it('owes a card after an edit, asks on the next call, and holds the turn until it matches the file', async () => {
    await read(bb());
    await read(join(repo, 'api/src/core/helper.ts'));
    await edit(bb(), 'helper(e);', 'helper(e); // x', { tool_use_id: 'e1' });
    writeFileSync(bb(), BB.replace('helper(e);', 'helper(e); // x'));
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e1', tool_input: { file_path: bb(), old_string: 'helper(e);', new_string: 'helper(e); // x' } });

    const next = pre(await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(next.hookSpecificOutput.additionalContext).toContain('no card matching its content');

    const stop = JSON.parse((await runClaudeHook({ ...base(), hook_event_name: 'Stop' })).stdout!) as { decision: string; reason: string };
    expect(stop.decision).toBe('block');
    expect(stop.reason).toContain('api/src/core/orch/bb.ts');
    expect(stop.reason).toContain('ctx card');

    card('api/src/core/orch/bb.ts', 'applies events to the blackboard; never touches the workspace directly');
    // The decision the rule asks for, then the turn can end.
    const { Recorder } = await import('../record/recorder.js');
    const { SessionState } = await import('../observe/store.js');
    new Recorder(Graph.load(join(repo, '.ctx')), new SessionState(repo, 's1'), repo).record({ node: 'api/src/core/orch/bb.ts', serves: 'orch.events', text: 'a comment only', who: 't', branch: 'main' });
    expect((await runClaudeHook({ ...base(), hook_event_name: 'Stop' })).stdout).toBeUndefined();
  });

  it('owes nothing for an edit another hook refused', async () => {
    writeFileSync(join(repo, '.ctx/config.toml'), '[enforce]\nread_before_edit = "off"\ndependencies = "off"\n');
    // ctx allows it and notes it, but the call never completes (another plugin denied it).
    const allowed = pre(await edit(bb(), 'helper(e);', 'helper(e); // x', { tool_use_id: 'denied-1' }));
    expect(allowed.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect((await runClaudeHook({ ...base(), hook_event_name: 'Stop' })).stdout).toBeUndefined();
  });

  it("keeps each agent's context its own: the main session's reads do not count for a subagent, which owes its own card", async () => {
    await read(bb());
    await read(join(repo, 'api/src/core/helper.ts'));
    const sub = { agent_id: 'agent-7', agent_type: 'web-engineer' };
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x', sub)).hookSpecificOutput.permissionDecision).toBe('deny');
    await read(bb(), sub);
    await read(join(repo, 'api/src/core/helper.ts'), sub);
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x', { ...sub, tool_use_id: 'e7' })).hookSpecificOutput.permissionDecision).toBeUndefined();
    writeFileSync(bb(), BB.replace('helper(e);', 'helper(e); // x'));
    await runClaudeHook({ ...base(sub), hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'e7', tool_input: { file_path: bb(), old_string: 'helper(e);', new_string: 'helper(e); // x' } });
    const subStop = JSON.parse((await runClaudeHook({ ...base(sub), hook_event_name: 'SubagentStop' })).stdout!) as { decision: string; reason: string };
    expect(subStop.decision).toBe('block');
    expect(subStop.reason).toContain('api/src/core/orch/bb.ts');
    // The main session edited nothing, so it owes nothing.
    expect((await runClaudeHook({ ...base(), hook_event_name: 'Stop' })).stdout).toBeUndefined();
  });

  it("maps an agent's worktree paths to the right module, and writes its card on its own branch", async () => {
    const wt = join(repo, '.claude/worktrees/agent-1');
    git('worktree', 'add', '-q', wt, '-b', 'web/st-1');
    const sub = { agent_id: 'agent-1', cwd: wt };
    const file = join(wt, 'api/src/core/orch/bb.ts');
    const readIt = pre(await runClaudeHook({ ...base(sub), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: file } }));
    expect(readIt.hookSpecificOutput.additionalContext).toContain('file api/src/core/orch/bb.ts');
    await read(file, sub);
    await read(join(wt, 'api/src/core/helper.ts'), sub);
    const out = pre(await edit(file, 'helper(e);', 'helper(e); // x', sub));
    expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain('[G orch.events]');

    const ctx = openRepo({ cwd: wt });
    expect(ctx.root).toBe(wt);
    writeCard(ctx.graph!, ctx.root, { path: 'api/src/core/orch/bb.ts', text: 'applies events', who: 't', date: '2026-09-30' });
    expect(readFileSync(join(wt, '.ctx/cards.ctx'), 'utf8')).toContain('F api/src/core/orch/bb.ts');
    expect(() => readFileSync(join(repo, '.ctx/cards.ctx'), 'utf8')).toThrow();
  });

  it('anchors a card in the spec through code-kit, when code-kit is present', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude/code-kit.json'), '{}');
    const cli = join(repo, 'fake-code-kit.mjs');
    writeFileSync(cli, `process.stdout.write(JSON.stringify({ path: process.argv[3], owner: 'web lane / web-engineer', lane: { name: 'web', agent: 'web-engineer' }, layer: { name: 'core', mayImport: ['schemas'], denyPackages: ['node:*'] }, requirements: [{ id: 'BOOK-4', title: 'Cancel a booking', spec: 'docs/specs/03-booking.md', stories: ['ST-4'] }] }));\n`);
    chmodSync(cli, 0o755);
    process.env.CODE_KIT_CLI = cli;
    const facts = factsFor(repo, 'api/src/core/orch/bb.ts');
    expect(facts.requirements).toEqual(['BOOK-4']);
    expect(facts.lines).toContain('spec  BOOK-4 Cancel a booking  (docs/specs/03-booking.md; ST-4)');
    expect(facts.lines).toContain('code-kit  lane web (web-engineer); layer core, may import schemas, never node:*');
    const first = pre(await runClaudeHook({ ...base({ session_id: 's9' }), hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: bb() } }));
    expect(first.hookSpecificOutput.additionalContext).toContain('spec  BOOK-4 Cancel a booking');
  });

  it('keeps cards as records: parsed, written back, and the latest in force', () => {
    card('api/src/core/helper.ts', 'first');
    card('api/src/core/helper.ts', 'second');
    const g = Graph.load(join(repo, '.ctx'));
    expect(g.cards.get('api/src/core/helper.ts')?.text).toBe('second');
    expect(g.cards.get('api/src/core/helper.ts')?.hash).toBe(contentHash(readFileSync(join(repo, 'api/src/core/helper.ts'), 'utf8')));
  });

  it('brings the rules and decisions of what a file imports into its slice', async () => {
    // caller.ts (L:core) imports bb.ts (L:orch): the orch rule and bb.ts's decision are not in caller's own chain.
    writeFileSync(join(repo, '.ctx/decisions.ctx'), 'D d-0001 2026-09-08 w/claude - main api/src/core/orch/bb.ts ->K orch.events applyEvent takes the event, never the workspace\n');
    card('api/src/core/caller.ts', 'wires the blackboard into the engine');
    const caller = join(repo, 'api/src/core/caller.ts');
    await read(caller);
    await read(bb());
    const out = pre(await edit(caller, 'new Blackboard();', 'new Blackboard(); // x'));
    const ctx = out.hookSpecificOutput.additionalContext!;
    expect(ctx).toContain('from what it imports');
    expect(ctx).toContain('via    L:orch: must state via events only  [G orch.events]');
    expect(ctx).toContain('via    api/src/core/orch/bb.ts: decided applyEvent takes the event, never the workspace  (d-0001)');
  });

  it("does not let a file's fresh card excuse an import that carries decisions or rules", async () => {
    writeFileSync(join(repo, '.ctx/decisions.ctx'), 'D d-0001 2026-09-08 w/claude - main api/src/core/orch/bb.ts ->K orch.events applyEvent takes the event, never the workspace\n');
    card('api/src/core/caller.ts', 'wires the blackboard into the engine');
    const caller = join(repo, 'api/src/core/caller.ts');
    const refused = pre(await edit(caller, 'new Blackboard();', 'new Blackboard(); // x'));
    expect(refused.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(refused.hookSpecificOutput.permissionDecisionReason).toContain('api/src/core/orch/bb.ts: imported by api/src/core/caller.ts, and it carries decisions or rules');
    await read(bb());
    expect(pre(await edit(caller, 'new Blackboard();', 'new Blackboard(); // x')).hookSpecificOutput.permissionDecision).toBeUndefined();
    // An import that carries nothing is still excused by the card.
    card('api/src/core/orch/bb.ts', 'applies events to the blackboard');
    expect(pre(await edit(bb(), 'helper(e);', 'helper(e); // x', { session_id: 's3' })).hookSpecificOutput.permissionDecision).toBeUndefined();
  });

  it('refuses in the Codex response shape too', async () => {
    const patch = '*** Begin Patch\n*** Update File: api/src/core/orch/bb.ts\n@@\n-    helper(e);\n+    helper(e); // x\n*** End Patch\n';
    const out = await runCodexHook({ session_id: 'c1', cwd: repo, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } });
    expect(pre(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
