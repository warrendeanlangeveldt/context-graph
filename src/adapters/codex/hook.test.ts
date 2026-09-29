import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoverageRecord } from '../../observe/coverage.js';
import type { Envelope, Touch } from '../../observe/event.js';
import { ObservationStore } from '../../observe/store.js';
import { runCodexHook } from './hook.js';

const GRAPH = `
M api/src/core/** L:core
L L:core Engine
K G core.events L:core state via events only
`;

describe('Codex hook adapter', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-codex-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'tester@example.com'], { cwd: repo });
    mkdirSync(join(repo, 'api/src/core'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    // These cases are about slices, histories, cards and decisions; the read-before-edit loop has its own suite.
    writeFileSync(join(repo, '.ctx/config.toml'), '[enforce]\nread_before_edit = "off"\ndependencies = "off"\ncards = "off"\n');
    writeFileSync(join(repo, 'api/src/core/a.ts'), 'export const a = 1;\n');
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  const base = { session_id: 'codex-1', cwd: '' };
  const events = (): Envelope[] => new ObservationStore(repo, 'codex-1').readAll();

  it('slices before apply_patch, observes patch files and shell reads, and blocks Stop', async () => {
    base.cwd = repo;
    const start = await runCodexHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    const startOut = JSON.parse(start.stdout!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(startOut.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(startOut.hookSpecificOutput.additionalContext).toMatch(/Context Graph \S+ is active/);

    await runCodexHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat api/src/core/a.ts' } });

    const patch = '*** Begin Patch\n*** Update File: api/src/core/a.ts\n@@\n-export const a = 1;\n+export const a = 2;\n*** Add File: api/src/core/b.ts\n+export const b = 1;\n*** End Patch';
    const pre = await runCodexHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } });
    const out = JSON.parse(pre.stdout!) as { hookSpecificOutput: { additionalContext: string } };
    const ctxText = out.hookSpecificOutput.additionalContext;
    expect(ctxText).toContain('edit api/src/core/a.ts');
    expect(ctxText).toContain('edit api/src/core/b.ts');
    expect(ctxText).toContain('[G core.events]');

    await runCodexHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: patch } });
    const evs = events();
    const edits = evs.filter((e) => e.t === 'edit').map((e) => `${(e.p as Touch).mode} ${(e.p as Touch).path}`);
    expect(edits).toEqual(['edit api/src/core/a.ts', 'write api/src/core/b.ts']);
    expect(evs.filter((e) => e.t === 'coverage').map((e) => (e.p as CoverageRecord).path)).toEqual(['api/src/core/a.ts', 'api/src/core/b.ts']);
    expect((evs.find((e) => e.t === 'touch')!.p as Touch)).toMatchObject({ mode: 'full', path: 'api/src/core/a.ts', tool: 'Bash' });

    const stop = await runCodexHook({ ...base, hook_event_name: 'Stop', stop_hook_active: false });
    expect(JSON.parse(stop.stdout!)).toMatchObject({ decision: 'block' });
    const again = await runCodexHook({ ...base, hook_event_name: 'Stop', stop_hook_active: true });
    expect(again.stdout).toBeUndefined();
    expect(evs.length).toBeGreaterThan(0);
  });

  it('hands over a module card before the first shell read under a module', async () => {
    base.cwd = repo;
    await runCodexHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    const pre = await runCodexHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'cat api/src/core/a.ts' } });
    const out = JSON.parse(pre.stdout!) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(out.hookSpecificOutput.additionalContext.split('\n')[0]).toMatch(/^module L:core/);
    expect(out.hookSpecificOutput.additionalContext).toContain('[G core.events]');
    const again = await runCodexHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'sed -n 1,5p api/src/core/a.ts' } });
    expect(again.stdout).toBeUndefined();
  });

  it('emits compaction on PreCompact and a finding on Interrupt', async () => {
    base.cwd = repo;
    await runCodexHook({ ...base, hook_event_name: 'SessionStart', source: 'startup' });
    await runCodexHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'sed -n 1,5p api/src/core/a.ts' } });
    await runCodexHook({ ...base, hook_event_name: 'PreCompact', trigger: 'auto' });
    await runCodexHook({ ...base, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: api/src/core/a.ts\n*** End Patch' } });
    await runCodexHook({ ...base, hook_event_name: 'Interrupt' });
    const evs = events();
    expect((evs.find((e) => e.t === 'compact')!.p as { paths: string[] }).paths).toEqual(['api/src/core/a.ts']);
    expect(evs.some((e) => e.t === 'finding' && (e.p as { rule: string }).rule === 'interrupted')).toBe(true);
  });
});
