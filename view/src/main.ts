import ForceGraph3D, { type ForceGraph3DInstance } from '3d-force-graph';
import ForceGraph from 'force-graph';
import SpriteText from 'three-spritetext';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { Vector2, type Object3D } from 'three';

/**
 * The synapse view (design spec §14). Two layers on one graph. The physical layer is files and
 * modules, coloured by what a session did to them. The meaning layer is concepts, the constraints
 * that govern modules and files, the packs those constraints came from, and the decisions that
 * serve or override them. Every colour mode, panel, and lens exists to answer one of the four
 * questions in §14.4, and the meaning layer is what turns a lit node into a governed one.
 */

type Kind = 'file' | 'module' | 'concept' | 'constraint';
interface SnapConstraint { id: string; mode: string; text: string; pack?: string }
interface SnapNode { id: string; kind: Kind; label: string; module?: string; size: number; constraints?: SnapConstraint[]; decisions?: number; parent?: string; mode?: string; pack?: string; attached?: string; adr?: string }
type Rel = 'import' | 'in' | 'impl' | 'governs' | 'serves' | 'overrides';
interface SnapLink { source: string; target: string; rel: Rel; decision?: string; who?: string; date?: string; text?: string }
interface Snapshot { root?: string; nodes: SnapNode[]; links: SnapLink[]; error?: string }
interface Env { t: string; ts: string; session: string; who: string; branch: string; seq?: number; p: Record<string, unknown> }
interface Coverage { path: string; applicable: string[]; loaded: Record<string, string>; callers: string[]; callers_loaded: number; callers_total: number; slice_injected: boolean; summarized_since: boolean; dark: string[]; session?: string; ts?: string }
interface VNode extends SnapNode { color: string; val: number; x?: number; y?: number; z?: number }
interface VLink { source: string | VNode; target: string | VNode; rel: Rel; count: number; lens?: boolean; decision?: string; text?: string }
type G3 = ForceGraph3DInstance<VNode, VLink>;
type G2 = InstanceType<typeof ForceGraph>;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const MODE_LEVEL: Record<string, number> = { full: 1, write: 1, edit: 0.95, range: 0.7, delegated: 0.45, grep: 0.35, summarized: 0.25, name: 0.2, external: 0.1, failed: 0.1, delete: 0.1 };
const HUES = ['#5fd3d8', '#f0b25c', '#9b8cff', '#f06c9b', '#8de07a', '#f0d36c', '#6cb4f0', '#e08a6c', '#c9a3ff', '#7ad3a4', '#d8a1f0', '#f0a06c'];

interface Palette { bg: string; idle: string; full: string; range: string; low: string; edit: string; dark: string; module: string; concept: string; enforced: string; guided: string; proposed: string; link: string; contain: string; govern: string; serve: string; override: string; lensLink: string; label: string; labelModule: string; dim: string; none: string }
const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: { bg: '#151b24', idle: '#3d4a5c', full: '#5fd3d8', range: '#3fa3a8', low: '#7a8aa0', edit: '#f0b25c', dark: '#ff7b7b', module: '#9b8cff', concept: '#e2c6ff', enforced: '#ffd98a', guided: '#c7c3ea', proposed: '#6b6f8a', link: 'rgba(150,170,200,0.28)', contain: 'rgba(155,140,255,0.32)', govern: 'rgba(255,217,138,0.55)', serve: 'rgba(122,211,154,0.85)', override: 'rgba(255,123,123,0.9)', lensLink: 'rgba(255,123,123,0.9)', label: '#c9d2dd', labelModule: '#eef1f6', dim: '#242c38', none: '#4a5563' },
  light: { bg: '#f2f4f7', idle: '#b9c2ce', full: '#0e8f95', range: '#3c7f83', low: '#6b7a8c', edit: '#c47a10', dark: '#c2413b', module: '#5b4bd6', concept: '#8b5cf6', enforced: '#b8860b', guided: '#6d6aa8', proposed: '#a3a7bd', link: 'rgba(60,80,110,0.25)', contain: 'rgba(91,75,214,0.32)', govern: 'rgba(184,134,11,0.55)', serve: 'rgba(47,125,79,0.85)', override: 'rgba(194,65,59,0.9)', lensLink: 'rgba(194,65,59,0.9)', label: '#33404f', labelModule: '#18202b', dim: '#dfe4ea', none: '#9aa4b1' },
};
type Category = 'full' | 'range' | 'low' | 'edit' | 'dark' | 'module' | 'concept' | 'enforced' | 'guided' | 'proposed';
const CATEGORIES: { key: Category; name: string; color: (p: Palette) => string }[] = [
  { key: 'edit', name: 'edited', color: (p) => p.edit },
  { key: 'dark', name: 'caller never loaded', color: (p) => p.dark },
  { key: 'full', name: 'read in full', color: (p) => p.full },
  { key: 'range', name: 'read a range', color: (p) => p.range },
  { key: 'low', name: 'grep or name only', color: (p) => p.low },
  { key: 'module', name: 'module', color: (p) => p.module },
  { key: 'concept', name: 'concept', color: (p) => p.concept },
  { key: 'enforced', name: 'enforced constraint', color: (p) => p.enforced },
  { key: 'guided', name: 'guided constraint', color: (p) => p.guided },
  { key: 'proposed', name: 'proposed', color: (p) => p.proposed },
];

interface Controls { theme: 'dark' | 'light'; mode: '3d' | '2d'; window: 'all' | 'day' | 'hour'; files: 'touched' | 'all'; labels: 'modules' | 'lit' | 'all' | 'none'; meaning: 'both' | 'concepts' | 'constraints' | 'none'; links: 'containment' | 'meaning' | 'imports' | 'all' | 'none'; colour: 'mode' | 'concept' | 'governance' | 'pack' | 'session'; size: number; bloom: boolean; freeze: boolean; speed: number; risky: boolean }
const DEFAULTS: Controls = { theme: 'dark', mode: '3d', window: 'all', files: 'touched', labels: 'modules', meaning: 'both', links: 'meaning', colour: 'mode', size: 1.4, bloom: false, freeze: false, speed: 20, risky: true };
const controls: Controls = { ...DEFAULTS, ...load() };
if (!['containment', 'meaning', 'imports', 'all', 'none'].includes(controls.links)) controls.links = 'meaning';

interface State { repo: string; snapshot: Snapshot; events: Env[]; session: string; expanded: Set<string>; live: boolean; cursor: number; ws?: WebSocket; boot?: number; lastEventAt?: number; selected?: string; playing?: number; lens?: string; isolate?: Category; sessionColor: Map<string, string> }
const state: State = { repo: '', snapshot: { nodes: [], links: [] }, events: [], session: '', expanded: new Set(), live: true, cursor: 0, sessionColor: new Map() };

function load(): Partial<Controls> { try { return JSON.parse(localStorage.getItem('ctx-view') ?? '{}') as Partial<Controls>; } catch { return {}; } }
function save(): void { try { localStorage.setItem('ctx-view', JSON.stringify(controls)); } catch { /* private mode */ } }
const pal = (): Palette => PALETTES[controls.theme];
/** Times are shown in the viewer's zone, not the UTC the stream carries. */
const clock = (ts: string | number): string => { const d = new Date(ts); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`; };
const stamp = (ts: string | number): string => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${clock(ts).slice(0, 5)}`; };

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
  indexSnapshot();
  await loadSessions();
  state.events = await api<Env[]>(`/v1/${state.repo}/events`);
  state.lastEventAt = Date.now();
  state.cursor = state.events.length;
  connect();
  await loadEvolution();
  rebuild();
  replayTo(state.cursor);
  refreshTime();
  renderMeaning();
  // Deep link: ?select=<node id> opens the focus drawer on load.
  const want = new URLSearchParams(location.search).get('select');
  if (want && nodeIndex.has(want)) setTimeout(() => select(want), 400);
}

