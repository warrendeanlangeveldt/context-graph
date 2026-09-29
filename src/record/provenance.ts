import { relative } from 'node:path';
import type { Graph } from '../graph/graph.js';
import type { DRecord } from '../graph/records.js';
import { git } from '../util/git.js';

/**
 * Commit provenance (design spec §9.4). A decision is recorded with `sha` of `-` and the file is never
 * rewritten afterwards: the commit that carries a decision is the commit that added its line, which git
 * already knows. Resolving it at read time (`git blame`) instead of rewriting after each commit keeps the
 * working tree clean, so a commit is the end of the work and not the start of another change.
 */
export interface ProvenanceResult { sha: string; linked: string[]; skipped: string[] }

/** The commit that added each decision line still carrying `-`, by decision id. Uncommitted lines are absent. */
export function resolveProvenance(graph: Graph, root: string): Map<string, string> {
  const out = new Map<string, string>();
  const file = relative(root, graph.decisionsFile).split('\\').join('/');
  if (file.startsWith('..')) return out; // a linked graph outside the repository has no history here
  const blame = git(root, ['blame', '--porcelain', '--', file]);
  if (!blame) return out;
  const shaAtLine = new Map<number, string>();
  for (const line of blame.split('\n')) {
    const m = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (m && !/^0+$/.test(m[1]!)) shaAtLine.set(Number(m[2]), m[1]!.slice(0, 8));
  }
  for (const d of graph.decisions.values()) {
    if (d.sha !== '-' || d.file !== graph.decisionsFile || !d.line) continue;
    const sha = shaAtLine.get(d.line);
    if (sha) out.set(d.id, sha);
  }
  return out;
}

/** The commit a decision arrived in, or `-` while it is not yet committed. */
export function commitOf(graph: Graph, root: string, d: DRecord): string {
  if (d.sha !== '-') return d.sha;
  return graph.provenance(() => resolveProvenance(graph, root)).get(d.id) ?? '-';
}

/**
 * What `ctx provenance` reports: which of this branch's decisions are committed, and in which commit.
 * Read-only; kept so older post-commit hooks that still call it do no harm.
 */
export function linkProvenance(graph: Graph, root: string, opts: { branch?: string } = {}): ProvenanceResult {
  const branch = opts.branch ?? git(root, ['branch', '--show-current']) ?? '';
  const resolved = resolveProvenance(graph, root);
  const linked: string[] = [];
  const skipped: string[] = [];
  for (const d of graph.decisions.values()) {
    if (d.sha !== '-' || (branch && d.branch !== branch)) continue;
    (resolved.has(d.id) ? linked : skipped).push(d.id);
  }
  const sha = (git(root, ['rev-parse', '--short', 'HEAD']) ?? '').slice(0, 8);
  return { sha, linked, skipped };
}
