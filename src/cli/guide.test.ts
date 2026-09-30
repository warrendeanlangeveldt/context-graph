import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCard } from '../cards/cards.js';
import { openRepo } from '../core/context.js';
import { INSTRUCTION_BLOCK } from '../init/instructions.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { cardsReport, nextStep } from './guide.js';

const GRAPH = 'M src/** L:src\nM ** L:repo\nL L:repo Repo\nL L:src Source\nE L:src in L:repo\nK G src.pure L:src no side effects at import\n';

describe('ctx next and ctx cards', () => {
  let repo: string;
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const next = () => nextStep(openRepo({ repo }), { doctor: false });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-guide-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    delete process.env.CLAUDE_PROJECT_DIR;
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    writeFileSync(join(repo, 'src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'package.json'), '{}\n');
    writeFileSync(join(repo, 'CLAUDE.md'), `# Project\n\n${INSTRUCTION_BLOCK}`);
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });
  afterEach(() => { for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  const withGraph = (graph = GRAPH): void => {
    mkdirSync(join(repo, '.ctx'), { recursive: true });
    writeFileSync(join(repo, '.ctx/graph.ctx'), graph);
  };

  it('starts with init when there is no graph', () => {
    expect(next().step).toBe('init');
  });

  it('sends a broken graph to status', () => {
    withGraph(GRAPH + 'E L:src in L:nowhere\n');
    const n = next();
    expect(n.step).toBe('status');
    expect(n.command).toBe('ctx check');
  });

  it('asks for what the last session still owes', () => {
    withGraph();
    const state = new SessionState(repo, 'sess-1');
    state.data.cardsOwed = { 'src/a.ts': { path: 'src/a.ts', since: 'now' } };
    state.save();
    // The session has to exist as an observation store for "last session" to find it.
    mkdirSync(join(process.env.CTX_HOME!, 'observations'), { recursive: true });
    new ObservationStore(repo, 'sess-1').append({ t: 'session', ts: new Date().toISOString(), session: 'sess-1', who: 't', branch: 'main', harness: 'claude-code', p: {} });
    const n = next();
    expect(n.step).toBe('cards');
    expect(n.why).toContain('1 card(s) (src/a.ts)');
  });

  it('points at the instruction block when it is missing', () => {
    withGraph();
    writeFileSync(join(repo, 'CLAUDE.md'), '# Project\n');
    const n = next();
    expect(n.step).toBe('init');
    expect(n.command).toBe('ctx install instructions');
  });

  it('asks for cards for files this branch changed, then for curation of proposals, then says done', () => {
    withGraph(GRAPH + 'K G? src.maybe L:src a proposal\n');
    git('checkout', '-q', '-b', 'feature');
    writeFileSync(join(repo, 'src/b.ts'), 'export const b = 2;\n');
    let n = next();
    expect(n.step).toBe('cards');
    expect(n.why).toContain('src/b.ts');
    const ctx = openRepo({ repo });
    writeCard(ctx.graph!, repo, { path: 'src/b.ts', text: 'holds b', who: 't', date: '2026-09-30' });
    n = next();
    expect(n.step).toBe('curate');
    expect(n.why).toContain('1 proposed rule(s)');
    writeFileSync(join(repo, '.ctx/graph.ctx'), GRAPH);
    n = next();
    expect(n.step).toBe('done');
    expect(n.summary.join(' ')).toContain('cards: 1 current, 0 stale, 1 missing, of 2 files');
  });

  it('reports cards for code, not configuration, and a project exclusion adds to the defaults', () => {
    withGraph();
    mkdirSync(join(repo, 'gen'));
    writeFileSync(join(repo, 'gen/out.ts'), 'export const g = 1;\n');
    writeFileSync(join(repo, '.ctx/config.toml'), '[cards]\nexclude = ["gen/**"]\n');
    const r = cardsReport(openRepo({ repo }));
    // package.json (a default exclusion) and gen/ (the project's) are both out.
    expect(r.missing).toEqual(['src/a.ts']);
  });
});
