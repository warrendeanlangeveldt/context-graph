import type { RepoContext } from '../core/context.js';
import type { WalkResult } from '../walker/walk.js';
import { openStore } from './index.js';
import { makeProvider } from './provider.js';

/**
 * Hint retrieval for the slice (design spec §10.4). Results are hints, never constraints: they
 * carry a score, sit below a threshold, and are dropped first under budget. Bounded by a timeout
 * so an unreachable embedding endpoint costs one wait, not a broken edit.
 */
export async function hintsFor(ctx: RepoContext, w: WalkResult, intent: string | undefined, timeoutMs = 800): Promise<string[]> {
  const cfg = ctx.config.embed;
  if (!cfg.enabled) return [];
  const store = openStore(ctx);
  if (!store) return [];
  try {
    if (store.count() === 0) return [];
    const query = [intent ?? '', `file ${w.path}`, ...w.constraints.map((k) => k.text)].filter(Boolean).join('\n').slice(0, 2000);
    const provider = makeProvider(cfg);
    const vec = await withTimeout(provider.embed([query]), timeoutMs);
    const v = vec[0];
    if (!v) return [];
    const hits = store
      .query(v, cfg.maxHints * 4, { includeArchived: cfg.includeArchived })
      .filter((h) => h.score >= cfg.minScore && h.path !== w.path)
      .slice(0, cfg.maxHints);
    return hits.map((h) => `${h.ref}  ${h.score.toFixed(2)}  "${snippet(h.text)}"`);
  } catch {
    return [];
  } finally {
    store.close();
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