function connect(): void {
  state.ws?.close();
  const last = state.events[state.events.length - 1]?.seq ?? 0;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/v1/${state.repo}/stream?since=${last}`);
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data as string) as Env & { boot?: number };
    if (e.t === 'ready') {
      // A restarted server numbers events from one again: what this tab holds is no longer comparable, so reload it.
      if (state.boot !== undefined && e.boot !== undefined && e.boot !== state.boot) { state.boot = e.boot; void resync(); return; }
      if (e.boot !== undefined) state.boot = e.boot;
      setStatus();
      return;
    }
    if (state.events.some((x) => x.seq === e.seq)) return;
    state.events.push(e);
    state.lastEventAt = Date.now();
    if (e.t === 'session' && !state.sessionColor.has(e.session)) addSessionOption(e);
    if (state.live) { state.cursor = state.events.length; applyEvent(e, true); refreshTime(); refreshPanels(); }
  };
  ws.onclose = () => { setStatus(); setTimeout(() => { if (state.ws === ws) connect(); }, 3000); };
  state.ws = ws;
}

/** Reload everything the stream cannot patch: after a server restart, or when the tab has been away. */
async function resync(): Promise<void> {
  await loadSessions();
  state.events = await api<Env[]>(`/v1/${state.repo}/events`);
  state.lastEventAt = Date.now();
  if (state.live) state.cursor = state.events.length;
  connect();
  replayTo(state.cursor);
  refreshTime();
}

async function loadSessions(): Promise<void> {
  const sessions = await api<{ session: string; who: string; branch: string; last: string; events: number }[]>(`/v1/${state.repo}/sessions`);
  const sel = $<HTMLSelectElement>('session');
  const keep = sel.value;
  sel.innerHTML = '<option value="">all sessions</option>';
  state.sessionColor.clear();
  sessions.forEach((s, i) => { state.sessionColor.set(s.session, HUES[i % HUES.length]!); const o = document.createElement('option'); o.value = s.session; o.textContent = `${s.session.slice(0, 8)}  ${s.who}  ${s.branch}  (${s.events})`; sel.appendChild(o); });
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

function addSessionOption(e: Env): void {
  const sel = $<HTMLSelectElement>('session');
  state.sessionColor.set(e.session, HUES[state.sessionColor.size % HUES.length]!);
  const o = document.createElement('option'); o.value = e.session; o.textContent = `${e.session.slice(0, 8)}  ${e.who}  ${e.branch}  (live)`; sel.appendChild(o);
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

// ---- snapshot indexes -----------------------------------------------------------------------

const nodeIndex = new Map<string, SnapNode>();
const callersOf = new Map<string, string[]>();
const calleesOf = new Map<string, string[]>();
const conceptsOf = new Map<string, string[]>();          // module -> concepts it implements (direct)
const governedBy = new Map<string, SnapNode[]>();         // module or file -> constraint nodes attached
const decisionLinks = new Map<string, SnapLink[]>();      // constraint or concept id -> serves/overrides links
const conceptHue = new Map<string, string>();
const packHue = new Map<string, string>();

function indexSnapshot(): void {
  nodeIndex.clear(); callersOf.clear(); calleesOf.clear(); conceptsOf.clear(); governedBy.clear(); decisionLinks.clear(); conceptHue.clear(); packHue.clear();
  for (const n of state.snapshot.nodes) nodeIndex.set(n.id, n);
  for (const l of state.snapshot.links) {
    if (l.rel === 'import') { callersOf.set(l.target, [...(callersOf.get(l.target) ?? []), l.source]); calleesOf.set(l.source, [...(calleesOf.get(l.source) ?? []), l.target]); }
    else if (l.rel === 'impl') conceptsOf.set(l.source, [...(conceptsOf.get(l.source) ?? []), l.target]);
    else if (l.rel === 'governs') { const k = nodeIndex.get(l.source); if (k) governedBy.set(l.target, [...(governedBy.get(l.target) ?? []), k]); }
    else if (l.rel === 'serves' || l.rel === 'overrides') decisionLinks.set(l.target, [...(decisionLinks.get(l.target) ?? []), l]);
  }
  let i = 0;
  for (const n of state.snapshot.nodes) if (n.kind === 'concept') conceptHue.set(n.id, HUES[i++ % HUES.length]!);
  i = 0;
  for (const n of state.snapshot.nodes) if (n.kind === 'constraint' && n.pack && !packHue.has(n.pack)) packHue.set(n.pack, HUES[(i++ + 3) % HUES.length]!);
}

function moduleOf(path: string): string | undefined { return nodeIndex.get(path)?.module; }
function chainOf(module: string | undefined): string[] { const out: string[] = []; let cur = module; while (cur && !out.includes(cur)) { out.push(cur); cur = nodeIndex.get(cur)?.parent; } return out; }
/** The concept a file or module belongs to: the first concept implemented by the nearest module in its chain. */
function conceptFor(n: SnapNode): string | undefined {
  const start = n.kind === 'module' ? n.id : n.kind === 'concept' ? undefined : n.module;
  if (n.kind === 'concept') return n.id;
  for (const m of chainOf(start)) { const c = conceptsOf.get(m)?.[0]; if (c) return c; }
  return undefined;
}
/** Constraints in force on a node: its own, then every module up its chain. */
function constraintsFor(n: SnapNode): SnapNode[] {
  const out: SnapNode[] = [];
  const start = n.kind === 'module' ? n.id : n.module;
  for (const id of [n.id, ...chainOf(start)]) for (const k of governedBy.get(id) ?? []) if (!out.includes(k)) out.push(k);
  return out;
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
    if (f.rule === 'callers-dark') return;
    findings.push({ ts: e.ts, session: e.session, rule: f.rule, message: f.message, ...(f.path ? { path: f.path } : {}), level: /no-decision|test-failed|opposed/.test(f.rule) ? 'bad' : 'warn' });
  } else if (e.t === 'session') {
    const p = e.p as { kind: string; arm?: string };
    if (p.kind === 'start') findings.push({ ts: e.ts, session: e.session, rule: 'session', message: `session started${p.arm === 'off' ? ' in observe-only mode' : ''}`, level: 'ok' });
  }
}

/** Earliest timestamp the chosen window admits; everything before it is left out of the graph, counters, and timeline. */
function windowStart(): number {
  if (controls.window === 'hour') return Date.now() - 3_600_000;
  if (controls.window === 'day') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  return 0;
}
function inWindow(e: Env, start: number): boolean { return start === 0 || new Date(e.ts).getTime() >= start; }

function replayTo(cursor: number): void {
  resetDerived();
  const start = windowStart();
  for (let i = 0; i < cursor && i < state.events.length; i++) { const e = state.events[i]!; if (inWindow(e, start)) applyEvent(e, false); }
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

function scheduleRefresh(): void { if (refreshTimer) return; refreshTimer = window.setTimeout(() => { refreshTimer = undefined; refreshGraph(); }, 120); }
function currentNodes(): VNode[] { return ((g3 ?? g2)?.graphData().nodes ?? []) as VNode[]; }
function currentLinks(): VLink[] { return ((g3 ?? g2)?.graphData().links ?? []) as VLink[]; }

function category(n: SnapNode, ns: NodeState | undefined): Category | undefined {
  if (n.kind === 'module') return 'module';
  if (n.kind === 'concept') return 'concept';
  if (n.kind === 'constraint') return n.mode === 'E' ? 'enforced' : n.mode === 'G' ? 'guided' : 'proposed';
  if (!ns) return undefined;
  if (ns.dark && ns.level <= 0.3) return 'dark';
  if (ns.edited) return 'edit';
  return ns.level >= 1 ? 'full' : ns.level >= 0.7 ? 'range' : 'low';
}

interface Lens { focus: Set<string>; red: Set<string>; green: Set<string>; links: Set<string> }
function lensSet(): Lens | undefined {
  if (!state.lens) return undefined;
  const n = nodeIndex.get(state.lens);
  if (!n) return undefined;
  const focus = new Set<string>([state.lens]);
  const red = new Set<string>(), green = new Set<string>(), links = new Set<string>();
  if (n.kind === 'file') {
    for (const c of callersOf.get(state.lens) ?? []) { focus.add(c); const ns = nodeState.get(c); if (ns && ns.level >= 0.7) green.add(c); else red.add(c); links.add(`${c}>${state.lens}`); }
    for (const m of chainOf(n.module)) focus.add(m);
    for (const k of constraintsFor(n)) { focus.add(k.id); links.add(`${k.id}>${k.attached ?? ''}`); }
  } else if (n.kind === 'constraint') {
    if (n.attached) { focus.add(n.attached); links.add(`${n.id}>${n.attached}`); for (const f of state.snapshot.nodes) if (f.kind === 'file' && f.module === n.attached && nodeState.has(f.id)) focus.add(f.id); }
    for (const l of decisionLinks.get(n.id) ?? []) { focus.add(l.source); (l.rel === 'overrides' ? red : green).add(l.source); links.add(`${l.source}>${n.id}`); }
  } else if (n.kind === 'concept') {
    for (const [m, cs] of conceptsOf) if (cs.includes(n.id)) { focus.add(m); links.add(`${m}>${n.id}`); for (const k of governedBy.get(m) ?? []) { focus.add(k.id); links.add(`${k.id}>${m}`); } }
    for (const l of decisionLinks.get(n.id) ?? []) { focus.add(l.source); green.add(l.source); links.add(`${l.source}>${n.id}`); }
  } else if (n.kind === 'module') {
    for (const k of governedBy.get(n.id) ?? []) { focus.add(k.id); links.add(`${k.id}>${n.id}`); }
    for (const c of conceptsOf.get(n.id) ?? []) { focus.add(c); links.add(`${n.id}>${c}`); }
    for (const f of state.snapshot.nodes) if (f.kind === 'file' && f.module === n.id && nodeState.has(f.id)) focus.add(f.id);
  }
  return { focus, red, green, links };
}

function visibleData(): { nodes: VNode[]; links: VLink[] } {
  const snap = state.snapshot;
  const lens = lensSet();
  const visible = new Set<string>();
  const nodes: VNode[] = [];
  const showConcepts = controls.meaning === 'both' || controls.meaning === 'concepts';
  const showConstraints = controls.meaning === 'both' || controls.meaning === 'constraints';
  for (const n of snap.nodes) {
    const ns = nodeState.get(n.id);
    const cat = category(n, ns);
    let show = n.kind === 'module'
      || (n.kind === 'concept' && showConcepts)
      || (n.kind === 'constraint' && showConstraints)
      || (n.kind === 'file' && (controls.files === 'all' || ns !== undefined || (n.module !== undefined && state.expanded.has(n.module))));
    if (lens?.focus.has(n.id)) show = true;
    if (state.isolate && cat !== state.isolate && n.kind !== 'module') show = false;
    if (!show) continue;
    visible.add(n.id);
    const base = n.kind === 'module' ? 4 + Math.sqrt(n.size) : n.kind === 'concept' ? 3.4 : n.kind === 'constraint' ? (n.mode === 'E' ? 2.2 : 1.6) : ns ? 1.6 : 0.9;
    nodes.push({ ...n, color: colorFor(n, ns, lens), val: base * controls.size * (lens && lens.focus.has(n.id) && n.kind === 'file' ? 1.6 : 1) });
  }
  const linkMap = new Map<string, VLink>();
  const want = (rel: Rel): boolean => {
    if (controls.links === 'all') return true;
    if (controls.links === 'none') return false;
    if (rel === 'import') return controls.links === 'imports';
    if (rel === 'in' || rel === 'impl') return controls.links === 'containment' || controls.links === 'meaning';
    return controls.links === 'meaning';
  };
  for (const l of snap.links) {
    const isLensLink = Boolean(lens?.links.has(`${l.source}>${l.target}`));
    if (!want(l.rel) && !isLensLink) continue;
    let s = l.source, t = l.target;
    if (!visible.has(s)) { const m = moduleOf(s); if (!m || !visible.has(m) || l.rel === 'in') continue; s = m; }
    if (!visible.has(t)) { const m = moduleOf(t); if (!m || !visible.has(m) || l.rel === 'in') continue; t = m; }
    if (s === t) continue;
    const key = `${s} ${t} ${l.rel}`;
    const cur = linkMap.get(key);
    if (cur) cur.count++; else linkMap.set(key, { source: s, target: t, rel: l.rel, count: 1, ...(isLensLink ? { lens: true } : {}), ...(l.decision ? { decision: l.decision } : {}), ...(l.text ? { text: l.text } : {}) });
  }
  return { nodes, links: [...linkMap.values()] };
}

function colorFor(n: SnapNode, ns: NodeState | undefined, lens: Lens | undefined): string {
  const p = pal();
  if (lens && !lens.focus.has(n.id)) return p.dim;
  if (lens?.red.has(n.id)) return p.dark;
  if (lens?.green.has(n.id)) return p.full;
  if (n.kind === 'concept') return controls.colour === 'concept' ? (conceptHue.get(n.id) ?? p.concept) : p.concept;
  if (n.kind === 'constraint') return controls.colour === 'pack' && n.pack ? (packHue.get(n.pack) ?? p.guided) : n.mode === 'E' ? p.enforced : n.mode === 'G' ? p.guided : p.proposed;
  if (controls.colour === 'concept') { const c = conceptFor(n); return c ? mix(conceptHue.get(c) ?? p.module, p.bg, n.kind === 'module' ? 0 : ns ? 0.15 : 0.55) : n.kind === 'module' ? p.module : p.none; }
  if (controls.colour === 'governance') { const ks = constraintsFor(n); const strongest = ks.some((k) => k.mode === 'E') ? p.enforced : ks.some((k) => k.mode === 'G') ? p.guided : p.none; return n.kind === 'module' || ns ? strongest : mix(strongest, p.bg, 0.5); }
  if (controls.colour === 'pack') { const k = constraintsFor(n).find((x) => x.pack); return k?.pack ? mix(packHue.get(k.pack) ?? p.guided, p.bg, n.kind === 'module' || ns ? 0 : 0.5) : n.kind === 'module' ? p.module : p.none; }
  if (controls.colour === 'session' && ns && n.kind === 'file') { const first = [...ns.sessions][0]; return (first && state.sessionColor.get(first)) ?? p.low; }
  if (n.kind === 'module') return ns ? mix(p.module, '#ffffff', Math.min(0.45, ns.level * 0.45)) : p.module;
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
function decisionCounts(id: string): { serves: number; overrides: number } {
  const ls = decisionLinks.get(id) ?? [];
  return { serves: ls.filter((l) => l.rel === 'serves').length, overrides: ls.filter((l) => l.rel === 'overrides').length };
}

function labelText(n: VNode): string | undefined {
  const ns = nodeState.get(n.id);
  const lens = lensSet();
  if (lens?.focus.has(n.id) && n.kind === 'file') return n.label;
  if (n.kind === 'constraint') { const c = decisionCounts(n.id); return `${n.mode === 'E' ? '⚑ ' : ''}${n.id.slice(2)}${c.serves || c.overrides ? `  ${c.serves}✓ ${c.overrides}✗` : ''}`; }
  if (n.kind === 'concept') return n.label.length > 48 ? n.label.slice(0, 46) + '…' : n.label;
  if (controls.labels === 'none') return undefined;
  if (n.kind === 'module') { const s = moduleStats(n.id); const ks = governedBy.get(n.id)?.length ?? 0; return `${n.id.replace(/^L:/, '')}  ${s.touched}/${s.total}${ks ? ` · ${ks} rule${ks === 1 ? '' : 's'}` : ''}${s.edits ? ` · ${s.edits} edits` : ''}${s.dark ? ` · ${s.dark} dark` : ''}`; }
  if (controls.labels === 'all') return n.label;
  if (controls.labels === 'lit' && ns) return n.label;
  return undefined;
}
function hoverText(n: VNode): string {
  const ns = nodeState.get(n.id);
  if (n.kind === 'module') { const s = moduleStats(n.id); const cs = conceptsOf.get(n.id) ?? []; return `${n.id}: ${s.touched} of ${s.total} files touched, ${s.edits} edits, ${s.dark} callers dark; ${governedBy.get(n.id)?.length ?? 0} constraints${cs.length ? `; implements ${cs.join(', ')}` : ''}`; }
  if (n.kind === 'constraint') { const c = decisionCounts(n.id); return `[${n.mode}] ${n.id.slice(2)} on ${n.attached}${n.pack ? ` (pack ${n.pack})` : ''}: ${n.label}. ${c.serves} decision${c.serves === 1 ? '' : 's'} serve it, ${c.overrides} override it.`; }
  if (n.kind === 'concept') { const ms = [...conceptsOf].filter(([, cs]) => cs.includes(n.id)).map(([m]) => m); return `${n.id}: ${n.label}${n.adr ? ` (ADR ${n.adr})` : ''}; implemented by ${ms.join(', ') || 'nothing yet'}`; }
  const ks = constraintsFor(n);
  return `${n.id}${ns ? `  [${ns.mode}${ns.edited ? `, edited ×${ns.edits}` : ''}${ns.dark ? ', caller never loaded' : ''}; ${ns.sessions.size} session${ns.sessions.size === 1 ? '' : 's'}]` : '  (not touched)'}${ks.length ? `; governed by ${ks.map((k) => k.id.slice(2)).join(', ')}` : ''}`;
}
const idOf = (x: string | VNode): string => (typeof x === 'string' ? x : x.id);
function linkColor(l: VLink, p: Palette): string {
  if (l.lens && (l.rel === 'import')) return p.lensLink;
  return l.rel === 'import' ? p.link : l.rel === 'governs' ? p.govern : l.rel === 'serves' ? p.serve : l.rel === 'overrides' ? p.override : p.contain;
}
function linkWidth(l: VLink): number { return l.lens ? 2.5 : l.rel === 'serves' || l.rel === 'overrides' ? 1.8 : l.rel === 'governs' ? 1.2 : Math.min(2.5, 0.3 + Math.log2(l.count)); }

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
        s.color = n.kind === 'module' ? p.labelModule : n.kind === 'concept' ? p.concept : n.kind === 'constraint' ? (n.mode === 'E' ? p.enforced : p.guided) : p.label;
        s.textHeight = (n.kind === 'module' ? 4.2 : n.kind === 'concept' ? 3.6 : n.kind === 'constraint' ? 2.4 : 2.6) * controls.size;
        s.position.y = (n.kind === 'module' ? 6 : n.kind === 'concept' ? 5 : 3) * controls.size;
        return s as unknown as Object3D;
      })
      .linkLabel((l) => (l.text ? `${l.rel} ${l.decision ?? ''}: ${l.text}` : l.rel))
      .linkColor((l) => linkColor(l, p))
      .linkOpacity(0.7)
      .linkWidth((l) => linkWidth(l))
      .linkDirectionalParticles((l) => (l.lens || l.rel === 'serves' || l.rel === 'overrides' ? 2 : 0))
      .linkDirectionalParticleColor((l) => linkColor(l, p))
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
          const s = moduleStats(v.id);
          const r = Math.sqrt(v.val) * 2 + 3;
          ctx.beginPath(); ctx.arc(v.x, v.y, r, 0, Math.PI * 2); ctx.strokeStyle = p.idle; ctx.lineWidth = 1.5 / scale; ctx.stroke();
          if (s.total) { ctx.beginPath(); ctx.arc(v.x, v.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (s.touched / s.total)); ctx.strokeStyle = s.dark ? p.dark : p.full; ctx.lineWidth = 3 / scale; ctx.stroke(); }
        }
        if (v.kind === 'constraint') {
          // Diamonds for rules: filled when enforced, outlined when guided, dotted when proposed.
          const r = Math.sqrt(v.val) * 2 + 1.5;
          ctx.beginPath(); ctx.moveTo(v.x, v.y - r); ctx.lineTo(v.x + r, v.y); ctx.lineTo(v.x, v.y + r); ctx.lineTo(v.x - r, v.y); ctx.closePath();
          ctx.fillStyle = p.bg; ctx.fill();
          if (v.mode === 'E') { ctx.fillStyle = v.color; ctx.fill(); }
          ctx.setLineDash(v.mode === 'G?' ? [2 / scale, 2 / scale] : []); ctx.strokeStyle = v.color; ctx.lineWidth = 1.5 / scale; ctx.stroke(); ctx.setLineDash([]);
        }
        const text = labelText(v);
        if (!text) return;
        const size = (v.kind === 'module' ? 12 : v.kind === 'concept' ? 11 : 9) / Math.max(0.6, scale) * Math.max(0.7, controls.size / 1.4);
        ctx.font = `${v.kind === 'module' || v.kind === 'concept' ? '600 ' : ''}${size}px IBM Plex Sans, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = v.kind === 'module' ? p.labelModule : v.kind === 'concept' ? p.concept : v.kind === 'constraint' ? v.color : p.label;
        ctx.fillText(text, v.x, v.y + Math.sqrt(v.val) * 2 + 5);
      })
      .linkLabel((l) => ((l as VLink).text ? `${(l as VLink).rel} ${(l as VLink).decision ?? ''}: ${(l as VLink).text}` : (l as VLink).rel))
      .linkColor((l) => linkColor(l as VLink, p))
      .linkWidth((l) => linkWidth(l as VLink))
      .linkLineDash((l) => ((l as VLink).rel === 'governs' ? [3, 3] : null))
      .linkDirectionalArrowLength((l) => ((l as VLink).rel === 'serves' || (l as VLink).rel === 'overrides' ? 4 : 0))
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
  const sameLinks = currentLinks().length === data.links.length;
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
  const lines = [id];
  if (n.kind === 'module') {
    const s = moduleStats(id);
    lines.push(`module: ${n.label}`, `${s.touched} of ${s.total} files touched, ${s.edits} edits, ${s.dark} callers never loaded`);
    const cs = conceptsOf.get(id) ?? [];
    if (cs.length) lines.push(`implements ${cs.map((c) => `${c} (${nodeIndex.get(c)?.label ?? ''})`).join('; ')}`);
    const ks = governedBy.get(id) ?? [];
    lines.push(ks.length ? 'governed by:' : 'no constraints attached to this module');
    for (const k of ks) { const c = decisionCounts(k.id); lines.push(`  [${k.mode}] ${k.id.slice(2)}${k.pack ? ` (${k.pack})` : ''}  ${k.label}${c.serves || c.overrides ? `  ${c.serves} serve, ${c.overrides} override` : ''}`); }
    const inherited = constraintsFor(n).filter((k) => !ks.includes(k));
    if (inherited.length) lines.push(`inherited from the chain: ${inherited.map((k) => k.id.slice(2)).join(', ')}`);
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    lines.push('', state.expanded.has(id) ? 'expanded: all files shown' : 'collapsed: touched files only');
    setLens(id, `${id.replace(/^L:/, '')}: its constraints, concepts, and touched files are lit; everything else is dimmed.`);
  } else if (n.kind === 'constraint') {
    const c = decisionCounts(id);
    lines.push(`[${n.mode === 'E' ? 'enforced' : n.mode === 'G' ? 'guided' : n.mode === 'R' ? 'recorded' : 'proposed'}] ${n.id.slice(2)}${n.pack ? `  from pack ${n.pack}` : ''}`, n.label, `governs ${n.attached}`);
    const ls = decisionLinks.get(id) ?? [];
    lines.push(ls.length ? `${c.serves} decision${c.serves === 1 ? '' : 's'} serve it, ${c.overrides} override it:` : 'no decision has referenced it yet');
    for (const l of ls) lines.push(`  ${l.rel === 'overrides' ? '✗' : '✓'} ${l.decision} ${l.date ?? ''} ${l.who ?? ''} on ${short(l.source)}: ${l.text ?? ''}`);
    setLens(id, `${n.id.slice(2)}: the node it governs, that node's touched files, and every decision that serves (teal) or overrides (red) it.`);
  } else if (n.kind === 'concept') {
    const ms = [...conceptsOf].filter(([, cs]) => cs.includes(id)).map(([m]) => m);
    lines.push(`concept: ${n.label}${n.adr ? `  (ADR ${n.adr})` : ''}`, ms.length ? `implemented by ${ms.join(', ')}` : 'implemented by nothing yet');
    for (const m of ms) for (const k of governedBy.get(m) ?? []) lines.push(`  ${m} · [${k.mode}] ${k.id.slice(2)}  ${k.label}`);
    const ls = decisionLinks.get(id) ?? [];
    if (ls.length) { lines.push(`${ls.length} decision${ls.length === 1 ? '' : 's'} point at it:`); for (const l of ls) lines.push(`  ✓ ${l.decision} on ${short(l.source)}: ${l.text ?? ''}`); }
    setLens(id, `${n.id}: the modules that implement it, their constraints, and the decisions that cite it.`);
  } else {
    if (ns) lines.push(`context ${ns.mode} (${Math.round(ns.level * 100)}%)${ns.edited ? `, edited ×${ns.edits}` : ''}${ns.dark ? ', a caller of an edited file that was never loaded' : ''}`, `sessions ${[...ns.sessions].map((s) => s.slice(0, 8)).join(', ')}`);
    else lines.push('not touched in this range');
    const concept = conceptFor(n);
    lines.push(`module ${n.module ?? 'none'}${concept ? `; concept ${concept}` : ''}`);
    const ks = constraintsFor(n);
    lines.push(ks.length ? 'in force here:' : 'no constraints in force here');
    for (const k of ks) lines.push(`  [${k.mode}] ${k.id.slice(2)}${k.pack ? ` (${k.pack})` : ''}  ${k.label}`);
    const rows = coverageRows.filter((c) => c.path === id);
    for (const c of rows.slice(-3)) {
      lines.push('', `edit ${c.ts ? clock(c.ts) : ''}  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}${c.summarized_since ? '  after compaction' : ''}`);
      const darkCallers = c.callers.filter((x) => !['full', 'range', 'edit', 'write'].includes(c.loaded[x] ?? ''));
      if (darkCallers.length) lines.push(`  never loaded: ${darkCallers.map(short).join(', ')}`);
    }
    const sl = slices.get(id);
    if (sl?.length) lines.push('', `slice injected ${clock(sl[sl.length - 1]!.ts)}:`, sl[sl.length - 1]!.rendered.split('\n').map((l) => `  ${l}`).join('\n'));
    const ds = decisionsSeen.filter((d) => d.node.split('#')[0] === id);
    for (const d of ds) lines.push('', `decision ${clock(d.ts)}  ${d.overrides ? `!${d.overrides}` : `->${d.serves}`}  ${d.text}`);
    if (sl?.length && ds.length) { const last = sl[sl.length - 1]!; const pointsBack = ds.some((d) => last.applicable.includes(d.serves) || (d.overrides !== undefined && last.applicable.includes(d.overrides))); lines.push('', pointsBack ? 'the decision points back at the slice that was injected' : 'the decision points outside the slice that was injected (a reach)'); }
    const callers = callersOf.get(id) ?? [];
    const c = rows.slice(-1)[0];
    const darkCount = callers.filter((x) => { const m = c?.loaded[x]; return !(m === 'full' || m === 'range' || m === 'edit' || m === 'write'); }).length;
    setLens(id, callers.length ? `${callers.length} caller${callers.length === 1 ? '' : 's'}; ${darkCount} never loaded (red), ${callers.length - darkCount} in context (teal); the rules in force are lit.` : 'no callers in the import graph; module chain and rules in force are lit.');
  }
  $('detail').textContent = lines.join('\n');
  renderCoverage();
  renderFocus(id);
  focusNode(id);
}

