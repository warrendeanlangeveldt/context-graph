import type { RepoContext } from '../core/context.js';
import { loadOrBuildImportIndex } from '../index/imports.js';
import { git } from '../util/git.js';
import { cardState, exemptFromCards } from './cards.js';

/** Which files a backfill cards: the modules changed lately, or every module. */
export type BackfillScope = 'active' | 'all';
/** "Lately", for the active scope. */
export const ACTIVE_DAYS = 90;

export interface Backfill {
  scope: BackfillScope;
  /** The files still without a current card, in the order to card them. */
  files: string[];
  /** The files in scope, carded or not, for the progress. */
  inScope: number;
}

/**
 * A brownfield project's card backlog (the card writer's backfill): every file in scope without a current
 * card, leaves first. A file is listed after the files it imports, so whoever cards it finds its imports
 * already carded and reads only the file itself; files in an import cycle follow the rest, those with
 * the fewest uncarded imports first. `active` scope keeps the modules where any file changed in the last
 * 90 days; `all` keeps every module.
 */
export function backfillOrder(ctx: RepoContext, scope: BackfillScope = 'active'): Backfill {
  const g = ctx.graph;
  if (!g) return { scope, files: [], inScope: 0 };
  const files = (git(ctx.root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '')
    .split('\n')
    .filter((f) => f && !exemptFromCards(f, ctx.config.cardsExclude) && g.mapPath(f));
  const moduleOf = (f: string): string | undefined => g.mapPath(f)?.logical;
  let inScope = files;
  if (scope === 'active') {
    const recent = (git(ctx.root, ['log', `--since=${ACTIVE_DAYS}.days`, '--name-only', '--format=']) ?? '').split('\n').filter(Boolean);
    const active = new Set(recent.map(moduleOf).filter((m): m is string => Boolean(m)));
    inScope = files.filter((f) => active.has(moduleOf(f)!));
  }
  const todo = new Set(inScope.filter((f) => {
    const s = cardState(g, ctx.root, f);
    return s.hash !== undefined && !s.fresh;
  }));
  const index = loadOrBuildImportIndex(ctx.root);
  const order: string[] = [];
  const placed = new Set<string>();
  const waitingOn = (f: string): string[] => (index.imports[f] ?? []).filter((i) => todo.has(i) && !placed.has(i) && i !== f);
  // Leaves first, a layer at a time; ties in path order so the order is the same on every run.
  let left = [...todo].sort();
  while (left.length) {
    const ready = left.filter((f) => waitingOn(f).length === 0);
    const next = ready.length ? ready : [left.slice().sort((a, b) => waitingOn(a).length - waitingOn(b).length || a.localeCompare(b))[0]!];
    for (const f of next) {
      order.push(f);
      placed.add(f);
    }
    left = left.filter((f) => !placed.has(f));
  }
  return { scope, files: order, inScope: inScope.length };
}
