import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRepo } from '../core/context.js';
import { harnessFrom, harnessProblems, withHarnessSetting } from '../core/harness.js';
import { isPersonsGraphAct } from './person-acts.js';
import { run } from './settings.js';

const CONFIG = '# Context Graph configuration.\n[repo]\nratifiers = ["warren"]   # who ratifies\n\n[slice]\nmax_tokens = 300\n';

describe('ctx settings: the harness settings, changed as the person', () => {
  let repo: string;
  let out: string[];
  let err: string[];
  const prev = { CTX_HOME: process.env.CTX_HOME, CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR, CODE_KIT_CLI: process.env.CODE_KIT_CLI };
  const ctx = (...positional: string[]) => (flags: Record<string, string | boolean> = {}) =>
    run({ cmd: 'settings', positional, flags, repo } as never, { json: Boolean(flags.json) });

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'ctx-settings-')));
    process.env.CTX_HOME = mkdtempSync(join(tmpdir(), 'ctx-home-'));
    process.env.CLAUDE_PROJECT_DIR = repo;
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.ctx'));
    writeFileSync(join(repo, '.ctx/graph.ctx'), 'M ** L:repo\nL L:repo Repo\n');
    writeFileSync(join(repo, '.ctx/config.toml'), CONFIG);
    out = [];
    err = [];
    vi.spyOn(console, 'log').mockImplementation((s: string) => void out.push(s));
    vi.spyOn(console, 'error').mockImplementation((s: string) => void err.push(s));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('VIEW-6 lists every setting with its value, default and what it does', async () => {
    expect(await ctx()({ json: true })).toBe(0);
    const rows = JSON.parse(out[0]!) as { key: string; value: unknown; default: unknown; about: string }[];
    expect(rows.map((r) => r.key)).toEqual(['card_writer', 'card_writer_model', 'curator', 'curator_model', 'side_questions', 'side_questions_model', 'pause_at_percent']);
    expect(rows.find((r) => r.key === 'card_writer')).toMatchObject({ value: false, default: false });
    expect(rows.find((r) => r.key === 'pause_at_percent')).toMatchObject({ value: 80 });
  });

  it('VIEW-6 set writes the [harness] section, keeping the rest of the file as it was', async () => {
    expect(await ctx('set', 'card_writer', 'true')({ reason: 'cards keep falling behind' })).toBe(0);
    expect(await ctx('set', 'card_writer_model', 'haiku')({ reason: 'cheap is fine' })).toBe(0);
    const text = readFileSync(join(repo, '.ctx/config.toml'), 'utf8');
    expect(text).toBe(`${CONFIG.replace(/\n$/, '')}\n\n[harness]\ncard_writer = true\ncard_writer_model = "haiku"\n`);
    expect(openRepo({ repo }).config.harness).toMatchObject({ card_writer: true, card_writer_model: 'haiku' });
    expect(await ctx('set', 'card_writer', 'false')({ reason: 'off again' })).toBe(0);
    expect(readFileSync(join(repo, '.ctx/config.toml'), 'utf8')).toContain('[harness]\ncard_writer = false\ncard_writer_model = "haiku"\n');
  });

  it('refuses an unknown setting, a value out of range, and a change without a reason', async () => {
    expect(await ctx('set', 'judge', 'true')({ reason: 'x' })).toBe(1);
    expect(err.at(-1)).toMatch(/isn't a harness setting/);
    expect(await ctx('set', 'pause_at_percent', '150')({ reason: 'x' })).toBe(1);
    expect(err.at(-1)).toBe('pause_at_percent must be a percentage from 1 to 100. Nothing was changed.');
    expect(await ctx('set', 'curator', 'true')({})).toBe(1);
    expect(err.at(-1)).toMatch(/Give a reason/);
    expect(readFileSync(join(repo, '.ctx/config.toml'), 'utf8')).toBe(CONFIG);
  });

  it("VIEW-6 with code-kit there, the change is approved in its log as the person's, from the pane", async () => {
    const bin = mkdtempSync(join(tmpdir(), 'code-kit-'));
    const said = join(bin, 'said.json');
    writeFileSync(join(bin, 'code-kit.mjs'), `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(said)}, JSON.stringify(process.argv.slice(2)));\n`);
    process.env.CODE_KIT_CLI = join(bin, 'code-kit.mjs');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.claude/code-kit.json'), '{}');
    expect(await ctx('set', 'curator', 'true')({ reason: 'try it for a sprint', via: 'pane' })).toBe(0);
    expect(JSON.parse(readFileSync(said, 'utf8'))).toEqual(['approve', 'ctx', '--reason', 'curator = true: try it for a sprint', '--via', 'context-graph']);
    expect(out.at(-1)).toMatch(/code-kit's approval log keeps it as your change/);
  });

  it('the harness section: values over the defaults, a wrong one giving way, and its problems', () => {
    expect(harnessFrom({ curator: true, pause_at_percent: 900 })).toMatchObject({ curator: true, pause_at_percent: 80 });
    expect(harnessProblems({ curator: 'yes', judge: true })).toEqual([
      '[harness] curator must be true or false',
      "[harness] judge isn't a harness setting (they are card_writer, card_writer_model, curator, curator_model, side_questions, side_questions_model, pause_at_percent)",
    ]);
    expect(withHarnessSetting('[harness]\ncurator = false   # off for now\n\n[x]\ny = 1\n', 'curator', true)).toBe('[harness]\ncurator = true   # off for now\n\n[x]\ny = 1\n');
    expect(withHarnessSetting('[harness]\ncurator = false\n\n[x]\ny = 1\n', 'side_questions', false)).toBe('[harness]\ncurator = false\nside_questions = false\n\n[x]\ny = 1\n');
  });

  it("no agent changes the settings: it's the person's act", () => {
    expect(isPersonsGraphAct('ctx settings set curator true --reason x')).toBe(true);
    expect(isPersonsGraphAct('node "/x/ctx.mjs" settings set card_writer true --reason x')).toBe(true);
    expect(isPersonsGraphAct('ctx settings --json')).toBe(false);
  });
});
