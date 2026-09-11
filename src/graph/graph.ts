import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import { parseText } from './parse.js';
import {
  isConceptId, isLogicalId, isPathId, splitSymbol,
  type ARecord, type CRecord, type DRecord, type ERecord, type GraphRecord, type KRecord, type LRecord,
  type MRecord, type SRecord, type ZRecord,
} from './records.js';
import { toAbsolute } from '../util/paths.js';

export interface Finding {
  level: 'error' | 'warn';
  rule: string;
  message: string;
  file?: string;
  line?: number;
}

export const GRAPH_FILE = 'graph.ctx';
export const DECISIONS_FILE = 'decisions.ctx';
export const ALIASES_FILE = 'aliases.ctx';
export const PROPOSALS_FILE = 'proposals.ctx';

/**
 * The active set of a repository's graph. Loads `graph.ctx`, `decisions.ctx`, `aliases.ctx`,
 * and `proposals.ctx` from one directory. The archive is never read here; the walker only ever
 * sees what this class exposes (design spec §21.1).
 */
export class Graph {
  readonly mappings: MRecord[] = [];
  readonly logicals = new Map<string, LRecord>();
  readonly concepts = new Map<string, CRecord>();
  readonly edges: ERecord[] = [];
  readonly constraints = new Map<string, KRecord>();
  readonly decisions = new Map<string, DRecord>();
  readonly supersessions: SRecord[] = [];
  readonly retirements: ZRecord[] = [];
  readonly aliases = new Map<string, ARecord>();
  readonly superseded = new Set<string>();
  readonly retired = new Map<string, ZRecord>();
  readonly loadFindings: Finding[] = [];

  private matchers: { rec: MRecord; match: (p: string) => boolean }[] = [];
  private aliasByNode = new Map<string, string>();

  private constructor(readonly dir: string) {}

  static load(dir: string): Graph {
    const g = new Graph(dir);
    const graphFile = join(dir, GRAPH_FILE);
    if (!existsSync(graphFile)) throw new Error(`no ${GRAPH_FILE} in ${dir}`);
    g.ingest(parseText(readFileSync(graphFile, 'utf8'), graphFile));
    for (const name of [DECISIONS_FILE, ALIASES_FILE, PROPOSALS_FILE]) {
      const f = join(dir, name);
      if (existsSync(f)) g.ingest(parseText(readFileSync(f, 'utf8'), f));
    }
    g.finalise();
    return g;
  }

  /** Build from records in memory, for tests and tooling. */
  static fromRecords(records: GraphRecord[], dir = '<memory>'): Graph {
    const g = new Graph(dir);
    g.ingest(records);
    g.finalise();
    return g;
  }

  get decisionsFile(): string { return join(this.dir, DECISIONS_FILE); }
  get proposalsFile(): string { return join(this.dir, PROPOSALS_FILE); }

  private ingest(records: GraphRecord[]): void {
    for (const r of records) {
      switch (r.kind) {
        case 'M': this.mappings.push(r); break;
        case 'L': this.logicals.set(r.id, r); break;
        case 'C': this.concepts.set(r.id, r); break;
        case 'E': this.edges.push(r); break;
        case 'K':
          if (this.constraints.has(r.id)) this.loadFindings.push({ level: 'error', rule: 'unique-id', message: `duplicate constraint id ${r.id}`, ...loc(r) });
          this.constraints.set(r.id, r);
          break;
        case 'D':
          if (this.decisions.has(r.id)) this.loadFindings.push({ level: 'error', rule: 'unique-id', message: `duplicate decision id ${r.id}`, ...loc(r) });
          this.decisions.set(r.id, r);
          break;
        case 'S': this.supersessions.push(r); break;
        case 'Z': this.retirements.push(r); break;
        case 'A':
          if (this.aliases.has(r.alias)) this.loadFindings.push({ level: 'error', rule: 'alias-unique', message: `duplicate alias ${r.alias}`, ...loc(r) });
          this.aliases.set(r.alias, r);
          break;
        case 'R': break;
      }
    }
  }

  private finalise(): void {
    this.matchers = this.mappings.map((rec) => ({ rec, match: picomatch(rec.glob, { dot: true }) }));
    for (const s of this.supersessions) this.superseded.add(s.oldId);
    for (const z of this.retirements) this.retired.set(z.target, z);
    for (const a of this.aliases.values()) this.aliasByNode.set(a.node, a.alias);
  }

