import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backfillOrder } from '../cards/backfill.js';
import { cardState, contentHash } from '../cards/cards.js';
import { cachedHash, flushHashCaches, resetHashCaches } from '../cards/hashcache.js';
import { claimWriter, releaseWriter, WRITER_STALE_MS } from '../cards/writer.js';
import { runClaudeHook } from '../adapters/claude-code/hook.js';
import { openRepo } from '../core/context.js';
import { hygieneReport } from '../hygiene/hygiene.js';
import { checkoutHash } from '../util/paths.js';
import { cardsReport } from './guide.js';
import { agentCoverage, proposals } from './present.js';
import { settingRows } from './settings.js';
import { run as snapshotRun } from './snapshot.js';

describe('what Context Graph costs to run (docs/specs/10-cost.md)', () => {
  let repo: string;
  let home: string;
  let out: string[];
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR };
  const git = (...a: string[]): string => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  const put = (path: string, text: string): void => writeFileSync(join(repo, path), text);
  /** Puts a file's modification time a minute back, out of the window a cache leaves alone. */
  const settle = (path: string): void => {
    const t = new Date(Date.now() - 60_000);
    utimesSync(join(repo, path), t, t);
  };
  const snapshot = async (flags: Record<string, string | boolean> = {}) => {
    out = [];
    expect(await snapshotRun({ cmd: 'snapshot', positional: [], flags: { repo, ...flags } } as never, { json: true })).toBe(0);
    return JSON.parse(out.join('\n')) as Record<string, unknown>;
  };

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-cost-')));
    home = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CTX_HOME = home;
    process.env.CLAUDE_PROJECT_DIR = repo;
    resetHashCaches();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'old'));
    mkdirSync(join(repo, '.ctx'));
    put('.ctx/graph.ctx', 'M src/** L:src\nM old/** L:old\nL L:src Source\nL L:old Old\n');
    put('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    put('src/b.ts', 'export const b = 1;\n');
    put('old/x.ts', 'export const x = 1;\n');
    put('.ctx/cards.ctx', `F src/b.ts ${contentHash('export const b = 1;\n')} 2026-10-10 t Holds b.\n`);
    for (const f of ['src/a.ts', 'src/b.ts', 'old/x.ts']) settle(f);
    const long = { ...process.env, GIT_AUTHOR_DATE: '2025-01-01T00:00:00', GIT_COMMITTER_DATE: '2025-01-01T00:00:00' };
    git('add', 'old', '.ctx/graph.ctx');
    execFileSync('git', ['commit', '-q', '-m', 'old'], { cwd: repo, env: long });
    git('add', '-A');
    git('commit', '-q', '-m', 'src');
    out = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('COST-3 a file is hashed once until its size or modification time changes, across runs', () => {
    let reads = 0;
    const hash = (): string | undefined => {
      reads += 1;
      return contentHash(readFileSync(join(repo, 'src/a.ts'), 'utf8'));
    };
    const first = cachedHash(repo, 'src/a.ts', hash);
    flushHashCaches();
    resetHashCaches(); // a new process: the cache comes from its file
    expect(cachedHash(repo, 'src/a.ts', hash)).toBe(first);
    expect(reads).toBe(1);
    put('src/a.ts', "import { b } from './b';\nexport const a = b + 1;\n");
    settle('src/a.ts');
    expect(cachedHash(repo, 'src/a.ts', hash)).not.toBe(first);
    expect(reads).toBe(2);
  });

  it('COST-3 an edited file is seen stale at once, however recently it changed', () => {
    const g = openRepo({ repo }).graph!;
    expect(cardState(g, repo, 'src/b.ts').fresh).toBe(true);
    put('src/b.ts', 'export const b = 2;\n'); // same size, just now
    expect(cardState(g, repo, 'src/b.ts').fresh).toBe(false);
  });

  it("COST-3 the backfill's active modules are read from the history once for each HEAD", () => {
    expect(backfillOrder(openRepo({ repo }), 'active').files).toEqual(['src/a.ts']);
    const cache = join(home, 'index', `${checkoutHash(repo)}.active.json`);
    expect(existsSync(cache)).toBe(true);
    // A cache for this HEAD naming old/ is believed: the history isn't walked again.
    const cached = JSON.parse(readFileSync(cache, 'utf8')) as { head: string };
    writeFileSync(cache, JSON.stringify({ ...cached, files: ['old/x.ts'] }));
    expect(backfillOrder(openRepo({ repo }), 'active').files).toEqual(['old/x.ts']);
    // HEAD moves: it's read again.
    put('src/c.ts', 'export const c = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'c');
    expect(backfillOrder(openRepo({ repo }), 'active').files).toContain('src/a.ts');
  });

  it('COST-4 one session per checkout runs the background work, until it ends or goes quiet', () => {
    const now = Date.now();
    expect(claimWriter(repo, 's1', now).mine).toBe(true);
    expect(claimWriter(repo, 's2', now + 1000)).toMatchObject({ mine: false, session: 's1' });
    expect(claimWriter(repo, 's1', now + 2000).mine).toBe(true);
    expect(claimWriter(repo, 's2', now + 2000 + WRITER_STALE_MS).mine).toBe(true);
    releaseWriter(repo, 's2');
    expect(claimWriter(repo, 's3', now + 2000 + WRITER_STALE_MS).mine).toBe(true);
  });

  it('COST-2 the snapshot returns what the separate commands do, from one process', async () => {
    const s = await snapshot({ session: 's1' });
    const ctx = openRepo({ repo });
    expect(s.proposals).toEqual(JSON.parse(JSON.stringify(proposals(ctx))));
    expect(s.cards).toEqual(cardsReport(ctx));
    expect(s.hygiene).toEqual(JSON.parse(JSON.stringify(hygieneReport(ctx).filter((f) => f.signal.startsWith('overridden-')))));
    expect(s.settings).toEqual(JSON.parse(JSON.stringify(settingRows(ctx))));
    expect(s.agents).toEqual(JSON.parse(JSON.stringify(agentCoverage(ctx, 's1'))));
    expect((s.info as { graphDir: string }).graphDir).toBe(join(repo, '.ctx'));
    // COST-4: the card writer off by default, so none of its lists, and no writer claimed.
    expect(Object.keys(s)).not.toContain('changed');
    expect(Object.keys(s)).not.toContain('backfill');
    expect(s.writer).toBeNull();
  });

  it('COST-2 and COST-4 with the card writer on, only the session that holds the writer gets its lists', async () => {
    put('.ctx/config.toml', '[harness]\ncard_writer = true\nbackfill = "active"\n');
    const mine = await snapshot({ session: 's1' });
    expect(mine.writer).toMatchObject({ mine: true, session: 's1' });
    expect((mine.backfill as { files: string[] }).files).toEqual(['src/a.ts']);
    expect(mine.changed).toBeDefined();
    const other = await snapshot({ session: 's2' });
    expect(other.writer).toMatchObject({ mine: false, session: 's1' });
    expect(Object.keys(other)).not.toContain('backfill');
    expect(Object.keys(other)).not.toContain('changed');
  });

  it('COST-2 with --file, the snapshot carries the file and its neighbours', async () => {
    const s = await snapshot({ session: 's1', file: 'src/a.ts' });
    expect((s.file as { path: string }).path).toBe('src/a.ts');
    expect((s.neighbours as { imports: { path: string }[] }).imports.map((i) => i.path)).toEqual(['src/b.ts']);
  });

  it('COST-4 a session that ends hands the writer on at once', async () => {
    expect(claimWriter(repo, 's1').mine).toBe(true);
    await runClaudeHook({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: repo } as never);
    expect(claimWriter(repo, 's2').mine).toBe(true);
  });

  it('COST-5 the completion hooks run only for the tools whose calls touch files, as PreToolUse does', () => {
    const file = join(dirname(fileURLToPath(import.meta.url)), '../../adapters/claude-code/hooks/hooks.json');
    const hooks = (JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, { matcher: string }[]> }).hooks;
    const pre = hooks.PreToolUse!.map((h) => h.matcher);
    expect(pre).toEqual(['Read|Grep|Glob|Edit|Write|MultiEdit|NotebookEdit|Bash']);
    expect(hooks.PostToolUse!.map((h) => h.matcher)).toEqual(pre);
    expect(hooks.PostToolUseFailure!.map((h) => h.matcher)).toEqual(pre);
  });
});
