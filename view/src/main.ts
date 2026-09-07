import ForceGraph3D from '3d-force-graph';
import ForceGraph from 'force-graph';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Vector2 } from 'three';

/**
 * The synapse view (design spec §14). Reads the server's graph snapshot and event stream and
 * shows what context each session actually built: brightness by how much of a file entered
 * context, colour by access mode, a pulse on edits, and the applicable files that stayed dark.
 * Collapsed to modules by default; a module expands when clicked or when a session touches it.
 */

type Kind = 'file' | 'module' | 'concept';
interface SnapNode { id: string; kind: Kind; label: string; module?: string; size: number }
interface SnapLink { source: string; target: string; rel: 'import' | 'in' | 'impl' }
interface Snapshot { root?: string; nodes: SnapNode[]; links: SnapLink[]; error?: string }
interface Env { t: string; ts: string; session: string; who: string; branch: string; seq?: number; p: Record<string, unknown> }
interface Coverage { path: string; applicable: string[]; loaded: Record<string, string>; callers: string[]; callers_loaded: number; callers_total: number; slice_injected: boolean; summarized_since: boolean; dark: string[]; session?: string; ts?: string; seq?: number }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE_LEVEL: Record<string, number> = { full: 1, write: 1, edit: 0.95, range: 0.7, delegated: 0.45, grep: 0.35, summarized: 0.25, name: 0.2, external: 0.1, failed: 0.1, delete: 0.1 };
const COLORS = { full: '#56bcc0', range: '#2d7f82', low: '#3b4b5e', edit: '#e3a65c', dark: '#ff6b6b', module: '#7c6cf0', concept: '#b48ef0', idle: '#1c2633', link: 'rgba(120,140,170,0.18)', contain: 'rgba(124,108,240,0.25)' };
const SESSION_COLORS = ['#56bcc0', '#e3a65c', '#7c6cf0', '#f06c9b', '#8de07a', '#f0d36c'];

interface State {
  repo: string;
  snapshot: Snapshot;
  events: Env[];
  session: string;
  mode: '3d' | '2d';
  collapsed: boolean;
  expanded: Set<string>;
  live: boolean;
  cursor: number;
  ws?: WebSocket;
}
const state: State = { repo: '', snapshot: { nodes: [], links: [] }, events: [], session: '', mode: '3d', collapsed: true, expanded: new Set(), live: true, cursor: 0 };

// ---- data --------------------------------------------------------------------------------

async function api<T>(path: string): Promise<T> {
  const r = await fetch(path);
  return (await r.json()) as T;
}

async function loadRepos(): Promise<void> {
  const repos = await api<{ hash: string; root: string | null; sessions: number }[]>('/v1/repos');
  const sel = $<HTMLSelectElement>('repo');
  sel.innerHTML = '';
  for (const r of repos) { const o = document.createElement('option'); o.value = r.hash; o.textContent = `${r.root ? r.root.split('/').pop() : r.hash} (${r.sessions} sessions)`; sel.appendChild(o); }
  const params = new URLSearchParams(location.search);
  state.repo = params.get('repo') ?? repos[0]?.hash ?? '';
  sel.value = state.repo;
}

async function loadRepo(): Promise<void> {
  if (!state.repo) return;
  state.snapshot = await api<Snapshot>(`/v1/${state.repo}/graph`);
  const sessions = await api<{ session: string; who: string; branch: string; last: string }[]>(`/v1/${state.repo}/sessions`);
  const sel = $<HTMLSelectElement>('session');
  sel.innerHTML = '<option value="">all sessions</option>';
  sessions.forEach((s, i) => { const o = document.createElement('option'); o.value = s.session; o.textContent = `${s.session.slice(0, 8)} ${s.who} ${s.branch}`; o.style.color = SESSION_COLORS[i % SESSION_COLORS.length]!; sel.appendChild(o); });
  state.events = await api<Env[]>(`/v1/${state.repo}/events`);
  state.cursor = state.events.length;
  connect();
  await loadEvolution();
  rebuild();
  setStatus();
}

