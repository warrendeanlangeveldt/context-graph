import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { DECISIONS_FILE, GRAPH_FILE, Graph, PROPOSALS_FILE } from '../graph/graph.js';
import { parseLine } from '../graph/parse.js';
import type { DRecord, GraphRecord } from '../graph/records.js';
import { appendRecord, formatRecord } from '../graph/write.js';
import { loadOrBuildImportIndex } from '../index/imports.js';
import { gitPerson } from '../util/git.js';
import { violationsFor } from './conformance.js';

/**
 * Ratification (design spec §11.4 and §16.2). A proposed record becomes active: `G?` becomes
 * `G`, or `E` when it names a test; proposed concepts and edges lose their flag. Records living in
 * proposals.ctx move into graph.ctx. For a checkable constraint with current violations, each
 * violation becomes a legacy decision on the offending file so the walker tells the next agent
 * it is a known exception. The commit that carries a ratified concept or enforced constraint
 * needs the trailer the merge gate checks; it is printed for the caller.
 */
export interface RatifyResult { ratified: string[]; missing: string[]; legacy: DRecord[]; trailer: string }

export function ratify(ctx: RepoContext, ids: string[], opts: { all?: boolean; today?: string } = {}): RatifyResult {
  const dir = ctx.graphDir;
  if (!dir || !ctx.graph) throw new Error('no graph to ratify in');
  const graphFile = join(dir, GRAPH_FILE);
  const proposalsFile = join(dir, PROPOSALS_FILE);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const wanted = new Set(ids);
  const ratified: string[] = [];
  const legacy: DRecord[] = [];
  const index = loadOrBuildImportIndex(ctx.root);
  const graph = ctx.graph;

  const process = (lines: string[], file: string): { kept: string[]; moved: string[] } => {
    const kept: string[] = [];
    const moved: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      let rec: GraphRecord | null = null;
      try { rec = parseLine(raw, i + 1, file); } catch { kept.push(raw); continue; }
      if (!rec) { kept.push(raw); continue; }
      const key = keyOf(rec);
      const isProposed = (rec.kind === 'K' && rec.mode === 'G?') || ((rec.kind === 'C' || rec.kind === 'E') && rec.proposed === true);
      if (!isProposed || !(opts.all || (key && wanted.has(key)))) { kept.push(raw); continue; }
      let out: GraphRecord = rec;
      if (rec.kind === 'K') {
        out = { ...rec, mode: rec.test ? 'E' : 'G' };
        delete (out as { since?: string }).since;
        if (rec.rule) {
          for (const v of violationsFor(graph, rec, index)) {
            const d: DRecord = { kind: 'D', id: graph.nextDecisionId(), date: today, who: `${gitPerson(ctx.root)}/human`, sha: '-', branch: 'ratify', node: v.from, serves: rec.id, overrides: rec.id, text: `legacy: predates ${rec.id}; ${v.detail}`, line: 0 };
            graph.addDecision(d);
            legacy.push(d);
          }
        }
      } else if (rec.kind === 'C') { out = { ...rec }; delete (out as { proposed?: boolean }).proposed; delete (out as { since?: string }).since; }
      else if (rec.kind === 'E') { out = { ...rec }; delete (out as { proposed?: boolean }).proposed; delete (out as { since?: string }).since; }
      ratified.push(key ?? raw);
      if (file === proposalsFile) moved.push(formatRecord(out)); else kept.push(formatRecord(out));
    }
    return { kept, moved };
  };

  const graphLines = readFileSync(graphFile, 'utf8').split('\n');
  const g = process(graphLines, graphFile);
  let additions: string[] = [];
  if (existsSync(proposalsFile)) {
    const p = process(readFileSync(proposalsFile, 'utf8').split('\n'), proposalsFile);
    additions = p.moved;
    writeFileSync(proposalsFile, p.kept.join('\n').replace(/\n+$/, '\n'), 'utf8');
  }
  const graphOut = [...g.kept];
  if (additions.length) graphOut.push(...additions);
  writeFileSync(graphFile, graphOut.join('\n').replace(/\n*$/, '\n'), 'utf8');
  for (const d of legacy) appendRecord(join(dir, DECISIONS_FILE), d);

  const missing = ids.filter((id) => !ratified.includes(id));
  const person = gitPerson(ctx.root);
  return { ratified, missing, legacy, trailer: `Ctx-Ratified-By: ${person}` };
}

function keyOf(r: GraphRecord): string | undefined {
  if (r.kind === 'K' || r.kind === 'C' || r.kind === 'L') return r.id;
  if (r.kind === 'E') return `${r.from} ${r.rel} ${r.to}`;
  return undefined;
}

export function reload(ctx: RepoContext): Graph {
  return Graph.load(ctx.graphDir!);
}
