import { backfillOrder, type BackfillScope } from '../cards/backfill.js';
import { cardState, exemptFromCards } from '../cards/cards.js';
import type { RepoContext } from '../core/context.js';
import { hygieneReport } from '../hygiene/hygiene.js';
import { INSTRUCTION_HEADING } from '../init/instructions.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { Recorder } from '../record/recorder.js';
import { git } from '../util/git.js';
import { walk } from '../walker/walk.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runDoctor } from './doctor.js';
import { openFromArgs, str, type Args } from './main.js';

/**
 * Helping a person find their way: `ctx cards` (which files have a card that matches them) and `ctx next`
 * (the one thing to do now, from the repository's state, and the skill that does it).
 */

export interface CardsReport {
  fresh: string[];
  stale: string[];
  missing: string[];
  /** Which files were considered: every tracked file, or only those this branch changed. */
  scope: 'all' | 'changed';
}

/** Files this branch changed since it left the default branch, plus uncommitted and new files. */
export function changedFiles(ctx: RepoContext): string[] {
  const root = ctx.root;
  const branch = git(root, ['branch', '--show-current']) ?? '';
  const base = branch && branch !== ctx.config.defaultBranch ? git(root, ['merge-base', ctx.config.defaultBranch, 'HEAD']) : undefined;
  const out = new Set<string>();
  for (const list of [base ? git(root, ['diff', '--name-only', base]) : undefined, git(root, ['diff', '--name-only', 'HEAD']), git(root, ['ls-files', '--others', '--exclude-standard'])]) {
    for (const f of (list ?? '').split('\n').filter(Boolean)) out.add(f);
  }
  return [...out].filter((f) => existsSync(join(root, f)));
}

