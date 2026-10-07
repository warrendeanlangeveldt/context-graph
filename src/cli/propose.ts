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
      ? JSON.stringify({ proposed: r.id, module: r.attachedTo, text: r.text, test: r.test ?? null, rule: r.rule ?? null }, null, 2)
      : `proposed ${r.id} on ${r.attachedTo}: ${formatRecord(r)}\nIt applies as proposed until a person ratifies it (ctx ratify ${r.id}, or Ratify in the Context pane).`,
  );
  return 0;
}
