import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { retrieveHits } from '../embed/hints.js';
import type { DRecord, KRecord } from '../graph/records.js';
import { callersOf, loadOrBuildImportIndex, type ImportIndex } from '../index/imports.js';
import { envelope, type Envelope, type Touch } from '../observe/event.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { liveLinesFor, localServer, notifyOverlay } from '../overlay/client.js';
import { repoHash, toAbsolute, toRepoRelative } from '../util/paths.js';
import { estimateTokens } from '../util/tokens.js';
import { renderSlice } from '../walker/slice.js';
import { walk, type WalkResult } from '../walker/walk.js';

/**
 * Hydrate (design spec §13, the pull side made cheap). One call returns the depth an agent never
 * fetches on its own: the slice for each file in scope, the callers with the lines that use the
 * file, the decision history behind the rules in force, what this session already holds, hints,
 * and what teammates are doing. Everything but the hints comes from walks and the import index.
 * What it returns is observed: a reach event, and range touches for the caller lines, because
 * that content genuinely entered context.
 */
export interface HydrateOptions {
  budget?: number;
  session?: string;
  who?: string;
  branch?: string;
  harness?: string;
  cwd?: string;
  /** Record reach and touches in the observation store. On by default. */
  record?: boolean;
  /** Maximum files to brief for a module, concept, or task scope. */
  maxFiles?: number;
}

export interface CallerRef { path: string; lines: { n: number; text: string }[]; loaded: boolean; test: boolean }

export interface HydrateResult {
  scope: string;
  files: string[];
  reason: string;
  text: string;
  tokens: number;
  dropped: string[];
  callers: Record<string, CallerRef[]>;
}

const DEFAULT_BUDGET = 1500;

