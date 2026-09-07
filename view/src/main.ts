import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import ForceGraph from 'force-graph';
import SpriteText from 'three-spritetext';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Vector2, type Object3D } from 'three';

/**
 * The synapse view (design spec §14). It exists to answer four questions, and every element is
 * there for one of them: for an edit, which applicable nodes lit and which stayed dark (the edit
 * lens, red callers, the risky table); what slice was injected and did the decision point back
 * at it (the detail panel); which sessions touched a file and how (colour by session, hover);
 * and across a session, which files were edited with the fewest callers in context (headline,
 * findings feed, the table's order). The graph is the picture; the panels are the sentences.
 */

type Kind = 'file' | 'module' | 'concept';
interface SnapConstraint { id: string; mode: string; text: string }
interface SnapNode { id: string; kind: Kind; label: string; module?: string; size: number; constraints?: SnapConstraint[]; decisions?: number; parent?: string }
interface SnapLink { source: string; target: string; rel: 'import' | 'in' | 'impl' }
interface Snapshot { root?: string; nodes: SnapNode[]; links: SnapLink[]; error?: string }
interface Env { t: string; ts: string; session: string; who: string; branch: string; seq?: number; p: Record<string, unknown> }
interface Coverage { path: string; applicable: string[]; loaded: Record<string, string>; callers: string[]; callers_loaded: number; callers_total: number; slice_injected: boolean; summarized_since: boolean; dark: string[]; session?: string; ts?: string }
interface VNode extends SnapNode { color: string; val: number; x?: number; y?: number; z?: number }
interface VLink { source: string | VNode; target: string | VNode; rel: string; count: number; lens?: boolean }
type G3 = ForceGraph3DInstance<VNode, VLink>;
type G2 = InstanceType<typeof ForceGraph>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE_LEVEL: Record<string, number> = { full: 1, write: 1, edit: 0.95, range: 0.7, delegated: 0.45, grep: 0.35, summarized: 0.25, name: 0.2, external: 0.1, failed: 0.1, delete: 0.1 };
const SESSION_COLORS = ['#5fd3d8', '#f0b25c', '#9b8cff', '#f06c9b', '#8de07a', '#f0d36c', '#6cb4f0', '#e08a6c'];

interface Palette { bg: string; idle: string; full: string; range: string; low: string; edit: string; dark: string; module: string; concept: string; link: string; contain: string; lensLink: string; label: string; labelModule: string; dim: string }
const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: '#151b24', idle: '#3d4a5c', full: '#5fd3d8', range: '#3fa3a8', low: '#7a8aa0', edit: '#f0b25c', dark: '#ff7b7b', module: '#9b8cff', concept: '#c9a3ff', link: 'rgba(150,170,200,0.28)', contain: 'rgba(155,140,255,0.35)', lensLink: 'rgba(255,123,123,0.9)', label: '#c9d2dd', labelModule: '#eef1f6', dim: '#242c38' },
  light: { bg: '#f2f4f7', idle: '#b9c2ce', full: '#0e8f95', range: '#3c7f83', low: '#6b7a8c', edit: '#c47a10', dark: '#c2413b', module: '#5b4bd6', concept: '#8b5cf6', link: 'rgba(60,80,110,0.25)', contain: 'rgba(91,75,214,0.35)', lensLink: 'rgba(194,65,59,0.9)', label: '#33404f', labelModule: '#18202b', dim: '#dfe4ea' },
};
type Category = 'full' | 'range' | 'low' | 'edit' | 'dark' | 'module' | 'concept';
const CATEGORIES: { key: Category; name: string; color: (p: Palette) => string }[] = [
  { key: 'edit', name: 'edited', color: (p) => p.edit },
  { key: 'dark', name: 'caller never loaded', color: (p) => p.dark },
  { key: 'full', name: 'read in full', color: (p) => p.full },
  { key: 'range', name: 'read a range', color: (p) => p.range },
  { key: 'low', name: 'grep or name only', color: (p) => p.low },
  { key: 'module', name: 'module', color: (p) => p.module },
  { key: 'concept', name: 'concept', color: (p) => p.concept },
];

interface Controls { theme: 'dark' | 'light'; mode: '3d' | '2d'; files: 'touched' | 'all'; labels: 'modules' | 'lit' | 'all' | 'none'; links: 'containment' | 'imports' | 'both' | 'none'; colour: 'mode' | 'session'; size: number; bloom: boolean; freeze: boolean; speed: number; risky: boolean }
const DEFAULTS: Controls = { theme: 'dark', mode: '3d', files: 'touched', labels: 'modules', links: 'containment', colour: 'mode', size: 1.4, bloom: false, freeze: false, speed: 20, risky: true };
const controls: Controls = { ...DEFAULTS, ...load() };

interface State { repo: string; snapshot: Snapshot; events: Env[]; session: string; expanded: Set<string>; live: boolean; cursor: number; ws?: WebSocket; selected?: string; playing?: number; lens?: string; isolate?: Category; sessionColor: Map<string, string> }
const state: State = { repo: '', snapshot: { nodes: [], links: [] }, events: [], session: '', expanded: new Set(), live: true, cursor: 0, sessionColor: new Map() };

function load(): Partial<Controls> { try { return JSON.parse(localStorage.getItem('ctx-view') ?? '{}') as Partial<Controls>; } catch { return {}; } }
function save(): void { try { localStorage.setItem('ctx-view', JSON.stringify(controls)); } catch { /* private mode */ } }
const pal = (): Palette => PALETTES[controls.theme];

// ---- data --------------------------------------------------------------------------------

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

async function loadRepos(): Promise<void> {
  const repos = await api<{ hash: string; root: string | null; sessions: number }[]>('/v1/repos');
  const sel = $<HTMLSelectElement>('repo');
  sel.innerHTML = '';
  for (const r of repos) { const o = document.createElement('option'); o.value = r.hash; o.textContent = `${r.root ? r.root.split('/').pop() : r.hash} (${r.sessions} sessions)`; sel.appendChild(o); }
  state.repo = new URLSearchParams(location.search).get('repo') ?? repos[0]?.hash ?? '';
  sel.value = state.repo;
}