// ---- focus drawer: a subtree and prose for the selected node ---------------------------------

interface TreeItem { id: string; label: string; color: string; shape: 'circle' | 'diamond' | 'pill'; note?: string }

function stateOf(id: string): { text: string; color: string; cat?: Category } {
  const n = nodeIndex.get(id);
  const ns = nodeState.get(id);
  const p = pal();
  if (!n) return { text: 'unknown', color: p.none };
  const cat = category(n, ns);
  if (n.kind === 'file') {
    if (!ns) return { text: 'not touched', color: p.idle, ...(cat ? { cat } : {}) };
    if (cat === 'dark') return { text: 'never loaded', color: p.dark, cat };
    if (cat === 'edit') return { text: `edited ×${ns.edits}`, color: p.edit, cat };
    if (ns.mode === 'summarized') return { text: 'compacted to a summary', color: p.low, cat: cat ?? 'low' };
    if (cat === 'full') return { text: 'read in full', color: p.full, cat };
    if (cat === 'range') return { text: 'read a range', color: p.range, cat };
    return { text: ns.mode === 'delegated' ? 'read by a subagent' : 'grep or name only', color: p.low, cat: cat ?? 'low' };
  }
  return { text: n.kind, color: cat ? CATEGORIES.find((c) => c.key === cat)?.color(p) ?? p.none : p.none, ...(cat ? { cat } : {}) };
}

