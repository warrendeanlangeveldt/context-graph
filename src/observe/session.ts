import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ctxHome, repoHash } from '../util/paths.js';

/**
 * Which harness session a process belongs to. Hooks are told by the harness. The MCP server and a
 * `ctx` command run from the agent's shell are not, and without this they recorded under a session
 * of their own, so a decision recorded through them cleared nobody's pending list and hydrate could
 * not see what the session had read. Both are children of the same harness process as the hooks,
 * so the hooks note their ancestor pids once and everyone else matches against them.
 */
export function ancestorPids(from = process.pid, depth = 5): number[] {
  const out: number[] = [];
  let pid = from;
  for (let i = 0; i < depth; i++) {
    let parent: number;
    try { parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { break; }
    if (!Number.isFinite(parent) || parent <= 1) break;
    out.push(parent);
    pid = parent;
  }
  return out;
}

export interface ResolveOptions { ancestors?: number[]; stateDir?: string; now?: number; recentMs?: number }

/**
 * Resolve the session for a process that was not told: `CLAUDE_SESSION_ID` or `CTX_SESSION` when set,
 * else the session whose hooks recorded an ancestor this process shares, else the harness session
 * most recently active here, else the given fallback.
 */
export function resolveSession(root: string, fallback: string, opts: ResolveOptions = {}): string {
  const env = process.env.CLAUDE_SESSION_ID ?? process.env.CTX_SESSION;
  if (env) return env;
  const stateDir = opts.stateDir ?? join(ctxHome(), 'state', repoHash(root));
  if (!existsSync(stateDir)) return fallback;
  const mine = new Set(opts.ancestors ?? ancestorPids());
  const now = opts.now ?? Date.now();
  const recentMs = opts.recentMs ?? 2 * 3600_000;
  let newest: { session: string; mtime: number } | undefined;
  for (const f of readdirSync(stateDir).filter((x) => x.endsWith('.json'))) {
    const file = join(stateDir, f);
    let data: { pids?: number[]; harness?: string };
    try { data = JSON.parse(readFileSync(file, 'utf8')) as { pids?: number[]; harness?: string }; } catch { continue; }
    const session = f.replace(/\.json$/, '');
    if (session === 'mcp' || session === 'cli') continue;
    if (mine.size && data.pids?.some((p) => mine.has(p))) return session;
    const mtime = statSync(file).mtimeMs;
    if (now - mtime <= recentMs && (!newest || mtime > newest.mtime)) newest = { session, mtime };
  }
  return newest?.session ?? fallback;
}