async function loadRepo(): Promise<void> {
  if (!state.repo) return;
  state.snapshot = await api<Snapshot>(`/v1/${state.repo}/graph`);
  $('empty').hidden = !state.snapshot.error;
  const sessions = await api<{ session: string; who: string; branch: string; last: string; events: number }[]>(`/v1/${state.repo}/sessions`);
  const sel = $<HTMLSelectElement>('session');
  sel.innerHTML = '<option value="">all sessions</option>';
  state.sessionColor.clear();
  sessions.forEach((s, i) => { state.sessionColor.set(s.session, SESSION_COLORS[i % SESSION_COLORS.length]!); const o = document.createElement('option'); o.value = s.session; o.textContent = `${s.session.slice(0, 8)}  ${s.who}  ${s.branch}  (${s.events})`; sel.appendChild(o); });
  state.events = await api<Env[]>(`/v1/${state.repo}/events`);
  state.cursor = state.events.length;
  connect();
  await loadEvolution();
  rebuild();
  replayTo(state.cursor);
  refreshTime();
}

function connect(): void {
  state.ws?.close();
  const last = state.events[state.events.length - 1]?.seq ?? 0;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/${state.repo}/stream?since=${last}`);
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data as string) as Env;
    if (e.t === 'ready') return;
    state.events.push(e);
    if (state.live) { state.cursor = state.events.length; applyEvent(e, true); refreshTime(); refreshPanels(); }
  };
  ws.onclose = () => { setStatus('disconnected, retrying'); setTimeout(() => { if (state.ws === ws) connect(); }, 3000); };
  state.ws = ws;
}

async function loadEvolution(): Promise<void> {
  const data = await api<{ decisions: { id: string; date: string; who: string; node: string; serves: string; overrides?: string; text: string; active: boolean; archived: boolean }[]; retirements: { target: string; date: string; reason: string }[] } | []>(`/v1/${state.repo}/decisions`);
  const ul = $<HTMLUListElement>('evolution');
  ul.innerHTML = '';
  if (Array.isArray(data)) { ul.innerHTML = '<li>no graph, so no decisions</li>'; return; }
  const rows = [...data.decisions.map((d) => ({ date: d.date, html: `<b>${d.id}</b> ${esc(d.who)} on ${esc(short(d.node))} → ${esc(d.serves)}${d.overrides ? ` <span class="pill dark">!${esc(d.overrides)}</span>` : ''}${d.active ? '' : ' <span class="pill">superseded</span>'}${d.archived ? ' <span class="pill">archived</span>' : ''}<br>${esc(d.text)}` })), ...data.retirements.map((z) => ({ date: z.date, html: `<b>retired</b> ${esc(z.target)}: ${esc(z.reason)}` }))].sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) ul.innerHTML = '<li>no decisions recorded yet</li>';
  for (const r of rows.slice(-60)) { const li = document.createElement('li'); li.innerHTML = `${r.date}  ${r.html}`; ul.appendChild(li); }
}

// ---- state derived from events ------------------------------------------------------------

interface NodeState { level: number; mode: string; edited: boolean; dark: boolean; sessions: Set<string>; lastTs: string; edits: number }
interface Finding { ts: string; session: string; rule: string; message: string; path?: string; level: 'bad' | 'warn' | 'ok' }
const nodeState = new Map<string, NodeState>();
const coverageRows: Coverage[] = [];
const findings: Finding[] = [];
const slices = new Map<string, { ts: string; rendered: string; applicable: string[] }[]>();
const decisionsSeen: { ts: string; node: string; serves: string; overrides?: string; text: string }[] = [];
let reaches = 0, compactions = 0, reads = 0;
let lastTouched: string | undefined;

function resetDerived(): void { nodeState.clear(); coverageRows.length = 0; findings.length = 0; slices.clear(); decisionsSeen.length = 0; reaches = 0; compactions = 0; reads = 0; lastTouched = undefined; }

function touch(path: string, level: number, mode: string, session: string, ts: string, edited: boolean): NodeState {
  const ns = nodeState.get(path) ?? { level: 0, mode, edited: false, dark: false, sessions: new Set(), lastTs: ts, edits: 0 };
  if (level >= ns.level) { ns.level = level; ns.mode = mode; }
  if (edited) { ns.edited = true; ns.edits++; }
  ns.dark = false;
  ns.sessions.add(session);
  ns.lastTs = ts;
  nodeState.set(path, ns);
  return ns;
}

function applyEvent(e: Env, animate: boolean): void {
  if (state.session && e.session !== state.session && e.t !== 'finding') return;
  if (e.t === 'touch' || e.t === 'edit') {
    const p = e.p as { path: string; mode: string; origin?: string };
    const mode = p.origin === 'subagent' ? 'delegated' : p.mode;
    if (e.t === 'touch') reads++;
    touch(p.path, MODE_LEVEL[mode] ?? 0.2, mode, e.session, e.ts, e.t === 'edit');
    const mod = moduleOf(p.path);
    if (mod) { const ms = nodeState.get(mod) ?? { level: 0, mode: 'module', edited: false, dark: false, sessions: new Set(), lastTs: e.ts, edits: 0 }; ms.level = Math.max(ms.level, (MODE_LEVEL[mode] ?? 0.2) * 0.6); ms.sessions.add(e.session); if (e.t === 'edit') ms.edits++; nodeState.set(mod, ms); }
    if (animate && !reduced && e.t === 'edit' && lastTouched && lastTouched !== p.path) pulse(lastTouched, p.path);
    lastTouched = p.path;
    if (animate) scheduleRefresh();
  } else if (e.t === 'coverage') {
    const c = e.p as unknown as Coverage;
    c.session = e.session; c.ts = e.ts;
    coverageRows.push(c);
    // The callers of an edited file that were never in context are the dark nodes that matter.
    for (const caller of c.callers) {
      const m = c.loaded[caller];
      if (m === 'full' || m === 'range' || m === 'edit' || m === 'write') continue;
      const ns = nodeState.get(caller);
      if (!ns || ns.level < 0.7) nodeState.set(caller, { level: ns?.level ?? 0.15, mode: ns?.mode ?? 'dark', edited: ns?.edited ?? false, dark: true, sessions: new Set([...(ns?.sessions ?? []), e.session]), lastTs: e.ts, edits: ns?.edits ?? 0 });
    }
    if (c.callers_total > 0 && c.callers_loaded === 0) findings.push({ ts: e.ts, session: e.session, rule: 'callers-dark', message: `${short(c.path)} edited with none of its ${c.callers_total} caller${c.callers_total === 1 ? '' : 's'} in context`, path: c.path, level: 'bad' });
    else if (c.callers_total > 0) findings.push({ ts: e.ts, session: e.session, rule: 'callers', message: `${short(c.path)} edited with ${c.callers_loaded} of ${c.callers_total} callers in context`, path: c.path, level: c.callers_loaded === c.callers_total ? 'ok' : 'warn' });
    if (c.summarized_since) findings.push({ ts: e.ts, session: e.session, rule: 'summarized', message: `${short(c.path)} edited after its content had been compacted away`, path: c.path, level: 'warn' });
    if (animate) { renderCoverage(); scheduleRefresh(); }
  } else if (e.t === 'slice') {
    const p = e.p as { path: string; rendered: string; applicable: string[] };
    slices.set(p.path, [...(slices.get(p.path) ?? []), { ts: e.ts, rendered: p.rendered, applicable: p.applicable }]);
  } else if (e.t === 'decision') {
    const d = e.p as { node: string; serves: string; overrides?: string; text: string };
    decisionsSeen.push({ ts: e.ts, node: d.node, serves: d.serves, ...(d.overrides ? { overrides: d.overrides } : {}), text: d.text });
    findings.push({ ts: e.ts, session: e.session, rule: 'decision', message: `decision on ${short(d.node)}: ${d.overrides ? `overrides ${d.overrides}` : `serves ${d.serves}`}`, path: d.node.split('#')[0], level: d.overrides ? 'warn' : 'ok' });
  } else if (e.t === 'reach') {
    reaches++;
  } else if (e.t === 'compact') {
    compactions++;
    const paths = (e.p as { paths: string[] }).paths;
    for (const p of paths) { const ns = nodeState.get(p); if (ns && ns.level > 0.25) { ns.level = 0.25; ns.mode = 'summarized'; } }
    findings.push({ ts: e.ts, session: e.session, rule: 'compact', message: `context compacted; ${paths.length} file${paths.length === 1 ? '' : 's'} now survive only as a summary`, level: 'warn' });
    if (animate) scheduleRefresh();
  } else if (e.t === 'finding') {
    const f = e.p as { rule: string; message: string; path?: string };
    if (f.rule === 'callers-dark') return; // already derived from coverage
    findings.push({ ts: e.ts, session: e.session, rule: f.rule, message: f.message, ...(f.path ? { path: f.path } : {}), level: /no-decision|test-failed|opposed/.test(f.rule) ? 'bad' : 'warn' });
  } else if (e.t === 'session') {
    const p = e.p as { kind: string; arm?: string };
    if (p.kind === 'start') findings.push({ ts: e.ts, session: e.session, rule: 'session', message: `session started${p.arm === 'off' ? ' in observe-only mode' : ''}`, level: 'ok' });
  }
}

function replayTo(cursor: number): void {
  resetDerived();
  for (let i = 0; i < cursor && i < state.events.length; i++) applyEvent(state.events[i]!, false);
  refreshPanels();
  refreshGraph();
}

function refreshPanels(): void {
  renderHeadline();
  renderFindings();
  renderCoverage();
  renderLegend();
  drawTimeline();
  setStatus();
}

// ---- graph rendering ------------------------------------------------------------------------

let g3: G3 | undefined;
let g2: G2 | undefined;
let fitted = false;
const el = $<HTMLDivElement>('graph');
let refreshTimer: number | undefined;
const nodeIndex = new Map<string, SnapNode>();
const callersOf = new Map<string, string[]>();

function scheduleRefresh(): void { if (refreshTimer) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; refreshGraph(); }, 120); }
function moduleOf(path: string): string | undefined { return nodeIndex.get(path)?.module; }
function currentNodes(): VNode[] { return ((g3 ?? g2)?.graphData().nodes ?? []) as VNode[]; }
function currentLinks(): VLink[] { return ((g3 ?? g2)?.graphData().links ?? []) as VLink[]; }
function chainOf(module: string | undefined): string[] { const out: string[] = []; let cur = module; while (cur && !out.includes(cur)) { out.push(cur); cur = nodeIndex.get(cur)?.parent; } return out; }

function category(n: SnapNode, ns: NodeState | undefined): Category | undefined {
  if (n.kind === 'module') return 'module';
  if (n.kind === 'concept') return 'concept';
  if (!ns) return undefined;
  if (ns.dark && ns.level <= 0.3) return 'dark';
  if (ns.edited) return 'edit';
  return ns.level >= 1 ? 'full' : ns.level >= 0.7 ? 'range' : 'low';
}

function lensSet(): { focus: Set<string>; callers: Set<string> } | undefined {
  if (!state.lens) return undefined;
  const focus = new Set<string>([state.lens]);
  const callers = new Set(callersOf.get(state.lens) ?? []);
  for (const c of callers) focus.add(c);
  for (const m of chainOf(moduleOf(state.lens))) focus.add(m);
  return { focus, callers };
}

function visibleData(): { nodes: VNode[]; links: VLink[] } {
  const snap = state.snapshot;
  nodeIndex.clear();
  callersOf.clear();
  for (const n of snap.nodes) nodeIndex.set(n.id, n);
  for (const l of snap.links) if (l.rel === 'import') callersOf.set(l.target, [...(callersOf.get(l.target) ?? []), l.source]);
  const lens = lensSet();
  const visible = new Set<string>();
  const nodes: VNode[] = [];
  for (const n of snap.nodes) {
    const ns = nodeState.get(n.id);
    const cat = category(n, ns);
    let show = n.kind !== 'file' || controls.files === 'all' || ns !== undefined || (n.module !== undefined && state.expanded.has(n.module));
    if (lens?.focus.has(n.id)) show = true;
    if (state.isolate && cat !== state.isolate && n.kind === 'file') show = false;
    if (!show) continue;
    visible.add(n.id);
    const base = n.kind === 'module' ? 4 + Math.sqrt(n.size) : n.kind === 'concept' ? 3 : ns ? 1.6 : 0.9;
    nodes.push({ ...n, color: colorFor(n, ns, lens), val: base * controls.size * (lens && lens.focus.has(n.id) && n.kind === 'file' ? 1.6 : 1) });
  }
  const linkMap = new Map<string, VLink>();
  const wantImports = controls.links === 'imports' || controls.links === 'both';
  const wantContain = controls.links === 'containment' || controls.links === 'both';
  for (const l of snap.links) {
    const isLensLink = Boolean(lens && l.rel === 'import' && l.target === state.lens && lens.callers.has(l.source));
    if (l.rel === 'import' && !wantImports && !isLensLink) continue;
    if ((l.rel === 'in' || l.rel === 'impl') && !wantContain) continue;
    let s = l.source, t = l.target;
    if (!visible.has(s)) { const m = moduleOf(s); if (!m || !visible.has(m) || l.rel === 'in') continue; s = m; }
    if (!visible.has(t)) { const m = moduleOf(t); if (!m || !visible.has(m) || l.rel === 'in') continue; t = m; }
    if (s === t) continue;
    const key = `${s} ${t} ${l.rel}`;
    const cur = linkMap.get(key);
    if (cur) cur.count++; else linkMap.set(key, { source: s, target: t, rel: l.rel, count: 1, ...(isLensLink ? { lens: true } : {}) });
  }
  return { nodes, links: [...linkMap.values()] };
}

function colorFor(n: SnapNode, ns: NodeState | undefined, lens: ReturnType<typeof lensSet>): string {
  const p = pal();
  if (lens && !lens.focus.has(n.id)) return p.dim;
  if (lens && lens.callers.has(n.id)) return ns && ns.level >= 0.7 ? p.full : p.dark;
  if (controls.colour === 'session' && ns && n.kind === 'file') {
    const first = [...ns.sessions][0];
    return (first && state.sessionColor.get(first)) ?? p.low;
  }
  if (n.kind === 'module') return ns ? mix(p.module, '#ffffff', Math.min(0.45, ns.level * 0.45)) : p.module;
  if (n.kind === 'concept') return p.concept;
  const cat = category(n, ns);
  if (!cat) return p.idle;
  return cat === 'dark' ? p.dark : cat === 'edit' ? p.edit : cat === 'full' ? p.full : cat === 'range' ? p.range : p.low;
}
function mix(a: string, b: string, t: number): string { const pa = hex(a), pb = hex(b); return '#' + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, '0')).join(''); }
function hex(c: string): number[] { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }

function moduleStats(id: string): { total: number; touched: number; edits: number; dark: number } {
  let total = 0, touched = 0, edits = 0, dark = 0;
  for (const n of state.snapshot.nodes) {
    if (n.kind !== 'file' || n.module !== id) continue;
    total++;
    const ns = nodeState.get(n.id);
    if (ns) { touched++; edits += ns.edits; if (ns.dark && ns.level <= 0.3) dark++; }
  }
  return { total, touched, edits, dark };
}

function labelText(n: VNode): string | undefined {
  const ns = nodeState.get(n.id);
  const lens = lensSet();
  if (lens?.focus.has(n.id) && n.kind === 'file') return n.label;
  if (controls.labels === 'none') return undefined;
  if (n.kind === 'module') { const s = moduleStats(n.id); return `${n.id.replace(/^L:/, '')}  ${s.touched}/${s.total}${s.edits ? ` · ${s.edits} edits` : ''}${s.dark ? ` · ${s.dark} dark` : ''}`; }
  if (n.kind === 'concept') return n.label;
  if (controls.labels === 'all') return n.label;
  if (controls.labels === 'lit' && ns) return n.label;
  return undefined;
}
function hoverText(n: VNode): string {
  const ns = nodeState.get(n.id);
  if (n.kind === 'module') { const s = moduleStats(n.id); return `${n.id}: ${s.touched} of ${s.total} files touched, ${s.edits} edits, ${s.dark} callers dark, ${n.constraints?.length ?? 0} constraints`; }
  return `${n.id}${ns ? `  [${ns.mode}${ns.edited ? `, edited ×${ns.edits}` : ''}${ns.dark ? ', caller never loaded' : ''}; ${ns.sessions.size} session${ns.sessions.size === 1 ? '' : 's'}]` : '  (not touched)'}`;
}
const idOf = (x: string | VNode): string => (typeof x === 'string' ? x : x.id);

function rebuild(): void {
  el.innerHTML = '';
  g3 = undefined; g2 = undefined;
  fitted = false;
  const data = visibleData();
  const p = pal();
  const w = el.clientWidth, h = el.clientHeight;
  if (controls.mode === '3d') {
    const g = new ForceGraph3D(el) as unknown as G3;
    g.width(w).height(h)
      .backgroundColor(p.bg)
      .graphData(data)
      .nodeLabel((n) => hoverText(n))
      .nodeColor((n) => n.color)
      .nodeVal((n) => n.val)
      .nodeOpacity(0.95)
      .nodeResolution(12)
      .nodeThreeObjectExtend(true)
      .nodeThreeObject((n) => {
        const text = labelText(n);
        if (!text) return undefined as unknown as Object3D;
        const s = new SpriteText(text);
        s.color = n.kind === 'module' ? p.labelModule : p.label;
        s.textHeight = n.kind === 'module' ? 4.2 * controls.size : 2.6 * controls.size;
        s.position.y = (n.kind === 'module' ? 6 : 3) * controls.size;
        return s as unknown as Object3D;
      })
      .linkColor((l) => (l.lens ? p.lensLink : l.rel === 'import' ? p.link : p.contain))
      .linkOpacity(0.6)
      .linkWidth((l) => (l.lens ? 2.5 : Math.min(2.5, 0.3 + Math.log2(l.count))))
      .linkDirectionalParticles((l) => (l.lens ? 2 : 0))
      .onNodeClick((n) => select(n.id))
      .onEngineStop(() => { if (!fitted) { fitted = true; g.zoomToFit(600, 40); } });
    if (controls.bloom && !reduced) g.postProcessingComposer().addPass(new UnrealBloomPass(new Vector2(w, h), 0.9, 0.5, 0.2));
    if (controls.freeze) g.cooldownTicks(0);
    g3 = g;
  } else {
    const g = new ForceGraph(el);
    g.width(w).height(h)
      .backgroundColor(p.bg)
      .graphData(data)
      .nodeLabel((n) => hoverText(n as VNode))
      .nodeColor((n) => (n as VNode).color)
      .nodeVal((n) => (n as VNode).val)
      .nodeCanvasObjectMode(() => 'after')
      .nodeCanvasObject((node, ctx, scale) => {
        const v = node as VNode;
        if (v.x === undefined || v.y === undefined) return;
        if (v.kind === 'module') {
          // A ring around the module: the touched fraction of its files.
          const s = moduleStats(v.id);
          const r = Math.sqrt(v.val) * 2 + 3;
          ctx.beginPath(); ctx.arc(v.x, v.y, r, 0, Math.PI * 2); ctx.strokeStyle = p.idle; ctx.lineWidth = 1.5 / scale; ctx.stroke();
          if (s.total) { ctx.beginPath(); ctx.arc(v.x, v.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (s.touched / s.total)); ctx.strokeStyle = s.dark ? p.dark : p.full; ctx.lineWidth = 3 / scale; ctx.stroke(); }
        }
        const text = labelText(v);
        if (!text) return;
        const size = (v.kind === 'module' ? 12 : 9) / Math.max(0.6, scale) * Math.max(0.7, controls.size / 1.4);
        ctx.font = `${v.kind === 'module' ? '600 ' : ''}${size}px IBM Plex Sans, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = v.kind === 'module' ? p.labelModule : p.label;
        ctx.fillText(text, v.x, v.y + Math.sqrt(v.val) * 2 + 5);
      })
      .linkColor((l) => ((l as VLink).lens ? p.lensLink : (l as VLink).rel === 'import' ? p.link : p.contain))
      .linkWidth((l) => ((l as VLink).lens ? 2.5 : Math.min(2.5, 0.3 + Math.log2((l as VLink).count))))
      .onNodeClick((n) => select((n as VNode).id))
      .onEngineStop(() => { if (!fitted) { fitted = true; g.zoomToFit(600, 40); } });
    if (controls.freeze) g.cooldownTicks(0);
    g2 = g;
  }
  renderLegend();
}