/** Every file's card state, or the branch's changed files' (`changed`), or a module's files (`module`: its chain names it). */
export function cardsReport(ctx: RepoContext, opts: { changed?: boolean; module?: string } = {}): CardsReport {
  const g = ctx.graph;
  const report: CardsReport = { fresh: [], stale: [], missing: [], scope: opts.changed ? 'changed' : 'all' };
  if (!g) return report;
  const files = opts.changed ? changedFiles(ctx) : (git(ctx.root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
  for (const f of files.sort()) {
    if (exemptFromCards(f, ctx.config.cardsExclude)) continue;
    if (opts.module && !walk(g, f, { maxDecisions: 0 }).chain.includes(opts.module)) continue;
    const s = cardState(g, ctx.root, f);
    if (s.hash === undefined) continue;
    (s.fresh ? report.fresh : s.card ? report.stale : report.missing).push(f);
  }
  return report;
}

export type Step = 'init' | 'status' | 'cards' | 'curate' | 'done';

export interface Next {
  step: Step;
  why: string;
  /** A command that does it directly, when one suffices. */
  command?: string;
  attention: string[];
  summary: string[];
}

/**
 * The step to take now. In order: no graph, a broken setup, work the last session still owes, the
 * instruction block, files this branch changed without a current card, then what waits for a person
 * (proposals to ratify, hygiene findings). Otherwise done, with a summary.
 */
export function nextStep(ctx: RepoContext, opts: { doctor?: boolean } = {}): Next {
  const attention: string[] = [];
  const summary: string[] = [];
  const result = (step: Step, why: string, extra: Partial<Next> = {}): Next => ({ step, why, attention, summary, ...extra });
  const isRepo = git(ctx.root, ['rev-parse', '--is-inside-work-tree']) === 'true';
  if (!isRepo) attention.push('This folder is not a git repository: decisions and cards are meant to travel with the code in git.');

  const g = ctx.graph;
  if (!g) return result('init', 'There is no graph for this repository yet, so nothing is injected and nothing is recorded. init proposes one from the tree, the tests, the instruction files and ADRs.');

  const errors = g.validate(ctx.root).filter((f) => f.level === 'error');
  if (errors.length) return result('status', `The graph has ${errors.length} error(s) (first: ${errors[0]!.message}); hooks read a broken graph. Fix it before anything else.`, { command: 'ctx check' });
  if (opts.doctor !== false) {
    const fails = runDoctor(ctx).filter((l) => l.level === 'fail');
    if (fails.length) return result('status', `Setup problem: ${fails[0]!.text}`, { command: 'ctx doctor' });
  }
  if (ctx.graphDir && !resolve(ctx.graphDir).startsWith(resolve(ctx.root) + '/')) attention.push('The graph is linked from outside the repository: ctx adopt moves it in, so teammates and other checkouts get it.');

  // What the last session still owes.
  const session = ObservationStore.sessions(ctx.root)[0]?.session;
  if (session) {
    const r = new Recorder(g, new SessionState(ctx.root, session), ctx.root);
    const decisions = r.pending().map((p) => p.path);
    const cards = r.cardsOwed();
    if (decisions.length || cards.length) {
      return result('cards', `The last session (${session}) still owes ${[decisions.length ? `${decisions.length} decision(s) (${decisions.slice(0, 3).join(', ')})` : '', cards.length ? `${cards.length} card(s) (${cards.slice(0, 3).join(', ')})` : ''].filter(Boolean).join(' and ')}.`);
    }
  }

  const ins = ['AGENTS.md', 'CLAUDE.md'].find((f) => existsSync(join(ctx.root, f)));
  if (ins && !readFileSync(join(ctx.root, ins), 'utf8').includes(INSTRUCTION_HEADING)) {
    return result('init', `${ins} has no Context Graph block, so agents are never told to hydrate before they read, or how the loop works.`, { command: 'ctx install instructions' });
  }

  const changed = cardsReport(ctx, { changed: true });
  if (changed.missing.length || changed.stale.length) {
    const n = changed.missing.length + changed.stale.length;
    return result('cards', `${n} file(s) this branch changed have no card matching them (${[...changed.stale, ...changed.missing].slice(0, 3).join(', ')}${n > 3 ? ', …' : ''}). The gate reports them, and the next agent to edit them has to read them in full.`, { command: 'ctx cards --changed' });
  }

  const proposals = [...g.constraints.values()].filter((k) => k.mode === 'G?').length + [...g.concepts.values()].filter((c) => c.proposed).length;
  const hygiene = hygieneReport(ctx).filter((f) => f.level === 'propose');
  if (proposals || hygiene.length) {
    return result('curate', [proposals ? `${proposals} proposed rule(s) or concept(s) wait for a person to ratify or drop` : '', hygiene.length ? `${hygiene.length} hygiene finding(s) propose a change` : ''].filter(Boolean).join('; ') + '.', { command: proposals ? 'ctx check' : 'ctx hygiene' });
  }

  const all = cardsReport(ctx);
  summary.push(`${g.logicals.size} modules, ${g.constraints.size} rules, ${g.decisions.size} decisions`);
  summary.push(`cards: ${all.fresh.length} current, ${all.stale.length} stale, ${all.missing.length} missing, of ${all.fresh.length + all.stale.length + all.missing.length} files`);
  return result('done', 'The graph is valid, nothing is owed, this branch\'s changed files all have current cards, and nothing waits for ratification.');
}

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  if (args.cmd === 'cards') {
    // The card writer's backfill: the files in scope without a current card, leaves first.
    if (args.flags.backfill === true) {
      const scope: BackfillScope = str(args.flags.scope) === 'all' ? 'all' : 'active';
      const b = backfillOrder(ctx, scope);
      if (env.json) { console.log(JSON.stringify(b, null, 2)); return 0; }
      console.log(`backfill (${scope === 'all' ? 'every module' : 'modules changed in the last 90 days'}): ${b.files.length} of ${b.inScope} files to card, leaves first`);
      for (const f of b.files.slice(0, 20)) console.log(`  ${f}`);
      if (b.files.length > 20) console.log(`  and ${b.files.length - 20} more`);
      return 0;
    }
    const module = str(args.flags.module);
    const r = cardsReport(ctx, { changed: args.flags.changed === true, ...(module ? { module } : {}) });
    if (!ctx.graph) { console.error('no graph for this repository: ctx init'); return 1; }
    const pick = args.flags.missing === true ? { missing: r.missing } : args.flags.stale === true ? { stale: r.stale } : r;
    if (env.json) { console.log(JSON.stringify(pick, null, 2)); return 0; }
    const total = r.fresh.length + r.stale.length + r.missing.length;
    console.log(`${r.scope === 'changed' ? 'changed files' : 'files'}: ${r.fresh.length} with a current card, ${r.stale.length} stale, ${r.missing.length} missing, of ${total}`);
    if (args.flags.missing !== true) for (const f of r.stale) console.log(`  stale    ${f}`);
    if (args.flags.stale !== true) for (const f of r.missing) console.log(`  missing  ${f}`);
    return 0;
  }
  const n = nextStep(ctx, { doctor: args.flags['no-doctor'] !== true });
  if (env.json) { console.log(JSON.stringify(n, null, 2)); return 0; }
  console.log(n.step === 'done' ? 'Next: nothing needs doing' : `Next: /context-graph:${n.step}${n.command ? `  (or: ${n.command})` : ''}`);
  console.log(`Why: ${n.why}`);
  for (const a of n.attention) console.log(`Note: ${a}`);
  for (const s of n.summary) console.log(`  ${s}`);
  return 0;
}