export async function hydrate(ctx: RepoContext, scopeIn: string, opts: HydrateOptions = {}): Promise<HydrateResult> {
  const g = ctx.graph;
  if (!g) throw new Error(`no graph for ${ctx.root}; hydrate needs one`);
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const index = loadOrBuildImportIndex(ctx.root);
  const session = opts.session ?? process.env.CLAUDE_SESSION_ID ?? process.env.CTX_SESSION ?? 'mcp';
  const store = new ObservationStore(ctx.root, session);
  const events = store.readAll();
  const meta = { session, who: opts.who ?? 'unknown/agent', branch: opts.branch ?? 'unknown', harness: opts.harness ?? 'mcp' };

  const { files, reason } = await resolveScope(ctx, scopeIn, index, events, opts);
  if (!files.length) throw new Error(`hydrate: nothing in the repository matches "${scopeIn}" (${reason})`);

  // 1. The floor: one slice per distinct chain-and-rules signature, so a module scope does not repeat itself.
  const walks = files.map((f) => walk(g, f, { maxDecisions: ctx.config.maxDecisions }));
  const sliceBlocks = (fileCap: number): string[] => {
    const groups = new Map<string, WalkResult[]>();
    for (const w of walks.slice(0, fileCap)) {
      const sig = [...w.chain, ...w.constraints.map((k) => k.id)].join('|');
      groups.set(sig, [...(groups.get(sig) ?? []), w]);
    }
    return [...groups.values()].map((ws) => {
      if (ws.length === 1) return renderSlice(g, ws[0]!, { maxTokens: ctx.config.maxTokens, proposed: 'full' }).text;
      // One slice for the group, then each file's own latest decisions, named by file.
      const rep: WalkResult = { ...ws[0]!, decisions: [] };
      const [, ...rest] = renderSlice(g, rep, { maxTokens: ctx.config.maxTokens, proposed: 'full' }).text.split('\n');
      const last = ws.flatMap((w) => w.decisions.map((d) => `  last   ${basename(w.path)}  ${d.id} ${d.date.slice(5)} ${d.who}  ${d.overrides ? `!${d.overrides}  ` : ''}${d.text}  (${d.sha === '-' ? `${d.branch} provisional` : d.sha})`));
      return [`edit ${ws.map((w) => short(w.path)).join(', ')}  (same chain and rules)`, ...rest, ...last.slice(0, ctx.config.maxDecisions)].join('\n');
    });
  };

  // 2. The neighbourhood: callers with the lines that use the file; callees by name.
  const loadedModes = loadedByPath(events);
  const callerRefs: Record<string, CallerRef[]> = {};
  const calleeNames: Record<string, string[]> = {};
  for (const f of files) {
    callerRefs[f] = callersOf(index, f)
      .map((c) => ({ path: c, lines: referenceLines(ctx.root, c, f), loaded: isLoaded(loadedModes[c]), test: isTestFile(c) }))
      .sort((a, b) => Number(a.test) - Number(b.test) || Number(a.loaded) - Number(b.loaded) || b.lines.length - a.lines.length);
    calleeNames[f] = index.imports[f] ?? [];
  }

  // 3. The decision history behind the rules in force. The rules themselves are already in the slices.
  const rules = new Map<string, KRecord>();
  for (const w of walks) for (const k of w.constraints) if (k.mode === 'E' || k.mode === 'G' || k.mode === 'G?') rules.set(k.id, k);
  const histories = [...rules.values()].map((k) => {
    const ds = [...g.decisions.values()].filter((d) => g.isActiveDecision(d) && (d.serves === k.id || d.overrides === k.id)).sort((a, b) => b.date.localeCompare(a.date));
    const overrides = ds.filter((d) => d.overrides === k.id);
    return { k, serves: ds.filter((d) => d.serves === k.id && d.overrides !== k.id), overrides, legacy: overrides.filter((d) => /^legacy:/.test(d.text)) };
  }).filter((h) => h.serves.length || h.overrides.length);

  // 4. This session.
  const state = new SessionState(ctx.root, session);
  const pending = Object.values(state.data.pending).filter((p) => files.includes(p.path)).map((p) => p.path);
  const lastCompact = [...events].reverse().find((e) => e.t === 'compact');
  const sessionLines = files.map((f) => {
    const m = loadedModes[f];
    return `${short(f)}: ${m ? describeMode(m.mode, m.ts) : 'not read this session'}${pending.includes(f) ? '; a decision is pending' : ''}`;
  });
  if (lastCompact) sessionLines.push(`context compacted at ${lastCompact.ts.slice(11, 16)}; ${(lastCompact.p as { paths: string[] }).paths.length} files survive only as summaries`);

  // 5 and 6. Hints and live lines.
  const live = [...new Set((await Promise.all(walks.map((w) => liveLinesFor(ctx, w, meta)))).flat())];
  const hints = ctx.config.embed.enabled ? await hintsFor(ctx, scopeIn, files) : [];

  // Assemble under budget: hints, callee lists, older decisions, caller lines go first; slices and rules never go.
  const dropped: string[] = [];
  const render = (callerCap: number, lineCap: number, withHints: boolean, withLive: boolean, withCallees: boolean, decisionCap: number, fileCap: number): string => {
    const shown = files.slice(0, fileCap);
    const count = shown.length === files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : `${shown.length} of ${files.length} files`;
    const out: string[] = [`hydrate ${scopeIn}${files.length > 1 || files[0] !== scopeIn ? `  (${count}: ${reason})` : ''}`];
    out.push(...sliceBlocks(fileCap));
    for (const f of shown) {
      const cs = callerRefs[f] ?? [];
      const dark = cs.filter((c) => !c.loaded).length;
      out.push(`${cs.length} caller${cs.length === 1 ? '' : 's'} of ${short(f)}${cs.length ? dark === cs.length ? ', none in context this session' : dark ? `, ${dark} not in context this session` : ', all in context this session' : ''}`);
      for (const c of cs.slice(0, callerCap)) {
        out.push(`  ${c.path}${c.loaded ? '  (in context)' : ''}`);
        for (const l of c.lines.slice(0, lineCap)) out.push(`    :${l.n}  ${l.text}`);
      }
      if (cs.length > callerCap) out.push(`  and ${cs.length - callerCap} more`);
      if (withCallees && calleeNames[f]?.length) out.push(`${short(f)} imports: ${calleeNames[f]!.slice(0, 8).map(tail2).join(', ')}${calleeNames[f]!.length > 8 ? ` and ${calleeNames[f]!.length - 8} more` : ''}`);
    }
    if (histories.length) {
      out.push('decisions behind the rules above:');
      for (const h of histories) {
        const parts: string[] = [];
        if (h.serves.length) parts.push(`served ${h.serves.length}: ${h.serves.slice(0, decisionCap).map((d) => `${d.id} ${d.date.slice(5)} ${basename(d.node)} "${d.text}"`).join('; ')}`);
        if (h.overrides.length) {
          const named = h.overrides.slice(0, decisionCap * 2);
          parts.push(`overridden ${h.overrides.length}${h.legacy.length === h.overrides.length ? ', all legacy' : h.legacy.length ? ` (${h.legacy.length} legacy)` : ''}: ${named.map((d) => `${basename(d.node)}${/^legacy:/.test(d.text) ? '' : ` "${d.text}"`}`).join(', ')}${h.overrides.length > named.length ? ` and ${h.overrides.length - named.length} more` : ''}`);
        }
        out.push(`  ${h.k.id}  ${parts.join('; ')}`);
      }
    }
    out.push('this session:', ...sessionLines.filter((_, i) => i < shown.length || i >= files.length).map((l) => `  ${l}`));
    if (withHints && hints.length) { out.push('hints:'); for (const h of hints) out.push(`  ${h}`); }
    if (withLive && live.length) { out.push('live:'); for (const l of live) out.push(`  ${l}`); }
    return out.join('\n');
  };

  let callerCap = 8, lineCap = 3, withHints = true, withLive = true, withCallees = true, decisionCap = 3, fileCap = files.length;
  let text = render(callerCap, lineCap, withHints, withLive, withCallees, decisionCap, fileCap);
  let tokens = estimateTokens(text);
  const steps: (() => string | undefined)[] = [
    () => { withHints = false; return 'hints'; },
    () => { withCallees = false; return 'callee list'; },
    () => { decisionCap = 1; return 'older decisions'; },
    () => { lineCap = 1; return 'caller usage lines'; },
    () => { callerCap = 3; return 'callers beyond three'; },
    () => { withLive = false; return 'live lines'; },
    () => { if (fileCap <= 3) return undefined; fileCap = 3; return 'files beyond three'; },
    () => { if (fileCap <= 1) return undefined; fileCap = 1; return 'files beyond the first'; },
  ];
  for (const step of steps) {
    if (tokens <= budget) break;
    const what = step();
    if (!what) continue;
    dropped.push(what);
    text = render(callerCap, lineCap, withHints, withLive, withCallees, decisionCap, fileCap);
    tokens = estimateTokens(text);
  }

  // Observe what entered context.
  if (opts.record !== false) {
    const nodes = [...new Set(walks.flatMap((w) => w.applicable))];
    const reach = envelope('reach', meta, { tool: 'hydrate', nodes: [...nodes, ...files] });
    store.append(reach);
    notifyOverlay(ctx, reach);
    for (const f of files.slice(0, fileCap)) {
      for (const c of (callerRefs[f] ?? []).slice(0, callerCap)) {
        const shown = c.lines.slice(0, lineCap);
        if (!shown.length) continue;
        const touch: Touch = { path: c.path, mode: 'range', range: [shown[0]!.n, shown[shown.length - 1]!.n], tool: 'hydrate', origin: 'main' };
        const env = envelope('touch', meta, touch);
        store.append(env);
        notifyOverlay(ctx, env);
      }
    }
  }

  return { scope: scopeIn, files, reason, text, tokens, dropped, callers: callerRefs };
}

