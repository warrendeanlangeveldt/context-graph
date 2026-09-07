import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Walk upward from `start` to the nearest directory containing `.git`. Falls back to `start`. */
export function findRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}

/** Per-user home for observations, state, index caches, and linked graphs. */
export function ctxHome(): string {
  return process.env.CTX_HOME ?? join(homedir(), '.ctx');
}

/** Stable short identifier for a repository, derived from its absolute root path. */
export function repoHash(root: string): string {
  return createHash('sha1').update(resolve(root)).digest('hex').slice(0, 12);
}

/**
 * Where this repository's graph lives. Precedence: CTX_GRAPH_DIR, then `.ctx/` inside the
 * repository, then a graph linked under the user's ctx home (for trialling a graph without
 * adding files to the repository). Undefined when no graph exists, which is observe-only mode.
 */
export function resolveGraphDir(root: string): string | undefined {
  if (process.env.CTX_GRAPH_DIR) return resolve(process.env.CTX_GRAPH_DIR);
  const inRepo = join(root, '.ctx');
  if (existsSync(join(inRepo, 'graph.ctx'))) return inRepo;
  const linked = join(ctxHome(), 'graphs', repoHash(root));
  if (existsSync(join(linked, 'graph.ctx'))) return linked;
  return undefined;
}

/** Repository-relative, forward-slash path. Paths outside the repository stay absolute. */
export function toRepoRelative(root: string, p: string, cwd?: string): string {
  const abs = isAbsolute(p) ? p : resolve(cwd ?? root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return abs.split(sep).join('/');
  return rel.split(sep).join('/');
}

export function toAbsolute(root: string, repoRelative: string): string {
  return isAbsolute(repoRelative) ? repoRelative : join(root, ...repoRelative.split('/'));
}
