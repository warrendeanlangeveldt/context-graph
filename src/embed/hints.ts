import type { RepoContext } from '../core/context.js';
import { localServer } from '../overlay/client.js';
import { repoHash } from '../util/paths.js';
import type { WalkResult } from '../walker/walk.js';
import { openStore } from './index.js';
import { makeProvider, type EmbeddingProvider } from './provider.js';
import type { Hit } from './store.js';

/**
 * Hint retrieval for the slice (design spec §10.4). Results are hints, never constraints: they
 * carry a score, sit below a threshold, and are dropped first under budget.
 *
 * Hooks are short-lived processes, so an in-process model would be loaded on every edit. When the
 * local server is running it keeps the model warm and answers hint queries; the hook only embeds
 * in-process as a fallback, and every path is bounded by a timeout.
 */
export function hintQuery(w: WalkResult, intent: string | undefined): string {
  return [intent ?? '', `file ${w.path}`, ...w.constraints.map((k) => k.text)].filter(Boolean).join('\n').slice(0, 2000);
}

/** In-process retrieval against the repository's index, with a caller-supplied warm provider when available. */
export async function retrieveHints(ctx: RepoContext, query: string, excludePath: string | undefined, provider?: EmbeddingProvider): Promise<string[]> {
  const cfg = ctx.config.embed;
  const store = openStore(ctx);
  if (!store) return [];
  try {
    if (store.count() === 0) return [];
    const p = provider ?? makeProvider(cfg);
    const vec = (await p.embed([query]))[0];
    if (!vec) return [];
    return store
      .query(vec, cfg.maxHints * 4, { includeArchived: cfg.includeArchived })
      .filter((h) => h.score >= cfg.minScore && h.path !== excludePath)
      .slice(0, cfg.maxHints)
      .map((h) => `${h.ref}  ${h.score.toFixed(2)}  "${snippet(h.text)}"`);
  } finally {
    store.close();
  }
}

/** Raw hits for a query, for callers that need paths and scores rather than rendered lines. Explicit calls may embed in-process. */
export async function retrieveHits(ctx: RepoContext, query: string, k: number, timeoutMs = 3000): Promise<Hit[]> {
  const store = openStore(ctx);
  if (!store) return [];
  try {
    if (store.count() === 0) return [];
    const vec = (await withTimeout(makeProvider(ctx.config.embed).embed([query]), timeoutMs))[0];
    if (!vec) return [];
    return store.query(vec, k, { includeArchived: ctx.config.embed.includeArchived });
  } finally {
    store.close();
  }
}

export async function hintsFor(ctx: RepoContext, w: WalkResult, intent: string | undefined, timeoutMs = 800): Promise<string[]> {
  if (!ctx.config.embed.enabled) return [];
  const query = hintQuery(w, intent);
  const local = localServer();
  if (local) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const q = new URLSearchParams({ q: query, path: w.path });
        const res = await fetch(`http://127.0.0.1:${local.port}/v1/${repoHash(ctx.root)}/hints?${q}`, { signal: ac.signal });
        if (res.ok) return (await res.json()) as string[];
      } finally {
        clearTimeout(timer);
      }
    } catch { /* fall through */ }
  }
  if (!ctx.config.embed.inProcessHooks) return [];
  try {
    return await withTimeout(retrieveHints(ctx, query, w.path), timeoutMs);
  } catch {
    return [];
  }
}

function snippet(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > 90 ? one.slice(0, 87) + '...' : one;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
