import { accessSync, constants } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';

/**
 * How an agent should run ctx from a shell. Messages name commands as `ctx card …`, `ctx record …`;
 * a plugin install doesn't put `ctx` on the PATH, so those would fail. When `ctx` isn't on the PATH,
 * commands are written as `node <this ctx>` instead, which works with no install step. `ctx install cli`
 * puts a `ctx` on the PATH for good.
 */
let cached: { onPath: boolean; command: string } | undefined;

export function isOnPath(name: string, path = process.env.PATH ?? ''): boolean {
  for (const dir of path.split(delimiter).filter(Boolean)) {
    try { accessSync(join(dir, name), constants.X_OK); return true; } catch { /* not here */ }
  }
  return false;
}

/** The running ctx script, as a shell command. Quoted with single quotes only when the path needs it. */
export function scriptCommand(script = process.argv[1] ?? ''): string {
  const abs = resolve(script);
  return /^[\w./@+-]+$/.test(abs) ? `node ${abs}` : `node '${abs.replace(/'/g, `'\\''`)}'`;
}

/** CTX_COMMAND overrides it: for a custom wrapper, and so tests don't depend on the machine they run on. */
export function ctxCommand(): { onPath: boolean; command: string } {
  if (cached) return cached;
  const forced = process.env.CTX_COMMAND;
  if (forced) return (cached = { onPath: forced === 'ctx', command: forced });
  const onPath = isOnPath('ctx');
  cached = { onPath, command: onPath ? 'ctx' : scriptCommand() };
  return cached;
}

const COMMAND = /(^|[\s`'"(:;])ctx (?=(?:card|cards|record|slice|slice-patch|hydrate|why|history|next|pending|coverage|doctor|check|install|ratify|retire|gate|hygiene|gc|init|applies)\b)/g;

/** Rewrite `ctx <command>` in agent-facing text to a command that runs here. Unchanged when `ctx` is on the PATH. */
export function localiseCommands(text: string, command = ctxCommand().command): string {
  if (command === 'ctx') return text;
  return text.replace(COMMAND, (_m, before: string) => `${before}${command} `);
}

/** Reset the cache (tests). */
export function resetCtxCommand(): void { cached = undefined; }
