import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { linkProvenance } from './provenance.js';

describe('linkProvenance', () => {
  it('links provisional decisions on this branch whose nodes the commit touched', () => {
    const repo = mkdtempSync(join(tmpdir(), 'ctx-prov-'));
    const g = (a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
    g(['init', '-q', '-b', 'feature/x']);
    g(['config', 'user.email', 't@example.com']);
    g(['config', 'user.name', 'T']);
    mkdirSync(join(repo, 'api/src/core/orch'), { recursive: true });
    mkdirSync(join(repo, 'api/src/other'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), 'M api/src/core/orch/** L:orch\nM api/src/core/** L:core\nM api/src/other/** L:other\nL L:orch O\nL L:core C\nL L:other X\nE L:orch in L:core\nK G k.one L:core text\n');
    writeFileSync(join(repo, '.ctx/decisions.ctx'), [
      'D d-0001 2026-09-07 w/c - feature/x api/src/core/orch/bb.ts ->K k.one on the file',
      'D d-0002 2026-09-07 w/c - feature/x L:core ->K k.one on the module',
      'D d-0003 2026-09-07 w/c - feature/x api/src/other/z.ts ->K k.one elsewhere',
      'D d-0004 2026-09-07 w/c - main api/src/core/orch/bb.ts ->K k.one other branch',
      'D d-0005 2026-09-07 w/c abcd1234 feature/x api/src/core/orch/bb.ts ->K k.one already linked',
    ].join('\n') + '\n');
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), 'x');
    writeFileSync(join(repo, 'api/src/other/z.ts'), 'y');
    g(['add', '.']);
    g(['commit', '-q', '-m', 'initial']);
    writeFileSync(join(repo, 'api/src/core/orch/bb.ts'), 'changed');
    g(['add', 'api/src/core/orch/bb.ts']);
    g(['commit', '-q', '-m', 'touch bb']);
    const sha = g(['rev-parse', '--short', 'HEAD']);

    const graph = Graph.load(join(repo, '.ctx'));
    const r = linkProvenance(graph, repo);
    expect(r.sha).toBe(sha.slice(0, 8));
    expect(r.linked).toEqual(['d-0001', 'd-0002']);
    expect(r.skipped).toEqual(['d-0003', 'd-0004']);
    const after = readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8');
    expect(after).toContain(`D d-0001 2026-09-07 w/c ${r.sha} feature/x`);
    expect(after).toContain(`D d-0002 2026-09-07 w/c ${r.sha} feature/x L:core`);
    expect(after).toContain('D d-0003 2026-09-07 w/c - feature/x');
    expect(after).toContain('D d-0005 2026-09-07 w/c abcd1234');
  });
});
