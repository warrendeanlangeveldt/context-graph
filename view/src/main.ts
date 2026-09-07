import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import ForceGraph from 'force-graph';
import SpriteText from 'three-spritetext';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Vector2, type Object3D } from 'three';

/**
 * The synapse view (design spec §14). Reads the server's graph snapshot and event stream and
 * shows what context each session actually built: brightness by how much of a file entered
 * context, colour by access mode, a pulse on edits, and the applicable files that stayed dark.
 * Modules are always shown and labelled; files appear when a session touched them, or all of
 * them on request. Every visual choice is a control, and the controls persist per browser.
 */

type Kind = 'file' | 'module' | 'concept';
interface SnapNode { id: string; kind: Kind; label: string; module?: string; size: number }
interface SnapLink { source: string; target: string; rel: 'import' | 'in' | 'impl' }
interface Snapshot { root?: string; nodes: SnapNode[]; links: SnapLink[]; error?: string }
interface Env { t: string; ts: string; session: string; who: string; branch: string; seq?: number; p: Record<string, unknown> }
interface Coverage { path: string; applicable: string[]; loaded: Record<string, string>; callers: string[]; callers_loaded: number; callers_total: number; slice_injected: boolean; summarized_since: boolean; dark: string[]; session?: string; ts?: string }
interface VNode { id: string; kind: Kind; label: string; module?: string; size: number; color: string; val: number; x?: number; y?: number; z?: number }
interface VLink { source: string | VNode; target: string | VNode; rel: string; count: number }
type G3 = ForceGraph3DInstance<VNode, VLink>;
type G2 = InstanceType<typeof ForceGraph>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE_LEVEL: Record<string, number> = { full: 1, write: 1, edit: 0.95, range: 0.7, delegated: 0.45, grep: 0.35, summarized: 0.25, name: 0.2, external: 0.1, failed: 0.1, delete: 0.1 };

interface Palette { bg: string; idle: string; full: string; range: string; low: string; edit: string; dark: string; module: string; concept: string; link: string; contain: string; label: string; labelModule: string }
const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: '#151b24', idle: '#3d4a5c', full: '#5fd3d8', range: '#3fa3a8', low: '#7a8aa0', edit: '#f0b25c', dark: '#ff7b7b', module: '#9b8cff', concept: '#c9a3ff', link: 'rgba(150,170,200,0.28)', contain: 'rgba(155,140,255,0.35)', label: '#c9d2dd', labelModule: '#eef1f6' },
  light: { bg: '#f2f4f7', idle: '#b9c2ce', full: '#0e8f95', range: '#3c7f83', low: '#6b7a8c', edit: '#c47a10', dark: '#c2413b', module: '#5b4bd6', concept: '#8b5cf6', link: 'rgba(60,80,110,0.25)', contain: 'rgba(91,75,214,0.35)', label: '#33404f', labelModule: '#18202b' },
};

interface Controls { theme: 'dark' | 'light'; mode: '3d' | '2d'; files: 'touched' | 'all'; labels: 'modules' | 'lit' | 'all' | 'none'; links: 'containment' | 'imports' | 'both' | 'none'; size: number; bloom: boolean; freeze: boolean; speed: number }
const DEFAULTS: Controls = { theme: 'dark', mode: '3d', files: 'touched', labels: 'modules', links: 'containment', size: 1.4, bloom: false, freeze: false, speed: 20 };
const controls: Controls = { ...DEFAULTS, ...load() };

interface State { repo: string; snapshot: Snapshot; events: Env[]; session: string; expanded: Set<string>; live: boolean; cursor: number; ws?: WebSocket; selected?: string; playing?: number }
const state: State = { repo: '', snapshot: { nodes: [], links: [] }, events: [], session: '', expanded: new Set(), live: true, cursor: 0 };

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
  for (const s of sessions) { const o = document.createElement('option'); o.value = s.session; o.textContent = `${s.session.slice(0, 8)}  ${s.who}  ${s.branch}  (${s.events})`; sel.appendChild(o); }
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
    if (state.live) { state.cursor = state.events.length; applyEvent(e, true); refreshTime(); setStatus(); }
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
    if (mod) { const ms = nodeState.get(mod) ?? { level: 0, mode: 'module', edited: false, dark: false, sessions: new Set(), lastTs: e.ts }; ms.level = Math.max(ms.level, level * 0.6); ms.sessions.add(e.session); nodeState.set(mod, ms); }
    if (animate && !reduced && e.t === 'edit' && lastTouched && lastTouched !== p.path) pulse(lastTouched, p.path);
    lastTouched = p.path;
    if (animate) scheduleRefresh();
  } else if (e.t === 'coverage') {
    const c = e.p as unknown as Coverage;
    c.session = e.session; c.ts = e.ts;
    coverageRows.push(c);
    for (const d of c.dark) if (!nodeState.has(d)) nodeState.set(d, { level: 0.15, mode: 'dark', edited: false, dark: true, sessions: new Set([e.session]), lastTs: e.ts });
    if (animate) { renderCoverage(); scheduleRefresh(); }
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
  setStatus();
}

