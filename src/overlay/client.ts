import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import type { Envelope } from '../observe/event.js';
import { ctxHome, repoHash } from '../util/paths.js';
import type { WalkResult } from '../walker/walk.js';

/**
 * Client side of the overlay (design spec §12 and §14.1). Two targets: the local `ctx serve`
 * process when it is running, and the hosted overlay when the developer has opted into
 * forwarding. Every call is bounded by a short timeout and never fails the hook.
 */
export interface OverlayTarget { url: string; token?: string; mode: 'local' | 'hosted' }

export interface LiveResponse {
  provisional?: { id: string; who: string; branch: string; serves: string; overrides?: string; text: string; age: string; conflict?: boolean }[];
  touches?: { who: string; session: string; mode: string; age: string }[];
}

export function localServer(): { port: number; pid: number } | undefined {
  const f = join(ctxHome(), 'serve.json');
  if (!existsSync(f)) return undefined;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8')) as { port: number; pid: number };
    if (j.port && j.pid && alive(j.pid)) return j;
  } catch { /* stale */ }
  return undefined;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function overlayTargets(ctx: RepoContext): OverlayTarget[] {
  const out: OverlayTarget[] = [];
  const local = localServer();
  if (local) out.push({ url: `http://127.0.0.1:${local.port}`, mode: 'local' });
  if (ctx.config.overlayUrl && ctx.config.forward) {
    const t: OverlayTarget = { url: ctx.config.overlayUrl.replace(/\/$/, ''), mode: 'hosted' };
    if (process.env.CTX_OVERLAY_TOKEN) t.token = process.env.CTX_OVERLAY_TOKEN;
    out.push(t);
  }
  return out;
}

async function request(t: OverlayTarget, method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (t.token) headers.authorization = `Bearer ${t.token}`;
    const res = await fetch(t.url + path, { method, headers, signal: ac.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!res.ok) throw new Error(`${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Fire-and-forget delivery of one envelope to every reachable overlay. */
export function notifyOverlay(ctx: RepoContext, env: Envelope): void {
  for (const t of overlayTargets(ctx)) {
    void request(t, 'POST', `/v1/${repoHash(ctx.root)}/observe`, [env], 300).catch(() => undefined);
  }
}

/** Provisional decisions and in-flight touches on the applicable nodes, rendered as `live` lines. */
export async function liveLinesFor(ctx: RepoContext, w: WalkResult, meta: { session: string; branch: string }): Promise<string[]> {
  const lines: string[] = [];
  for (const t of overlayTargets(ctx)) {
    try {
      const q = new URLSearchParams({ nodes: w.applicable.join(','), path: w.path, branch: meta.branch, session: meta.session });
      const r = (await request(t, 'GET', `/v1/${repoHash(ctx.root)}/live?${q}`, undefined, 400)) as LiveResponse | undefined;
      for (const p of r?.provisional ?? []) {
        lines.push(`${p.id} provisional ${p.who} on ${p.branch}  ${p.overrides ? `!${p.overrides}  ` : ''}${p.text}  (${p.age})${p.conflict ? '  <- conflicts with what you are about to honour' : ''}`);
      }
      // One line per person: the strongest access they have had, not every touch they made.
      const rank: Record<string, number> = { write: 6, edit: 6, full: 5, range: 4, delegated: 3, grep: 2, name: 1 };
      const byWho = new Map<string, { mode: string; age: string }>();
      for (const x of r?.touches ?? []) {
        const cur = byWho.get(x.who);
        if (!cur || (rank[x.mode] ?? 0) > (rank[cur.mode] ?? 0)) byWho.set(x.who, { mode: x.mode, age: x.age });
      }
      for (const [who, x] of byWho) lines.push(`${who} has this file open (${x.mode}, ${x.age})`);
    } catch { /* overlay unreachable: no live lines */ }
  }
  return lines;
}

/** Tell the overlays a decision was recorded, so it becomes provisional state until merged. */
export function publishDecision(ctx: RepoContext, env: Envelope): void {
  notifyOverlay(ctx, env);
}