function trunc(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
const nameOf = (id: string): string => (id.startsWith('L:') || id.startsWith('C:') || id.startsWith('K:') ? id.slice(2) : id.split('/').pop() ?? id);

function renderFocus(id: string): void {
  const n = nodeIndex.get(id);
  const sec = $('focus');
  if (!n) { sec.hidden = true; return; }
  const wasHidden = sec.hidden;
  sec.hidden = false;
  const p = pal();
  const ns = nodeState.get(id);
  const chain = n.kind === 'module' ? chainOf(n.id).slice(1) : n.kind === 'file' ? chainOf(n.module) : n.kind === 'constraint' ? chainOf(n.attached?.startsWith('L:') ? n.attached : nodeIndex.get(n.attached ?? '')?.module) : [];
  const concepts = [...new Set(chain.concat(n.kind === 'module' ? [n.id] : []).flatMap((m) => conceptsOf.get(m) ?? []))];
  const rules = n.kind === 'constraint' ? [] : n.kind === 'concept' ? [...conceptsOf].filter(([, cs]) => cs.includes(id)).flatMap(([m]) => governedBy.get(m) ?? []) : constraintsFor(n);
  const item = (nid: string): TreeItem => { const s = stateOf(nid); const nn = nodeIndex.get(nid); return { id: nid, label: nameOf(nid), color: s.color, shape: nn?.kind === 'constraint' ? 'diamond' : nn?.kind === 'concept' ? 'pill' : 'circle', note: s.text }; };

  // Rows of the tree, top to bottom. Each row is a heading plus items; the centre row holds the node itself.
  let above: { head: string; items: TreeItem[] }[] = [];
  let below: { head: string; items: TreeItem[]; right?: boolean }[] = [];
  let side: TreeItem[] = [];
  if (n.kind === 'file') {
    const callers = (callersOf.get(id) ?? []).map(item).sort((a, b) => (a.note === 'never loaded' ? -1 : 1) - (b.note === 'never loaded' ? -1 : 1));
    const callees = (calleesOf.get(id) ?? []).map(item);
    above = [{ head: 'concepts', items: concepts.map(item) }, { head: 'module chain', items: [...chain].reverse().map(item) }];
    side = rules.map((k) => item(k.id));
    below = [{ head: `callers ${callers.length}`, items: callers.slice(0, 14) }, { head: `imports ${callees.length}`, items: callees.slice(0, 10), right: true }];
  } else if (n.kind === 'module') {
    const files = state.snapshot.nodes.filter((f) => f.kind === 'file' && f.module === id && nodeState.has(f.id)).sort((a, b) => (nodeState.get(b.id)?.edits ?? 0) - (nodeState.get(a.id)?.edits ?? 0)).map((f) => item(f.id));
    const children = state.snapshot.nodes.filter((m) => m.kind === 'module' && m.parent === id).map((m) => item(m.id));
    above = [{ head: 'concepts', items: concepts.map(item) }, { head: 'parents', items: [...chain].reverse().map(item) }];
    side = rules.map((k) => item(k.id));
    below = [{ head: `touched files ${files.length}`, items: files.slice(0, 14) }, { head: `submodules ${children.length}`, items: children.slice(0, 10), right: true }];
  } else if (n.kind === 'constraint') {
    const ls = decisionLinks.get(id) ?? [];
    above = [{ head: n.pack ? `pack ${n.pack}` : 'rule', items: [] }, { head: 'governs', items: n.attached ? [item(n.attached.split('#')[0]!)] : [] }];
    below = [{ head: `served by ${ls.filter((l) => l.rel === 'serves').length}`, items: ls.filter((l) => l.rel === 'serves').map((l) => ({ ...item(l.source), color: p.full, note: l.text ?? '' })) }, { head: `overridden by ${ls.filter((l) => l.rel === 'overrides').length}`, items: ls.filter((l) => l.rel === 'overrides').map((l) => ({ ...item(l.source), color: p.dark, note: l.text ?? '' })), right: true }];
  } else {
    const ms = [...conceptsOf].filter(([, cs]) => cs.includes(id)).map(([m]) => item(m));
    const ls = decisionLinks.get(id) ?? [];
    above = [{ head: n.adr ? `ADR ${n.adr}` : 'concept', items: [] }];
    side = rules.map((k) => item(k.id));
    below = [{ head: `implemented by ${ms.length}`, items: ms }, { head: `cited by ${ls.length} decisions`, items: ls.map((l) => ({ ...item(l.source), color: p.full, note: l.text ?? '' })), right: true }];
  }
  const centre: TreeItem = { ...item(id), label: n.kind === 'file' ? id.split('/').slice(-2).join('/') : nameOf(id) };
  $('focusTree').innerHTML = treeSvg(centre, above, side, below, p);
  $('focusProse').innerHTML = proseFor(n, ns, chain, concepts, rules);
  for (const el2 of $('focusTree').querySelectorAll<SVGElement>('[data-id]')) el2.addEventListener('click', () => select(el2.dataset.id!));
  $('focusClose')?.addEventListener('click', () => { sec.hidden = true; state.selected = undefined; setLens(undefined); const g = g3 ?? g2; if (g) g.width(el.clientWidth).height(el.clientHeight); });
  if (wasHidden) { const g = g3 ?? g2; if (g) g.width(el.clientWidth).height(el.clientHeight); }
}

function treeSvg(centre: TreeItem, above: { head: string; items: TreeItem[] }[], side: TreeItem[], below: { head: string; items: TreeItem[]; right?: boolean }[], p: Palette): string {
  const box = $('focusTree');
  const W = Math.max(420, box.clientWidth || 560), H = 300;
  const cx = side.length ? W * 0.36 : W * 0.5, cy = 150;
  const parts: string[] = [];
  const esc2 = (s: string): string => esc(s);
  const shape = (t: TreeItem, x: number, y: number, r: number): string => {
    const core = t.shape === 'diamond' ? `<path d="M${x} ${y - r} L${x + r} ${y} L${x} ${y + r} L${x - r} ${y} Z" fill="${t.color}" stroke="${p.bg}"/>`
      : t.shape === 'pill' ? `<rect x="${x - r * 1.6}" y="${y - r * 0.8}" width="${r * 3.2}" height="${r * 1.6}" rx="${r * 0.8}" fill="${t.color}" stroke="${p.bg}"/>`
      : `<circle cx="${x}" cy="${y}" r="${r}" fill="${t.color}" stroke="${p.bg}"/>`;
    return `<g class="node" data-id="${esc2(t.id)}"><title>${esc2(t.id)}${t.note ? ` — ${esc2(t.note)}` : ''}</title>${core}</g>`;
  };
  const line = (x1: number, y1: number, x2: number, y2: number, color: string, dash = false): string => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1"${dash ? ' stroke-dasharray="3 3"' : ''}/>`;
  // Above: rows at y = 26 and 70, items spread across the left area.
  const rowsAbove = above.filter((r) => r.items.length || r.head);
  rowsAbove.forEach((row, i) => {
    const y = 28 + i * 42;
    parts.push(`<text class="head" x="8" y="${y - 12}">${esc2(row.head)}</text>`);
    const usable = (side.length ? W * 0.66 : W) - 16;
    const step = Math.min(120, usable / Math.max(1, row.items.length));
    row.items.forEach((t, j) => {
      const x = 16 + step * j + step / 2;
      parts.push(line(x, y + 6, cx, cy - 12, p.contain));
      parts.push(shape(t, x, y, 5), `<text x="${x}" y="${y + 16}" text-anchor="middle" class="muted">${esc2(trunc(t.label, Math.max(6, Math.floor(step / 6.5))))}</text>`);
    });
  });
  // Side: rules stacked on the right.
  if (side.length) {
    const x = W * 0.72;
    parts.push(`<text class="head" x="${x - 8}" y="14">rules in force ${side.length}</text>`);
    side.slice(0, 9).forEach((t, i) => {
      const y = 28 + i * 24;
      parts.push(line(cx + 14, cy, x - 8, y, p.govern, true));
      parts.push(shape(t, x, y, 5), `<text x="${x + 10}" y="${y + 4}">${esc2(trunc(t.label, Math.floor((W - x - 16) / 6.2)))}</text>`);
    });
    if (side.length > 9) parts.push(`<text class="muted" x="${x + 10}" y="${28 + 9 * 24}">and ${side.length - 9} more</text>`);
  }
  // Centre.
  parts.push(shape(centre, cx, cy, 11), `<text x="${cx}" y="${cy + 26}" text-anchor="middle" style="font-weight:600">${esc2(trunc(centre.label, 42))}</text>`, `<text x="${cx}" y="${cy + 40}" text-anchor="middle" class="muted">${esc2(centre.note ?? '')}</text>`);
  // Below: two groups, left and right halves.
  below.forEach((row) => {
    const half = row.right ? [W * 0.5 + 8, W - 8] : [8, (below.length > 1 ? W * 0.5 : W) - 8];
    const y = 232;
    parts.push(`<text class="head" x="${half[0]}" y="${y - 12}">${esc2(row.head)}</text>`);
    const usable = half[1]! - half[0]!;
    const step = Math.min(96, usable / Math.max(1, row.items.length));
    row.items.forEach((t, j) => {
      const x = half[0]! + step * j + step / 2;
      parts.push(line(x, y - 6, cx, cy + 12, t.color === p.dark ? p.override : t.color === p.full ? p.serve : p.link));
      parts.push(shape(t, x, y, 5), `<text x="${x}" y="${y + 16}" text-anchor="middle" class="muted">${esc2(trunc(t.label, Math.max(6, Math.floor(step / 6.5))))}</text>`);
    });
    if (!row.items.length) parts.push(`<text class="muted" x="${half[0]}" y="${y + 4}">none</text>`);
  });
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${parts.join('')}</svg>`;
}

function proseFor(n: SnapNode, ns: NodeState | undefined, chain: string[], concepts: string[], rules: SnapNode[]): string {
  const out: string[] = [];
  const title = n.kind === 'file' ? n.id : `${nameOf(n.id)} <small style="color:var(--muted)">${n.kind}</small>`;
  out.push(`<h3>${esc(title)}<button id="focusClose">close</button></h3>`);
  const chainText = chain.length ? chain.map(nameOf).join(', inside ') : 'no mapped module';
  const conceptText = concepts.length ? concepts.map((c) => `<b>${esc(nodeIndex.get(c)?.label ?? c)}</b>`).join(' and ') : '';
  const enforced = rules.filter((k) => k.mode === 'E'), guided = rules.filter((k) => k.mode === 'G'), proposed = rules.filter((k) => k.mode === 'G?');
  const ruleText = rules.length ? `${countOf(enforced.length, 'enforced rule')} and ${countOf(guided.length, 'guided rule')}${proposed.length ? ` plus ${countOf(proposed.length, 'proposed one')}` : ''} ${rules.length === 1 ? 'is' : 'are'} in force: ${rules.slice(0, 4).map((k) => `<code>${esc(k.id.slice(2))}</code>`).join(', ')}${rules.length > 4 ? ` and ${rules.length - 4} more` : ''}.` : 'No rule is in force here.';

  if (n.kind === 'file') {
    out.push(`<p>Sits in ${esc(chainText)}${conceptText ? `, which implements ${conceptText}` : ''}. ${ruleText}</p>`);
    const callers = callersOf.get(n.id) ?? [], callees = calleesOf.get(n.id) ?? [];
    const rows = coverageRows.filter((c) => c.path === n.id);
    const last = rows[rows.length - 1];
    const readText = !ns ? 'was <b>not touched</b> in this session' : ns.mode === 'summarized' ? 'was read, then <b>compacted to a summary</b>' : ns.level >= 1 ? 'was <b>read in full</b>' : ns.level >= 0.7 ? 'was <b>read in part</b>' : ns.dark && ns.level <= 0.3 ? 'was <b class="bad">never loaded</b>, though something that imports it was edited' : 'was seen only through <b>grep hits or its name</b>';
    let session = `In this session it ${readText}`;
    if (ns?.edited) {
      session += ` and edited ${ns.edits === 1 ? 'once' : `${ns.edits} times`}`;
      if (last && last.callers_total) {
        const dark = last.callers.filter((c) => !['full', 'range', 'edit', 'write'].includes(last.loaded[c] ?? ''));
        session += `; at the last edit <b class="${last.callers_loaded === 0 ? 'bad' : last.callers_loaded < last.callers_total ? 'warn' : 'good'}">${last.callers_loaded} of ${last.callers_total} callers</b> were in context`;
        if (dark.length) session += `, and the ${dark.length === 1 ? 'one' : dark.length} never loaded ${dark.length === 1 ? 'was' : 'were'} ${dark.slice(0, 4).map((d) => `<code>${esc(nameOf(d))}</code>`).join(', ')}${dark.length > 4 ? ` and ${dark.length - 4} more` : ''}`;
      } else if (last) session += '; it has no callers in the import graph, so the rules above are the only context that applies';
      if (last?.summarized_since) session += '. <b class="warn">Its own content had been compacted away before that edit.</b>';
    }
    out.push(`<p>${session}.</p>`);
    out.push(`<p>It has ${countOf(callers.length, 'caller')} and imports ${countOf(callees.length, 'file')}.</p>`);
    const sl = slices.get(n.id);
    const ds = decisionsSeen.filter((d) => d.node.split('#')[0] === n.id);
    if (ns?.edited) out.push(`<p>${sl?.length ? `A slice was injected before ${sl.length === 1 ? 'the' : 'each'} edit${sl.length > 1 ? ` (${sl.length})` : ''}` : '<b class="warn">No slice was injected</b> before its edits'}. ${ds.length ? `${countOf(ds.length, 'decision')} recorded: ${ds.map((d) => `${d.overrides ? `<b class="warn">overrides ${esc(d.overrides)}</b>` : `serves <code>${esc(d.serves)}</code>`}, "${esc(d.text)}"`).join('; ')}.` : ns.edited && sl?.length ? '<b class="warn">No decision was recorded.</b>' : ''}</p>`);
    if (n.decisions) out.push(`<p>${countOf(n.decisions, 'earlier decision')} on this file ${n.decisions === 1 ? 'is' : 'are'} in the graph.</p>`);
  } else if (n.kind === 'module') {
    const s = moduleStats(n.id);
    out.push(`<p><b>${esc(n.label)}</b>. It holds ${countOf(s.total, 'file')}${chain.length ? ` and sits inside ${esc(chain.map(nameOf).join(', inside '))}` : ''}${conceptText ? `. It implements ${conceptText}` : ''}. ${ruleText}</p>`);
    out.push(`<p>In this session <b>${s.touched} of ${s.total}</b> files were touched with ${countOf(s.edits, 'edit')}${s.dark ? `, and <b class="bad">${countOf(s.dark, 'caller')}</b> of edited files ${s.dark === 1 ? 'was' : 'were'} never loaded` : s.edits ? ', and every caller of an edited file was in context' : ''}.</p>`);
    const own = governedBy.get(n.id) ?? [];
    if (own.length) out.push(`<p>Rules attached here: ${own.map((k) => `<code>${esc(k.id.slice(2))}</code> (${k.mode === 'E' ? 'enforced' : k.mode === 'G' ? 'guided' : 'proposed'}${k.pack ? `, from ${esc(k.pack)}` : ''}) ${esc(k.label)}`).join('; ')}.</p>`);
    if (n.decisions) out.push(`<p>${countOf(n.decisions, 'decision')} ${n.decisions === 1 ? 'is' : 'are'} recorded on the module itself.</p>`);
  } else if (n.kind === 'constraint') {
    const ls = decisionLinks.get(n.id) ?? [];
    const serves = ls.filter((l) => l.rel === 'serves'), over = ls.filter((l) => l.rel === 'overrides');
    out.push(`<p><code>${esc(n.id.slice(2))}</code> is ${n.mode === 'E' ? '<b>enforced</b> by a test' : n.mode === 'G' ? '<b>guided</b>: injected before edits, not machine-checked' : n.mode === 'R' ? 'recorded history, never injected' : '<b>proposed</b> and not yet ratified'}${n.pack ? `, and came from the <b>${esc(n.pack)}</b> pack` : ''}. It governs <b>${esc(nameOf(n.attached ?? ''))}</b>${chain.length ? ` inside ${esc(chain.map(nameOf).join(', inside '))}` : ''}.</p>`);
    out.push(`<p>It says: <i>${esc(n.label)}</i></p>`);
    out.push(`<p>${serves.length || over.length ? `${countOf(serves.length, 'decision')} <b class="good">serve</b> it and ${countOf(over.length, 'decision')} <b class="${over.length ? 'bad' : 'good'}">override</b> it.` : 'No decision has referenced it yet.'}${over.length ? ` The overrides: ${over.map((l) => `<code>${esc(nameOf(l.source))}</code> (${esc(l.who ?? '')}, ${esc(l.date ?? '')}) "${esc(l.text ?? '')}"`).join('; ')}.` : ''}</p>`);
    const legacy = over.filter((l) => /^legacy:/.test(l.text ?? '')).length;
    if (legacy) out.push(`<p>${countOf(legacy, 'override')} ${legacy === 1 ? 'is' : 'are'} recorded legacy exceptions that predate the rule; they are the debt list for it.</p>`);
  } else {
    const ms = [...conceptsOf].filter(([, cs]) => cs.includes(n.id)).map(([m]) => m);
    const ls = decisionLinks.get(n.id) ?? [];
    out.push(`<p><b>${esc(n.label)}</b>${n.adr ? ` (ADR ${esc(n.adr)})` : ''}. ${ms.length ? `Implemented by ${ms.map((m) => `<b>${esc(nameOf(m))}</b>`).join(', ')}` : '<b class="warn">No module implements it yet</b>'}. ${ruleText}</p>`);
    out.push(`<p>${ls.length ? `${countOf(ls.length, 'decision')} cite it directly: ${ls.map((l) => `<code>${esc(nameOf(l.source))}</code> "${esc(l.text ?? '')}"`).join('; ')}.` : 'No decision cites it directly; decisions usually point at the rules beneath it.'}</p>`);
  }
  return out.join('');
}

function countOf(n: number, noun: string): string { return `${n} ${noun}${n === 1 ? '' : noun.endsWith('one') ? 's' : 's'}`; }

function setLens(id: string | undefined, text?: string): void {
  state.lens = id;
  const box = $('lens');
  if (!id) { box.hidden = true; refreshGraph(); return; }
  $('lens-title').textContent = id.startsWith('K:') ? id.slice(2) : short(id);
  $('lens-text').textContent = text ?? '';
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
  const governed = coverageRows.filter((c) => { const n = nodeIndex.get(c.path); return n && constraintsFor(n).length; }).length;
  const note = !edits ? 'No edits in this range. Reads alone do not change the codebase.'
    : withSlice === 0 ? `No slices were injected: this ran observe-only, or before the plugin. ${governed} of ${edits} edits touched files with rules in force that the session was never shown.`
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
    li.innerHTML = `<i>●</i> ${clock(f.ts)} <b>${esc(f.rule)}</b> ${esc(f.message)}`;
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
    const n = nodeIndex.get(path);
    return { path, edits: cs.length, slices: cs.filter((c) => c.slice_injected).length, loaded: last.callers_loaded, total: last.callers_total, dark, risky: cs.some((c) => c.callers_total > 0 && c.callers_loaded === 0), summarized: cs.some((c) => c.summarized_since), rules: n ? constraintsFor(n).length : 0 };
  });
  if (controls.risky) rows = rows.filter((r) => r.risky || r.dark > 0 || r.summarized);
  rows.sort((a, b) => Number(b.risky) - Number(a.risky) || b.dark - a.dark || b.rules - a.rules || b.edits - a.edits);
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="5" style="color:var(--muted)">${coverageRows.length ? 'no risky edits; untick "risky only" to see all' : 'no edits with coverage in this range'}</td></tr>`; return; }
  for (const r of rows.slice(0, 80)) {
    const tr = document.createElement('tr');
    if (r.path === state.selected) tr.classList.add('selected');
    if (r.risky) tr.classList.add('risky');
    tr.innerHTML = `<td class="path" title="${esc(r.path)}">${esc(short(r.path))}${r.rules ? ` <span class="pill" title="rules in force">${r.rules} rule${r.rules === 1 ? '' : 's'}</span>` : ''}${r.summarized ? ' <span class="pill">compacted</span>' : ''}</td><td>${r.edits}</td><td><span class="pill ${r.slices ? 'on' : ''}">${r.slices}/${r.edits}</span></td><td>${r.total ? `${r.loaded}/${r.total}` : '<span class="pill">none</span>'}</td><td>${r.dark ? `<span class="pill dark">${r.dark}</span>` : '<span class="pill good">0</span>'}</td>`;
    tr.onclick = () => select(r.path);
    tbody.appendChild(tr);
  }
}