function refreshGraph(): void {
  const data = visibleData();
  if (!g3 && !g2) return;
  const cur = currentNodes();
  const sameNodes = cur.length === data.nodes.length && cur.every((n) => data.nodes.some((d) => d.id === n.id));
  const curLinks = currentLinks();
  const sameLinks = curLinks.length === data.links.length;
  if (sameNodes && sameLinks) {
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const n of cur) { const d = byId.get(n.id); if (d) { n.color = d.color; n.val = d.val; } }
    if (g3) { g3.nodeColor(g3.nodeColor()); g3.nodeThreeObject(g3.nodeThreeObject()); } else g2!.nodeColor(g2!.nodeColor());
  } else if (g3) g3.graphData(data);
  else g2!.graphData(data);
}

function pulse(from: string, to: string): void {
  if (!g3) return;
  const link = currentLinks().find((l) => (idOf(l.source) === from && idOf(l.target) === to) || (idOf(l.source) === to && idOf(l.target) === from));
  if (link) g3.emitParticle(link);
}

function select(id: string): void {
  const n = nodeIndex.get(id);
  if (!n) return;
  state.selected = id;
  const ns = nodeState.get(id);
  const lines = [id, `kind ${n.kind}${n.module ? `  module ${n.module}` : ''}${n.decisions ? `  decisions ${n.decisions}` : ''}`];
  if (n.kind === 'module') {
    const s = moduleStats(id);
    lines.push(`${s.touched} of ${s.total} files touched, ${s.edits} edits, ${s.dark} callers never loaded`);
    for (const k of n.constraints ?? []) lines.push(`  [${k.mode}] ${k.id}  ${k.text}`);
    if (!n.constraints?.length) lines.push('  no constraints attached to this module');
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    lines.push('', state.expanded.has(id) ? 'expanded: all files shown' : 'collapsed: touched files only');
    state.lens = undefined;
    refreshGraph();
  } else if (n.kind === 'file') {
    if (ns) lines.push(`context ${ns.mode} (${Math.round(ns.level * 100)}%)${ns.edited ? `, edited ×${ns.edits}` : ''}${ns.dark ? ', a caller of an edited file that was never loaded' : ''}`, `sessions ${[...ns.sessions].map((s) => s.slice(0, 8)).join(', ')}`);
    else lines.push('not touched in this range');
    for (const k of n.constraints ?? []) lines.push(`  [${k.mode}] ${k.id}  ${k.text}`);
    const rows = coverageRows.filter((c) => c.path === id);
    for (const c of rows.slice(-3)) {
      lines.push('', `edit ${c.ts?.slice(11, 19) ?? ''}  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}${c.summarized_since ? '  after compaction' : ''}`);
      const darkCallers = c.callers.filter((x) => !['full', 'range', 'edit', 'write'].includes(c.loaded[x] ?? ''));
      if (darkCallers.length) lines.push(`  never loaded: ${darkCallers.map(short).join(', ')}`);
      lines.push(`  applicable: ${c.applicable.join(' ')}`);
    }
    const sl = slices.get(id);
    if (sl?.length) lines.push('', `slice injected ${sl[sl.length - 1]!.ts.slice(11, 19)}:`, sl[sl.length - 1]!.rendered.split('\n').map((l) => `  ${l}`).join('\n'));
    const ds = decisionsSeen.filter((d) => d.node.split('#')[0] === id);
    for (const d of ds) lines.push('', `decision ${d.ts.slice(11, 19)}  ${d.overrides ? `!${d.overrides}` : `->${d.serves}`}  ${d.text}`);
    if (sl?.length && ds.length) { const last = sl[sl.length - 1]!; const pointsBack = ds.some((d) => last.applicable.includes(d.serves) || (d.overrides !== undefined && last.applicable.includes(d.overrides))); lines.push('', pointsBack ? 'the decision points back at the slice that was injected' : 'the decision points outside the slice that was injected (a reach)'); }
    setLens(id);
  } else {
    lines.push(n.label);
    for (const k of n.constraints ?? []) lines.push(`  [${k.mode}] ${k.id}  ${k.text}`);
  }
  $('detail').textContent = lines.join('\n');
  renderCoverage();
  focusNode(id);
}

