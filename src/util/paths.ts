import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
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

/**
 * The main checkout of a repository, from any of its worktrees. A linked worktree's `.git` is a file
 * naming `<main>/.git/worktrees/<name>`; anything else (a main checkout, a submodule, no repository)
 * is its own main checkout.
 */
export function mainCheckout(root: string): string {
  const self = realPath(root);
  try {
    const dotGit = join(self, '.git');
    if (!statSync(dotGit).isFile()) return self;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))?.[1]?.trim();
    const m = gitdir ? /^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/.exec(realPath(resolve(self, gitdir))) : null;
    return m ? m[1]! : self;
  } catch {
    return self;
  }
}

/** A path with symlinks resolved (macOS /var is /private/var), or as given when it doesn't exist. */
function realPath(p: string): string {
  try { return realpathSync(resolve(p)); } catch { return resolve(p); }
}

/** Whether `root` is a linked worktree of another checkout (an agent's or a lane's). */
export function isLinkedWorktree(root: string): boolean {
  return mainCheckout(root) !== realPath(root);
}

/**
 * Stable short identifier for a repository. Every worktree of one repository shares it, so a session's
 * observations, state, linked graph and overlay identity are the same whichever checkout an agent is in.
 */
export function repoHash(root: string): string {
  return createHash('sha1').update(mainCheckout(root)).digest('hex').slice(0, 12);
}

/** Identifier for one checkout, for caches derived from its files (a worktree is on its own branch). */
export function checkoutHash(root: string): string {
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

/** A repository file's text, or undefined when it doesn't exist or can't be read. */
export function readRepoText(root: string, repoRelative: string): string | undefined {
  const abs = toAbsolute(root, repoRelative);
  try { return statSync(abs).isFile() ? readFileSync(abs, 'utf8') : undefined; } catch { return undefined; }
}

export function toAbsolute(root: string, repoRelative: string): string {
  return isAbsolute(repoRelative) ? repoRelative : join(root, ...repoRelative.split('/'));
}