// ---- graph rendering ------------------------------------------------------------------------

let g3: G3 | undefined;
let g2: G2 | undefined;
const el = $<HTMLDivElement>('graph');
let refreshTimer: number | undefined;
const nodeIndex = new Map<string, SnapNode>();

function scheduleRefresh(): void { if (refreshTimer) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; refreshGraph(); }, 120); }
function moduleOf(path: string): string | undefined { return nodeIndex.get(path)?.module; }
function currentNodes(): VNode[] { return ((g3 ?? g2)?.graphData().nodes ?? []) as VNode[]; }
function currentLinks(): VLink[] { return ((g3 ?? g2)?.graphData().links ?? []) as VLink[]; }

function visibleData(): { nodes: VNode[]; links: VLink[] } {
  const snap = state.snapshot;
  nodeIndex.clear();
  for (const n of snap.nodes) nodeIndex.set(n.id, n);
  const visible = new Set<string>();
  const nodes: VNode[] = [];
  for (const n of snap.nodes) {
    const ns = nodeState.get(n.id);
    const show = n.kind !== 'file' || controls.files === 'all' || ns !== undefined || (n.module !== undefined && state.expanded.has(n.module));
    if (!show) continue;
    visible.add(n.id);
    const base = n.kind === 'module' ? 4 + Math.sqrt(n.size) : n.kind === 'concept' ? 3 : ns ? 1.6 : 0.9;
    nodes.push({ ...n, color: colorFor(n, ns), val: base * controls.size });
  }
  const linkMap = new Map<string, VLink>();
  const wantImports = controls.links === 'imports' || controls.links === 'both';
  const wantContain = controls.links === 'containment' || controls.links === 'both';
  for (const l of snap.links) {
    if (l.rel === 'import' && !wantImports) continue;
    if ((l.rel === 'in' || l.rel === 'impl') && !wantContain) continue;
    let s = l.source, t = l.target;
    if (!visible.has(s)) { const m = moduleOf(s); if (!m || !visible.has(m) || l.rel === 'in') continue; s = m; }
    if (!visible.has(t)) { const m = moduleOf(t); if (!m || !visible.has(m) || l.rel === 'in') continue; t = m; }
    if (s === t) continue;
    const key = `${s} ${t} ${l.rel}`;
    const cur = linkMap.get(key);
    if (cur) cur.count++; else linkMap.set(key, { source: s, target: t, rel: l.rel, count: 1 });
  }
  return { nodes, links: [...linkMap.values()] };
}

function colorFor(n: SnapNode, ns: NodeState | undefined): string {
  const p = pal();
  if (n.kind === 'module') return ns ? mix(p.module, '#ffffff', Math.min(0.45, ns.level * 0.45)) : p.module;
  if (n.kind === 'concept') return p.concept;
  if (!ns) return p.idle;
  if (ns.dark && ns.level <= 0.3) return p.dark;
  if (ns.edited) return p.edit;
  return ns.level >= 1 ? p.full : ns.level >= 0.7 ? p.range : p.low;
}
function mix(a: string, b: string, t: number): string { const pa = hex(a), pb = hex(b); return '#' + pa.map((v, i) => Math.round(v + (pb[i]! - v) * t).toString(16).padStart(2, '0')).join(''); }
function hex(c: string): number[] { return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)); }

function labelText(n: VNode): string | undefined {
  const ns = nodeState.get(n.id);
  if (controls.labels === 'none') return undefined;
  if (n.kind !== 'file') return n.kind === 'module' ? n.id.replace(/^L:/, '') : n.label;
  if (controls.labels === 'all') return n.label;
  if (controls.labels === 'lit' && ns) return n.label;
  return undefined;
}
function hoverText(n: VNode): string {
  const ns = nodeState.get(n.id);
  return `${n.id}${ns ? `  [${ns.mode}${ns.edited ? ', edited' : ''}${ns.dark ? ', applicable but never loaded' : ''}]` : ''}`;
}
const idOf = (x: string | VNode): string => (typeof x === 'string' ? x : x.id);

