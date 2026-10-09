import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contentHash } from '../cards/cards.js';
import { openRepo } from '../core/context.js';
import { neighbours } from './neighbours.js';

describe("ctx neighbours: a file's imports and importers, with their cards and broken rules", () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const A = "import { b } from './b';\nimport { c } from '../lib/c';\nexport const a = b + c;\n";
  const B = 'export const b = 1;\n';

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-neighbours-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'lib'));
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, 'src/a.ts'), A);
    writeFileSync(join(repo, 'src/b.ts'), B);
    writeFileSync(join(repo, 'lib/c.ts'), 'export const c = 2;\n');
    writeFileSync(join(repo, 'src/d.ts'), "import { a } from './a';\nexport const d = a;\n");
    // a's card is current, b's was written for an older b, c and d have none; a breaks src.no-lib.
    writeFileSync(
      join(repo, '.ctx/graph.ctx'),
      `M src/** L:src\nM lib/** L:lib\nL L:src Source\nL L:lib Library\nK G src.no-lib L:src source never imports the library rule:noimport:L:src:L:lib\n`,
    );
    writeFileSync(
      join(repo, '.ctx/cards.ctx'),
      `F src/a.ts ${contentHash(A)} 2026-10-10 warren Holds a.\nF src/b.ts ${contentHash('export const b = 0;\n')} 2026-10-10 warren Holds b.\n`,
    );
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('VIEW-2 marks each neighbour current, stale or missing, and the rules a file breaks', () => {
    const n = neighbours(openRepo({ repo }), 'src/a.ts');
    expect(n.card).toBe('current');
    expect(n.breaks).toEqual(['src.no-lib']);
    expect(n.imports.map((x) => `${x.path}:${x.card}`)).toEqual(['lib/c.ts:missing', 'src/b.ts:stale']);
    expect(n.importers.map((x) => `${x.path}:${x.card}`)).toEqual(['src/d.ts:missing']);
  });

  it('a file with no imports or importers has none', () => {
    const n = neighbours(openRepo({ repo }), 'lib/c.ts');
    expect(n.imports).toEqual([]);
    expect(n.importers.map((x) => x.path)).toEqual(['src/a.ts']);
  });
});
