import { backfillOrder, type BackfillScope } from '../cards/backfill.js';
import { claimWriter } from '../cards/writer.js';
import type { RepoContext } from '../core/context.js';
import { overrideFindings } from '../hygiene/hygiene.js';
import { unmappedFolders } from '../init/bootstrap.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { ctxHome, nestedWorktree, repoHash } from '../util/paths.js';
import { cardsReport } from './guide.js';
import { latestSession, openFromArgs, str, type Args } from './main.js';
import { neighbours } from './neighbours.js';
import { agentCoverage, fileContext, proposals } from './present.js';
import { settingRows } from './settings.js';

/**
 * `ctx snapshot --json` (docs/specs/10-cost.md, COST-2): what the mod shows on a refresh, from one process
 * with the graph loaded once, in place of the eleven commands it ran one after another. With `--session`
 * and the card writer or the backfill on, it claims the checkout's background work for that session
 * (COST-4); only the session holding it gets the lists the card writer works from.
 */

/** What `ctx info --json` prints. */
export function infoOf(ctx: RepoContext) {
  // counts: the graph's size, for the mod (the curator runs after every 10 new decisions, CUR-1).
  const counts = ctx.graph ? { decisions: ctx.graph.decisions.size, rules: ctx.graph.constraints.size } : null;
  // unmapped: folders with code the graph maps only to the whole repository (the Map offers to add them).
  return { root: ctx.root, repoHash: repoHash(ctx.root), graphDir: ctx.graphDir ?? null, config: ctx.config, ctxHome: ctxHome(), branch: currentBranch(ctx.root), person: gitPerson(ctx.root), counts, unmapped: unmappedFolders(ctx) };
}

export interface SnapshotOptions {
  session?: string | undefined;
  /** The followed file: its context and neighbours come with it. */
  file?: string | undefined;
  agent?: string | undefined;
}

export function snapshot(ctx: RepoContext, args: Args, opts: SnapshotOptions = {}) {
  const info = infoOf(ctx);
  if (!ctx.graph) return { info };
  const h = ctx.config.harness;
  const background = h.card_writer || h.backfill !== 'off';
  const writer = background && opts.session ? claimWriter(ctx.root, opts.session) : null;
  const working = background && (writer ? writer.mine : true);
  const session = opts.session ?? latestSession(ctx.root);
  const out: Record<string, unknown> = {
    info,
    proposals: proposals(ctx),
    cards: cardsReport(ctx),
    // CUR-2: hygiene's overridden rules, the findings the pane flags; the rest of hygiene runs git.
    hygiene: overrideFindings(ctx),
    settings: settingRows(ctx),
    agents: session ? agentCoverage(ctx, session) : [],
    writer,
  };
  if (working && h.card_writer) {
    out.changed = cardsReport(ctx, { changed: true });
    out.recent = cardsReport(ctx, { recent: true });
  }
  if (working && h.backfill !== 'off') out.backfill = backfillOrder(ctx, h.backfill as BackfillScope);
  if (opts.file) {
    // A file in a lane's worktree under this checkout is read in that worktree, with its own cards.
    const nested = nestedWorktree(ctx.root, opts.file);
    const fileCtx = nested ? openFromArgs({ ...args, flags: { ...args.flags, repo: nested.root } }) : ctx;
    const path = (nested ? nested.path : opts.file).replace(/^\.\//, '');
    const worktree = nested ? opts.file.replace(/^\.\//, '').slice(0, -nested.path.length - 1) : null;
    out.file = { ...fileContext(fileCtx, path, { session, agent: opts.agent }), worktree };
    out.neighbours = neighbours(fileCtx, path);
  }
  return out;
}

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const s = snapshot(ctx, args, { session: str(args.flags.session), file: str(args.flags.file), agent: str(args.flags.agent) });
  if (env.json) {
    console.log(JSON.stringify(s));
    return 0;
  }
  const keys = Object.keys(s).filter((k) => k !== 'info');
  console.log(`snapshot of ${ctx.root}: ${keys.length ? keys.join(', ') : 'no graph'}`);
  return 0;
}
