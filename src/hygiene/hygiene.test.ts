import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { gc, hygieneReport, retire, timeline } from './hygiene.js';

const GRAPH = `
M src/core/** L:core
M src/old/**  L:old
M **          L:repo
L L:core Core
L L:old Old
L L:repo Repo
E L:core in L:repo
E L:old in L:repo
C C:adr-0002 Old layering adr:0002
C C:adr-0003 New layering adr:0003
K G core.rule L:core a rule everyone breaks
K G core.fine L:core a rule people follow
K G? core.stale L:core an old proposal since:2026-01-01
K G old.rule L:old a rule on a retired module
Z old.rule 2026-02-01 w/human module dissolved
`;

const DECISIONS = `
D d-0001 2026-03-01 w/c aaaa main src/core/a.ts ->K core.fine !K core.rule broke it once
D d-0002 2026-03-02 w/c bbbb main src/core/a.ts ->K core.fine !K core.rule broke it twice
D d-0003 2026-03-03 w/c cccc main src/core/a.ts ->K core.fine !K core.rule broke it thrice
D d-0004 2026-01-10 w/c dddd main src/core/b.ts ->K core.fine first version
D d-0005 2026-01-20 w/c eeee main src/core/b.ts ->K core.fine second version
D d-0006 2026-09-01 w/c ffff main src/core/b.ts ->K core.fine third version
D d-0007 2026-08-01 w/c gggg main src/core/gone.ts ->K core.fine on a deleted file
S d-0005 d-0004
S d-0006 d-0005
`;

describe('hygiene', () => {
  let repo: string;
  let home: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'ctx-hyg-'));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    delete process.env.CLAUDE_PROJECT_DIR;
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'w@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'W'], { cwd: repo });
    mkdirSync(join(repo, 'src/core'), { recursive: true });
    mkdirSync(join(repo, 'docs/adr'), { recursive: true });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, '.ctx/decisions.ctx'), DECISIONS);
    writeFileSync(join(repo, 'src/core/a.ts'), 'a');
    writeFileSync(join(repo, 'src/core/b.ts'), 'b');
    writeFileSync(join(repo, 'docs/adr/0002-old-layering.md'), '# ADR-0002\n\nStatus: Superseded by ADR-0003\n');
    writeFileSync(join(repo, 'docs/adr/0003-new-layering.md'), '# ADR-0003\n\nStatus: Accepted\n');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repo });
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it('reports signals with evidence and proposals', () => {
    const findings = hygieneReport(openRepo({ repo }));
    const by = (s: string): typeof findings => findings.filter((f) => f.signal === s);
    expect(by('overridden-in-practice')[0]).toMatchObject({ target: 'core.rule', level: 'propose' });
    expect(by('overridden-in-practice')[0]!.evidence).toHaveLength(3);
    expect(by('expired-proposal')[0]).toMatchObject({ target: 'core.stale' });
    expect(by('superseded-adr')[0]).toMatchObject({ target: 'C:adr-0002' });
    expect(by('superseded-adr')[0]!.proposal).toContain('--succ C:adr-0003');
    expect(by('deleted-path')[0]!.evidence[0]).toContain('src/core/gone.ts');
    expect(findings.some((f) => f.signal === 'overridden-in-practice' && f.target === 'core.fine')).toBe(false);
  });

  it('archives inactive records, keeps ids resolvable in the timeline, and retires with a reason', () => {
    const ctx = openRepo({ repo });
    const r = gc(ctx, { now: new Date('2026-09-07'), deleted: true });
    // d-0005 was superseded only six days before "now", so it stays in the active file; d-0004 and old.rule are old enough.
    expect(r.archived.sort()).toEqual(['d-0004', 'd-0007', 'old.rule']);
    expect(r.archiveFile).toBe(join(repo, '.ctx/archive/2026.ctx'));
    const archive = readFileSync(r.archiveFile!, 'utf8');
    expect(archive).toContain('D d-0004');
    expect(archive).toContain('S d-0005 d-0004');
    expect(archive).toContain('K G old.rule');
    expect(archive).toContain('Z old.rule');
    expect(archive).toContain('D d-0007');
    const decisions = readFileSync(join(repo, '.ctx/decisions.ctx'), 'utf8');
    expect(decisions).not.toContain('d-0004');
    expect(decisions).toContain('D d-0005');
    expect(decisions).toContain('D d-0006');
    expect(decisions).toContain('S d-0006 d-0005');
    expect(readFileSync(join(repo, '.ctx/graph.ctx'), 'utf8')).not.toContain('old.rule');

    const ctx2 = openRepo({ repo });
    expect(ctx2.graph!.validate(repo).filter((f) => f.level === 'error')).toEqual([]);
    const rows = timeline(ctx2, 'src/core/b.ts');
    expect(rows.map((x) => `${x.kind}:${x.id}${x.archived ? '*' : ''}`)).toEqual(['decision:d-0004*', 'superseded:d-0004*', 'decision:d-0005', 'superseded:d-0005', 'decision:d-0006']);

    const ret = retire(ctx2, 'C:adr-0002', 'ADR 0002 superseded', 'C:adr-0003');
    expect(ret.needsTrailer).toBe(true);
    expect(ret.record).toMatchObject({ target: 'C:adr-0002', succ: 'C:adr-0003' });
    const ctx3 = openRepo({ repo });
    expect(ctx3.graph!.isRetired('C:adr-0002')).toBe(true);
    expect(existsSync(join(repo, '.ctx/archive'))).toBe(true);
  });
});
