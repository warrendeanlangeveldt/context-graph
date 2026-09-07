import { needGraph, openFromArgs, str, type Args } from '../cli/main.js';
import { gc, hygieneReport, retire } from './hygiene.js';

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  needGraph(ctx);
  if (args.cmd === 'hygiene') {
    const findings = hygieneReport(ctx);
    if (env.json) { console.log(JSON.stringify(findings, null, 2)); return 0; }
    if (!findings.length) { console.log('nothing to propose'); return 0; }
    for (const f of findings) {
      console.log(`${f.level === 'propose' ? 'PROPOSE' : 'INFO   '} ${f.signal.padEnd(22)} ${f.target}`);
      for (const e of f.evidence) console.log(`  ${e}`);
      console.log(`  -> ${f.proposal}`);
    }
    return 0;
  }
  if (args.cmd === 'gc') {
    const r = gc(ctx, { deleted: args.flags.deleted === true });
    if (env.json) { console.log(JSON.stringify(r)); return 0; }
    console.log(r.archived.length ? `archived ${r.archived.length} record(s) to ${r.archiveFile}: ${r.archived.join(', ')}` : 'nothing old enough to archive');
    if (r.droppedProposals.length) console.log(`dropped ${r.droppedProposals.length} expired proposed edge(s)`);
    return 0;
  }
  if (args.cmd === 'retire') {
    const target = args.positional[0];
    const reason = str(args.flags.reason);
    if (!target || !reason) throw new Error('ctx retire <k-id|c-id> --reason "<why>" [--succ <id>]');
    const r = retire(ctx, target, reason, str(args.flags.succ));
    console.log(`retired ${r.record.target}${r.record.succ ? ` -> ${r.record.succ}` : ''}`);
    if (r.needsTrailer) console.log(`this retirement needs ratification; include in the commit:\n  ${r.trailer}`);
    return 0;
  }
  return 1;
}
