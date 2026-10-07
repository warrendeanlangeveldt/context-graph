import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type { RepoContext } from '../core/context.js';
import { GRAPH_FILE, type Graph } from './graph.js';
import type { ERecord, LRecord, MRecord } from './records.js';
import { formatRecord } from './write.js';

/**
 * Giving a set of paths its own module: mapping lines, the module, and its containment edge, written
 * into graph.ctx. A path maps to the first mapping that matches it, so a new module's mappings go in
 * before any broader mapping that would otherwise claim its paths (`M ** L:repo`, a parent's glob).
 * Shared by `ctx module` and by `ctx init` on a graph that already names its modules.
 */

const MODULE_ID = /^L:[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A path inside every path `glob` matches: its literal directory, with a file name no one uses. */
export function probePath(glob: string): string {
  const literal = glob.split('/').filter((p) => p && !/[*?[\]{}!()]/.test(p));
  return [...literal, '__ctx_probe__.ts'].join('/');
}

/** The module a set of globs' files belong to now: the parent a new module for them would sit in. */
export function currentModule(g: Graph, globs: string[]): string | undefined {
  return g.mapPath(probePath(globs[0]!))?.logical;
}

export interface NewModule {
  id: string;
  name?: string | undefined;
  globs: string[];
  parent?: string | undefined;
  /** Whether the containment edge is agreed (a person's or the delegated ratifier's), or proposed. */
  agreed: boolean;
}

export interface ModuleResult {
  mappings: MRecord[];
  logical: LRecord | null;
  edge: ERecord | null;
}

/** Checks a new module against the graph; returns why it can't be added, or undefined. */
export function moduleProblem(g: Graph, m: NewModule): string | undefined {
  if (!MODULE_ID.test(m.id)) return `${m.id} isn't a module id: L: then letters, digits, dots, dashes and underscores.`;
  if (!m.globs.length) return 'Name the paths: --paths "<glob> [<glob>…]".';
  const mapped = new Set(g.mappings.map((x) => x.glob));
  const taken = m.globs.filter((x) => mapped.has(x));
  if (taken.length) return `${taken.join(', ')} ${taken.length === 1 ? 'is' : 'are'} already mapped (to ${g.mappings.find((x) => x.glob === taken[0])!.logical}).`;
  if (m.parent !== undefined && !g.logicals.has(m.parent)) return `${m.parent} isn't a module in the graph.`;
  if (m.parent === m.id) return 'A module can\'t sit in itself.';
  return undefined;
}

/**
 * Writes the module into graph.ctx: each mapping before the first existing mapping that would shadow it,
 * the module (when new) and its containment edge (when new and it has a parent) at the end.
 */
export function addModule(ctx: RepoContext, m: NewModule, today = new Date().toISOString().slice(0, 10)): ModuleResult {
  const g = ctx.graph!;
  const file = join(ctx.graphDir!, GRAPH_FILE);
  const lines = readFileSync(file, 'utf8').split('\n');
  const mappings: MRecord[] = m.globs.map((glob) => ({ kind: 'M', glob, logical: m.id, line: 0 }));
  // Insert before the first M line whose glob claims the new paths; with none, after the last M line.
  const isM = (l: string) => /^M\s/.test(l.trim());
  const shadows = (l: string, glob: string) => {
    const existing = l.trim().split(/\s+/)[1];
    return Boolean(existing) && picomatch(existing!, { dot: true })(probePath(glob));
  };
  let at = lines.findIndex((l) => isM(l) && m.globs.some((glob) => shadows(l, glob)));
  if (at < 0) {
    const last = lines.map((l, i) => (isM(l) ? i : -1)).filter((i) => i >= 0).pop();
    at = last === undefined ? lines.length : last + 1;
  }
  lines.splice(at, 0, ...mappings.map(formatRecord));
  const isNew = !g.logicals.has(m.id);
  const logical: LRecord | null = isNew ? { kind: 'L', id: m.id, name: m.name?.trim() || m.id.slice(2), line: 0 } : null;
  const edge: ERecord | null =
    isNew && m.parent ? { kind: 'E', from: m.id, rel: 'in', to: m.parent, line: 0, ...(m.agreed ? {} : { proposed: true, since: today }) } : null;
  const tail = [logical, edge].filter((r): r is LRecord | ERecord => r !== null).map(formatRecord);
  const body = lines.join('\n').replace(/\n*$/, '\n');
  writeFileSync(file, body + tail.map((l) => `${l}\n`).join(''), 'utf8');
  return { mappings, logical, edge };
}
