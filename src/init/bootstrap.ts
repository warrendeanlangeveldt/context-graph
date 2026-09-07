import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import picomatch from 'picomatch';
import type { RepoContext } from '../core/context.js';
import type { Graph } from '../graph/graph.js';
import type { CRecord, ERecord, GraphRecord, KRecord, LRecord, MRecord } from '../graph/records.js';
import { buildImportIndex, type ImportIndex } from '../index/imports.js';
import { git } from '../util/git.js';

/**
 * Bootstrap (design spec §16). Derives a first graph from the tree so adoption does not begin
 * with a blank file. Everything it produces is a proposal: logical nodes and mappings from the
 * directory structure, dependency edges from the import graph, constraints from architecture
 * tests and instruction files, concepts from ADRs. Idempotent: re-running proposes only additions.
 */
export interface BootstrapOptions {
  minFiles?: number;
  maxDepth?: number;
  maxModules?: number;
  today?: string;
}

export interface BootstrapResult {
  mappings: MRecord[];
  logicals: LRecord[];
  edges: ERecord[];
  concepts: CRecord[];
  constraints: KRecord[];
  notes: string[];
  files: string[];
  index: ImportIndex;
}

const CODE_EXT = /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|py|go|rs|java|kt|cs|rb|php|swift)$/;
const NOISE_DIRS = new Set(['node_modules', 'dist', 'build', 'out', '.git', 'coverage', '__pycache__', '.next', 'vendor', 'target', 'bin', 'obj', 'test', 'tests', '__tests__', 'spec', 'fixtures', 'generated']);
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'CONTRIBUTING.md', 'GEMINI.md', '.github/copilot-instructions.md'];
const IMPERATIVE = /\b(never|do not|don't|must|always|only|no\s+\w+|required|forbidden|not allowed)\b/i;

export function bootstrap(ctx: RepoContext, opts: BootstrapOptions = {}): BootstrapResult {
  const root = ctx.root;
  const minFiles = opts.minFiles ?? 5;
  const maxDepth = opts.maxDepth ?? 7;
  const maxModules = opts.maxModules ?? 60;
  const today = opts.today ?? isoToday();
  const notes: string[] = [];
  const files = (git(root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
  if (!files.length) throw new Error(`git ls-files returned nothing for ${root}; commit something first`);

  // 1. Directory tree of source files -> modules.
  const counts = new Map<string, number>();
  const direct = new Map<string, number>();
  for (const f of files) {
    if (!CODE_EXT.test(f)) continue;
    const parts = f.split('/');
    if (parts.some((p) => NOISE_DIRS.has(p))) continue;
    direct.set(dirname(f), (direct.get(dirname(f)) ?? 0) + 1);
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  let candidates = [...counts.entries()]
    .filter(([dir, n]) => n >= minFiles && dir.split('/').length <= maxDepth)
    .map(([dir, n]) => ({ dir, n }));
  // Collapse single-child chains: a directory whose only content is one child directory is not a module.
  candidates = candidates.filter((c) => {
    const children = candidates.filter((o) => dirname(o.dir) === c.dir);
    return !(children.length === 1 && (direct.get(c.dir) ?? 0) === 0 && children[0]!.n === c.n);
  });
  if (candidates.length > maxModules) {
    const keep = new Set(candidates.sort((a, b) => b.n - a.n).slice(0, maxModules).map((c) => c.dir));
    for (const c of [...keep]) { let d = dirname(c); while (d && d !== '.') { if (candidates.some((x) => x.dir === d)) keep.add(d); d = dirname(d); } }
    candidates = candidates.filter((c) => keep.has(c.dir));
    notes.push(`kept the ${keep.size} largest modules of ${counts.size} candidate directories; raise --max-modules to see more`);
  }
  candidates.sort((a, b) => b.dir.split('/').length - a.dir.split('/').length || a.dir.localeCompare(b.dir));

  const ids = new Map<string, string>();
  const used = new Set<string>();
  const mappings: MRecord[] = [];
  const logicals: LRecord[] = [];
  const idFor = (dir: string): string => {
    const parts = dir.split('/');
    let id = `L:${slug(parts[parts.length - 1]!)}`;
    for (let i = parts.length - 2; used.has(id) && i >= 0; i--) id = `L:${slug(parts[i]!)}-${id.slice(2)}`;
    used.add(id);
    return id;
  };
  for (const c of candidates) {
    const id = idFor(c.dir);
    ids.set(c.dir, id);
    mappings.push({ kind: 'M', glob: `${c.dir}/**`, logical: id, line: 0 });
    logicals.push({ kind: 'L', id, name: `${basename(c.dir)} (${c.n} source files)`, line: 0 });
  }
  const rootId = 'L:repo';
  logicals.push({ kind: 'L', id: rootId, name: `${basename(root)} repository`, line: 0 });
  mappings.push({ kind: 'M', glob: '**', logical: rootId, line: 0 });

  const edges: ERecord[] = [];
  const parentOf = (dir: string): string => {
    let d = dirname(dir);
    while (d && d !== '.') { const p = ids.get(d); if (p) return p; d = dirname(d); }
    return rootId;
  };
  for (const c of candidates) edges.push({ kind: 'E', from: ids.get(c.dir)!, rel: 'in', to: parentOf(c.dir), line: 0 });

  // 2. Import graph -> dependency edges between modules.
  const index = buildImportIndex(root);
  const moduleOf = (f: string): string | undefined => {
    let d = dirname(f);
    while (d && d !== '.') { const m = ids.get(d); if (m) return m; d = dirname(d); }
    return undefined;
  };
  const depCounts = new Map<string, number>();
  for (const [from, targets] of Object.entries(index.imports)) {
    const a = moduleOf(from);
    if (!a) continue;
    for (const t of targets) {
      const b = moduleOf(t);
      if (!b || a === b || isAncestor(edges, a, b) || isAncestor(edges, b, a)) continue;
      depCounts.set(`${a}\t${b}`, (depCounts.get(`${a}\t${b}`) ?? 0) + 1);
    }
  }
  for (const [key, n] of [...depCounts.entries()].sort((x, y) => y[1] - x[1])) {
    if (n < 3) continue;
    const [a, b] = key.split('\t') as [string, string];
    edges.push({ kind: 'E', from: a, rel: 'dep', to: b, proposed: true, since: today, line: 0 });
  }

  // 3. Architecture tests -> proposed constraints with test: set.
  const constraints: KRecord[] = [];
  for (const f of files) {
    if (!/(boundary|architecture|layering|dependenc|arch-|-arch)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i.test(f)) continue;
    const src = safeRead(join(root, f));
    if (!src) continue;
    const node = moduleOf(f) ?? rootId;
    const names = [...src.matchAll(/\b(?:it|test)\(\s*['"`]([^'"`]{8,160})['"`]/g)].map((m) => m[1]!);
    if (!names.length) names.push(`rules enforced by ${basename(f)}`);
    for (const n of names.slice(0, 12)) {
      constraints.push({ kind: 'K', mode: 'G?', id: `arch.${slug(n).slice(0, 48)}`, attachedTo: node, text: n.replace(/\s+/g, ' '), test: f, since: today, line: 0 });
    }
  }

  // 4. Instruction files -> proposed guided constraints, each quoting its source line.
  // Several names often point at one file through symlinks; propose from each real file once.
  const seenReal = new Set<string>();
  const instructionFiles = files.filter((f) => INSTRUCTION_FILES.includes(basename(f)) || INSTRUCTION_FILES.includes(f)).filter((f) => {
    let real = f;
    try { real = realpathSync(join(root, f)); } catch { /* keep the path itself */ }
    if (seenReal.has(real)) { notes.push(`${f}: same file as one already scanned; skipped`); return false; }
    seenReal.add(real);
    return true;
  });
  for (const f of instructionFiles) {
    const src = safeRead(join(root, f));
    if (!src) continue;
    const node = moduleOf(f) ?? (f.includes('/') ? moduleOfDir(ids, dirname(f)) ?? rootId : rootId);
    let n = 0;
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length && n < 40; i++) {
      const raw = lines[i]!.replace(/^[\s>*-]+/, '').replace(/\*\*/g, '').trim();
      if (raw.length < 24 || raw.length > 220 || raw.startsWith('#') || raw.startsWith('```') || raw.startsWith('|')) continue;
      if (!IMPERATIVE.test(raw)) continue;
      n++;
      constraints.push({ kind: 'K', mode: 'G?', id: `agent.${slug(raw).slice(0, 40)}-${i + 1}`, attachedTo: node, text: `[${f}:${i + 1}] ${raw}`, since: today, line: 0 });
    }
    if (n) notes.push(`${f}: ${n} imperative line(s) proposed as guided constraints`);
  }

  // 5. ADRs -> proposed concepts.
  const concepts: CRecord[] = [];
  for (const f of files) {
    if (!/(^|\/)(adr|adrs|decisions|decision-records)\/[^/]*\.md$/i.test(f)) continue;
    if (/template|readme|index/i.test(basename(f))) continue;
    const src = safeRead(join(root, f));
    if (!src) continue;
    const num = /(\d{3,5})/.exec(basename(f))?.[1];
    const title = (/^#\s+(.+)$/m.exec(src)?.[1] ?? basename(f, '.md')).replace(/^ADR[-\s]*\d+[:\s-]*/i, '').trim();
    const status = /^\**\s*status\s*\**\s*[:|]?\s*\**\s*([^\n*]+)/im.exec(src)?.[1]?.trim();
    const id = `C:adr-${num ?? slug(title).slice(0, 24)}`;
    const rec: CRecord = { kind: 'C', id, name: title.slice(0, 120), proposed: true, since: today, line: 0 };
    if (num) rec.adr = num;
    concepts.push(rec);
    if (status && /supersed|deprecated|rejected|withdrawn/i.test(status)) notes.push(`${f}: status "${status}"; hygiene will propose retiring ${id} once ratified`);
  }

  if (ctx.config.embed.enabled) notes.push('embedding-based module clustering is not part of bootstrap; modules come from the tree and the import graph');
  return { mappings, logicals, edges, concepts, constraints, notes, files, index };
}

/** Records not already present in the graph, so re-running proposes only additions. */
export function newRecordsOnly(result: BootstrapResult, graph: Graph | undefined): GraphRecord[] {
  if (!graph) return [...result.mappings, ...result.logicals, ...result.edges, ...result.concepts, ...result.constraints];
  const out: GraphRecord[] = [];
  const globs = new Set(graph.mappings.map((m) => m.glob));
  for (const m of result.mappings) if (!globs.has(m.glob)) out.push(m);
  for (const l of result.logicals) if (!graph.logicals.has(l.id)) out.push(l);
  const edgeKey = (e: ERecord): string => `${e.from} ${e.rel} ${e.to}`;
  const edges = new Set(graph.edges.map(edgeKey));
  for (const e of result.edges) if (!edges.has(edgeKey(e))) out.push(e);
  for (const c of result.concepts) if (!graph.concepts.has(c.id)) out.push(c);
  for (const k of result.constraints) if (!graph.constraints.has(k.id)) out.push(k);
  return out;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeRead(p: string): string | undefined {
  try { return existsSync(p) ? readFileSync(p, 'utf8') : undefined; } catch { return undefined; }
}

function isAncestor(edges: ERecord[], ancestor: string, node: string): boolean {
  let cur: string | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur === ancestor) return true;
    cur = edges.find((e) => e.rel === 'in' && e.from === cur)?.to;
  }
  return false;
}

function moduleOfDir(ids: Map<string, string>, dir: string): string | undefined {
  let d = dir;
  while (d && d !== '.') { const m = ids.get(d); if (m) return m; d = dirname(d); }
  return undefined;
}

export const matchesGlob = (glob: string, path: string): boolean => picomatch(glob, { dot: true })(path);
