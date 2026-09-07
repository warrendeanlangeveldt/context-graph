import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { needGraph, openFromArgs, str, type Args } from '../cli/main.js';
import { formatCorpus, parseCorpus, proposeCorpus } from './corpus.js';
import { buildReport, formatReport } from './report.js';
import { runBench, type Arm, type Harness, type RunRecord } from './runner.js';

const USAGE = `ctx bench corpus [--since <date>] [--limit <n>] [--test-command "<cmd with {tests}>"] [--write]
ctx bench run [--arms A,C] [--runs 3] [--harness claude|codex|command] [--command "<cmd>"] [--tasks t-1,t-2] [--timeout <s>] [--keep]
ctx bench report [--dir <results dir>]`;

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const sub = args.positional[0];
  const ctx = openFromArgs(args);
  const benchDir = ctx.graphDir && !ctx.graphDir.startsWith(ctx.root) ? join(ctx.graphDir, 'bench') : join(ctx.root, '.ctx', 'bench');
  const corpusFile = str(args.flags.corpus) ?? join(benchDir, 'tasks.ctx');

  if (sub === 'corpus') {
    const { tasks, skipped } = proposeCorpus(ctx, { ...(str(args.flags.since) ? { since: str(args.flags.since)! } : {}), ...(str(args.flags.limit) ? { limit: Number(str(args.flags.limit)) } : {}), ...(str(args.flags['test-command']) ? { testCommand: str(args.flags['test-command'])! } : {}) });
    if (env.json) { console.log(JSON.stringify({ tasks, skipped }, null, 2)); return 0; }
    console.log(`${tasks.length} task(s) proposed, ${skipped.length} commit(s) skipped`);
    for (const t of tasks) console.log(`  ${t.id}  ${t.stratum.padEnd(18)} ${t.prompt.split('\n')[0]?.slice(0, 70)}`);
    if (args.flags.write) { mkdirSync(benchDir, { recursive: true }); writeFileSync(corpusFile, formatCorpus(tasks), 'utf8'); console.log(`wrote ${corpusFile}`); }
    else console.log(`pass --write to save to ${corpusFile}`);
    return 0;
  }

  if (sub === 'run') {
    if (!existsSync(corpusFile)) throw new Error(`no corpus at ${corpusFile}; run ctx bench corpus --write first`);
    const tasks = parseCorpus(readFileSync(corpusFile, 'utf8'));
    const arms = (str(args.flags.arms) ?? 'A,C').split(',').map((a) => a.trim().toUpperCase()) as Arm[];
    for (const a of arms) if (!['A', 'B', 'C'].includes(a)) throw new Error(`unknown arm ${a}`);
    const harness = (str(args.flags.harness) ?? 'claude') as Harness;
    if (!['claude', 'codex', 'command'].includes(harness)) throw new Error('--harness claude|codex|command');
    if (arms.some((a) => a !== 'A')) needGraph(ctx);
    const r = await runBench(ctx, tasks, {
      arms, harness, runs: Number(str(args.flags.runs) ?? 1),
      ...(str(args.flags.command) ? { command: str(args.flags.command)! } : {}),
      ...(str(args.flags.tasks) ? { tasks: str(args.flags.tasks)!.split(',') } : {}),
      ...(str(args.flags.timeout) ? { timeoutMs: Number(str(args.flags.timeout)) * 1000 } : {}),
      ...(str(args.flags.out) ? { outDir: resolve(str(args.flags.out)!) } : {}),
      keepWorktrees: args.flags.keep === true,
      log: (s) => { if (!env.json) console.log(s); },
    });
    const report = buildReport(r.records);
    writeFileSync(join(r.dir, 'report.md'), formatReport(report), 'utf8');
    writeFileSync(join(r.dir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    if (env.json) console.log(JSON.stringify({ dir: r.dir, report }, null, 2));
    else { console.log(''); console.log(formatReport(report)); console.log(`results in ${r.dir}`); }
    return 0;
  }

  if (sub === 'report') {
    let dir = str(args.flags.dir);
    if (!dir) {
      const results = join(benchDir, 'results');
      const runs = existsSync(results) ? readdirSync(results).sort() : [];
      if (!runs.length) throw new Error(`no results under ${results}`);
      dir = join(results, runs[runs.length - 1]!);
    }
    const records = readFileSync(join(dir, 'runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RunRecord);
    const report = buildReport(records);
    if (env.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    return 0;
  }

  console.error(USAGE);
  return 1;
}
