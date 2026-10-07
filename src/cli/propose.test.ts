import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openRepo } from '../core/context.js';
import { ratify } from '../init/ratify.js';
import { proposals } from './present.js';
import { propose, proposalId } from '../record/propose.js';
import { run } from './propose.js';

const GRAPH = `M src/** L:src
M ** L:repo
L L:repo Repo
L L:src Source
E L:src in L:repo
K G src.pure L:src no side effects at import
`;

describe('ctx propose: a rule for a path, proposed for a person to ratify', () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-propose-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'warren@example.com');
    git('config', 'user.name', 'Warren');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    writeFileSync(join(repo, '.ctx/config.toml'), '[repo]\nratifiers = ["warren"]\n');
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it("proposes a rule on a path's module, which then waits among the proposals", () => {
    const res = propose(openRepo({ repo }), { target: 'src/a.ts', text: 'Dates are stored in UTC' }, '2026-10-07');
    expect(res).toMatchObject({ record: { id: 'src.dates-are-stored', mode: 'G?', attachedTo: 'L:src', since: '2026-10-07' } });
    expect(readFileSync(join(repo, '.ctx/proposals.ctx'), 'utf8')).toContain('K G? src.dates-are-stored L:src Dates are stored in UTC since:2026-10-07');
    expect(proposals(openRepo({ repo })).find((p) => p.id === 'src.dates-are-stored')).toMatchObject({ kind: 'guidance', module: 'L:src' });
  });

  it('a person ratifies it like any proposal', () => {
    propose(openRepo({ repo }), { target: 'L:src', text: 'Dates are stored in UTC', id: 'src.utc' });
    ratify(openRepo({ repo }), ['src.utc']);
    const g = openRepo({ repo }).graph!;
    expect(g.constraints.get('src.utc')).toMatchObject({ mode: 'G', attachedTo: 'L:src' });
  });

  it('refuses what it can\'t place, a duplicate, and a taken or unusable id', () => {
    const ctx = openRepo({ repo });
    expect(propose(ctx, { target: 'L:nowhere', text: 'x' })).toEqual({ error: "L:nowhere isn't a module in the graph." });
    expect(propose(ctx, { target: 'src/a.ts', text: 'no side effects at import' })).toEqual({ error: 'L:src already has this rule, as src.pure.' });
    expect(propose(ctx, { target: 'src/a.ts', text: 'x', id: 'src.pure' })).toMatchObject({ error: expect.stringContaining('already a rule') });
    expect(propose(ctx, { target: 'src/a.ts', text: 'x', id: 'has space' })).toMatchObject({ error: expect.stringContaining("isn't a usable id") });
    expect(propose(ctx, { target: 'src/a.ts', text: 'x', test: 'npm test' })).toMatchObject({ error: expect.stringContaining('--test takes the path') });
  });

  it('ids are made unique', () => {
    const taken = new Set(['src.dates-stored-utc']);
    expect(proposalId('L:src', 'Dates stored in UTC', (id) => taken.has(id))).toBe('src.dates-stored-utc-2');
  });

  it('the command line prints what it proposed, and fails with the reason', async () => {
    const out: string[] = [];
    const log = console.log;
    console.log = (s: string) => out.push(s);
    try {
      expect(await run({ cmd: 'propose', positional: ['src/a.ts', 'Money', 'is', 'integer', 'cents'], flags: { repo } }, { json: true })).toBe(0);
    } finally {
      console.log = log;
    }
    expect(JSON.parse(out[0]!)).toMatchObject({ proposed: 'src.money-integer-cents', module: 'L:src' });
  });
});
