import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { contentHash } from './cards.js';
import { backfillOrder } from './backfill.js';

describe("backfill: a brownfield project's cards, leaves first", () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (path: string, text: string): void => writeFileSync(join(repo, path), text);

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-backfill-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'old'));
    mkdirSync(join(repo, '.ctx'));
    put('.ctx/graph.ctx', 'M src/** L:src\nM old/** L:old\nL L:src Source\nL L:old Old\n');
    // top imports mid, mid imports leaf; done already has its card.
    put('src/top.ts', "import { m } from './mid';\nexport const t = m;\n");
    put('src/mid.ts', "import { l } from './leaf';\nexport const m = l;\n");
    put('src/leaf.ts', 'export const l = 1;\n');
    put('src/done.ts', 'export const d = 1;\n');
    put('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    put('src/b.ts', "import { a } from './a';\nexport const b = a;\n");
    put('old/x.ts', 'export const x = 1;\n');
    put('.ctx/cards.ctx', `F src/done.ts ${contentHash('export const d = 1;\n')} 2026-10-10 t Done.\n`);
    // old/ was last touched long ago; src/ just now.
    const long = { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00', GIT_COMMITTER_DATE: '2025-01-01T00:00:00' };
    git('add', 'old', '.ctx/graph.ctx');
    execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd: repo, env: long });
    git('add', '-A');
    git('commit', '-q', '-m', 'src');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('lists the uncarded files of modules changed lately, each after what it imports, a cycle last', () => {
    const b = backfillOrder(openRepo({ repo }), 'active');
    expect(b.files).toEqual(['src/leaf.ts', 'src/mid.ts', 'src/top.ts', 'src/a.ts', 'src/b.ts']);
    expect(b.inScope).toBe(6);
  });

  it('all takes every module', () => {
    const b = backfillOrder(openRepo({ repo }), 'all');
    expect(b.files).toContain('old/x.ts');
    expect(b.files.indexOf('src/leaf.ts')).toBeLessThan(b.files.indexOf('src/mid.ts'));
    expect(b.inScope).toBe(7);
  });
});
