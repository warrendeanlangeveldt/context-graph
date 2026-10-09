import { cardState, exemptFromCards } from '../cards/cards.js';
import { callersOf, loadOrBuildImportIndex } from '../index/imports.js';
import { conformanceReport } from '../init/conformance.js';
import type { RepoContext } from '../core/context.js';
import { needGraph, openFromArgs, type Args } from './main.js';

/** A file's card as the File tab marks it: current, stale, missing, or exempt (it owes none). */
export type CardMark = 'current' | 'stale' | 'missing' | 'exempt';

export interface Neighbour {
  path: string;
  card: CardMark;
  /** The rules the file breaks now (rule-bearing constraints with a violation from it). */
  breaks: string[];
}

export interface Neighbours {
  path: string;
  card: CardMark;
  breaks: string[];
  imports: Neighbour[];
  importers: Neighbour[];
}

/**
 * A file's neighbourhood for the Context pane's File tab (docs/specs/09-panes.md, VIEW-2): what it
 * imports and what imports it, from the import index, each with its card's state and the rules it
 * breaks, so the uncarded and rule-breaking ones stand out.
 */
export function neighbours(ctx: RepoContext, path: string): Neighbours {
  const g = needGraph(ctx);
  const index = loadOrBuildImportIndex(ctx.root);
  const broken = new Map<string, string[]>();
  for (const [id, vs] of conformanceReport(ctx)) for (const v of vs) broken.set(v.from, [...(broken.get(v.from) ?? []), id]);
  const mark = (p: string): CardMark => {
    if (exemptFromCards(p, ctx.config.cardsExclude)) return 'exempt';
    const s = cardState(g, ctx.root, p);
    return s.fresh ? 'current' : s.card ? 'stale' : 'missing';
  };
  const of = (p: string): Neighbour => ({ path: p, card: mark(p), breaks: [...new Set(broken.get(p) ?? [])] });
  return {
    path,
    card: mark(path),
    breaks: [...new Set(broken.get(path) ?? [])],
    imports: (index.imports[path] ?? []).slice().sort().map(of),
    importers: callersOf(index, path).map(of),
  };
}

/** `ctx neighbours <path>`: what a file imports and what imports it, with their cards and broken rules. */
export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const path = args.positional[0];
  if (!path) throw new Error('ctx neighbours <path>');
  const n = neighbours(ctx, path.replace(/^\.\//, ''));
  const line = (x: Neighbour) => `  ${x.path}  card ${x.card}${x.breaks.length ? `, breaks ${x.breaks.join(', ')}` : ''}`;
  console.log(
    env.json
      ? JSON.stringify(n, null, 2)
      : [`${n.path}  card ${n.card}`, 'imports:', ...(n.imports.length ? n.imports.map(line) : ['  (none)']), 'imported by:', ...(n.importers.length ? n.importers.map(line) : ['  (none)'])].join('\n'),
  );
  return 0;
}