function setLens(id: string | undefined): void {
  state.lens = id;
  const box = $('lens');
  if (!id) { box.hidden = true; refreshGraph(); return; }
  const callers = callersOf.get(id) ?? [];
  const c = coverageRows.filter((x) => x.path === id).slice(-1)[0];
  const darkCount = callers.filter((x) => { const m = c?.loaded[x]; return !(m === 'full' || m === 'range' || m === 'edit' || m === 'write'); }).length;
  $('lens-title').textContent = short(id);
  $('lens-text').textContent = callers.length ? `${callers.length} caller${callers.length === 1 ? '' : 's'}; ${darkCount} never loaded (red), ${callers.length - darkCount} in context (teal). Everything else is dimmed.` : 'no callers in the import graph; module chain highlighted.';
  box.hidden = false;
  refreshGraph();
}

function focusNode(id: string): void {
  const node = currentNodes().find((n) => n.id === id);
  if (!node || node.x === undefined || node.y === undefined) return;
  if (g3) { const dist = 120; const r = Math.hypot(node.x, node.y, node.z ?? 0) || 1; g3.cameraPosition({ x: node.x * (1 + dist / r), y: node.y * (1 + dist / r), z: (node.z ?? 0) * (1 + dist / r) }, { x: node.x, y: node.y, z: node.z ?? 0 }, 800); }
  else if (g2) { g2.centerAt(node.x, node.y, 600); g2.zoom(3, 600); }
}

