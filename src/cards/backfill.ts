import type { RepoContext } from '../core/context.js';
import { loadOrBuildImportIndex } from '../index/imports.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, headSha } from '../util/git.js';
import { checkoutHash, ctxHome } from '../util/paths.js';
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
    const active = activeModules(ctx.root, moduleOf);
    inScope = files.filter((f) => active.has(moduleOf(f)!));
  }
  const todo = new Set(inScope.filter((f) => {
    const s = cardState(g, ctx.root, f);
    return s.hash !== undefined && !s.fresh;
  }));
  const index = loadOrBuildImportIndex(ctx.root);
  return { scope, files: leavesFirst([...todo], (f) => index.imports[f] ?? []), inScope: inScope.length };
}

/**
 * The files in the order to card them: a layer at a time, each file after the files it imports, ties in
 * path order so the order is the same on every run. Where only an import cycle is left, the file with
 * the fewest imports still waiting goes next on its own. One pass over the import graph (COST-3).
 */
export function leavesFirst(files: string[], importsOf: (f: string) => string[]): string[] {
  const todo = new Set(files);
  const waiting = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const f of todo) {
    const deps = [...new Set(importsOf(f))].filter((i) => todo.has(i) && i !== f);
    waiting.set(f, deps.length);
    for (const d of deps) dependents.set(d, [...(dependents.get(d) ?? []), f]);
  }
  const order: string[] = [];
  const left = new Set([...todo].sort());
  const place = (f: string, freed: string[]): void => {
    order.push(f);
    left.delete(f);
    for (const d of dependents.get(f) ?? []) {
      const n = waiting.get(d)! - 1;
      waiting.set(d, n);
      if (n === 0 && left.has(d)) freed.push(d);
    }
  };
  let layer = [...left].filter((f) => waiting.get(f) === 0);
  while (left.size) {
    if (!layer.length) {
      // An import cycle: the file with the fewest imports still waiting, then by path.
      let pick: string | undefined;
      for (const f of left) if (pick === undefined || waiting.get(f)! < waiting.get(pick)!) pick = f;
      layer = [pick!];
    }
    const freed: string[] = [];
    for (const f of layer) place(f, freed);
    // A file waits on nothing once its last import is placed: it's in the next layer.
    layer = freed.filter((f) => left.has(f)).sort();
  }
  return order;
}

/**
 * The modules any file changed in within the last 90 days, cached for the commit HEAD is on (COST-3):
 * the history doesn't change until HEAD moves.
 */
function activeModules(root: string, moduleOf: (f: string) => string | undefined): Set<string> {
  const head = headSha(root);
  const file = join(ctxHome(), 'index', `${checkoutHash(root)}.active.json`);
  if (head) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as { head: string; days: number; files: string[] };
      if (cached.head === head && cached.days === ACTIVE_DAYS) return new Set(cached.files.map(moduleOf).filter((m): m is string => Boolean(m)));
    } catch {
      /* none yet: read the history */
    }
  }
  const recent = [...new Set((git(root, ['log', `--since=${ACTIVE_DAYS}.days`, '--name-only', '--format=']) ?? '').split('\n').filter(Boolean))];
  if (head) {
    try {
      mkdirSync(join(ctxHome(), 'index'), { recursive: true });
      writeFileSync(file, JSON.stringify({ head, days: ACTIVE_DAYS, files: recent }), 'utf8');
    } catch {
      /* a read-only home: read the history again next time */
    }
  }
  return new Set(recent.map(moduleOf).filter((m): m is string => Boolean(m)));
}
