import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Graph } from '../graph/graph.js';
import { commitOf, linkProvenance } from './provenance.js';

describe('provenance', () => {
  it('resolves each decision to the commit that added its line, and never rewrites the file', () => {
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
    const sha = g(['rev-parse', 'HEAD']).slice(0, 8);
    // Recorded after the commit: not committed yet.
    writeFileSync(join(repo, '.ctx/decisions.ctx'), readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8') + 'D d-9f3a21 2026-09-08 w/c - feature/x api/src/core/orch/bb.ts ->K k.one after the commit\n');
    const before = readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8');

    const graph = Graph.load(join(repo, '.ctx'));
    const r = linkProvenance(graph, repo);
    expect(r.linked).toEqual(['d-0001', 'd-0002', 'd-0003']);
    expect(r.skipped).toEqual(['d-9f3a21']);
    expect(commitOf(graph, repo, graph.decisions.get('d-0001')!)).toBe(sha);
    expect(commitOf(graph, repo, graph.decisions.get('d-9f3a21')!)).toBe('-');
    expect(commitOf(graph, repo, graph.decisions.get('d-0005')!)).toBe('abcd1234');
    // Nothing is written: a commit leaves the working tree clean.
    expect(readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8')).toBe(before);
  });
});