// ---- panels ---------------------------------------------------------------------------------

function renderHeadline(): void {
  const edits = coverageRows.length;
  const withSlice = coverageRows.filter((c) => c.slice_injected).length;
  const ct = coverageRows.reduce((s, c) => s + c.callers_total, 0);
  const cl = coverageRows.reduce((s, c) => s + c.callers_loaded, 0);
  const darkEdits = coverageRows.filter((c) => c.callers_total > 0 && c.callers_loaded === 0).length;
  $('h-edits').textContent = String(edits);
  $('h-slice').textContent = edits ? `${Math.round((withSlice / edits) * 100)}%` : '–';
  $('h-slice-wrap').className = `stat ${edits && withSlice === 0 ? 'warn' : withSlice === edits && edits ? 'good' : ''}`;
  $('h-callers').textContent = ct ? `${Math.round((cl / ct) * 100)}%` : '–';
  $('h-callers-wrap').className = `stat ${ct ? (cl / ct < 0.34 ? 'bad' : cl / ct < 0.67 ? 'warn' : 'good') : ''}`;
  $('h-dark').textContent = String(darkEdits);
  $('h-dark-wrap').className = `stat ${darkEdits ? 'bad' : edits ? 'good' : ''}`;
  $('h-decisions').textContent = String(decisionsSeen.length);
  $('h-decisions-wrap').className = `stat ${edits && !decisionsSeen.length && withSlice ? 'warn' : decisionsSeen.length ? 'good' : ''}`;
  $('h-reach').textContent = String(reaches);
  $('h-compact').textContent = String(compactions);
  $('h-compact-wrap').className = `stat ${compactions ? 'warn' : ''}`;
  $('h-reads').textContent = String(reads);
  const note = !edits ? 'No edits in this range. Reads alone do not change the codebase.'
    : withSlice === 0 ? 'No slices were injected: this ran observe-only, or before the plugin. The numbers describe what the session built on its own.'
    : darkEdits ? `${darkEdits} edit${darkEdits === 1 ? '' : 's'} changed a file while none of its callers were in context. Those are where locally-good becomes contextually-wrong.`
    : 'Every edit had at least one caller in context.';
  $('h-note').textContent = note;
}