function connect(): void {
  state.ws?.close();
  const last = state.events[state.events.length - 1]?.seq ?? 0;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/${state.repo}/stream?since=${last}`);
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data as string) as Env;
    if (e.t === 'ready') return;
    state.events.push(e);
    if (state.live) { state.cursor = state.events.length; applyEvent(e, true); refreshTime(); setStatus(); }
  };
  ws.onclose = () => { setStatus('disconnected'); setTimeout(() => { if (state.ws === ws) connect(); }, 3000); };
  state.ws = ws;
}

async function loadEvolution(): Promise<void> {
  const data = await api<{ decisions: { id: string; date: string; who: string; node: string; serves: string; overrides?: string; text: string; active: boolean; archived: boolean }[]; retirements: { target: string; date: string; reason: string }[] } | []>(`/v1/${state.repo}/decisions`);
  const ul = $<HTMLUListElement>('evolution');
  ul.innerHTML = '';
  if (Array.isArray(data)) return;
  const rows = [...data.decisions.map((d) => ({ date: d.date, html: `<b>${d.id}</b> ${d.who} on ${short(d.node)} → ${d.serves}${d.overrides ? ` <span class="pill dark">!${d.overrides}</span>` : ''}${d.active ? '' : ' <span class="pill">superseded</span>'}${d.archived ? ' <span class="pill">archived</span>' : ''}<br>${escapeHtml(d.text)}` })), ...data.retirements.map((z) => ({ date: z.date, html: `<b>retired</b> ${z.target}: ${escapeHtml(z.reason)}` }))].sort((a, b) => a.date.localeCompare(b.date));
  for (const r of rows.slice(-60)) { const li = document.createElement('li'); li.innerHTML = `${r.date} ${r.html}`; ul.appendChild(li); }
}

// ---- state derived from events ------------------------------------------------------------

interface NodeState { level: number; mode: string; edited: boolean; dark: boolean; sessions: Set<string>; lastTs: string }
const nodeState = new Map<string, NodeState>();
const coverageRows: Coverage[] = [];
let lastTouched: string | undefined;

function resetDerived(): void { nodeState.clear(); coverageRows.length = 0; lastTouched = undefined; }

function applyEvent(e: Env, animate: boolean): void {
  if (state.session && e.session !== state.session && e.t !== 'finding') return;
  if (e.t === 'touch' || e.t === 'edit') {
    const p = e.p as { path: string; mode: string; origin?: string };
    const mode = p.origin === 'subagent' ? 'delegated' : p.mode;
    const ns = nodeState.get(p.path) ?? { level: 0, mode, edited: false, dark: false, sessions: new Set(), lastTs: e.ts };
    const level = MODE_LEVEL[mode] ?? 0.2;
    if (level >= ns.level) { ns.level = level; ns.mode = mode; }
    if (e.t === 'edit') ns.edited = true;
    ns.dark = false;
    ns.sessions.add(e.session);
    ns.lastTs = e.ts;
    nodeState.set(p.path, ns);
    const mod = moduleOf(p.path);
    if (mod) { state.expanded.add(mod); const ms = nodeState.get(mod) ?? { level: 0, mode: 'module', edited: false, dark: false, sessions: new Set(), lastTs: e.ts }; ms.level = Math.max(ms.level, level * 0.6); ms.sessions.add(e.session); nodeState.set(mod, ms); }
    if (animate && !reduced && e.t === 'edit' && lastTouched && lastTouched !== p.path) pulse(lastTouched, p.path);
    lastTouched = p.path;
    if (animate) scheduleRefresh();
  } else if (e.t === 'coverage') {
    const c = e.p as unknown as Coverage;
    c.session = e.session; c.ts = e.ts; c.seq = e.seq;
    coverageRows.push(c);
    for (const d of c.dark) { const ns = nodeState.get(d) ?? { level: 0.15, mode: 'dark', edited: false, dark: true, sessions: new Set(), lastTs: e.ts }; ns.dark = !nodeState.has(d) || ns.level < 0.3; nodeState.set(d, ns); }
    if (animate) renderCoverage();
  } else if (e.t === 'compact') {
    for (const p of (e.p as { paths: string[] }).paths) { const ns = nodeState.get(p); if (ns && ns.level > 0.25) { ns.level = 0.25; ns.mode = 'summarized'; } }
    if (animate) scheduleRefresh();
  }
}

function replayTo(cursor: number): void {
  resetDerived();
  for (let i = 0; i < cursor && i < state.events.length; i++) applyEvent(state.events[i]!, false);
  renderCoverage();
  refreshGraph();
}

// ---- graph rendering ------------------------------------------------------------------------

type G3 = ReturnType<typeof ForceGraph3D>;
type G2 = ReturnType<typeof ForceGraph>;
let g3: G3 | undefined;
let g2: G2 | undefined;
const el = $<HTMLDivElement>('graph');
let refreshTimer: number | undefined;

function scheduleRefresh(): void { if (refreshTimer) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; refreshGraph(); }, 120); }

function moduleOf(path: string): string | undefined { return state.snapshot.nodes.find((n) => n.id === path)?.module; }

function visibleData(): { nodes: (SnapNode & { color: string; val: number })[]; links: { source: string; target: string; rel: string; count: number }[] } {
  const snap = state.snapshot;
  const showFiles = !state.collapsed || snap.nodes.length <= 1500;
  const visible = new Set<string>();
  const nodes: (SnapNode & { color: string; val: number })[] = [];
  for (const n of snap.nodes) {
    const ns = nodeState.get(n.id);
    const show = n.kind !== 'file' || showFiles || (n.module ? state.expanded.has(n.module) : true) || ns !== undefined;
    if (!show) continue;
    visible.add(n.id);
    nodes.push({ ...n, color: colorFor(n, ns), val: n.kind === 'module' ? Math.max(3, Math.sqrt(n.size) * 2) : n.size });
  }
  const linkMap = new Map<string, { source: string; target: string; rel: string; count: number }>();
  for (const l of snap.links) {
    let s = l.source, t = l.target;
    if (!visible.has(s)) { const m = moduleOf(s); if (!m || !visible.has(m) || l.rel === 'in') continue; s = m; }
    if (!visible.has(t)) { const m = moduleOf(t); if (!m || !visible.has(m) || l.rel === 'in') continue; t = m; }
    if (s === t) continue;
    const key = `${s} ${t} ${l.rel}`;
    const cur = linkMap.get(key);
    if (cur) cur.count++; else linkMap.set(key, { source: s, target: t, rel: l.rel, count: 1 });
  }
  return { nodes, links: [...linkMap.values()] };
}

function colorFor(n: SnapNode, ns: NodeState | undefined): string {
  if (n.kind === 'module') return ns ? mix(COLORS.module, '#ffffff', Math.min(0.5, ns.level * 0.5)) : COLORS.module;
  if (n.kind === 'concept') return COLORS.concept;
  if (!ns) return COLORS.idle;
  if (ns.dark && ns.level <= 0.3) return COLORS.dark;
  if (ns.edited) return COLORS.edit;
  const base = ns.level >= 1 ? COLORS.full : ns.level >= 0.7 ? COLORS.range : COLORS.low;
  const sessionIdx = state.session ? -1 : [...ns.sessions].length > 1 ? 0 : -1;
  return sessionIdx >= 0 ? mix(base, '#ffffff', 0.15) : base;
}

function mix(a: string, b: string, t: number): string {
  const pa = hex(a), pb = hex(b);
  return '#' + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, '0')).join('');
}
function hex(c: string): number[] { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }

function nodeLabel(n: SnapNode): string {
  const ns = nodeState.get(n.id);
  return `${n.id}${ns ? `  [${ns.mode}${ns.edited ? ', edited' : ''}${ns.dark ? ', applicable but never loaded' : ''}]` : ''}`;
}

function rebuild(): void {
  el.innerHTML = '';
  g3 = undefined; g2 = undefined;
  const data = visibleData();
  if (state.mode === '3d') {
    g3 = ForceGraph3D()(el)
      .backgroundColor('#0b0f14')
      .graphData(data)
      .nodeLabel((n) => nodeLabel(n as SnapNode))
      .nodeColor((n) => (n as { color: string }).color)
      .nodeVal((n) => (n as { val: number }).val)
      .nodeOpacity(0.92)
      .linkColor((l) => ((l as { rel: string }).rel === 'import' ? COLORS.link : COLORS.contain))
      .linkWidth((l) => Math.min(3, 0.4 + Math.log2((l as { count: number }).count)))
      .linkDirectionalParticles(0)
      .onNodeClick((n) => select(n as SnapNode));
    if (!reduced) {
      const bloom = new UnrealBloomPass(new Vector2(el.clientWidth, el.clientHeight), 1.1, 0.6, 0.15);
      g3.postProcessingComposer().addPass(bloom);
    }
  } else {
    g2 = ForceGraph()(el)
      .backgroundColor('#0b0f14')
      .graphData(data)
      .nodeLabel((n) => nodeLabel(n as SnapNode))
      .nodeColor((n) => (n as { color: string }).color)
      .nodeVal((n) => (n as { val: number }).val)
      .linkColor((l) => ((l as { rel: string }).rel === 'import' ? COLORS.link : COLORS.contain))
      .linkWidth((l) => Math.min(3, 0.4 + Math.log2((l as { count: number }).count)))
      .onNodeClick((n) => select(n as SnapNode));
  }
  renderCoverage();
}

function refreshGraph(): void {
  const data = visibleData();
  const g = g3 ?? g2;
  if (!g) return;
  const cur = g.graphData() as { nodes: { id: string }[]; links: { source: { id?: string } | string; target: { id?: string } | string }[] };
  const sameNodes = cur.nodes.length === data.nodes.length && cur.nodes.every((n) => data.nodes.some((d) => d.id === n.id));
  if (sameNodes) {
    // Keep positions: update colours in place, only the visual props change.
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const n of cur.nodes as (SnapNode & { color: string; val: number })[]) { const d = byId.get(n.id); if (d) { n.color = d.color; n.val = d.val; } }
    if (g3) g3.nodeColor(g3.nodeColor()); else g2!.nodeColor(g2!.nodeColor());
  } else {
    g.graphData(data);
  }
}

function pulse(from: string, to: string): void {
  const g = g3 ?? g2;
  if (!g) return;
  const links = (g.graphData() as { links: { source: { id?: string } | string; target: { id?: string } | string }[] }).links;
  const id = (x: { id?: string } | string): string => (typeof x === 'string' ? x : x.id ?? '');
  const link = links.find((l) => (id(l.source) === from && id(l.target) === to) || (id(l.source) === to && id(l.target) === from));
  if (link && g3) g3.emitParticle(link as never);
}

function select(n: SnapNode): void {
  const ns = nodeState.get(n.id);
  const rows = coverageRows.filter((c) => c.path === n.id);
  const lines = [n.id, `kind ${n.kind}${n.module ? `  module ${n.module}` : ''}`];
  if (ns) lines.push(`context ${ns.mode} (${Math.round(ns.level * 100)}%)${ns.edited ? ', edited' : ''}${ns.dark ? ', applicable but never loaded' : ''}`, `sessions ${[...ns.sessions].map((s) => s.slice(0, 8)).join(', ')}`);
  for (const c of rows.slice(-3)) lines.push('', `edit ${c.ts?.slice(11, 19) ?? ''}  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}  dark ${c.dark.length}`, `applicable: ${c.applicable.join(' ')}`, `loaded: ${Object.entries(c.loaded).map(([p, m]) => `${short(p)}:${m}`).join(' ')}`);
  if (n.kind === 'module') { if (state.expanded.has(n.id)) state.expanded.delete(n.id); else state.expanded.add(n.id); refreshGraph(); lines.push('', state.expanded.has(n.id) ? 'expanded' : 'collapsed'); }
  $('detail').textContent = lines.join('\n');
}

function renderCoverage(): void {
  const tbody = $<HTMLTableSectionElement>('coverage').querySelector('tbody')!;
  tbody.innerHTML = '';
  for (const c of coverageRows.slice(-40).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="path" title="${c.path}">${short(c.path)}</td><td><span class="pill ${c.slice_injected ? 'on' : ''}">${c.slice_injected ? 'yes' : 'no'}</span></td><td>${c.callers_loaded}/${c.callers_total}</td><td>${c.dark.length ? `<span class="pill dark">${c.dark.length}</span>` : '0'}</td>`;
    tr.onclick = () => { const n = state.snapshot.nodes.find((x) => x.id === c.path); if (n) select(n); for (const r of tbody.querySelectorAll('tr')) r.classList.remove('selected'); tr.classList.add('selected'); };
    tbody.appendChild(tr);
  }
}

