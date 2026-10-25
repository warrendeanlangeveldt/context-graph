import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutHash, ctxHome, toAbsolute } from '../util/paths.js';

/**
 * COST-3 (docs/specs/10-cost.md): a file's content hash, kept by its size and modification time, so
 * `ctx cards`, the backfill and the snapshot read only the files that changed since the last run. Kept
 * per checkout under the ctx home, beside the import index, and written once as the process exits.
 */

interface Entry {
  /** Size in bytes. */
  s: number;
  /** Modification time, in ms. */
  m: number;
  /** The content hash, or null for a file whose contents aren't code a card describes. */
  h: string | null;
}

interface Cache {
  file: string;
  entries: Record<string, Entry>;
  dirty: boolean;
}

const caches = new Map<string, Cache>();
let flushing = false;

/** A file changed this close to the run may change again within the same mtime: it isn't cached. */
const RACY_MS = 2000;

function cacheFor(root: string): Cache {
  const key = checkoutHash(root);
  let c = caches.get(key);
  if (c) return c;
  const file = join(ctxHome(), 'hashes', `${key}.json`);
  let entries: Record<string, Entry> = {};
  try {
    entries = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
  } catch {
    /* none yet, or unreadable: start empty */
  }
  c = { file, entries, dirty: false };
  caches.set(key, c);
  if (!flushing) {
    flushing = true;
    process.on('exit', flushHashCaches);
  }
  return c;
}

/** Writes each cache that changed. Run as the process exits; tests call it directly. */
export function flushHashCaches(): void {
  for (const c of caches.values()) {
    if (!c.dirty) continue;
    try {
      mkdirSync(join(c.file, '..'), { recursive: true });
      writeFileSync(c.file, JSON.stringify(c.entries), 'utf8');
      c.dirty = false;
    } catch {
      /* a read-only home: the next run hashes again */
    }
  }
}

/** Forgets what this process read, so the next lookup reads the cache file again (for tests). */
export function resetHashCaches(): void {
  caches.clear();
}

/**
 * The file's hash as `compute` gives it (undefined for a file that owes no card), from the cache when
 * its size and modification time are unchanged. A file that doesn't exist is never cached.
 */
export function cachedHash(root: string, path: string, compute: () => string | undefined, now = Date.now()): string | undefined {
  let st;
  try {
    st = statSync(toAbsolute(root, path));
  } catch {
    return compute();
  }
  const c = cacheFor(root);
  const hit = c.entries[path];
  if (hit && hit.s === st.size && hit.m === st.mtimeMs) return hit.h ?? undefined;
  const h = compute();
  if (now - st.mtimeMs >= RACY_MS) {
    c.entries[path] = { s: st.size, m: st.mtimeMs, h: h ?? null };
    c.dirty = true;
  } else if (hit) {
    delete c.entries[path];
    c.dirty = true;
  }
  return h;
}
