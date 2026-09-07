import type { Graph } from '../graph/graph.js';
import { isActiveMode, splitSymbol, type DRecord, type KRecord } from '../graph/records.js';

export interface WalkOptions {
  symbol?: string;
  maxDecisions?: number;
}

export interface WalkResult {
  path: string;
  symbol?: string;
  /** Logical chain from the file's module upward. Empty when no mapping covers the path. */
  chain: string[];
  concepts: string[];
  /** Ordered most specific first: path#symbol, path, chain, concepts. Constraints keep this order within a mode. */
  constraints: KRecord[];
  decisions: DRecord[];
  /** Every node id consulted, in order. The reproducible "applicable set" for coverage. */
  nodes: string[];
  /** Ids of everything that applies: nodes, constraint ids, decision ids. */
  applicable: string[];
  mapped: boolean;
}

/**
 * Resolve a repository-relative path to its applicable context (design spec §7.1).
 * Deterministic: the same graph and path always give the same result.
 */
export function walk(graph: Graph, pathIn: string, opts: WalkOptions = {}): WalkResult {
  const resolved = graph.resolve(pathIn);
  const { path, symbol: inlineSymbol } = splitSymbol(resolved);
  const symbol = opts.symbol ?? inlineSymbol;

  const mapping = graph.mapPath(path);
  const chain: string[] = [];
  if (mapping) {
    const queue = [mapping.logical];
    const seen = new Set<string>();
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      chain.push(n);
      queue.push(...graph.parentsOf(n));
    }
  }

  const concepts: string[] = [];
  for (const n of chain) for (const c of graph.conceptsOf(n)) if (!concepts.includes(c)) concepts.push(c);

  const nodes: string[] = [];
  if (symbol) nodes.push(`${path}#${symbol}`);
  nodes.push(path, ...chain, ...concepts);

  const constraints: KRecord[] = [];
  for (const n of nodes) constraints.push(...graph.constraintsOn(n));

  const decisions = graph.decisionsOn(nodes).slice(0, opts.maxDecisions ?? 4);

  const applicable = [...nodes, ...constraints.map((k) => k.id), ...decisions.map((d) => d.id)];

  const result: WalkResult = { path, chain, concepts, constraints, decisions, nodes, applicable, mapped: Boolean(mapping) };
  if (symbol) result.symbol = symbol;
  return result;
}

/** Whether an edit to this node demands a decision: at least one enforced or guided constraint applies. */
export function demandsDecision(w: WalkResult): boolean {
  return w.constraints.some(isActiveMode);
}
