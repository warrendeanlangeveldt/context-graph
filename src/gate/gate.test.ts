import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { formatGate, runGate } from './gate.js';

const BASE_GRAPH = `
M api/src/core/orch/** L:orch
M api/src/core/**      L:core
L L:orch Orchestration
L L:core Engine
C C:pure Engine never depends on impls
E L:orch in L:core
E L:core impl C:pure
K G orch.envelope L:orch confidence stays in the envelope
K G orch.events   L:orch state via events only
K G core.reuse    L:core reuse before adding
`;

describe('merge gate', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const g = (a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (msg: string): void => { g(['add', '-A']); g(['commit', '-q', '-m', msg]); };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-gate-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 'T']);
    mkdirSync(join(repo, 'api/src/core/orch'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), BASE_GRAPH);
    writeFileSync(join(repo, '.ctx/decisions.ctx'), 'D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first\n');
    writeFileSync(join(repo, '.ctx/config.toml'), '[repo]\nratifiers = ["warren"]\n');
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), 'a');
    writeFileSync(join(repo, 'api/src/core/x.ts'), 'x');
    commit('base');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('finds opposed arrows, double supersession, stale basis, context moved, unratified concepts, and unlinked provenance', () => {
    // Branch work.
    g(['checkout', '-q', '-b', 'feature/x']);
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), 'a2');
    writeFileSync(join(repo, '.ctx/decisions.ctx'), [
      'D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first',
      'D d-0002 2026-08-10 w/c - feature/x api/src/core/orch/bb.ts ->K orch.events !K orch.envelope verdicts move to envelope',
      'D d-0003 2026-08-11 w/c - feature/x api/src/core/x.ts ->K core.reuse reused the resolver',
      'S d-0002 d-0001',
    ].join('\n') + '\n');
    writeFileSync(join(repo, '.ctx/graph.ctx'), BASE_GRAPH + 'C C:new-idea A new concept nobody ratified\n');
    commit('branch work');

    // Main moves on.
    g(['checkout', '-q', 'main']);
    writeFileSync(join(repo, '.ctx/decisions.ctx'), [
      'D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first',
      'D d-0004 2026-08-12 m/x bbbb main api/src/core/orch/bb.ts ->K orch.envelope reaffirmed: verdicts stay in payload',
      'D d-0005 2026-08-13 m/x cccc main api/src/core/orch/bb.ts ->K orch.events replaced first',
      'S d-0005 d-0001',
    ].join('\n') + '\n');
    writeFileSync(join(repo, '.ctx/graph.ctx'), BASE_GRAPH.replace('reuse before adding', 'reuse before adding, and say which layer') + 'K G core.money L:core integer minor units only\n');
    commit('main moves');
    g(['checkout', '-q', 'feature/x']);

    const ctx = openRepo({ repo });
    const report = runGate(ctx, { base: 'main' });
    const rules = report.findings.map((f) => `${f.level}:${f.rule}`);
    expect(rules).toContain('fail:opposed-arrows');
    expect(rules).toContain('fail:double-supersession');
    expect(rules).toContain('warn:stale-basis');
    expect(rules).toContain('warn:context-moved');
    expect(rules).toContain('fail:unratified');
    expect(rules).toContain('warn:unlinked-provenance');
    expect(report.ok).toBe(false);

    const opposed = report.findings.find((f) => f.rule === 'opposed-arrows')!;
    expect(opposed.title).toContain('orch.envelope');
    expect(opposed.lines[0]).toContain('d-0004');
    expect(opposed.lines[1]).toContain('d-0002');
    const moved = report.findings.find((f) => f.rule === 'context-moved')!;
    expect(moved.title).toBe('api/src/core/orch/bb.ts');
    expect(moved.lines[0]).toContain('core.money');
    const stale = report.findings.find((f) => f.rule === 'stale-basis')!;
    expect(stale.title).toBe('d-0003 -> core.reuse');
    const text = formatGate(report);
    expect(text).toContain('FAIL opposed-arrows');
    expect(text).toContain('suggest: one of these supersedes the other');
  });

  it('passes a clean branch with a ratified concept', () => {
    g(['checkout', '-q', '-b', 'feature/clean']);
    writeFileSync(join(repo, '.ctx/graph.ctx'), BASE_GRAPH + 'C C:ratified A ratified concept\n');
    writeFileSync(join(repo, '.ctx/decisions.ctx'), 'D d-0001 2026-08-01 w/c aaaa main api/src/core/orch/bb.ts ->K orch.events first\nD d-0002 2026-08-10 w/c dddd feature/clean api/src/core/orch/bb.ts ->K orch.events second\n');
    g(['add', '-A']);
    g(['commit', '-q', '-m', 'ratified work\n\nCtx-Ratified-By: warren']);
    const report = runGate(openRepo({ repo }), { base: 'main' });
    expect(report.findings.filter((f) => f.level === 'fail')).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
