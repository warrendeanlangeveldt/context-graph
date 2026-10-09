import { cardState, exemptFromCards } from '../cards/cards.js';
import type { RepoContext } from '../core/context.js';
import { isLogicalId } from '../graph/records.js';
import { git } from '../util/git.js';
import { needGraph, openFromArgs, type Args } from './main.js';

/** A file's card in the map: current, stale (the file changed since), or missing. */
export type MapCard = 'current' | 'stale' | 'missing';

export interface MapModule {
  id: string;
  name: string;
  /** Its depth in the tree, 0 for a module nothing contains. */
  depth: number;
  parents: string[];
  rules: { agreed: number; proposed: number };
  /** The dates of the decisions on it, or on its files, in the last 30 days. */
  decisions: string[];
  files: { path: string; card: MapCard }[];
}

const DAYS = 30;

/**
 * The graph as a map (docs/specs/08-graph-explorer.md, MAP-1): every module in tree order, with its
 * rules agreed and proposed, its decisions of the last 30 days, and each file it maps with its card's
 * state, for the Context pane's Map tab and its coverage heat map.
 */
export function graphMap(ctx: RepoContext, now = Date.now()): MapModule[] {
  const g = needGraph(ctx);
  const files = (git(ctx.root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean).sort();
  const byModule = new Map<string, { path: string; card: MapCard }[]>();
  for (const f of files) {
    if (exemptFromCards(f, ctx.config.cardsExclude)) continue;
    const m = g.mapPath(f)?.logical;
    if (!m) continue;
    const s = cardState(g, ctx.root, f);
    if (s.hash === undefined) continue;
    byModule.set(m, [...(byModule.get(m) ?? []), { path: f, card: s.fresh ? 'current' : s.card ? 'stale' : 'missing' }]);
  }
  const since = new Date(now - DAYS * 86_400_000).toISOString().slice(0, 10);
  const moduleOf = (node: string): string | undefined => (isLogicalId(node) ? node : g.mapPath(node)?.logical);
  const decided = new Map<string, string[]>();
  for (const d of g.decisions.values()) {
    if (d.date < since) continue;
    const m = moduleOf(d.node);
    if (m) decided.set(m, [...(decided.get(m) ?? []), d.date]);
  }
  // Tree order: each module after its parent, children by id; a module with no parent at the top.
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const id of [...g.logicals.keys()].sort()) {
    const parents = g.parentsOf(id).filter((p) => g.logicals.has(p));
    if (!parents.length) roots.push(id);
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), id]);
  }
  const out: MapModule[] = [];
  const seen = new Set<string>();
  const visit = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const ks = g.constraintsOn(id);
    out.push({
      id,
      name: g.logicals.get(id)!.name,
      depth,
      parents: g.parentsOf(id),
      rules: { agreed: ks.filter((k) => k.mode !== 'G?').length, proposed: ks.filter((k) => k.mode === 'G?').length },
      decisions: (decided.get(id) ?? []).sort(),
      files: byModule.get(id) ?? [],
    });
    for (const c of children.get(id) ?? []) visit(c, depth + 1);
  };
  for (const r of roots) visit(r, 0);
  return out;
}

/** `ctx map`: the modules as a tree, with rules, recent decisions and card coverage. */
export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const map = graphMap(ctx);
  if (env.json) {
    console.log(JSON.stringify(map, null, 2));
    return 0;
  }
  for (const m of map) {
    const carded = m.files.filter((f) => f.card === 'current').length;
    console.log(`${'  '.repeat(m.depth)}${m.id} ${m.name}  rules ${m.rules.agreed}${m.rules.proposed ? ` (+${m.rules.proposed} proposed)` : ''}  decisions ${m.decisions.length}  carded ${carded}/${m.files.length}`);
  }
  return 0;
}
