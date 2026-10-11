import { formatRecord } from '../graph/write.js';
import { propose } from '../record/propose.js';
import { openFromArgs, str, type Args } from './main.js';

/** `ctx propose <path or L:module> "<rule>"`: see src/record/propose.ts. */
export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const [target, ...words] = args.positional;
  if (!target || !words.length) throw new Error('ctx propose <path or L:module> "<rule>" [--id <id>] [--test <path>] [--rule <checkable rule>]');
  const result = propose(ctx, { target, text: words.join(' '), id: str(args.flags.id), test: str(args.flags.test), rule: str(args.flags.rule) });
  if ('error' in result) {
    console.error(result.error);
    return 1;
  }
  const r = result.record;
  console.log(
    env.json
      ? JSON.stringify({ [r.mode === 'G' ? 'added' : 'proposed']: r.id, mode: r.mode, module: r.attachedTo, text: r.text, test: r.test ?? null, rule: r.rule ?? null }, null, 2)
      : r.mode === 'G'
        ? `added guidance ${r.id} on ${r.attachedTo}: ${formatRecord(r)}\nIt applies now: agents editing ${r.attachedTo} see it before they edit.`
        : `proposed ${r.id} on ${r.attachedTo}: ${formatRecord(r)}\nIt applies as proposed until a person accepts it (ctx ratify ${r.id}, or Accept in the Context pane).`,
  );
  return 0;
}
