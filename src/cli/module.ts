import { addModule, currentModule, moduleProblem } from '../graph/modules.js';
import { formatRecord } from '../graph/write.js';
import { needGraph, openFromArgs, str, type Args } from './main.js';

const USAGE = 'ctx module <L:id> --paths "<glob> [<glob>…]" [--in <L:parent>] [--name "<name>"] [--delegated --reason "<why>"]';

/**
 * `ctx module`: gives a set of paths its own module, so rules can attach to them and not to everything
 * around them (src/graph/modules.ts). The module sits in the module its paths belonged to, or `--in`.
 * Its containment edge is proposed, and walked as its parent until ratified; the delegated ratifier,
 * where `[delegate] may_ratify` includes modules, adds it agreed with `--delegated --reason`.
 */
export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const g = needGraph(ctx);
  const id = args.positional[0];
  const paths = str(args.flags.paths);
  if (!id || !paths) throw new Error(USAGE);
  const globs = paths.split(/[\s,]+/).filter(Boolean);
  const delegated = args.flags.delegated === true;
  const reason = str(args.flags.reason)?.trim();
  const delegate = ctx.config.delegate;
  if (delegated) {
    const refuse = !delegate
      ? "This repository delegates no ratification ([delegate] ratifier isn't set in .ctx/config.toml). Leave --delegated out to add the module with its edge proposed."
      : !delegate.mayRatify.includes('modules')
        ? `The delegated ratifier may ratify ${delegate.mayRatify.join(', ') || 'nothing'}, not modules. Leave --delegated out to add the module with its edge proposed, or add "modules" to [delegate] may_ratify.`
        : !reason
          ? 'A delegated module needs --reason "<why these paths are their own module>".'
          : undefined;
    if (refuse) {
      console.error(refuse);
      return 1;
    }
  }
  const parent = str(args.flags.in) ?? currentModule(g, globs);
  const m = { id, name: str(args.flags.name), globs, parent: parent === id ? undefined : parent, agreed: delegated };
  const problem = moduleProblem(g, m);
  if (problem) {
    console.error(problem);
    return 1;
  }
  const r = addModule(ctx, m);
  const trailer = delegated ? `Ctx-Ratified-By: ${delegate!.ratifier} (delegated)` : null;
  if (env.json) {
    console.log(
      JSON.stringify(
        {
          module: id,
          paths: globs,
          parent: r.edge?.to ?? null,
          edge: r.edge ? (r.edge.proposed ? 'proposed' : 'agreed') : null,
          trailer,
          ...(delegated ? { reason } : {}),
        },
        null,
        2,
      ),
    );
    return 0;
  }
  const lines = [...r.mappings, r.logical, r.edge].filter(Boolean).map((x) => `  ${formatRecord(x!)}`);
  console.log(`added ${id} to graph.ctx:\n${lines.join('\n')}`);
  if (r.edge?.proposed)
    console.log(
      `Its containment edge is proposed: its files inherit ${r.edge.to}'s rules through it until a person ratifies it (ctx ratify "${id} in ${r.edge.to}").`,
    );
  if (trailer) console.log(`Commit it with the trailer:\n  ${trailer}\n(${reason})`);
  return 0;
}
