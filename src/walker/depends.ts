import type { Graph } from '../graph/graph.js';
import { isActiveMode, type DRecord, type KRecord } from '../graph/records.js';
import { walk } from './walk.js';

/**
 * Context that reaches a file through what it imports (design spec §7.4). The walk follows containment:
 * a file sees the rules of its own module and the modules above it. But a rule is often obeyed somewhere
 * other than where it is written down: the rule about what an event must carry is attached to the module
 * that defines events, and broken in the service that records them. So before an edit, each file the
 * edited file imports contributes its own decisions, and the ratified rules of its module that the
 * edited file does not already see. One hop, and bounded when rendered.
 */
export interface DependencyContext {
  /** Imported file -> what it contributes. Only imports that carry something appear. */
  byImport: { path: string; rules: KRecord[]; decisions: DRecord[] }[];
}

export function dependencyContext(graph: Graph, path: string, imports: string[]): DependencyContext {
  const own = walk(graph, path);
  const seen = new Set(own.constraints.map((k) => k.id));
  const byImport: DependencyContext['byImport'] = [];
  for (const imp of imports) {
    if (imp === path) continue;
    const w = walk(graph, imp);
    // The dependency's own module and the file itself, not the ancestors both share (the root's rules
    // already reach the edited file through its own chain).
    const local = new Set([imp, w.chain[0]].filter(Boolean) as string[]);
    const rules = w.constraints.filter((k) => local.has(k.attachedTo) && isActiveMode(k) && !seen.has(k.id));
    for (const k of rules) seen.add(k.id);
    const decisions = [...graph.decisions.values()].filter((d) => (d.node === imp || d.node.startsWith(`${imp}#`)) && graph.isActiveDecision(d));
    if (rules.length || decisions.length) byImport.push({ path: imp, rules, decisions });
  }
  return { byImport };
}

/** Whether an import carries context an edit must not skip: its own decisions, or rules the edited file does not see. */
export function carriesContext(ctx: DependencyContext, imp: string): boolean {
  return ctx.byImport.some((b) => b.path === imp);
}

/**
 * The lines added under the slice. Module rules are grouped under their module (they belong to it, not to
 * whichever import reached it first), up to `maxRules`. Decisions follow, newest first across all imports,
 * up to `maxDecisions`: a decision is the one thing the code cannot show, so none is cut to make room for
 * rule text, and no import's decisions are cut below another's.
 */
export function renderDependencyContext(graph: Graph, ctx: DependencyContext, opts: { maxRules?: number; maxDecisions?: number } = {}): string | undefined {
  if (!ctx.byImport.length) return undefined;
  const maxRules = opts.maxRules ?? 4;
  const maxDecisions = opts.maxDecisions ?? 8;
  const rules: string[] = [];
  for (const b of ctx.byImport) {
    for (const k of b.rules) {
      const where = k.attachedTo.startsWith('L:') ? k.attachedTo : graph.aliasFor(b.path) ?? b.path;
      rules.push(`  via    ${where}: must ${k.text}  [${k.mode} ${k.id}]`);
    }
  }
  const decisions = ctx.byImport
    .flatMap((b) => b.decisions.map((d) => ({ d, name: graph.aliasFor(b.path) ?? b.path })))
    .sort((a, b) => graph.newestFirst(a.d, b.d))
    .map(({ d, name }) => `  via    ${name}: decided ${d.text}  (${d.id})`);
  const lines = [...rules.slice(0, maxRules), ...decisions.slice(0, maxDecisions)];
  const hidden = Math.max(0, rules.length - maxRules) + Math.max(0, decisions.length - maxDecisions);
  if (hidden) lines.push(`  via    and ${hidden} more from what it imports: ctx hydrate <file>`);
  return ['from what it imports', ...lines].join('\n');
}