function renderFindings(): void {
  const ul = $<HTMLUListElement>('findings');
  ul.innerHTML = '';
  const all = $<HTMLInputElement>('findingsAll').checked;
  const rows = findings.filter((f) => all || f.level !== 'ok').slice(-40).reverse();
  if (!rows.length) { ul.innerHTML = `<li>${findings.length ? 'nothing risky; tick "all findings" to see the rest' : 'nothing yet'}</li>`; return; }
  for (const f of rows) {
    const li = document.createElement('li');
    li.className = f.level;
    li.innerHTML = `<i>●</i> ${f.ts.slice(11, 19)} <b>${esc(f.rule)}</b> ${esc(f.message)}`;
    if (f.path) { li.style.cursor = 'pointer'; li.onclick = () => select(f.path!); }
    ul.appendChild(li);
  }
}

function renderCoverage(): void {
  const tbody = $<HTMLTableSectionElement>('coverage').querySelector('tbody')!;
  tbody.innerHTML = '';
  const byFile = new Map<string, Coverage[]>();
  for (const c of coverageRows) byFile.set(c.path, [...(byFile.get(c.path) ?? []), c]);
  let rows = [...byFile.entries()].map(([path, cs]) => {
    const last = cs[cs.length - 1]!;
    const dark = Math.max(...cs.map((c) => c.callers_total - c.callers_loaded));
    return { path, edits: cs.length, slices: cs.filter((c) => c.slice_injected).length, loaded: last.callers_loaded, total: last.callers_total, dark, risky: cs.some((c) => c.callers_total > 0 && c.callers_loaded === 0), summarized: cs.some((c) => c.summarized_since) };
  });
  if (controls.risky) rows = rows.filter((r) => r.risky || r.dark > 0 || r.summarized);
  rows.sort((a, b) => Number(b.risky) - Number(a.risky) || b.dark - a.dark || b.edits - a.edits);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">${coverageRows.length ? 'no risky edits; untick "risky only" to see all' : 'no edits with coverage in this range'}</td></tr>`; return; }
  for (const r of rows.slice(0, 80)) {
    const tr = document.createElement('tr');
    if (r.path === state.selected) tr.classList.add('selected');
    if (r.risky) tr.classList.add('risky');
    tr.innerHTML = `<td class="path" title="${esc(r.path)}">${esc(short(r.path))}${r.summarized ? ' <span class="pill">compacted</span>' : ''}</td><td>${r.edits}</td><td><span class="pill ${r.slices ? 'on' : ''}">${r.slices}/${r.edits}</span></td><td>${r.total ? `${r.loaded}/${r.total}` : '<span class="pill">none</span>'}</td><td>${r.dark ? `<span class="pill dark">${r.dark}</span>` : '<span class="pill good">0</span>'}</td>`;
    tr.onclick = () => select(r.path);
    tbody.appendChild(tr);
  }
}

