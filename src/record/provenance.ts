import { readFileSync, writeFileSync } from 'node:fs';
import type { Graph } from '../graph/graph.js';
import { isPathId, splitSymbol } from '../graph/records.js';
import { git } from '../util/git.js';

/**
 * Commit provenance (design spec §9.4). Decisions are recorded with `sha` of `-`. After a commit,
 * every provisional decision on this branch whose node was changed by that commit gets the SHA.
 * A decision on a logical node is linked when any file mapped to it changed.
 */
export interface ProvenanceResult { sha: string; linked: string[]; skipped: string[] }

export function linkProvenance(graph: Graph, root: string, opts: { sha?: string; branch?: string } = {}): ProvenanceResult {
  const sha = (opts.sha ?? git(root, ['rev-parse', '--short', 'HEAD']) ?? '').slice(0, 8);
  if (!sha) throw new Error('no commit to link: not a git repository or no HEAD');
  const changed = new Set((git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]) ?? '').split('\n').filter(Boolean));
  const branch = opts.branch ?? git(root, ['branch', '--show-current']) ?? '';
  const linked: string[] = [];
  const skipped: string[] = [];

  const touchesNode = (node: string): boolean => {
    if (isPathId(node)) return changed.has(splitSymbol(node).path);
    for (const f of changed) {
      const m = graph.mapPath(f);
      if (!m) continue;
      if (m.logical === node) return true;
      let cur: string[] = graph.parentsOf(m.logical);
      const seen = new Set<string>();
      while (cur.length) {
        const n = cur.shift()!;
        if (seen.has(n)) continue;
        seen.add(n);
        if (n === node) return true;
        cur.push(...graph.parentsOf(n));
      }
    }
    return false;
  };

  const file = graph.decisionsFile;
  const lines = readFileSync(file, 'utf8').split('\n');
  const out = lines.map((line) => {
    const m = /^D (\S+) (\S+) (\S+) - (\S+) (\S+) (.*)$/.exec(line);
    if (!m) return line;
    const [, id, date, who, dBranch, node, rest] = m as unknown as [string, string, string, string, string, string, string];
    if (branch && dBranch !== branch) { skipped.push(id); return line; }
    if (!touchesNode(node)) { skipped.push(id); return line; }
    linked.push(id);
    return `D ${id} ${date} ${who} ${sha} ${dBranch} ${node} ${rest}`;
  });
  if (linked.length) writeFileSync(file, out.join('\n'), 'utf8');
  return { sha, linked, skipped };
}
