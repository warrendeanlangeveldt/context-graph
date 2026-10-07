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
/** Files a harness already puts in front of the model every turn. A rule cut from one and pinned to the root would only repeat what the model has. */
const HARNESS_INJECTED = new Set(['AGENTS.md', 'CLAUDE.md', '.cursorrules', 'GEMINI.md', '.github/copilot-instructions.md']);
const MAX_INSTRUCTION_RULES = 12;
const IMPERATIVE = /\b(never|do not|don't|must|always|only|no\s+\w+|required|forbidden|not allowed)\b/i;
const GENERIC_DIRS = new Set(['src', 'source', 'sources']);
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
/** File names that announce a rule: architecture and boundary suites, and the negative-test convention (`no-`, `never-`, `only-`). */
const ARCH_FILE = /(boundary|architecture|layering|dependenc|arch-|-arch|\.arch\.|invariant|contract|policy|conventions|(^|\/)(no|never|must|only|rules?|guards?)-[^/]*)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i;
/** A sentence that states a rule rather than describes a fixture. */
const RULE_TEXT = /(?<![-\w])(never|must|may not|cannot|can't|only|does not|do not|no longer|is not allowed|forbidden|no)\b/i;
/** Strong names: the file exists to state rules, so a describe block is a rule even without a keyword. */
const STRONG_ARCH_FILE = /(boundary|architecture|layering|\.arch\.|(^|\/)(no|never)-[^/]*)[^/]*\.(test|spec)\.[cm]?[jt]sx?$/i;
/** A sentence short and declarative enough to stand as a rule; explanations and narratives fail this. */
const ruleShaped = (t: string): boolean => t.length <= 140 && t.split(/\s+/).length <= 22 && !/->|=>|\bbelow\b|\bhere\b|\btests?\s+[—-]|^(So|Two|Three|Both|Neither|Enough|Most|Some|Many|Half|Every case|What is|Runs|This|These|Those|It|There|Prior|Before|After|Previously|Historically|Originally|Once|When|Because|Since|Now)\b/.test(t);
/** A sentence that explains rather than describes. */
const RATIONALE = /\b(because|so that|so a|so the|so they|there were|there was|used to|instead of|rather than|otherwise|deliberately|on purpose|never|must|one of each|the reason)\b/i;

/** Sentences of the block comment that opens a file, comment markers stripped; empty when the file has none. */
export function headerSentences(src: string): string[] {
  const m = /^\s*(?:#![^\n]*\n)?\s*\/\*\*?([\s\S]*?)\*\//.exec(src);
  if (!m) return [];
  const body = m[1]!.split(/\r?\n/).map((l) => l.replace(/^\s*\*\s?/, '')).join('\n');
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p && !/^@/.test(p) && !/^\s*[-|`]/.test(p));
  const out: string[] = [];
  for (const p of paragraphs.slice(0, 3)) for (const sentence of p.split(/(?<=[.!?])\s+(?=[A-Z"'(])/)) { const t = sentence.trim(); if (t.length >= 16 && t.length <= 240 && !/->|=>/.test(t) && (t.split('"').length - 1) % 2 === 0) out.push(t); }
  return out.slice(0, 8);
}

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
  // When that child is a `src`, the parent is the module and the child is the convention, so keep the parent.
  const dropped = new Set<string>();
  for (const c of candidates) {
    const children = candidates.filter((o) => dirname(o.dir) === c.dir);
    if (!(children.length === 1 && (direct.get(c.dir) ?? 0) === 0 && children[0]!.n === c.n)) continue;
    dropped.add(GENERIC_DIRS.has(basename(children[0]!.dir)) ? children[0]!.dir : c.dir);
  }
  candidates = candidates.filter((c) => !dropped.has(c.dir));
  if (candidates.length > maxModules) {
    const keep = new Set(candidates.sort((a, b) => b.n - a.n).slice(0, maxModules).map((c) => c.dir));
    for (const c of [...keep]) { let d = dirname(c); while (d && d !== '.') { if (candidates.some((x) => x.dir === d)) keep.add(d); d = dirname(d); } }
    candidates = candidates.filter((c) => keep.has(c.dir));
    notes.push(`kept the ${keep.size} largest modules of ${counts.size} candidate directories; raise --max-modules to see more`);
  }
  // A `src` directory is a convention, not a module: its files roll up to the enclosing module.
  candidates = candidates.filter((c) => !(GENERIC_DIRS.has(basename(c.dir)) && candidates.some((o) => o.dir !== c.dir && c.dir.startsWith(o.dir + '/'))));
  candidates.sort((a, b) => b.dir.split('/').length - a.dir.split('/').length || a.dir.localeCompare(b.dir));

  const ids = new Map<string, string>();
  const used = new Set<string>();
  const mappings: MRecord[] = [];
  const logicals: LRecord[] = [];
  // Names come from the leaf. A leaf shared by several modules (app, components, lib) is prefixed with the
  // enclosing module's name, so `L:web-app` and `L:mobile-app` rather than `L:app` and `L:src-app`.
  const leafCount = new Map<string, number>();
  for (const c of candidates) { const l = slug(basename(c.dir)); leafCount.set(l, (leafCount.get(l) ?? 0) + 1); }
  const idFor = (dir: string): string => {
    const parts = dir.split('/');
    const leaf = slug(parts[parts.length - 1]!);
    let id = `L:${leaf}`;
    // Prefix with the nearest meaningful segment above (never `src`), then keep climbing until unique.
    let i = parts.length - 2;
    if ((leafCount.get(leaf) ?? 0) > 1 || used.has(id)) {
      while (i >= 0 && GENERIC_DIRS.has(parts[i]!)) i--;
      if (i >= 0) { id = `L:${slug(parts[i]!)}-${leaf}`; i--; }
    }
    for (; used.has(id) && i >= 0; i--) { if (GENERIC_DIRS.has(parts[i]!)) continue; id = `L:${slug(parts[i]!)}-${id.slice(2)}`; }
    used.add(id);
    return id;
  };
  // A graph that already names its modules was curated: the tree scan doesn't second-guess the modules it
  // has. It proposes a module only for a folder nothing claims but the root mapping or a parent folder's
  // glob (one the project grew since), with its containment edge proposed for a person to ratify.
  const existing = ctx.graph;
  const curated = Boolean(existing && existing.mappings.some((m) => m.glob !== '**'));
  if (curated) {
    const own = new Set(existing!.mappings.map((m) => m.glob));
    candidates = candidates.filter((c) => {
      if (own.has(`${c.dir}/**`)) return false;
      const claim = existing!.mapPath(`${c.dir}/__ctx_probe__.ts`);
      if (!claim || claim.glob === '**') return true;
      return claim.glob.endsWith('/**') && c.dir.startsWith(`${claim.glob.slice(0, -3)}/`);
    });
    for (const id of existing!.logicals.keys()) used.add(id);
    notes.push(
      candidates.length
        ? `the graph already defines ${existing!.logicals.size} modules; ${candidates.length} folder(s) it doesn't map yet are proposed as new modules, with their containment edges proposed`
        : `the graph already defines ${existing!.logicals.size} modules, and maps every folder that looks like one`,
    );
  }
  for (const c of [...candidates].sort((a, b) => a.dir.split('/').length - b.dir.split('/').length || a.dir.localeCompare(b.dir))) ids.set(c.dir, idFor(c.dir));
  for (const c of candidates) {
    const id = ids.get(c.dir)!;
    mappings.push({ kind: 'M', glob: `${c.dir}/**`, logical: id, line: 0 });
    logicals.push({ kind: 'L', id, name: `${basename(c.dir)} (${c.n} source files)`, line: 0 });
  }
  const rootId = curated ? (existing!.mappings.find((m) => m.glob === '**')?.logical ?? existing!.logicals.keys().next().value ?? 'L:repo') : 'L:repo';
  if (!curated) {
    logicals.push({ kind: 'L', id: rootId, name: `${basename(root)} repository`, line: 0 });
    mappings.push({ kind: 'M', glob: '**', logical: rootId, line: 0 });
  }
  if (curated) for (const m of existing!.mappings) if (m.glob !== '**' && m.glob.endsWith('/**')) ids.set(m.glob.slice(0, -3), m.logical);

  const edges: ERecord[] = [];
  const parentOf = (dir: string): string => {
    let d = dirname(dir);
    while (d && d !== '.') { const p = ids.get(d); if (p) return p; d = dirname(d); }
    return rootId;
  };

  for (const c of candidates)
    edges.push({ kind: 'E', from: ids.get(c.dir)!, rel: 'in', to: parentOf(c.dir), line: 0, ...(curated ? { proposed: true, since: today } : {}) });

  // 2. Import graph -> dependency edges between modules.
  const index = buildImportIndex(root);
  const moduleOf = (f: string): string | undefined => {
    if (curated) { const m = existing!.mapPath(f); return m && m.logical !== rootId ? m.logical : undefined; }
    let d = dirname(f);
    while (d && d !== '.') { const m = ids.get(d); if (m) return m; d = dirname(d); }
    return undefined;
  };
  const depCounts = new Map<string, number>();
  for (const [from, targets] of Object.entries(index.imports)) {
    if (curated) break;
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

  // 3. Architecture and negative tests -> proposed constraints with test: set. A repository's own
  // `no-*.test.ts` is the clearest rule it has; the header sentence is the rule, the describe blocks the detail.
  const constraints: KRecord[] = [];
  const seenRule = new Set<string>();
  for (const f of files) {
    if (!TEST_FILE.test(f)) continue;
    const src = safeRead(join(root, f));
    if (!src) continue;
    const head = headerSentences(src);
    const headRule = head.find((x) => RULE_TEXT.test(x) && ruleShaped(x));
    const strong = STRONG_ARCH_FILE.test(f);
    if (!ARCH_FILE.test(f) && !headRule) continue;
    const node = moduleOf(f) ?? rootId;
    const push = (text: string): void => {
      const id = `arch.${slug(text).slice(0, 48)}`;
      if (seenRule.has(id)) return;
      seenRule.add(id);
      constraints.push({ kind: 'K', mode: 'G?', id, attachedTo: node, text: text.replace(/\s+/g, ' ').trim(), test: f, since: today, line: 0 });
    };
    // Describe blocks written as rules come first: they are terse by convention. The header sentence is the
    // fallback, then rule-shaped it() names; a strongly named file with none of those still gets one line.
    // A strongly named file is rules by declaration, so its names need no keyword; a contract or policy suite must earn it.
    const isRule = (n: string): boolean => ruleShaped(n) && (strong || RULE_TEXT.test(n));
    const describes = [...src.matchAll(/\bdescribe\(\s*['"`]([^'"`]{8,160})['"`]/g)].map((m) => m[1]!).filter(isRule);
    const its = [...src.matchAll(/\b(?:it|test)\(\s*['"`]([^'"`]{8,160})['"`]/g)].map((m) => m[1]!).filter(isRule);
    const names = describes.length ? describes.slice(0, 4) : headRule ? [headRule] : its.slice(0, 4);
    if (!names.length && strong) names.push(`rules enforced by ${basename(f)}`);
    for (const n of names) push(n);
  }

  // 3b. File headers that carry a rationale -> recorded notes on the file. Dropped first under budget,
  // never enforced, but they answer `why` and travel with hydrate to the callers that never read the file.
  let headerNotes = 0;
  for (const f of files) {
    if (headerNotes >= 120 || TEST_FILE.test(f) || !/\.[cm]?[jt]sx?$/.test(f)) continue;
    const src = safeRead(join(root, f));
    if (!src) continue;
    const sentences = headerSentences(src);
    if (sentences.length < 2) continue;
    const why = sentences.slice(1).find((x) => RATIONALE.test(x));
    if (!why) continue;
    const text = clip(`${sentences[0]} ${why}`.replace(/\s+/g, ' ').trim(), 220);
    constraints.push({ kind: 'K', mode: 'R', id: `hdr.${slug(f.replace(/\.[^.]+$/, '')).slice(0, 60)}`, attachedTo: f, text, since: today, line: 0 });
    headerNotes++;
  }
  if (headerNotes) notes.push(`${headerNotes} file header(s) carry a rationale; recorded as notes on those files`);

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
  // A line that names a module's directory or id is pinned to that module, where it arrives at edit time and
  // the model may not have it in mind. Lines naming nothing are kept only from files the harness does not
  // already inject, and even then capped: they apply to every file and each one taxes every slice.
  const moduleForText = (raw: string): string | undefined => {
    for (const c of [...ids.keys()].map((dir) => ({ dir })).sort((a, b) => b.dir.length - a.dir.length)) {
      const id = ids.get(c.dir)!;
      if (raw.includes(id) || raw.includes(`${c.dir}/`) || raw.includes(`\`${c.dir}\``) || new RegExp(`(^|[\\s\`'"(])${c.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(/\\*\\*)?([\\s\`'")]|$)`).test(raw)) return id;
    }
    return undefined;
  };
  for (const f of instructionFiles) {
    const src = safeRead(join(root, f));
    if (!src) continue;
    const injected = HARNESS_INJECTED.has(basename(f)) || HARNESS_INJECTED.has(f);
    const fallback = moduleOf(f) ?? (f.includes('/') ? moduleOfDir(ids, dirname(f)) ?? rootId : rootId);
    let n = 0, skipped = 0;
    const lines = src.split(/\r?\n/);
    for (let i = 0; i < lines.length && n < MAX_INSTRUCTION_RULES; i++) {
      const raw = lines[i]!.replace(/^[\s>*-]+/, '').replace(/\*\*/g, '').trim();
      if (raw.length < 24 || raw.length > 220 || raw.startsWith('#') || raw.startsWith('```') || raw.startsWith('|')) continue;
      if (!IMPERATIVE.test(raw)) continue;
      const anchored = moduleForText(raw);
      if (!anchored && injected) { skipped++; continue; }
      n++;
      constraints.push({ kind: 'K', mode: 'G?', id: `agent.${slug(raw).slice(0, 40)}-${i + 1}`, attachedTo: anchored ?? fallback, text: `[${f}:${i + 1}] ${raw}`, since: today, line: 0 });
    }
    if (n) notes.push(`${f}: ${n} imperative line(s) proposed as guided constraints${skipped ? `; ${skipped} global line(s) left where the harness already injects them` : ''}`);
    else if (skipped) notes.push(`${f}: ${skipped} imperative line(s) name no module; left where the harness already injects them`);
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

/** Cut at a word boundary, marking the cut, so a note never ends mid-word. */
function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(' ', max - 1);
  return `${t.slice(0, cut > max / 2 ? cut : max - 1)}…`;
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