function renderLegend(): void {
  const box = $('legend');
  box.innerHTML = '';
  const p = pal();
  const counts = new Map<Category, number>();
  for (const n of state.snapshot.nodes) { const c = category(n, nodeState.get(n.id)); if (c) counts.set(c, (counts.get(c) ?? 0) + 1); }
  for (const c of CATEGORIES) {
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', String(state.isolate === c.key));
    b.innerHTML = `<i style="background:${c.color(p)}"></i>${c.name} <b>${counts.get(c.key) ?? 0}</b>`;
    b.title = state.isolate === c.key ? 'showing only this category; click to show all' : 'click to show only this category';
    b.onclick = () => { state.isolate = state.isolate === c.key ? undefined : c.key; renderLegend(); refreshGraph(); };
    box.appendChild(b);
  }
  if (controls.colour === 'session') {
    for (const [s, color] of state.sessionColor) { const b = document.createElement('button'); b.innerHTML = `<i style="background:${color}"></i>${s.slice(0, 8)}`; b.onclick = () => { state.session = state.session === s ? '' : s; $<HTMLSelectElement>('session').value = state.session; replayTo(state.cursor); }; box.appendChild(b); }
  }
}

function drawTimeline(): void {
  const canvas = $<HTMLCanvasElement>('tl');
  const w = canvas.clientWidth || 600;
  const h = canvas.height;
  if (canvas.width !== w) canvas.width = w;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const p = pal();
  ctx.clearRect(0, 0, w, h);
  const evs = state.events.filter((e) => !state.session || e.session === state.session || e.t === 'finding');
  if (!evs.length) return;
  const t0 = new Date(evs[0]!.ts).getTime();
  const t1 = new Date(evs[evs.length - 1]!.ts).getTime();
  const span = Math.max(1, t1 - t0);
  const bins = Math.max(20, Math.floor(w / 4));
  const reads = new Array<number>(bins).fill(0), edits = new Array<number>(bins).fill(0), bad = new Array<number>(bins).fill(0), marks: { x: number; kind: string }[] = [];
  const binOf = (ts: string): number => Math.min(bins - 1, Math.floor(((new Date(ts).getTime() - t0) / span) * bins));
  for (const e of evs) {
    const b = binOf(e.ts);
    if (e.t === 'touch') reads[b]!++;
    else if (e.t === 'edit') edits[b]!++;
    else if (e.t === 'coverage') { const c = e.p as unknown as Coverage; if (c.callers_total > 0 && c.callers_loaded === 0) bad[b]!++; }
    else if (e.t === 'compact' || e.t === 'decision' || (e.t === 'session' && (e.p as { kind: string }).kind === 'start')) marks.push({ x: (b + 0.5) * (w / bins), kind: e.t });
  }
  const max = Math.max(1, ...reads.map((r, i) => r + edits[i]!));
  const bw = w / bins;
  for (let i = 0; i < bins; i++) {
    const rh = (reads[i]! / max) * (h - 6), eh = (edits[i]! / max) * (h - 6);
    ctx.fillStyle = p.low; ctx.fillRect(i * bw, h - 3 - rh, Math.max(1, bw - 1), rh);
    ctx.fillStyle = bad[i] ? p.dark : p.edit; ctx.fillRect(i * bw, h - 3 - rh - eh, Math.max(1, bw - 1), eh);
  }
  for (const m of marks) { ctx.fillStyle = m.kind === 'compact' ? p.edit : m.kind === 'decision' ? p.full : p.module; ctx.fillRect(m.x - 1, 0, 2, h); }
  // cursor
  const cursorEv = state.events[Math.max(0, state.cursor - 1)];
  if (cursorEv && !state.live) { const x = ((new Date(cursorEv.ts).getTime() - t0) / span) * w; ctx.fillStyle = p.labelModule; ctx.fillRect(x - 1, 0, 2, h); }
  $('tl-start').textContent = evs[0]!.ts.slice(0, 16).replace('T', ' ');
  $('tl-end').textContent = evs[evs.length - 1]!.ts.slice(11, 16);
  canvas.title = 'grey: reads · orange: edits · red: edits with all callers dark · marks: session start (purple), compaction (orange), decision (teal). Click to seek.';
}

// ---- controls -------------------------------------------------------------------------------

function short(p: string): string { const parts = p.split('/'); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; }
function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
function setStatus(text?: string): void { $('status').textContent = text ?? `${state.events.length} events · ${nodeState.size} nodes lit · ${state.snapshot.nodes.filter((n) => n.kind === 'module').length} modules, ${state.snapshot.nodes.filter((n) => n.kind === 'file').length} files`; }
function refreshTime(): void { const r = $<HTMLInputElement>('time'); r.max = String(state.events.length); if (state.live) r.value = r.max; drawTimeline(); }
function press(on: string, off: string): void { $(on).setAttribute('aria-pressed', 'true'); $(off).setAttribute('aria-pressed', 'false'); }
function applyTheme(): void { document.documentElement.dataset.theme = controls.theme; $('theme').textContent = controls.theme === 'dark' ? 'light theme' : 'dark theme'; }
function syncControls(): void {
  applyTheme();
  press(controls.mode === '3d' ? 'mode3d' : 'mode2d', controls.mode === '3d' ? 'mode2d' : 'mode3d');
  $<HTMLSelectElement>('files').value = controls.files;
  $<HTMLSelectElement>('labels').value = controls.labels;
  $<HTMLSelectElement>('links').value = controls.links;
  $<HTMLSelectElement>('colour').value = controls.colour;
  $<HTMLInputElement>('size').value = String(controls.size);
  $('bloom').setAttribute('aria-pressed', String(controls.bloom));
  $('freeze').setAttribute('aria-pressed', String(controls.freeze));
  $<HTMLSelectElement>('speed').value = String(controls.speed);
  $<HTMLInputElement>('risky').checked = controls.risky;
}