let fitted = false;

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
        s.textHeight = n.kind === 'module' ? 4.5 * controls.size : 2.6 * controls.size;
        s.position.y = (n.kind === 'module' ? 6 : 3) * controls.size;
        return s as unknown as Object3D;
      })
      .linkColor((l) => (l.rel === 'import' ? p.link : p.contain))
      .linkOpacity(0.6)
      .linkWidth((l) => Math.min(2.5, 0.3 + Math.log2(l.count)))
      .linkDirectionalParticles(0)
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
        const text = labelText(v);
        if (!text || v.x === undefined || v.y === undefined) return;
        const size = (v.kind === 'module' ? 12 : 9) / Math.max(0.6, scale) * Math.max(0.7, controls.size / 1.4);
        ctx.font = `${v.kind === 'module' ? '600 ' : ''}${size}px IBM Plex Sans, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = v.kind === 'module' ? p.labelModule : p.label;
        ctx.fillText(text, v.x, v.y + Math.sqrt(v.val) * 2 + 2);
      })
      .linkColor((l) => ((l as VLink).rel === 'import' ? p.link : p.contain))
      .linkWidth((l) => Math.min(2.5, 0.3 + Math.log2((l as VLink).count)))
      .onNodeClick((n) => select((n as VNode).id))
      .onEngineStop(() => { if (!fitted) { fitted = true; g.zoomToFit(600, 40); } });
    if (controls.freeze) g.cooldownTicks(0);
    g2 = g;
  }
  renderCoverage();
}

function refreshGraph(): void {
  const data = visibleData();
  if (!g3 && !g2) return;
  const cur = currentNodes();
  const sameNodes = cur.length === data.nodes.length && cur.every((n) => data.nodes.some((d) => d.id === n.id));
  if (sameNodes) {
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
  const rows = coverageRows.filter((c) => c.path === id);
  const lines = [id, `kind ${n.kind}${n.module ? `  module ${n.module}` : ''}`];
  if (ns) lines.push(`context ${ns.mode} (${Math.round(ns.level * 100)}%)${ns.edited ? ', edited' : ''}${ns.dark ? ', applicable but never loaded' : ''}`, `sessions ${[...ns.sessions].map((s) => s.slice(0, 8)).join(', ')}`);
  for (const c of rows.slice(-3)) lines.push('', `edit ${c.ts?.slice(11, 19) ?? ''}  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}  dark ${c.dark.length}`, `applicable: ${c.applicable.join(' ')}`, `loaded: ${Object.entries(c.loaded).map(([p, m]) => `${short(p)}:${m}`).join(' ')}`);
  if (n.kind === 'module') { if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id); refreshGraph(); lines.push('', state.expanded.has(id) ? 'expanded: all files shown' : 'collapsed: touched files only'); }
  $('detail').textContent = lines.join('\n');
  focusNode(id);
}

function focusNode(id: string): void {
  const node = currentNodes().find((n) => n.id === id);
  if (!node || node.x === undefined || node.y === undefined) return;
  if (g3) { const dist = 120; const r = Math.hypot(node.x, node.y, node.z ?? 0) || 1; g3.cameraPosition({ x: node.x * (1 + dist / r), y: node.y * (1 + dist / r), z: (node.z ?? 0) * (1 + dist / r) }, { x: node.x, y: node.y, z: node.z ?? 0 }, 800); }
  else if (g2) { g2.centerAt(node.x, node.y, 600); g2.zoom(3, 600); }
}

function renderCoverage(): void {
  const tbody = $<HTMLTableSectionElement>('coverage').querySelector('tbody')!;
  tbody.innerHTML = '';
  if (!coverageRows.length) { tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">no edits with coverage in this range</td></tr>'; return; }
  for (const c of coverageRows.slice(-60).reverse()) {
    const tr = document.createElement('tr');
    if (c.path === state.selected) tr.classList.add('selected');
    tr.innerHTML = `<td class="path" title="${esc(c.path)}">${esc(short(c.path))}</td><td><span class="pill ${c.slice_injected ? 'on' : ''}">${c.slice_injected ? 'yes' : 'no'}</span></td><td>${c.callers_loaded}/${c.callers_total}</td><td>${c.dark.length ? `<span class="pill dark">${c.dark.length}</span>` : '0'}</td>`;
    tr.onclick = () => { select(c.path); for (const r of tbody.querySelectorAll('tr')) r.classList.remove('selected'); tr.classList.add('selected'); };
    tbody.appendChild(tr);
  }
}

// ---- controls -------------------------------------------------------------------------------

function short(p: string): string { const parts = p.split('/'); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; }
function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
function setStatus(text?: string): void { $('status').textContent = text ?? `${state.events.length} events · ${coverageRows.length} edits · ${nodeState.size} nodes lit · ${state.snapshot.nodes.filter((n) => n.kind === 'module').length} modules, ${state.snapshot.nodes.filter((n) => n.kind === 'file').length} files`; }
function refreshTime(): void { const r = $<HTMLInputElement>('time'); r.max = String(state.events.length); if (state.live) r.value = r.max; }
function press(on: string, off: string): void { $(on).setAttribute('aria-pressed', 'true'); $(off).setAttribute('aria-pressed', 'false'); }
function applyTheme(): void { document.documentElement.dataset.theme = controls.theme; $('theme').textContent = controls.theme === 'dark' ? 'light theme' : 'dark theme'; }
function syncControls(): void {
  applyTheme();
  press(controls.mode === '3d' ? 'mode3d' : 'mode2d', controls.mode === '3d' ? 'mode2d' : 'mode3d');
  $<HTMLSelectElement>('files').value = controls.files;
  $<HTMLSelectElement>('labels').value = controls.labels;
  $<HTMLSelectElement>('links').value = controls.links;
  $<HTMLInputElement>('size').value = String(controls.size);
  $('bloom').setAttribute('aria-pressed', String(controls.bloom));
  $('freeze').setAttribute('aria-pressed', String(controls.freeze));
  $<HTMLSelectElement>('speed').value = String(controls.speed);
}

$<HTMLSelectElement>('repo').onchange = (e) => { state.repo = (e.target as HTMLSelectElement).value; resetDerived(); void loadRepo(); };
$<HTMLSelectElement>('session').onchange = (e) => { state.session = (e.target as HTMLSelectElement).value; replayTo(state.cursor); };
$('mode3d').onclick = () => { controls.mode = '3d'; save(); syncControls(); rebuild(); };
$('mode2d').onclick = () => { controls.mode = '2d'; save(); syncControls(); rebuild(); };
$<HTMLSelectElement>('files').onchange = (e) => { controls.files = (e.target as HTMLSelectElement).value as Controls['files']; save(); refreshGraph(); };
$<HTMLSelectElement>('labels').onchange = (e) => { controls.labels = (e.target as HTMLSelectElement).value as Controls['labels']; save(); rebuild(); };
$<HTMLSelectElement>('links').onchange = (e) => { controls.links = (e.target as HTMLSelectElement).value as Controls['links']; save(); refreshGraph(); };
$<HTMLInputElement>('size').oninput = (e) => { controls.size = Number((e.target as HTMLInputElement).value); save(); rebuild(); };
$('bloom').onclick = () => { controls.bloom = !controls.bloom; save(); syncControls(); rebuild(); };
$('freeze').onclick = () => { controls.freeze = !controls.freeze; save(); syncControls(); const g = g3 ?? g2; if (g) { g.cooldownTicks(controls.freeze ? 0 : Infinity); if (!controls.freeze) g.d3ReheatSimulation(); } };
$('fit').onclick = () => { (g3 ?? g2)?.zoomToFit(600, 40); };
$('theme').onclick = () => { controls.theme = controls.theme === 'dark' ? 'light' : 'dark'; save(); syncControls(); rebuild(); };
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
    renderCoverage(); setStatus();
    if (next >= state.events.length) stopPlay();
  }, 100);
};
function stopPlay(): void { if (state.playing) { clearInterval(state.playing); state.playing = undefined; } $('play').textContent = 'play'; }

window.addEventListener('resize', () => { const g = g3 ?? g2; if (g) g.width(el.clientWidth).height(el.clientHeight); });

void (async () => {
  syncControls();
  try {
    await loadRepos();
    await loadRepo();
  } catch (e) {
    setStatus(`error: ${(e as Error).message}`);
  }
})();
