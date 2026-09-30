import type { Graph } from '../graph/graph.js';
import { isActiveMode, type DRecord, type KRecord } from '../graph/records.js';
import { walk } from './walk.js';

/**
 * Context that reaches a file through what it imports (design spec §7.4). The walk follows containment:
 * a file sees the rules of its own module and the modules above it. But a rule is often obeyed somewhere
 * other than where it is written down: the rule about what an event must carry is attached to the module
 * that defines events, and broken in the service that records them. So before an edit, each file the
 * edited file imports contributes its own decisions, and the ratified rules of its module that the
 * edited file does not already see. One hop; rules before decisions; bounded.
 */
export interface DependencyContext {
  /** Imported file -> what it contributes. Only imports that carry something appear. */
  byImport: { path: string; rules: KRecord[]; decisions: DRecord[] }[];
}

export function dependencyContext(graph: Graph, path: string, imports: string[], opts: { maxDecisionsPerImport?: number } = {}): DependencyContext {
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
    const decisions = graph.decisionsOn([imp]).filter((d) => !d.node.includes('#') || d.node.startsWith(`${imp}#`)).slice(0, opts.maxDecisionsPerImport ?? 2);
    if (rules.length || decisions.length) byImport.push({ path: imp, rules, decisions });
  }
  return { byImport };
}

/** Whether an import carries context an edit must not skip: its own decisions, or rules the edited file does not see. */
export function carriesContext(ctx: DependencyContext, imp: string): boolean {
  return ctx.byImport.some((b) => b.path === imp);
}

/** The lines added under the slice. At most `maxLines`, rules first, so the budget never hides a rule for a decision. */
export function renderDependencyContext(graph: Graph, ctx: DependencyContext, opts: { maxLines?: number } = {}): string | undefined {
  if (!ctx.byImport.length) return undefined;
  const max = opts.maxLines ?? 6;
  const rules: string[] = [];
  const decisions: string[] = [];
  for (const b of ctx.byImport) {
    const name = graph.aliasFor(b.path) ?? b.path;
    for (const k of b.rules) rules.push(`  via    ${name}: must ${k.text}  [${k.mode} ${k.id}]`);
    for (const d of b.decisions) decisions.push(`  via    ${name}: decided ${d.text}  (${d.id})`);
  }
  const lines = [...rules, ...decisions];
  const shown = lines.slice(0, max);
  if (lines.length > shown.length) shown.push(`  via    and ${lines.length - shown.length} more from what it imports: ctx hydrate <file>`);
  return ['from what it imports', ...shown].join('\n');
}
