import { openFromArgs, str, type Args } from '../cli/main.js';
import { formatGate, runGate } from './gate.js';

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const base = str(args.flags.base);
  if (!base) throw new Error('ctx gate --base <ref> [--head <ref>] [--run-tests]');
  const report = runGate(ctx, { base, ...(str(args.flags.head) ? { head: str(args.flags.head)! } : {}), runTests: args.flags['run-tests'] === true });
  console.log(env.json ? JSON.stringify(report, null, 2) : formatGate(report));
  return report.ok ? 0 : 1;
}
