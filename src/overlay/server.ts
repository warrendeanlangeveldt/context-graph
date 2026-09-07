import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { openRepo } from '../core/context.js';
import type { DRecord } from '../graph/records.js';
import { loadArchive } from '../hygiene/hygiene.js';
import { loadOrBuildImportIndex } from '../index/imports.js';
import type { CoverageRecord } from '../observe/coverage.js';
import type { Envelope, SessionPayload, Touch } from '../observe/event.js';
import { ctxHome, findRepoRoot, repoHash } from '../util/paths.js';

/**
 * The event server (design spec §12 and §14.1). One binary, two modes. Local mode binds to
 * loopback, ingests from hooks and by tailing observation files, and serves the synapse view.
 * Hosted mode is the same server with a bearer token, fed by forwarded observations, holding
 * provisional decisions and in-flight touches across branches and running the cross-branch
 * checks continuously. It is an overlay: if it is down, nothing but early warning is lost.
 */
export interface ServeOptions {
  port: number;
  hosted?: boolean;
  token?: string;
  bufferEvents?: number;
  retentionDays?: number;
  viewDir?: string;
  /** Local mode: repositories to register up front (root paths). Others register as sessions arrive. */
  repos?: string[];
  bind?: string;
}

interface Stamped extends Envelope { seq: number }
interface SessionInfo { session: string; who: string; branch: string; harness: string; cwd?: string; arm?: string; first: string; last: string; events: number }
interface Provisional { decision: DRecord; who: string; branch: string; session: string; ts: string }
interface TouchInfo { who: string; session: string; branch: string; mode: string; ts: string }

class RepoState {
  seq = 0;
  buffer: Stamped[] = [];
  sessions = new Map<string, SessionInfo>();
  provisional = new Map<string, Provisional>();
  touches = new Map<string, TouchInfo[]>();
  findings: Stamped[] = [];
  root?: string;
  snapshot?: { at: number; data: unknown };
  constructor(readonly hash: string, readonly cap: number) {}
}

export interface RunningServer { port: number; close(): Promise<void>; state(hash: string): RepoState | undefined; ingest(hash: string, envs: Envelope[]): Stamped[] }