function renderMeaning(): void {
  const box = $('meaningPanel');
  box.innerHTML = '';
  const concepts = state.snapshot.nodes.filter((n) => n.kind === 'concept');
  const constraints = state.snapshot.nodes.filter((n) => n.kind === 'constraint');
  if (!concepts.length && !constraints.length) { box.innerHTML = '<p style="color:var(--muted)">the server has no meaning layer for this repository: no graph, or the server predates this view (restart ctx serve)</p>'; return; }
  const kRow = (k: SnapNode): HTMLElement => {
    const c = decisionCounts(k.id);
    const d = document.createElement('div');
    d.className = 'k';
    d.innerHTML = `<span class="mode ${k.mode === 'E' ? 'E' : k.mode === 'G' ? 'G' : ''}">${esc(k.mode ?? '')}</span><span>${esc(k.id.slice(2))}${k.pack ? ` <small>(${esc(k.pack)})</small>` : ''}</span><span class="counts"><span class="s">${c.serves}✓</span> <span class="o">${c.overrides}✗</span></span>`;
    d.title = k.label;
    d.onclick = () => select(k.id);
    return d;
  };
  const covered = new Set<string>();
  for (const c of concepts) {
    const ms = [...conceptsOf].filter(([, cs]) => cs.includes(c.id)).map(([m]) => m);
    const wrap = document.createElement('div');
    wrap.className = 'concept';
    const b = document.createElement('b');
    b.textContent = c.label;
    b.onclick = () => select(c.id);
    wrap.appendChild(b);
    const small = document.createElement('small');
    small.textContent = `${c.id}${c.adr ? ` · ADR ${c.adr}` : ''} · ${ms.length ? ms.map((m) => m.replace(/^L:/, '')).join(', ') : 'no module implements it yet'}`;
    wrap.appendChild(small);
    for (const m of ms) for (const k of governedBy.get(m) ?? []) { covered.add(k.id); wrap.appendChild(kRow(k)); }
    box.appendChild(wrap);
  }
  const rest = constraints.filter((k) => !covered.has(k.id));
  if (rest.length) {
    const wrap = document.createElement('div');
    wrap.className = 'concept';
    wrap.innerHTML = '<b>Rules without a concept</b><small>attached to modules that implement no concept</small>';
    (wrap.firstChild as HTMLElement).onclick = () => undefined;
    for (const k of rest) wrap.appendChild(kRow(k));
    box.appendChild(wrap);
  }
  const packs = [...packHue.keys()];
  if (packs.length) {
    const p = document.createElement('div');
    p.className = 'packs';
    p.innerHTML = `packs in this graph: ${packs.map((x) => `<span class="pill" style="border-color:${packHue.get(x)};color:${packHue.get(x)}">${esc(x)}</span>`).join(' ')} · switch colour to "by pack" to see where they bind`;
    box.appendChild(p);
  }
}