$<HTMLSelectElement>('repo').onchange = (e) => { state.repo = (e.target as HTMLSelectElement).value; resetDerived(); void loadRepo(); };
$<HTMLSelectElement>('session').onchange = (e) => { state.session = (e.target as HTMLSelectElement).value; replayTo(state.cursor); };
$('mode3d').onclick = () => { controls.mode = '3d'; save(); syncControls(); rebuild(); };
$('mode2d').onclick = () => { controls.mode = '2d'; save(); syncControls(); rebuild(); };
$<HTMLSelectElement>('files').onchange = (e) => { controls.files = (e.target as HTMLSelectElement).value as Controls['files']; save(); refreshGraph(); };
$<HTMLSelectElement>('labels').onchange = (e) => { controls.labels = (e.target as HTMLSelectElement).value as Controls['labels']; save(); rebuild(); };
$<HTMLSelectElement>('links').onchange = (e) => { controls.links = (e.target as HTMLSelectElement).value as Controls['links']; save(); refreshGraph(); };
$<HTMLSelectElement>('colour').onchange = (e) => { controls.colour = (e.target as HTMLSelectElement).value as Controls['colour']; save(); renderLegend(); refreshGraph(); };
$<HTMLInputElement>('size').oninput = (e) => { controls.size = Number((e.target as HTMLInputElement).value); save(); rebuild(); };
$('bloom').onclick = () => { controls.bloom = !controls.bloom; save(); syncControls(); rebuild(); };
$('freeze').onclick = () => { controls.freeze = !controls.freeze; save(); syncControls(); const g = g3 ?? g2; if (g) { g.cooldownTicks(controls.freeze ? 0 : Infinity); if (!controls.freeze) g.d3ReheatSimulation(); } };
$('fit').onclick = () => { (g3 ?? g2)?.zoomToFit(600, 40); };
$('theme').onclick = () => { controls.theme = controls.theme === 'dark' ? 'light' : 'dark'; save(); syncControls(); rebuild(); drawTimeline(); };
$('lens-off').onclick = () => { state.selected = undefined; setLens(undefined); renderCoverage(); $('detail').textContent = 'click a node, a row, or search'; };
$<HTMLInputElement>('risky').onchange = (e) => { controls.risky = (e.target as HTMLInputElement).checked; save(); renderCoverage(); };
$<HTMLInputElement>('findingsAll').onchange = () => renderFindings();
$<HTMLInputElement>('search').onchange = (e) => {
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  if (!q) return;
  const hit = state.snapshot.nodes.find((n) => n.id.toLowerCase() === q) ?? state.snapshot.nodes.find((n) => n.id.toLowerCase().includes(q));
  if (!hit) { $('detail').textContent = `nothing matches "${q}"`; return; }
  if (hit.kind === 'file' && !nodeState.has(hit.id) && controls.files === 'touched') { if (hit.module) state.expanded.add(hit.module); refreshGraph(); }
  setTimeout(() => select(hit.id), 50);
};
$<HTMLSelectElement>('speed').onchange = (e) => { controls.speed = Number((e.target as HTMLSelectElement).value); save(); };
$('live').onclick = () => { stopPlay(); state.live = true; $('live').setAttribute('aria-pressed', 'true'); state.cursor = state.events.length; $('timeLabel').textContent = 'live'; replayTo(state.cursor); refreshTime(); };
$<HTMLInputElement>('time').oninput = (e) => { stopPlay(); state.live = false; $('live').setAttribute('aria-pressed', 'false'); state.cursor = Number((e.target as HTMLInputElement).value); const ev = state.events[state.cursor - 1]; $('timeLabel').textContent = ev ? ev.ts.slice(11, 19) : 'start'; replayTo(state.cursor); };
$<HTMLCanvasElement>('tl').onclick = (e) => {
  const canvas = e.currentTarget as HTMLCanvasElement;
  const frac = (e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth;
  const evs = state.events;
  if (!evs.length) return;
  const t0 = new Date(evs[0]!.ts).getTime(), t1 = new Date(evs[evs.length - 1]!.ts).getTime();
  const target = t0 + frac * (t1 - t0);
  let idx = evs.findIndex((x) => new Date(x.ts).getTime() >= target);
  if (idx < 0) idx = evs.length;
  stopPlay(); state.live = false; $('live').setAttribute('aria-pressed', 'false');
  state.cursor = idx; $<HTMLInputElement>('time').value = String(idx);
  const ev = evs[idx - 1]; $('timeLabel').textContent = ev ? ev.ts.slice(11, 19) : 'start';
  replayTo(idx);
};
$('play').onclick = () => {
  if (state.playing) { stopPlay(); return; }
  state.live = false; $('live').setAttribute('aria-pressed', 'false');
  if (state.cursor >= state.events.length) { state.cursor = 0; replayTo(0); }
  $('play').textContent = 'pause';
  state.playing = window.setInterval(() => {
    const step = Math.max(1, Math.round(controls.speed / 10));
    const next = Math.min(state.events.length, state.cursor + step);
    for (let i = state.cursor; i < next; i++) applyEvent(state.events[i]!, true);
    state.cursor = next;
    $<HTMLInputElement>('time').value = String(next);
    const ev = state.events[next - 1]; $('timeLabel').textContent = ev ? ev.ts.slice(11, 19) : 'start';
    refreshPanels();
    if (next >= state.events.length) stopPlay();
  }, 100);
};
function stopPlay(): void { if (state.playing) { clearInterval(state.playing); state.playing = undefined; } $('play').textContent = 'play'; }

window.addEventListener('resize', () => { const g = g3 ?? g2; if (g) g.width(el.clientWidth).height(el.clientHeight); drawTimeline(); });

void (async () => {
  syncControls();
  try {
    await loadRepos();
    await loadRepo();
  } catch (e) {
    setStatus(`error: ${(e as Error).message}`);
  }
})();
