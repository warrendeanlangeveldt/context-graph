import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoverageRecord } from './coverage.js';
import type { Envelope, Touch } from './event.js';
import { replayTranscript } from './replay.js';
import { ObservationStore } from './store.js';

const GRAPH = 'M api/src/** L:api\nL L:api API\nK G api.rule L:api a rule\n';

describe('replayTranscript', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-replay-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    execFileSync('git', ['init', '-q'], { cwd: repo });
    mkdirSync(join(repo, 'api/src'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, 'api/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'api/src/b.ts'), "import { a } from './a.js';\n");
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('reconstructs a Claude Code transcript: reads, sidechain, compaction, edits with coverage', async () => {
    const t = (o: object): string => JSON.stringify(o);
    const lines = [
      t({ type: 'user', sessionId: 'S1', cwd: repo, gitBranch: 'feature/r', timestamp: '2026-09-01T10:00:00.000Z', uuid: 'u1', isSidechain: false, message: { role: 'user', content: 'hi' } }),
      t({ type: 'assistant', sessionId: 'S1', cwd: repo, gitBranch: 'feature/r', timestamp: '2026-09-01T10:00:01.000Z', uuid: 'u2', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: join(repo, 'api/src/a.ts') } }] } }),
      t({ type: 'assistant', sessionId: 'S1', cwd: repo, timestamp: '2026-09-01T10:00:02.000Z', uuid: 'u3', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Grep', input: { pattern: 'a', path: join(repo, 'api') } }] } }),
      t({ type: 'system', subtype: 'compact_boundary', sessionId: 'S1', timestamp: '2026-09-01T10:00:03.000Z', uuid: 'u4', content: 'Conversation compacted' }),
      t({ type: 'assistant', sessionId: 'S1', cwd: repo, timestamp: '2026-09-01T10:00:04.000Z', uuid: 'u5', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: join(repo, 'api/src/a.ts'), old_string: '1', new_string: '2' } }] } }),
      t({ type: 'assistant', sessionId: 'S1', cwd: repo, timestamp: '2026-09-01T10:00:05.000Z', uuid: 'u6', isSidechain: false, message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'cat api/src/b.ts && echo x > api/src/c.ts' } }] } }),
    ];
    const file = join(repo, 'S1.jsonl');
    writeFileSync(file, lines.join('\n') + '\n');
    const r = await replayTranscript(file, { repo });
    expect(r.harness).toBe('claude-code');
    expect(r.session).toBe('S1');
    expect(r.edits).toBe(2);
    expect(r.coverage).toBe(2);
    const evs: Envelope[] = new ObservationStore(repo, 'S1').readAll();
    expect(evs.map((e) => e.t)).toEqual(['session', 'touch', 'touch', 'compact', 'edit', 'coverage', 'touch', 'edit', 'coverage']);
    expect(evs[0]!.ts).toBe('2026-09-01T10:00:00.000Z');
    expect(evs[0]!.branch).toBe('feature/r');
    expect((evs[2]!.p as Touch)).toMatchObject({ origin: 'subagent', mode: 'grep', path: 'api' });
    expect((evs[3]!.p as { paths: string[] }).paths).toEqual(['api/src/a.ts']);
    const cov = evs[5]!.p as CoverageRecord;
    expect(cov.path).toBe('api/src/a.ts');
    expect(cov.summarized_since).toBe(true);
    expect(cov.callers).toEqual(['api/src/b.ts']);
    expect(cov.slice_injected).toBe(false);
  });

  it('reconstructs a Codex rollout and a codex exec stream', async () => {
    const t = (o: object): string => JSON.stringify(o);
    const rollout = [
      t({ timestamp: '2026-09-02T09:00:00.000Z', type: 'session_meta', payload: { id: 'thread-9', cwd: repo, cli_version: '0.153.4', git: { branch: 'feature/c' } } }),
      t({ timestamp: '2026-09-02T09:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'rg -n "a" api/src' }) } }),
      t({ timestamp: '2026-09-02T09:00:02.000Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: api/src/a.ts\n@@\n-x\n+y\n*** End Patch' } }),
      t({ timestamp: '2026-09-02T09:00:03.000Z', type: 'compacted', payload: {} }),
      t({ timestamp: '2026-09-02T09:00:04.000Z', type: 'response_item', payload: { type: 'local_shell_call', action: { command: ['cat', 'api/src/b.ts'] } } }),
    ];
    const f1 = join(repo, 'rollout-thread-9.jsonl');
    writeFileSync(f1, rollout.join('\n') + '\n');
    const r1 = await replayTranscript(f1, { repo });
    expect(r1).toMatchObject({ harness: 'codex', session: 'thread-9', cliVersion: '0.153.4', edits: 1, coverage: 1, warnings: [] });
    const evs = new ObservationStore(repo, 'thread-9').readAll();
    expect(evs.map((e) => e.t)).toEqual(['session', 'touch', 'edit', 'coverage', 'compact', 'touch']);
    expect(evs[0]!.branch).toBe('feature/c');
    expect((evs[1]!.p as Touch)).toMatchObject({ mode: 'grep', path: 'api/src' });

    const exec = [
      t({ type: 'thread.started', thread_id: 'exec-1' }),
      t({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'sed -n 1,3p api/src/a.ts', exit_code: 0, status: 'completed' } }),
      t({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: 'api/src/b.ts', kind: 'update' }, { path: 'api/src/n.ts', kind: 'add' }], status: 'completed' } }),
    ];
    const f2 = join(repo, 'exec.jsonl');
    writeFileSync(f2, exec.join('\n') + '\n');
    const r2 = await replayTranscript(f2, { repo, harness: 'codex' });
    expect(r2.session).toBe('exec-1');
    expect(r2.edits).toBe(2);
    expect(r2.warnings[0]).toMatch(/no timestamps/);
    const evs2 = new ObservationStore(repo, 'exec-1').readAll();
    expect(evs2.filter((e) => e.t === 'edit').map((e) => (e.p as Touch).mode)).toEqual(['edit', 'write']);
  });
});
