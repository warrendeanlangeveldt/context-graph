import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from '../cards/cards.js';
import { openRepo } from '../core/context.js';
import { graphMap } from './map.js';

describe('ctx map: the modules as a tree, with rules, recent decisions and card coverage', () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const A = 'export const a = 1;\n';
  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-map-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, 'src/billing'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, 'src/a.ts'), A);
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 1;\n');
    writeFileSync(join(repo, 'src/billing/invoice.ts'), 'export const i = 1;\n');
    writeFileSync(
      join(repo, '.ctx/graph.ctx'),
      'M src/billing/** L:billing\nM src/** L:src\nL L:src Source\nL L:billing Billing\nE L:billing in L:src\nK G src.pure L:src no side effects\nK G? billing.cents L:billing money in cents\n',
    );
    writeFileSync(join(repo, '.ctx/cards.ctx'), `F src/a.ts ${contentHash(A)} 2026-10-10 w Holds a.\nF src/b.ts ${contentHash('old')} 2026-10-10 w Holds b.\n`);
    writeFileSync(
      join(repo, '.ctx/decisions.ctx'),
      'D d-0001 2026-10-08 w/c - main src/billing/invoice.ts ->K billing.cents in cents\nD d-0002 2026-10-09 w/c - main L:billing ->K billing.cents again\nD d-0003 2026-07-01 w/c - main src/a.ts ->K src.pure long ago\n',
    );
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('MAP-1 a module tree with rule counts, the last 30 days of decisions, and each file with its card', () => {
    const map = graphMap(openRepo({ repo }), Date.parse('2026-10-10T12:00:00Z'));
    expect(map.map((m) => `${m.depth}:${m.id}`)).toEqual(['0:L:src', '1:L:billing']);
    const [src, billing] = map;
    expect(src).toMatchObject({ name: 'Source', rules: { agreed: 1, proposed: 0 }, decisions: [] });
    expect(src!.files).toEqual([
      { path: 'src/a.ts', card: 'current' },
      { path: 'src/b.ts', card: 'stale' },
    ]);
    expect(billing).toMatchObject({ rules: { agreed: 0, proposed: 1 }, decisions: ['2026-10-08', '2026-10-09'], parents: ['L:src'] });
    expect(billing!.files).toEqual([{ path: 'src/billing/invoice.ts', card: 'missing' }]);
  });
});