  // ---- lookups -------------------------------------------------------------

  /** Alias to node id; anything else passes through. */
  resolve(id: string): string {
    return this.aliases.get(id)?.node ?? id;
  }

  aliasFor(node: string): string | undefined {
    return this.aliasByNode.get(node);
  }

  /** First mapping whose glob matches the repository-relative path. */
  mapPath(path: string): MRecord | undefined {
    const { path: p } = splitSymbol(path);
    return this.matchers.find((m) => m.match(p))?.rec;
  }

  parentsOf(node: string): string[] {
    return this.edges.filter((e) => e.rel === 'in' && e.from === node && !e.proposed).map((e) => e.to);
  }

  conceptsOf(node: string): string[] {
    return this.edges.filter((e) => e.rel === 'impl' && e.from === node && !e.proposed).map((e) => e.to);
  }

  isRetired(id: string): boolean {
    return this.retired.has(id);
  }

  /** Constraints attached to exactly this node, unretired. */
  constraintsOn(node: string): KRecord[] {
    const out: KRecord[] = [];
    for (const k of this.constraints.values()) {
      if (k.attachedTo === node && !this.retired.has(k.id)) out.push(k);
    }
    return out;
  }

  activeConstraint(id: string): KRecord | undefined {
    const k = this.constraints.get(id);
    return k && !this.retired.has(id) ? k : undefined;
  }

  nodeExists(id: string): boolean {
    if (isLogicalId(id)) return this.logicals.has(id);
    if (isConceptId(id)) return this.concepts.has(id);
    return true; // paths are validated against the tree by validate(root)
  }

  /** Whether an id names a constraint or a concept that a decision may point at. */
  targetExists(id: string): boolean {
    return this.constraints.has(id) || this.concepts.has(id);
  }

  /** A decision is active when it is not superseded and its basis still resolves. */
  isActiveDecision(d: DRecord): boolean {
    if (this.superseded.has(d.id)) return false;
    const z = this.retired.get(d.serves);
    if (z && !z.succ) return false;
    return true;
  }

  /** Active decisions on any of the given nodes, newest first. */
  decisionsOn(nodes: string[]): DRecord[] {
    const set = new Set(nodes);
    const out: DRecord[] = [];
    for (const d of this.decisions.values()) {
      if (set.has(d.node) && this.isActiveDecision(d)) out.push(d);
    }
    return out.sort((a, b) => (a.date === b.date ? compareIds(b.id, a.id) : b.date.localeCompare(a.date)));
  }

  /** Decisions that serve or override a constraint or concept, newest first. The "why" of a rule is here,
   * not on the rule's own node: a decision is recorded against the file or module it changed. */
  decisionsFor(id: string, opts: { includeSuperseded?: boolean } = {}): DRecord[] {
    return [...this.decisions.values()]
      .filter((d) => (d.serves === id || d.overrides === id) && (opts.includeSuperseded === true || this.isActiveDecision(d)))
      .sort((a, b) => (a.date === b.date ? compareIds(b.id, a.id) : b.date.localeCompare(a.date)));
  }

  allDecisionsOn(node: string): DRecord[] {
    return [...this.decisions.values()].filter((d) => d.node === node).sort((a, b) => compareIds(a.id, b.id));
  }