function renderLegend(): void {
  const box = $('legend');
  box.innerHTML = '';
  const p = pal();
  const counts = new Map<Category, number>();
  for (const n of state.snapshot.nodes) { const c = category(n, nodeState.get(n.id)); if (c) counts.set(c, (counts.get(c) ?? 0) + 1); }
  const show = CATEGORIES.filter((c) => (counts.get(c.key) ?? 0) > 0 || ['edit', 'dark', 'module'].includes(c.key));
  for (const c of show) {
    const b = document.createElement('button');
    b.setAttribute('aria-pressed', String(state.isolate === c.key));
    b.innerHTML = `<i style="background:${c.color(p)}"></i>${c.name} <b>${counts.get(c.key) ?? 0}</b>`;
    b.title = state.isolate === c.key ? 'showing only this category; click to show all' : 'click to show only this category';
    b.onclick = () => { state.isolate = state.isolate === c.key ? undefined : c.key; renderLegend(); refreshGraph(); };
    box.appendChild(b);
  }
  const swatches = controls.colour === 'concept' ? [...conceptHue].map(([id, color]) => ({ label: nodeIndex.get(id)?.label ?? id, color, id }))
    : controls.colour === 'pack' ? [...packHue].map(([id, color]) => ({ label: `pack ${id}`, color, id: '' }))
    : controls.colour === 'governance' ? [{ label: 'enforced in force', color: p.enforced, id: '' }, { label: 'guided in force', color: p.guided, id: '' }, { label: 'no rule in force', color: p.none, id: '' }]
    : controls.colour === 'session' ? [...state.sessionColor].map(([s, color]) => ({ label: s.slice(0, 8), color, id: '' })) : [];
  for (const s of swatches) {
    const b = document.createElement('button');
    b.innerHTML = `<i style="background:${s.color}"></i>${esc(s.label.length > 40 ? s.label.slice(0, 38) + '…' : s.label)}`;
    if (s.id) b.onclick = () => select(s.id);
    box.appendChild(b);
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
  const start = windowStart();
  const evs = state.events.filter((e) => inWindow(e, start) && (!state.session || e.session === state.session || e.t === 'finding'));
  if (!evs.length) return;
  const times = evs.map((e) => new Date(e.ts).getTime()).filter((t) => Number.isFinite(t));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const span = Math.max(1, t1 - t0);
  const bins = Math.max(20, Math.floor(w / 4));
  const reads = new Array<number>(bins).fill(0), edits = new Array<number>(bins).fill(0), bad = new Array<number>(bins).fill(0), marks: { x: number; kind: string }[] = [];
  const binOf = (ts: string): number => Math.min(bins - 1, Math.max(0, Math.floor(((new Date(ts).getTime() - t0) / span) * bins)));
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
  const cursorEv = state.events[Math.max(0, state.cursor - 1)];
  if (cursorEv && !state.live) { const x = ((new Date(cursorEv.ts).getTime() - t0) / span) * w; ctx.fillStyle = p.labelModule; ctx.fillRect(x - 1, 0, 2, h); }
  const day = 86_400_000;
  $('tl-start').textContent = stamp(t0);
  $('tl-end').textContent = span > day ? stamp(t1) : clock(t1).slice(0, 5);
  canvas.title = 'grey: reads · orange: edits · red: edits with all callers dark · marks: session start (purple), compaction (orange), decision (teal). Click to seek.';
}

// ---- controls -------------------------------------------------------------------------------

function short(p: string): string { const parts = p.split('/'); return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p; }
function esc(s: string): string { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)); }
function ago(ms: number): string { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`; }
function setStatus(text?: string): void {
  const snap = state.snapshot.nodes;
  const open = state.ws?.readyState === WebSocket.OPEN;
  const fresh = state.lastEventAt ? `last event ${ago(Date.now() - state.lastEventAt)} ago` : 'no events yet';
  const link = open ? (state.live ? `live · ${fresh}` : `paused at ${state.cursor} · ${fresh}`) : 'reconnecting';
  const el = $('status');
  el.textContent = text ?? `${link} · ${state.events.length} events · ${nodeState.size} nodes lit · ${snap.filter((n) => n.kind === 'module').length} modules, ${snap.filter((n) => n.kind === 'file').length} files, ${snap.filter((n) => n.kind === 'concept').length} concepts, ${snap.filter((n) => n.kind === 'constraint').length} rules`;
  el.classList.toggle('warn', !open);
}
window.setInterval(() => { if (state.repo) setStatus(); }, 1000);
function refreshTime(): void { const r = $<HTMLInputElement>('time'); r.max = String(state.events.length); if (state.live) r.value = r.max; drawTimeline(); }
function press(on: string, off: string): void { $(on).setAttribute('aria-pressed', 'true'); $(off).setAttribute('aria-pressed', 'false'); }
function applyTheme(): void { document.documentElement.dataset.theme = controls.theme; $('theme').textContent = controls.theme === 'dark' ? 'light theme' : 'dark theme'; }
function syncControls(): void {
  applyTheme();
  press(controls.mode === '3d' ? 'mode3d' : 'mode2d', controls.mode === '3d' ? 'mode2d' : 'mode3d');
  $<HTMLSelectElement>('files').value = controls.files;
  $<HTMLSelectElement>('window').value = controls.window;
  $<HTMLSelectElement>('labels').value = controls.labels;
  $<HTMLSelectElement>('meaning').value = controls.meaning;
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
$<HTMLSelectElement>('window').onchange = (e) => { controls.window = (e.target as HTMLSelectElement).value as Controls['window']; save(); replayTo(state.cursor); refreshTime(); };
$<HTMLSelectElement>('labels').onchange = (e) => { controls.labels = (e.target as HTMLSelectElement).value as Controls['labels']; save(); rebuild(); };
$<HTMLSelectElement>('meaning').onchange = (e) => { controls.meaning = (e.target as HTMLSelectElement).value as Controls['meaning']; save(); refreshGraph(); renderLegend(); };
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
  const hit = state.snapshot.nodes.find((n) => n.id.toLowerCase() === q) ?? state.snapshot.nodes.find((n) => n.id.toLowerCase().includes(q) || n.label.toLowerCase().includes(q));
  if (!hit) { $('detail').textContent = `nothing matches "${q}"`; return; }
  if (hit.kind === 'file' && !nodeState.has(hit.id) && controls.files === 'touched') { if (hit.module) state.expanded.add(hit.module); refreshGraph(); }
  setTimeout(() => select(hit.id), 50);
};
$<HTMLSelectElement>('speed').onchange = (e) => { controls.speed = Number((e.target as HTMLSelectElement).value); save(); };
$('live').onclick = () => { stopPlay(); state.live = true; $('live').setAttribute('aria-pressed', 'true'); state.cursor = state.events.length; $('timeLabel').textContent = 'live'; replayTo(state.cursor); refreshTime(); };
$<HTMLInputElement>('time').oninput = (e) => { stopPlay(); state.live = false; $('live').setAttribute('aria-pressed', 'false'); state.cursor = Number((e.target as HTMLInputElement).value); const ev = state.events[state.cursor - 1]; $('timeLabel').textContent = ev ? clock(ev.ts) : 'start'; replayTo(state.cursor); };
$<HTMLCanvasElement>('tl').onclick = (e) => {
  const canvas = e.currentTarget as HTMLCanvasElement;
  const frac = (e.clientX - canvas.getBoundingClientRect().left) / canvas.clientWidth;
  const evs = state.events;
  if (!evs.length) return;
  const times = evs.map((x) => new Date(x.ts).getTime());
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const target = t0 + frac * (t1 - t0);
  const idx = times.filter((t) => t <= target).length;
  stopPlay(); state.live = false; $('live').setAttribute('aria-pressed', 'false');
  state.cursor = idx; $<HTMLInputElement>('time').value = String(idx);
  const ev = evs[idx - 1]; $('timeLabel').textContent = ev ? clock(ev.ts) : 'start';
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
    const ev = state.events[next - 1]; $('timeLabel').textContent = ev ? clock(ev.ts) : 'start';
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