// ---- scope resolution ------------------------------------------------------------------------

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'why', 'how', 'what', 'when', 'where', 'does', 'did', 'has', 'have', 'not', 'are', 'was', 'were', 'can', 'fix', 'add', 'make', 'change', 'update', 'remove', 'write', 'read', 'directly', 'before', 'after', 'about', 'against', 'through', 'then', 'than', 'file', 'files', 'code', 'path', 'key', 'work', 'check', 'look', 'audit', 'review', 'please', 'should', 'would', 'could', 'need', 'needs', 'want', 'like', 'just', 'also', 'still', 'its', 'our', 'your', 'you', 'all', 'any', 'one', 'two', 'new', 'old']);

async function resolveScope(ctx: RepoContext, scope: string, index: ImportIndex, events: Envelope[], opts: HydrateOptions): Promise<{ files: string[]; reason: string }> {
  const g = ctx.graph!;
  const maxFiles = opts.maxFiles ?? 6;
  const trimmed = scope.trim();
  const asPath = normalisePath(ctx, trimmed, opts.cwd);
  if (asPath && (existsSync(toAbsolute(ctx.root, asPath)) || index.imports[asPath])) return { files: [asPath], reason: 'a file' };

  const loaded = loadedByPath(events);
  const rank = (fs: string[]): string[] => fs
    .map((f) => ({ f, touched: loaded[f] ? 1 : 0, callers: callersOf(index, f).length, test: isTestFile(f) ? 1 : 0 }))
    .sort((a, b) => a.test - b.test || b.touched - a.touched || b.callers - a.callers)
    .map((x) => x.f);

  if (trimmed.startsWith('L:') && g.logicals.has(trimmed)) {
    const fs = Object.keys(index.imports).filter((f) => walk(g, f, { maxDecisions: 0 }).chain.includes(trimmed));
    return { files: rank(fs).slice(0, maxFiles), reason: `most connected of ${fs.length} under ${trimmed}` };
  }
  if (trimmed.startsWith('C:') && g.concepts.has(trimmed)) {
    const modules = g.edges.filter((e) => e.rel === 'impl' && e.to === trimmed && !e.proposed).map((e) => e.from);
    const fs = Object.keys(index.imports).filter((f) => { const ch = walk(g, f, { maxDecisions: 0 }).chain; return modules.some((m) => ch.includes(m)); });
    return { files: rank(fs).slice(0, maxFiles), reason: `most connected of ${fs.length} under ${modules.join(', ')}, which implement ${trimmed}` };
  }

  // A task description: the paths it names, else the index, else the names its words match.
  const named: string[] = [];
  for (const raw of trimmed.split(/[\s,;()"'`]+/)) {
    const tok = raw.replace(/[:.]+$/, '');
    const p = normalisePath(ctx, tok, opts.cwd);
    if (p && (existsSync(toAbsolute(ctx.root, p)) || index.imports[p]) && !named.includes(p)) named.push(p);
  }
  if (named.length) return { files: named.slice(0, maxFiles), reason: 'the files the task names' };
  if (ctx.config.embed.enabled) {
    try {
      const hits = await retrieveHits(ctx, trimmed, 12, 3000);
      const fs = [...new Set(hits.map((h) => h.path).filter((p): p is string => Boolean(p) && (index.imports[p!] !== undefined || existsSync(toAbsolute(ctx.root, p!)))))];
      if (fs.length) return { files: fs.slice(0, maxFiles), reason: 'the files nearest the task in the index' };
    } catch { /* fall through to name matching */ }
  }
  const words = [...new Set(trimmed.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  const wantsTests = words.some((w) => /^(test|tests|spec|specs)$/.test(w));
  const scored = Object.keys(index.imports).filter((f) => wantsTests || !isTestFile(f)).map((f) => {
    const parts = basename(f).toLowerCase().replace(/\.[^.]+$/, '').split(/[^a-z0-9]+/).filter(Boolean);
    const score = words.filter((w) => parts.some((p) => p === w || (w.length >= 5 && p.includes(w)) || (p.length >= 5 && w.includes(p)))).length;
    return { f, score, parts: parts.length };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.parts - b.parts);
  const best = scored.length ? scored.filter((x) => x.score === scored[0]!.score).map((x) => x.f) : [];
  return { files: rank(best).slice(0, maxFiles), reason: scored.length ? `files whose names match "${words.join(' ')}"` : 'no match' };
}

function normalisePath(ctx: RepoContext, p: string, cwd?: string): string | undefined {
  if (!p || p.startsWith('L:') || p.startsWith('C:') || /^https?:/.test(p)) return undefined;
  if (!/[/.]/.test(p)) return undefined;
  if (isAbsolute(p)) return toRepoRelative(ctx.root, p);
  if (existsSync(join(ctx.root, p))) return p;
  if (cwd && existsSync(resolve(cwd, p))) return toRepoRelative(ctx.root, resolve(cwd, p));
  return p;
}

// ---- caller reference lines ------------------------------------------------------------------

const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'];

/** Lines in `caller` that import `target` and then use what they imported. */
export function referenceLines(root: string, caller: string, target: string, cap = 6): { n: number; text: string }[] {
  let src: string;
  try { src = readFileSync(toAbsolute(root, caller), 'utf8'); } catch { return []; }
  const lines = src.split(/\r?\n/);
  const targetBase = target.replace(/\.[^.]+$/, '');
  const out: { n: number; text: string }[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const m = /\bfrom\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/.exec(l);
    if (!m) continue;
    const spec = m[1] ?? m[2] ?? m[3] ?? '';
    if (!spec.startsWith('.')) continue;
    const resolved = resolve('/', dirname(caller), spec).slice(1).replace(/\.(js|jsx|mjs|cjs|ts|tsx|mts|cts)$/, '');
    const hit = resolved === targetBase || EXTS.some((e) => resolved + e === target) || resolved + '/index' === targetBase;
    if (!hit) continue;
    out.push({ n: i + 1, text: l.trim() });
    const named = /\{([^}]*)\}/.exec(l)?.[1] ?? '';
    for (const part of named.split(',')) { const nm = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim(); if (nm) names.push(nm); }
    const def = /^\s*import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(,|from)/.exec(l)?.[1];
    if (def) names.push(def);
    const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(l)?.[1];
    if (star) names.push(star);
  }
  if (!out.length) return [];
  const importLines = new Set(out.map((o) => o.n));
  if (names.length) {
    const re = new RegExp(`\\b(${names.map((n) => n.replace(/[$]/g, '\\$')).join('|')})\\b`);
    for (let i = 0; i < lines.length && out.length < cap; i++) {
      if (importLines.has(i + 1)) continue;
      const l = lines[i]!;
      if (re.test(l) && !/^\s*(\/\/|\*)/.test(l)) out.push({ n: i + 1, text: l.trim().slice(0, 140) });
    }
  }
  return out.sort((a, b) => a.n - b.n).slice(0, cap);
}

// ---- helpers -----------------------------------------------------------------------------------

function loadedByPath(events: Envelope[]): Record<string, { mode: string; ts: string }> {
  const out: Record<string, { mode: string; ts: string }> = {};
  const rank: Record<string, number> = { full: 6, write: 6, range: 5, edit: 5, grep: 3, delegated: 2, summarized: 1, name: 1 };
  for (const e of events) {
    if (e.t !== 'touch' && e.t !== 'edit') continue;
    const p = e.p as Touch;
    const mode = p.origin === 'subagent' ? 'delegated' : p.mode;
    const cur = out[p.path];
    if (!cur || (rank[mode] ?? 0) >= (rank[cur.mode] ?? 0)) out[p.path] = { mode, ts: e.ts };
  }
  return out;
}
function isLoaded(m: { mode: string } | undefined): boolean { return Boolean(m && ['full', 'range', 'edit', 'write'].includes(m.mode)); }
function isTestFile(p: string): boolean { return /\.(test|spec)\.[a-z]+$|(^|\/)(__tests__|tests?)\//.test(p); }
function describeMode(mode: string, ts: string): string {
  const when = ts.slice(11, 16);
  return mode === 'full' || mode === 'write' ? `read in full at ${when}` : mode === 'range' || mode === 'edit' ? `read in part at ${when}` : mode === 'grep' ? `only grep hits at ${when}` : mode === 'delegated' ? `read by a subagent at ${when}` : mode === 'summarized' ? 'read, then compacted to a summary' : `seen by name at ${when}`;
}
function tail2(p: string): string { return p.split('/').slice(-2).join('/'); }
function short(p: string): string { const parts = p.split('/'); return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : p; }

async function hintsFor(ctx: RepoContext, scope: string, files: string[]): Promise<string[]> {
  try {
    const query = `${scope}\n${files.join('\n')}`;
    const local = localServer();
    if (local) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 1500);
      try {
        const q = new URLSearchParams({ q: query, path: files[0] ?? '' });
        const res = await fetch(`http://127.0.0.1:${local.port}/v1/${repoHash(ctx.root)}/hints?${q}`, { signal: ac.signal });
        if (res.ok) return (await res.json()) as string[];
      } finally { clearTimeout(t); }
    }
    const hits = await retrieveHits(ctx, query, ctx.config.embed.maxHints * 4, 3000);
    return hits.filter((h) => h.score >= ctx.config.embed.minScore && !files.includes(h.path ?? '')).slice(0, ctx.config.embed.maxHints).map((h) => `${h.ref}  ${h.score.toFixed(2)}  "${h.text.replace(/\s+/g, ' ').slice(0, 90)}"`);
  } catch {
    return [];
  }
}