  nextDecisionId(): string {
    let max = 0;
    for (const id of this.decisions.keys()) {
      const m = /^d-(\d+)$/.exec(id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `d-${String(max + 1).padStart(4, '0')}`;
  }

  // ---- validation (design spec §6.2) ----------------------------------------

  validate(root?: string): Finding[] {
    const f: Finding[] = [...this.loadFindings];
    const known = (id: string): boolean => (isPathId(id) ? true : this.nodeExists(id));

    for (const e of this.edges) {
      if (!known(e.from)) f.push({ level: 'error', rule: 'edge-endpoint', message: `edge from unknown node ${e.from}`, ...loc(e) });
      if (!known(e.to)) f.push({ level: 'error', rule: 'edge-endpoint', message: `edge to unknown node ${e.to}`, ...loc(e) });
    }
    for (const k of this.constraints.values()) {
      if (!known(k.attachedTo)) f.push({ level: 'error', rule: 'attach', message: `constraint ${k.id} attached to unknown node ${k.attachedTo}`, ...loc(k) });
      if (k.mode === 'E') {
        if (!k.test) f.push({ level: 'error', rule: 'enforced-test', message: `enforced constraint ${k.id} has no test:`, ...loc(k) });
        else if (root && !existsSync(toAbsolute(root, k.test))) f.push({ level: 'error', rule: 'enforced-test', message: `test for ${k.id} not found: ${k.test}`, ...loc(k) });
      }
      if (isPathId(k.attachedTo) && !this.mapPath(k.attachedTo)) f.push({ level: 'error', rule: 'mapping-cover', message: `no mapping covers ${k.attachedTo} (constraint ${k.id})`, ...loc(k) });
    }
    for (const d of this.decisions.values()) {
      if (!this.targetExists(d.serves)) f.push({ level: 'error', rule: 'arrow-target', message: `decision ${d.id} -> ${d.serves} does not exist`, ...loc(d) });
      if (d.overrides && !this.constraints.has(d.overrides)) f.push({ level: 'error', rule: 'override-target', message: `decision ${d.id} !${d.overrides} does not exist`, ...loc(d) });
      if (d.overrides && this.constraints.get(d.overrides)?.mode === 'E') f.push({ level: 'error', rule: 'override-enforced', message: `decision ${d.id} overrides enforced constraint ${d.overrides}; change the test instead`, ...loc(d) });
      if (!known(d.node)) f.push({ level: 'error', rule: 'attach', message: `decision ${d.id} on unknown node ${d.node}`, ...loc(d) });
      if (isPathId(d.node) && !this.mapPath(d.node)) f.push({ level: 'error', rule: 'mapping-cover', message: `no mapping covers ${splitSymbol(d.node).path} (decision ${d.id})`, ...loc(d) });
      const z = this.retired.get(d.serves);
      if (z && !z.succ && !this.superseded.has(d.id)) f.push({ level: 'warn', rule: 'orphaned-basis', message: `decision ${d.id} points at retired ${d.serves} with no successor`, ...loc(d) });
      if (root && isPathId(d.node) && !existsSync(toAbsolute(root, splitSymbol(d.node).path))) f.push({ level: 'warn', rule: 'deleted-path', message: `decision ${d.id} is on a path that does not exist: ${d.node}`, ...loc(d) });
    }
    const seenOld = new Set<string>();
    for (const s of this.supersessions) {
      if (!this.decisions.has(s.newId)) f.push({ level: 'error', rule: 'supersession', message: `S names unknown decision ${s.newId}`, ...loc(s) });
      if (!this.decisions.has(s.oldId)) f.push({ level: 'error', rule: 'supersession', message: `S names unknown decision ${s.oldId}`, ...loc(s) });
      if (seenOld.has(s.oldId)) f.push({ level: 'error', rule: 'double-supersession', message: `${s.oldId} is superseded twice`, ...loc(s) });
      seenOld.add(s.oldId);
    }
    for (const z of this.retirements) {
      if (!this.targetExists(z.target)) f.push({ level: 'error', rule: 'retire-target', message: `Z names unknown ${z.target}`, ...loc(z) });
      if (z.succ && !this.targetExists(z.succ)) f.push({ level: 'error', rule: 'retire-succ', message: `Z successor ${z.succ} does not exist`, ...loc(z) });
    }
    for (const a of this.aliases.values()) {
      if (!known(a.node)) f.push({ level: 'error', rule: 'alias-target', message: `alias ${a.alias} points at unknown node ${a.node}`, ...loc(a) });
      if (root && isPathId(a.node) && !existsSync(toAbsolute(root, a.node))) f.push({ level: 'warn', rule: 'alias-target', message: `alias ${a.alias} points at a path that does not exist: ${a.node}`, ...loc(a) });
    }
    for (const m of this.mappings) {
      if (!this.logicals.has(m.logical)) f.push({ level: 'error', rule: 'mapping-target', message: `mapping ${m.glob} names unknown ${m.logical}`, ...loc(m) });
    }
    return f;
  }
}

function loc(r: { file?: string; line: number }): { file?: string; line?: number } {
  const out: { file?: string; line?: number } = {};
  if (r.file) out.file = r.file;
  if (r.line) out.line = r.line;
  return out;
}

function compareIds(a: string, b: string): number {
  const na = Number(/\d+/.exec(a)?.[0] ?? 0);
  const nb = Number(/\d+/.exec(b)?.[0] ?? 0);
  return na - nb || a.localeCompare(b);
}