export async function startServer(opts: ServeOptions): Promise<RunningServer> {
  const cap = opts.bufferEvents ?? 50_000;
  const retentionMs = (opts.retentionDays ?? 30) * 86_400_000;
  const repos = new Map<string, RepoState>();
  const clients = new Map<WebSocket, { hash: string; session?: string }>();
  const viewDir = opts.viewDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'view', 'dist');
  const state = (hash: string): RepoState => { let s = repos.get(hash); if (!s) { s = new RepoState(hash, cap); repos.set(hash, s); } return s; };

  const broadcast = (hash: string, items: Stamped[]): void => {
    for (const [ws, sub] of clients) {
      if (sub.hash !== hash || ws.readyState !== WebSocket.OPEN) continue;
      for (const it of items) if (!sub.session || it.session === sub.session || it.t === 'finding') ws.send(JSON.stringify(it));
    }
  };

  const ingest = (hash: string, envs: Envelope[]): Stamped[] => {
    const s = state(hash);
    const out: Stamped[] = [];
    for (const env of envs) {
      if (!env || typeof env !== 'object' || !env.t || !env.session) continue;
      const st: Stamped = { ...env, seq: ++s.seq };
      s.buffer.push(st);
      if (s.buffer.length > cap) s.buffer.splice(0, s.buffer.length - cap);
      out.push(st);
      track(s, st, retentionMs);
      if (st.t === 'decision') {
        const d = st.p as DRecord;
        if (d.sha === '-') s.provisional.set(d.id, { decision: d, who: st.who, branch: st.branch, session: st.session, ts: st.ts });
        else s.provisional.delete(d.id);
        for (const f of crossBranchFindings(s, d, st)) { f.seq = ++s.seq; s.buffer.push(f); s.findings.push(f); out.push(f); }
      }
      if (st.t === 'session' && !opts.hosted && !s.root) {
        const cwd = (st.p as SessionPayload).cwd;
        if (cwd && existsSync(cwd)) s.root = findRepoRoot(cwd);
      }
    }
    broadcast(hash, out);
    return out;
  };

  // Local mode: replay and tail the observation files on disk.
  const tails = new Map<string, number>();
  const readNew = (file: string, hash: string): void => {
    let size: number;
    try { size = statSync(file).size; } catch { return; }
    const from = tails.get(file) ?? 0;
    if (size <= from) { if (size < from) tails.set(file, 0); return; }
    const stream = createReadStream(file, { start: from, end: size - 1, encoding: 'utf8' });
    let buf = '';
    stream.on('data', (d) => { buf += d; });
    stream.on('end', () => {
      tails.set(file, size);
      const lines = buf.split('\n');
      const envs: Envelope[] = [];
      for (const l of lines) { if (!l.trim()) continue; try { envs.push(JSON.parse(l) as Envelope); } catch { /* torn line */ } }
      if (envs.length) ingest(hash, envs);
    });
  };
  let watcher: ReturnType<typeof watch> | undefined;
  if (!opts.hosted) {
    const obsDir = join(ctxHome(), 'observations');
    mkdirSync(obsDir, { recursive: true });
    for (const hash of readdirSync(obsDir)) {
      const dir = join(obsDir, hash);
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl')).sort((a, b) => statSync(join(dir, a)).mtimeMs - statSync(join(dir, b)).mtimeMs)) readNew(join(dir, f), hash);
    }
    for (const r of opts.repos ?? []) state(repoHash(r)).root = findRepoRoot(r);
    try {
      watcher = watch(obsDir, { recursive: true }, (_ev, name) => {
        if (!name || !String(name).endsWith('.jsonl')) return;
        const rel = String(name);
        const hash = rel.split(/[\\/]/)[0]!;
        readNew(join(obsDir, rel), hash);
      });
    } catch { /* recursive watch unsupported: ingestion still works through POST */ }
  }

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: Error) => { res.statusCode = 500; res.end(JSON.stringify({ error: e.message })); });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    res.setHeader('access-control-allow-origin', '*');
    if (url.pathname.startsWith('/v1/')) {
      if (opts.token && req.headers.authorization !== `Bearer ${opts.token}`) { res.statusCode = 401; res.end('unauthorised'); return; }
      const parts = url.pathname.split('/').filter(Boolean); // v1, hash, ...
      if (parts[1] === 'repos') return sendJson(res, [...repos.values()].map((s) => ({ hash: s.hash, root: s.root ?? null, sessions: s.sessions.size, events: s.buffer.length, provisional: s.provisional.size })));
      const hash = parts[1];
      if (!hash) { res.statusCode = 404; res.end(); return; }
      const s = state(hash);
      const rest = parts.slice(2).join('/');
      if (req.method === 'POST' && rest === 'observe') { const body = (await readBody(req)) as Envelope[]; ingest(hash, Array.isArray(body) ? body : [body]); return sendJson(res, { ok: true, seq: s.seq }); }
      if (req.method === 'POST' && rest === 'register') { const body = (await readBody(req)) as { root?: string }; if (body.root && existsSync(body.root) && !opts.hosted) s.root = findRepoRoot(body.root); return sendJson(res, { ok: true, root: s.root ?? null }); }
      if (req.method === 'POST' && rest === 'provisional/retire') {
        const body = (await readBody(req)) as { ids?: string[]; branch?: string };
        let n = 0;
        for (const [id, p] of s.provisional) if ((body.ids && body.ids.includes(id)) || (body.branch && p.branch === body.branch)) { s.provisional.delete(id); n++; }
        return sendJson(res, { retired: n });
      }
      if (rest === 'live') return sendJson(res, live(s, url.searchParams));
      if (rest === 'sessions') return sendJson(res, [...s.sessions.values()].sort((a, b) => b.last.localeCompare(a.last)));
      if (rest === 'provisional') return sendJson(res, [...s.provisional.values()]);
      if (rest === 'conflicts') { const branch = url.searchParams.get('branch'); return sendJson(res, s.findings.filter((f) => !branch || (f.p as { branches?: string[] }).branches?.includes(branch))); }
      if (rest === 'events') { const session = url.searchParams.get('session'); const since = Number(url.searchParams.get('since') ?? 0); return sendJson(res, s.buffer.filter((e) => e.seq > since && (!session || e.session === session)).slice(-5000)); }
      if (rest === 'coverage') { const session = url.searchParams.get('session'); return sendJson(res, s.buffer.filter((e) => e.t === 'coverage' && (!session || e.session === session)).map((e) => ({ seq: e.seq, ts: e.ts, session: e.session, ...(e.p as CoverageRecord) }))); }
      if (rest === 'graph') return sendJson(res, snapshot(s));
      if (rest === 'decisions') return sendJson(res, decisionsFor(s));
      res.statusCode = 404; res.end(JSON.stringify({ error: 'not found' })); return;
    }
    // Static view.
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    const abs = join(viewDir, file);
    if (existsSync(abs) && statSync(abs).isFile()) {
      res.setHeader('content-type', MIME[extname(abs)] ?? 'application/octet-stream');
      res.end(readFileSync(abs));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>Context Graph</title><body style="font-family:system-ui;padding:2rem;max-width:60ch"><h1>Context Graph server</h1><p>The event server is running on port ${opts.port}${opts.hosted ? ' (hosted mode)' : ''}. ${repos.size} repository(ies) known.</p><p>The synapse view has not been built on this machine. Build it once with:</p><pre>cd ${resolve(viewDir, '..')} &amp;&amp; npm install &amp;&amp; npm run build</pre><p>then reload this page. The API is live under <code>/v1/</code>.</p></body>`);
      return;
    }
    res.statusCode = 404; res.end('not found');
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/v1\/([^/]+)\/stream$/.exec(url.pathname);
    if (!m) { socket.destroy(); return; }
    if (opts.token && req.headers.authorization !== `Bearer ${opts.token}` && url.searchParams.get('token') !== opts.token) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const hash = m[1]!;
      const session = url.searchParams.get('session') ?? undefined;
      const since = Number(url.searchParams.get('since') ?? 0);
      clients.set(ws, session ? { hash, session } : { hash });
      const s = state(hash);
      for (const e of s.buffer) if (e.seq > since && (!session || e.session === session || e.t === 'finding')) ws.send(JSON.stringify(e));
      ws.send(JSON.stringify({ t: 'ready', seq: s.seq }));
      ws.on('close', () => clients.delete(ws));
    });
  });

  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.bind ?? (opts.hosted ? '0.0.0.0' : '127.0.0.1'), () => resolveStart());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const serveFile = join(ctxHome(), 'serve.json');
  if (!opts.hosted) { mkdirSync(ctxHome(), { recursive: true }); writeFileSync(serveFile, JSON.stringify({ port, pid: process.pid, startedAt: new Date().toISOString() }), 'utf8'); }
  const prune = setInterval(() => { for (const s of repos.values()) pruneOld(s, retentionMs); }, 60_000);
  prune.unref();

  return {
    port,
    state: (hash) => repos.get(hash),
    ingest,
    close: () => new Promise<void>((done) => {
      clearInterval(prune);
      watcher?.close();
      for (const ws of clients.keys()) ws.close();
      wss.close();
      server.close(() => { if (!opts.hosted && existsSync(serveFile)) { try { unlinkSync(serveFile); } catch { /* ignore */ } } done(); });
    }),
  };
}

// ---- state tracking -----------------------------------------------------------------

function track(s: RepoState, e: Stamped, retentionMs: number): void {
  let info = s.sessions.get(e.session);
  if (!info) { info = { session: e.session, who: e.who, branch: e.branch, harness: e.harness, first: e.ts, last: e.ts, events: 0 }; s.sessions.set(e.session, info); }
  info.last = e.ts; info.events++;
  if (e.t === 'session') { const p = e.p as SessionPayload; if (p.cwd) info.cwd = p.cwd; if (p.arm) info.arm = p.arm; }
  if (e.t === 'touch' || e.t === 'edit') {
    const p = e.p as Touch;
    const list = s.touches.get(p.path) ?? [];
    list.push({ who: e.who, session: e.session, branch: e.branch, mode: p.mode, ts: e.ts });
    const cutoff = Date.now() - retentionMs;
    s.touches.set(p.path, list.filter((t) => new Date(t.ts).getTime() > cutoff).slice(-50));
  }
}

function pruneOld(s: RepoState, retentionMs: number): void {
  const cutoff = Date.now() - retentionMs;
  for (const [id, p] of s.provisional) if (new Date(p.ts).getTime() < cutoff) s.provisional.delete(id);
  for (const [path, list] of s.touches) { const kept = list.filter((t) => new Date(t.ts).getTime() > cutoff); if (kept.length) s.touches.set(path, kept); else s.touches.delete(path); }
}

/** Opposed arrows between this decision and provisional decisions on other branches (design spec §12.1). */
function crossBranchFindings(s: RepoState, d: DRecord, st: Stamped): Stamped[] {
  const out: Stamped[] = [];
  for (const other of s.provisional.values()) {
    if (other.decision.id === d.id || other.branch === st.branch) continue;
    const o = other.decision;
    const k = (d.overrides && o.serves === d.overrides) ? d.overrides : (o.overrides && d.serves === o.overrides) ? o.overrides : undefined;
    if (!k) continue;
    out.push({
      t: 'finding', ts: new Date().toISOString(), session: st.session, who: st.who, branch: st.branch, harness: 'overlay', seq: 0,
      p: { rule: 'live-opposed-arrows', message: `${d.id} on ${st.branch} and ${o.id} on ${other.branch} disagree about ${k}: "${d.text}" vs "${o.text}"`, constraint: k, branches: [st.branch, other.branch], decisions: [d.id, o.id], sessions: [st.session, other.session] },
    });
  }
  return out;
}

function live(s: RepoState, q: URLSearchParams): unknown {
  const nodes = new Set((q.get('nodes') ?? '').split(',').filter(Boolean));
  const path = q.get('path') ?? '';
  const branch = q.get('branch') ?? '';
  const session = q.get('session') ?? '';
  const now = Date.now();
  const age = (ts: string): string => { const m = Math.max(0, Math.round((now - new Date(ts).getTime()) / 60_000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const provisional = [...s.provisional.values()]
    .filter((p) => p.branch !== branch && (nodes.has(p.decision.node) || nodes.has(p.decision.serves) || (p.decision.overrides !== undefined && nodes.has(p.decision.overrides))))
    .map((p) => ({ id: p.decision.id, who: p.who, branch: p.branch, serves: p.decision.serves, overrides: p.decision.overrides, text: p.decision.text, age: age(p.ts), conflict: p.decision.overrides !== undefined && nodes.has(p.decision.overrides) }));
  const touches = (s.touches.get(path) ?? []).filter((t) => t.session !== session && now - new Date(t.ts).getTime() < 2 * 3_600_000).slice(-5).map((t) => ({ who: t.who, session: t.session, mode: t.mode, age: age(t.ts) }));
  return { provisional, touches };
}

// ---- graph snapshot for the view -------------------------------------------------------

function snapshot(s: RepoState): unknown {
  if (!s.root) return { error: 'repository root unknown to the server; start a session or POST /register', nodes: [], links: [] };
  if (s.snapshot && Date.now() - s.snapshot.at < 60_000) return s.snapshot.data;
  const ctx = openRepo({ repo: s.root });
  const index = loadOrBuildImportIndex(s.root);
  const nodes: { id: string; kind: 'file' | 'module' | 'concept'; label: string; module?: string; size: number }[] = [];
  const links: { source: string; target: string; rel: 'import' | 'in' | 'impl' }[] = [];
  const seen = new Set<string>();
  const add = (n: typeof nodes[number]): void => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
  const g = ctx.graph;
  if (g) {
    for (const l of g.logicals.values()) add({ id: l.id, kind: 'module', label: l.name, size: 1 });
    for (const c of g.concepts.values()) if (!c.proposed) add({ id: c.id, kind: 'concept', label: c.name, size: 1 });
    for (const e of g.edges) if (!e.proposed && (e.rel === 'in' || e.rel === 'impl') && seen.has(e.from) && seen.has(e.to)) links.push({ source: e.from, target: e.to, rel: e.rel });
  }
  const files = Object.keys(index.imports);
  for (const f of files) {
    const m = g?.mapPath(f)?.logical;
    add({ id: f, kind: 'file', label: f.split('/').pop() ?? f, size: Math.max(1, Math.min(8, (index.imports[f]?.length ?? 0) / 2 + 1)), ...(m ? { module: m } : {}) });
    if (m && seen.has(m)) { const mod = nodes.find((n) => n.id === m); if (mod) mod.size += 1; links.push({ source: f, target: m, rel: 'in' }); }
  }
  for (const [f, targets] of Object.entries(index.imports)) for (const t of targets) if (seen.has(t)) links.push({ source: f, target: t, rel: 'import' });
  const data = { root: s.root, nodes, links, builtAt: new Date().toISOString() };
  s.snapshot = { at: Date.now(), data };
  return data;
}

function decisionsFor(s: RepoState): unknown {
  if (!s.root) return [];
  const ctx = openRepo({ repo: s.root });
  const g = ctx.graph;
  if (!g || !ctx.graphDir) return [];
  const rows: { id: string; date: string; who: string; node: string; serves: string; overrides?: string; text: string; sha: string; branch: string; active: boolean; archived: boolean }[] = [];
  for (const d of g.decisions.values()) rows.push({ id: d.id, date: d.date, who: d.who, node: d.node, serves: d.serves, ...(d.overrides ? { overrides: d.overrides } : {}), text: d.text, sha: d.sha, branch: d.branch, active: g.isActiveDecision(d), archived: false });
  for (const r of loadArchive(ctx.graphDir)) if (r.kind === 'D') rows.push({ id: r.id, date: r.date, who: r.who, node: r.node, serves: r.serves, ...(r.overrides ? { overrides: r.overrides } : {}), text: r.text, sha: r.sha, branch: r.branch, active: false, archived: true });
  const retirements = [...g.retirements, ...loadArchive(ctx.graphDir).filter((r) => r.kind === 'Z')].map((z) => z.kind === 'Z' ? { target: z.target, date: z.date, who: z.who, reason: z.reason, succ: z.succ } : null).filter(Boolean);
  return { decisions: rows.sort((a, b) => a.date.localeCompare(b.date)), retirements };
}

// ---- http helpers ----------------------------------------------------------------------

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2' };

function sendJson(res: ServerResponse, data: unknown): void {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let buf = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { buf += d; if (buf.length > 50_000_000) reject(new Error('body too large')); });
    req.on('end', () => { try { resolveBody(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e as Error); } });
    req.on('error', reject);
  });
}
