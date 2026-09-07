import type { RepoContext } from '../core/context.js';
import { git } from '../util/git.js';

/**
 * Replay corpus (design spec §20.5). Tasks are real commits: prompt from the message, starting
 * tree from the parent, hidden check from the tests the commit touched. Strata are inferred so
 * the effect can be reported per kind of change.
 *
 *   T <task-id> <base-sha> <task-sha> <stratum> <check-command...>
 *   P <task-id> <prompt text...>
 */
export interface Task { id: string; base: string; sha: string; stratum: string; check: string; prompt: string }

export const STRATA = ['single-file', 'multi-file-module', 'cross-module', 'refactor', 'new-capability'] as const;

export function parseCorpus(text: string): Task[] {
  const tasks = new Map<string, Task>();
  const prompts = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [kind, ...rest] = line.split(/\s+/);
    if (kind === 'T') {
      const [id, base, sha, stratum, ...check] = rest;
      if (!id || !base || !sha || !stratum || !check.length) throw new Error(`bad T record: ${line}`);
      tasks.set(id, { id, base, sha, stratum, check: check.join(' '), prompt: '' });
    } else if (kind === 'P') {
      const [id, ...words] = rest;
      if (!id) throw new Error(`bad P record: ${line}`);
      prompts.set(id, (prompts.get(id) ? prompts.get(id) + '\n' : '') + words.join(' '));
    }
  }
  for (const t of tasks.values()) t.prompt = prompts.get(t.id) ?? '';
  return [...tasks.values()].filter((t) => t.prompt);
}

export function formatCorpus(tasks: Task[]): string {
  const out = ['# Replay corpus. T: task, base, commit, stratum, check command. P: prompt lines (repeatable).'];
  for (const t of tasks) {
    out.push(`T ${t.id} ${t.base} ${t.sha} ${t.stratum} ${t.check}`);
    for (const line of t.prompt.split('\n')) if (line.trim()) out.push(`P ${t.id} ${line.trim()}`);
  }
  return out.join('\n') + '\n';
}

const TEST_FILE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(^|\/)test_[^/]*\.py|_test\.py|_test\.go)$/;

/** Propose tasks from history: commits that touched tests, newest first. */
export function proposeCorpus(ctx: RepoContext, opts: { since?: string; limit?: number; testCommand?: string } = {}): { tasks: Task[]; skipped: { sha: string; reason: string }[] } {
  const root = ctx.root;
  const args = ['log', '--no-merges', '--format=%H%x1f%ad%x1f%s%x1f%b%x1e', '--date=short'];
  if (opts.since) args.push(`--since=${opts.since}`);
  args.push('-n', String((opts.limit ?? 20) * 6));
  const log = git(root, args) ?? '';
  const tasks: Task[] = [];
  const skipped: { sha: string; reason: string }[] = [];
  for (const entry of log.split('\x1e')) {
    if (tasks.length >= (opts.limit ?? 20)) break;
    const [sha, , subject, body] = entry.trim().split('\x1f');
    if (!sha || !subject) continue;
    const files = (git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) ?? '').split('\n').filter(Boolean);
    const tests = files.filter((f) => TEST_FILE.test(f));
    const code = files.filter((f) => !TEST_FILE.test(f) && !/\.(md|txt|json|ya?ml|lock)$/.test(f) && !f.startsWith('.ctx/'));
    if (!tests.length) { skipped.push({ sha: sha.slice(0, 8), reason: 'no test touched' }); continue; }
    if (!code.length) { skipped.push({ sha: sha.slice(0, 8), reason: 'only tests or docs' }); continue; }
    const parent = git(root, ['rev-parse', `${sha}^`]);
    if (!parent) { skipped.push({ sha: sha.slice(0, 8), reason: 'no parent' }); continue; }
    const check = opts.testCommand ? opts.testCommand.replaceAll('{tests}', tests.join(' ')) : defaultCheck(tests);
    if (!check) { skipped.push({ sha: sha.slice(0, 8), reason: 'no test command for these files' }); continue; }
    const stratum = classify(ctx, subject, code);
    const prompt = [subject, ...(body ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !/^(Co-Authored-By|Signed-off-by|Claude-Session|Ctx-Ratified-By)/i.test(l))].join('\n').slice(0, 1200);
    tasks.push({ id: `t-${sha.slice(0, 8)}`, base: parent.slice(0, 12), sha: sha.slice(0, 12), stratum, check, prompt });
  }
  return { tasks, skipped };
}

function defaultCheck(tests: string[]): string | undefined {
  const js = tests.filter((t) => /\.[cm]?[jt]sx?$/.test(t));
  const py = tests.filter((t) => t.endsWith('.py'));
  const go = tests.filter((t) => t.endsWith('.go'));
  if (js.length) return `npx vitest run ${js.join(' ')}`;
  if (py.length) return `pytest ${py.join(' ')}`;
  if (go.length) return `go test ${[...new Set(go.map((t) => './' + t.replace(/\/[^/]+$/, '')))].join(' ')}`;
  return undefined;
}

function classify(ctx: RepoContext, subject: string, code: string[]): string {
  if (/^refactor/i.test(subject)) return 'refactor';
  if (/^feat/i.test(subject)) return 'new-capability';
  if (code.length === 1) return 'single-file';
  const modules = new Set(code.map((f) => ctx.graph?.mapPath(f)?.logical ?? f.split('/').slice(0, -1).join('/')));
  return modules.size === 1 ? 'multi-file-module' : 'cross-module';
}
