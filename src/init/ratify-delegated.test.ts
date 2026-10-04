import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { ratify } from './ratify.js';

const GRAPH = 'M src/** L:src\nM ** L:repo\nL L:repo Repo\nL L:src Source\nE L:src in L:repo\nK G? src.pure L:src no side effects at import\nK G? src.tested L:src proven by a test test:src/a.test.ts\nC C:events Change goes through events proposed\n';

describe('delegated ratification (AUT-3)', () => {
  let repo: string;
  const prev = process.env.CTX_HOME;
  const config = (delegate: string) => writeFileSync(join(repo, '.ctx/config.toml'), `[repo]\nratifiers = ["warren"]\n${delegate}`);
  const graph = () => readFileSync(join(repo, '.ctx/graph.ctx'), 'utf8');
  const decisions = () => { try { return readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8'); } catch { return ''; } };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-delegate-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
  });
  afterEach(() => { if (prev === undefined) delete process.env.CTX_HOME; else process.env.CTX_HOME = prev; });

  it('ratifies what the rules allow, records a decision naming the ratifier, the rule and the reason, and gives the delegated trailer', () => {
    config('\n[delegate]\nratifier = "sidequest-lead"\nmay_ratify = ["guidance", "concepts"]\n');
    const r = ratify(openRepo({ repo }), ['src.pure', 'C:events'], { today: '2026-10-04', delegated: { reason: 'every module in this idea is pure at import' } });
    expect(r.ratified.sort()).toEqual(['C:events', 'src.pure']);
    expect(r.trailer).toBe('Ctx-Ratified-By: sidequest-lead (delegated)');
    expect(graph()).toContain('K G src.pure');
    const d = decisions();
    expect(d).toContain('sidequest-lead/delegated');
    expect(d).toContain('ratified src.pure (delegated: guidance): every module in this idea is pure at import');
    expect(d).toContain('ratified C:events (delegated: concepts)');
  });

  it('is all or nothing: one record outside the rules ratifies nothing', () => {
    config('\n[delegate]\nratifier = "sidequest-lead"\nmay_ratify = ["guidance"]\n');
    expect(() => ratify(openRepo({ repo }), ['src.pure', 'src.tested'], { delegated: { reason: 'x' } })).toThrow(/a person ratifies these: src.tested \(enforced\)/);
    expect(graph()).toBe(GRAPH);
    expect(decisions()).toBe('');
  });

  it('refuses when nothing is delegated, or without a reason', () => {
    config('');
    expect(() => ratify(openRepo({ repo }), ['src.pure'], { delegated: { reason: 'x' } })).toThrow(/delegates no ratification/);
    config('\n[delegate]\nratifier = "sidequest-lead"\n');
    expect(() => ratify(openRepo({ repo }), ['src.pure'], { delegated: { reason: ' ' } })).toThrow(/needs --reason/);
    expect(graph()).toBe(GRAPH);
  });

  it('defaults to guidance only, and a person still ratifies as before', () => {
    config('\n[delegate]\nratifier = "sidequest-lead"\n');
    expect(openRepo({ repo }).config.delegate).toEqual({ ratifier: 'sidequest-lead', mayRatify: ['guidance'] });
    const r = ratify(openRepo({ repo }), ['src.tested'], { today: '2026-10-04' });
    expect(r.ratified).toEqual(['src.tested']);
    expect(r.trailer).not.toContain('delegated');
  });
});
