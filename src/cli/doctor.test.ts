import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { ObservationStore } from '../observe/store.js';
import { envelope } from '../observe/event.js';
import { runDoctor } from './doctor.js';

describe('ctx doctor', () => {
  it('names the missing link: stale processes, a stale plugin, shell-only use, and a missing instruction block', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-doc-'));
    const home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    const claudeDir = mkdtempSync(join(tmpdir(), 'ctx-claude-'));
    process.env.CTX_HOME = home;
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), 'M src/** L:src\nL L:src Source\nK G? src.guess L:src a guess\n');
    writeFileSync(join(repo, '.ctx/config.toml'), '[repo]\nratifiers = []\n');
    writeFileSync(join(repo, 'AGENTS.md'), '# Rules\n');
    mkdirSync(join(claudeDir, 'plugins', 'cache', 'v', 'hooks'), { recursive: true });
    writeFileSync(join(claudeDir, 'plugins', 'cache', 'v', 'hooks', 'hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit|Bash' }], PostToolUse: [{ matcher: '' }] } }));
    const installedAt = '2026-09-07T09:16:00.000Z';
    writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'context-graph@context-graph': [{ version: '0.0.1', installPath: join(claudeDir, 'plugins', 'cache', 'v'), installedAt, lastUpdated: installedAt }] } }));
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'context-graph@context-graph': true } }));
    const now = Date.parse('2026-09-08T00:00:00.000Z');
    const store = new ObservationStore(repo, 'cli');
    store.append(envelope('decision', { session: 'cli', who: 'w', branch: 'main', harness: 'cli' }, { id: 'd-0001' }));
    new ObservationStore(repo, 'old-replay').append(envelope('touch', { session: 'old-replay', who: 'w', branch: 'main', harness: 'claude-code-replay' }, { path: 'src/a.ts', mode: 'full', tool: 'Read', origin: 'main' }));

    const ctx = openRepo({ repo });
    const lines = runDoctor(ctx, { now, claudeDir, processes: [
      { pid: 11, started: Date.parse('2026-09-02T00:00:00Z'), command: 'claude' },
      { pid: 12, started: Date.parse('2026-09-07T20:00:00Z'), command: 'claude' },
    ] });
    const text = lines.map((l) => `${l.level} ${l.text}`).join('\n');
    expect(text).toContain('ok graph at');
    expect(text).not.toContain('linked from outside');
    expect(text).toContain('warn ratifiers is empty');
    expect(text).toContain('warn every rule is still proposed');
    expect(text).toContain('warn AGENTS.md lacks the Context Graph block');
    expect(text).toMatch(/warn Claude Code plugin 0\.0\.1 installed but the source is \d+\.\d+\.\d+/);
    expect(text).toContain('info installed pre-hook covers edits only');
    expect(text).toContain('fail 1 of 2 running Claude Code sessions started before the plugin');
    expect(text).toContain('(pids 11)');
    expect(text).toContain('fail no hook has fired here in the last 24 hours, though ctx was used');
    expect(text).toContain('info ctx used from the shell or MCP without hooks: cli (1 events)');
    expect(text).toContain('info 1 session reconstructed with ctx replay, not observed live');
  });
});

describe('adopting a linked graph', () => {
  it('doctor warns while the graph is linked from outside the repository', async () => {
    const { mkdtempSync, mkdirSync: mk, writeFileSync: wf, symlinkSync } = await import('node:fs');
    const { tmpdir: td } = await import('node:os');
    const { join: j } = await import('node:path');
    const { repoHash } = await import('../util/paths.js');
    const repo = mkdtempSync(j(td(), 'ctx-adopt-repo-'));
    const elsewhere = mkdtempSync(j(td(), 'ctx-adopt-graph-'));
    const home = mkdtempSync(j(td(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    wf(j(elsewhere, 'graph.ctx'), 'M ** L:root\nL L:root Root\n');
    mk(j(home, 'graphs'), { recursive: true });
    symlinkSync(elsewhere, j(home, 'graphs', repoHash(repo)));
    const { openRepo } = await import('../core/context.js');
    const { runDoctor } = await import('./doctor.js');
    const lines = runDoctor(openRepo({ repo }), { claudeDir: mkdtempSync(j(td(), 'ctx-claude-')), processes: [] });
    expect(lines.some((l) => l.level === 'warn' && l.text.includes('linked from outside this repository'))).toBe(true);
  });
});
