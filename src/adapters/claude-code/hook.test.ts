import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoverageRecord } from '../../observe/coverage.js';
import type { Envelope } from '../../observe/event.js';
import { ObservationStore } from '../../observe/store.js';
import { runClaudeHook, type HookInput } from './hook.js';

const GRAPH = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
L L:orch Orchestration
L L:core Engine
C C:pure Engine never depends on impls
E L:orch in L:core
E L:core impl C:pure
K G orch.events L:orch state via events only
K E boundary.core L:core never imports impls test:api/boundary.test.ts
A bb api/src/core/orch/bb.ts
`;

const BB = `import { helper } from '../helper.js';

export class Blackboard {
  applyEvent(e: string): void {
    helper(e);
  }
}
`;

describe('Claude Code hook adapter, end to end on a temporary repository', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CTX_GRAPH_DIR: process.env.CTX_GRAPH_DIR };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-repo-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    process.env.CLAUDE_PROJECT_DIR = repo;
    delete process.env.CTX_GRAPH_DIR;
    execFileSync('git', ['init', '-q', '-b', 'feature/test'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Tester'], { cwd: repo });
    mkdirSync(join(repo, 'api/src/core/orch'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, 'api/boundary.test.ts'), '');
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), BB);
    writeFileSync(join(repo, 'api/src/core/helper.ts'), 'export const helper = (e: string): void => {};\n');
    writeFileSync(join(repo, 'api/src/core/caller.ts'), "import { Blackboard } from './orch/bb.js';\nnew Blackboard();\n");
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const base = (): Pick<HookInput, 'session_id' | 'cwd'> => ({ session_id: 'sess-1', cwd: repo });
  const events = (): Envelope[] => new ObservationStore(repo, 'sess-1').readAll();

  it('injects a slice before an edit, observes the edit with coverage, then demands a decision at Stop', async () => {
    const start = await runClaudeHook({ ...base(), hook_event_name: 'SessionStart', start_reason: 'startup' });
    expect(start.stdout).toContain('Context Graph is active');
    expect(start.stdout).toContain('bb = api/src/core/orch/bb.ts');

    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'grep -rn applyEvent api/src' } });
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'api/src/core/orch/bb.ts'), offset: 3, limit: 4 } });

    const pre = await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'api/src/core/orch/bb.ts'), old_string: 'helper(e);', new_string: 'helper(e); this.count++;' } });
    expect(pre.stdout).toBeDefined();
    const out = JSON.parse(pre.stdout!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext.split('\n')[0]).toBe('edit bb#Blackboard');
    expect(out.hookSpecificOutput.additionalContext).toContain('[E boundary.core]');
    expect(out.hookSpecificOutput.additionalContext).toContain('[G orch.events]');

    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), BB.replace('helper(e);', 'helper(e); this.count++;'));
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'api/src/core/orch/bb.ts'), old_string: 'helper(e);', new_string: 'helper(e); this.count++;' } });

    const evs = events();
    expect(evs.map((e) => e.t)).toEqual(['session', 'touch', 'touch', 'slice', 'edit', 'coverage', 'finding']);
    const cov = evs.find((e) => e.t === 'coverage')!.p as CoverageRecord;
    expect(cov.path).toBe('api/src/core/orch/bb.ts');
    expect(cov.slice_injected).toBe(true);
    expect(cov.loaded['api/src/core/orch/bb.ts']).toBe('edit');
    expect(cov.loaded['api/src']).toBe('grep');
    expect(cov.callers).toEqual(['api/src/core/caller.ts']);
    expect(cov.callers_loaded).toBe(0);
    expect(cov.applicable).toContain('orch.events');
    expect((evs.find((e) => e.t === 'finding')!.p as { rule: string }).rule).toBe('callers-dark');

    const stop1 = await runClaudeHook({ ...base(), hook_event_name: 'Stop' });
    const blocked = JSON.parse(stop1.stdout!) as { decision: string; reason: string };
    expect(blocked.decision).toBe('block');
    expect(blocked.reason).toContain('api/src/core/orch/bb.ts');
    expect(blocked.reason).toContain('orch.events');
  });

  it('records shell-driven edits and stays quiet in observe-only mode', async () => {
    writeFileSync(join(repo, '.ctx/config.toml'), '[slice]\nenabled = false\n');
    const start = await runClaudeHook({ ...base(), hook_event_name: 'SessionStart', start_reason: 'startup' });
    expect(start.stdout).toContain('observe-only');
    const pre = await runClaudeHook({ ...base(), hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'api/src/core/orch/bb.ts'), old_string: 'x', new_string: 'y' } });
    expect(pre.stdout).toBeUndefined();
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: "sed -i '' 's/helper/helper2/' api/src/core/orch/bb.ts" } });
    const evs = events();
    expect(evs.filter((e) => e.t === 'edit')).toHaveLength(1);
    expect(evs.some((e) => e.t === 'coverage')).toBe(true);
    const stop = await runClaudeHook({ ...base(), hook_event_name: 'Stop' });
    expect(stop.stdout).toBeUndefined();
  });

  it('attributes subagent touches and emits compaction', async () => {
    await runClaudeHook({ ...base(), hook_event_name: 'SessionStart', start_reason: 'startup' });
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'api/src/core/helper.ts') } });
    await runClaudeHook({ ...base(), hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'api/src/core/caller.ts') }, agent_id: 'agent-9', agent_type: 'Explore' });
    await runClaudeHook({ ...base(), hook_event_name: 'SessionStart', start_reason: 'compact' });
    const evs = events();
    const sub = evs.find((e) => e.t === 'touch' && (e.p as { origin: string }).origin === 'subagent');
    expect(sub).toBeDefined();
    const compact = evs.find((e) => e.t === 'compact')!.p as { paths: string[] };
    expect(compact.paths).toEqual(['api/src/core/helper.ts']);
    expect(evs.filter((e) => e.t === 'session').map((e) => (e.p as { kind: string }).kind)).toEqual(['start']);
  });
});
