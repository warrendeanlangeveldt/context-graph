import type { Args } from './main.js';

/**
 * Lifecycle and runtime commands live in their own modules and are loaded on demand so the hook
 * path (which runs on every tool call) never pays for them. Each module exports `run(args)` and
 * returns an exit code, or undefined when it does not own the command.
 */
export async function extraCommands(args: Args, env: { json: boolean; usage: string }): Promise<number | undefined> {
  switch (args.cmd) {
    case 'init': case 'ratify': case 'pack':
      return (await import('../init/cli.js')).run(args, env);
    case 'gate':
      return (await import('../gate/cli.js')).run(args, env);
    case 'hygiene': case 'gc': case 'retire':
      return (await import('../hygiene/cli.js')).run(args, env);
    case 'serve': case 'overlay':
      return (await import('../overlay/cli.js')).run(args, env);
    case 'bench':
      return (await import('../bench/cli.js')).run(args, env);
    case 'next': case 'cards':
      return (await import('./guide.js')).run(args, env);
    default:
      return undefined;
  }
}