// ---- controls -------------------------------------------------------------------------------

function short(p: string): string { const parts = p.split('/'); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; }
function escapeHtml(s: string): string { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)); }
function setStatus(text?: string): void { $('status').textContent = text ?? `${state.events.length} events · ${coverageRows.length} edits · ${nodeState.size} nodes lit`; }
function refreshTime(): void { const r = $<HTMLInputElement>('time'); r.max = String(state.events.length); if (state.live) r.value = r.max; }

$<HTMLSelectElement>('repo').onchange = (e) => { state.repo = (e.target as HTMLSelectElement).value; resetDerived(); void loadRepo(); };
$<HTMLSelectElement>('session').onchange = (e) => { state.session = (e.target as HTMLSelectElement).value; replayTo(state.cursor); };
$('mode3d').onclick = () => { state.mode = '3d'; press('mode3d', 'mode2d'); rebuild(); };
$('mode2d').onclick = () => { state.mode = '2d'; press('mode2d', 'mode3d'); rebuild(); };
$('collapse').onclick = () => { state.collapsed = !state.collapsed; $('collapse').setAttribute('aria-pressed', String(state.collapsed)); $('collapse').textContent = state.collapsed ? 'modules' : 'files'; refreshGraph(); };
$('live').onclick = () => { state.live = true; $('live').setAttribute('aria-pressed', 'true'); state.cursor = state.events.length; $('timeLabel').textContent = 'live'; replayTo(state.cursor); refreshTime(); };
$<HTMLInputElement>('time').oninput = (e) => { state.live = false; $('live').setAttribute('aria-pressed', 'false'); state.cursor = Number((e.target as HTMLInputElement).value); const ev = state.events[state.cursor - 1]; $('timeLabel').textContent = ev ? ev.ts.slice(11, 19) : 'start'; replayTo(state.cursor); };
function press(on: string, off: string): void { $(on).setAttribute('aria-pressed', 'true'); $(off).setAttribute('aria-pressed', 'false'); }

window.addEventListener('resize', () => { const g = g3 ?? g2; if (g) g.width(el.clientWidth).height(el.clientHeight); });

void (async () => {
  try {
    await loadRepos();
    await loadRepo();
    replayTo(state.cursor);
    refreshTime();
  } catch (e) {
    setStatus(`error: ${(e as Error).message}`);
  }
})();
