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
/**
 * Whether an edit here owes a decision. Enforced and guided rules ask; so do proposed ones, because a
 * decision that serves a proposal is the evidence that ratifies it, and one that overrides it is the
 * evidence that retires it. A freshly bootstrapped graph would otherwise never grow.
 */
export function demandsDecision(w: WalkResult, graph?: Pick<Graph, 'logicals' | 'mappings'>): boolean {
  // A test file owes nothing unless it is itself the test behind a rule; tests rarely embody a design decision.
  if (isTestPath(w.path) && !w.constraints.some((k) => k.test && k.test === w.path.split('#')[0])) return false;
  // A proposal pinned to the repository root applies to every file and is usually a bootstrap's guess at a
  // global convention; it earns evidence through ratification, not by taxing every edit. The root is the
  // module the catch-all mapping names, or the top of a chain of two or more when there is no catch-all.
  // In a one-module graph the root is the file's own module. A proposal on the file's own module asks.
  const catchAll = graph && graph.logicals.size > 1 ? graph.mappings.find((m) => m.glob === '**')?.logical : undefined;
  const root = catchAll ?? (w.chain.length > 1 ? w.chain[w.chain.length - 1] : undefined);
  return w.constraints.some((k) => isActiveMode(k) || (k.mode === 'G?' && k.attachedTo !== root));
}

export function isTestPath(p: string): boolean {
  return /\.(test|spec)\.[cm]?[jt]sx?$|(^|\/)(__tests__|tests?)\//.test(p.split('#')[0]!);
}
