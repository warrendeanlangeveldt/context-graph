import type { RepoContext } from '../core/context.js';
import type { Finding, Graph } from '../graph/graph.js';
import type { KRecord } from '../graph/records.js';
import { loadOrBuildImportIndex, type ImportIndex } from '../index/imports.js';

/**
 * Conformance (design spec §16.2). Constraints that carry a machine-checkable `rule:` are
 * evaluated against the import graph, so a rule the code already breaks is never ratified
 * without its violations being recorded as legacy decisions.
 *
 *   noimport:<A>:<B>     files mapped to A (or its descendants) never import files mapped to B (or its descendants)
 *   public-entry:<A>     imports into A from outside A target an index file
 */
export interface Violation { rule: string; constraint: string; from: string; to: string; detail: string }

/** Test files exercise the seams on purpose; a layering rule is about runtime code unless it says `+tests`. */
const TEST_FILE = /(\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?|(^|\/)__tests__\/|(^|\/)tests?\/)/;

export function violationsFor(graph: Graph, k: KRecord, index: ImportIndex): Violation[] {
  if (!k.rule) return [];
  const includeTests = k.rule.endsWith('+tests');
  const [kind, ...args] = k.rule.replace(/\+tests$/, '').split(':');
  const skip = (file: string): boolean => !includeTests && TEST_FILE.test(file);
  const under = (file: string, logical: string): boolean => {
    const m = graph.mapPath(file);
    if (!m) return false;
    let cur: string[] = [m.logical];
    const seen = new Set<string>();
    while (cur.length) {
      const n = cur.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      if (n === logical) return true;
      cur.push(...graph.parentsOf(n));
    }
    return false;
  };
  const out: Violation[] = [];
  if (kind === 'noimport') {
    const a = args.slice(0, args.length / 2).join(':');
    const b = args.slice(args.length / 2).join(':');
    for (const [from, targets] of Object.entries(index.imports)) {
      if (skip(from) || !under(from, a)) continue;
      for (const t of targets) if (under(t, b)) out.push({ rule: k.rule, constraint: k.id, from, to: t, detail: `${from} imports ${t}` });
    }
  } else if (kind === 'public-entry') {
    const a = args.join(':');
    for (const [from, targets] of Object.entries(index.imports)) {
      if (skip(from) || under(from, a)) continue;
      for (const t of targets) {
        if (!under(t, a)) continue;
        if (/(^|\/)index\.[cm]?[jt]sx?$/.test(t)) continue;
        out.push({ rule: k.rule, constraint: k.id, from, to: t, detail: `${from} imports ${t} past the public entry` });
      }
    }
  }
  return out;
}

export function conformanceReport(ctx: RepoContext, opts: { includeProposed?: boolean } = {}): Map<string, Violation[]> {
  const g = ctx.graph;
  const out = new Map<string, Violation[]>();
  if (!g) return out;
  const index = loadOrBuildImportIndex(ctx.root);
  for (const k of g.constraints.values()) {
    if (!k.rule || g.isRetired(k.id)) continue;
    if (k.mode === 'G?' && !opts.includeProposed) continue;
    out.set(k.id, violationsFor(g, k, index));
  }
  return out;
}

export function conformanceFindings(ctx: RepoContext): Finding[] {
  const findings: Finding[] = [];
  for (const [id, vs] of conformanceReport(ctx)) {
    const g = ctx.graph!;
    const legacy = new Set([...g.decisions.values()].filter((d) => d.overrides === id && /^legacy:/.test(d.text) && g.isActiveDecision(d)).map((d) => d.node));
    for (const v of vs) if (!legacy.has(v.from)) findings.push({ level: 'warn', rule: 'conformance', message: `${id}: ${v.detail}` });
  }
  return findings;
}
