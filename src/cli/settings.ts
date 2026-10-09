import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS, HARNESS_KEYS, harnessProblems, parseHarnessValue, withHarnessSetting, type HarnessKey } from '../core/harness.js';
import { toolAdapters } from '../tool-adapters/index.js';
import { parseToml } from '../util/toml.js';
import { openFromArgs, str, type Args } from './main.js';

/**
 * `ctx settings`: the harness settings in force (docs/specs/09-panes.md, VIEW-6). `ctx settings set
 * <key> <value> --reason "…" [--via pane]` changes one as the person: written to .ctx/config.toml, and,
 * where a tool that shares the repository keeps a log of such changes (code-kit's approval log), recorded
 * there as theirs. The hooks refuse `settings set` from every agent.
 */
export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  if (!ctx.graphDir) {
    console.error(`No graph for ${ctx.root}: run ctx init first.`);
    return 1;
  }
  const file = join(ctx.graphDir, 'config.toml');
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    /* no config yet: the defaults hold */
  }
  const section = parseToml(text).harness;
  const [sub, key, value] = args.positional;
  if (sub === 'set') {
    if (!key || value === undefined) throw new Error('ctx settings set <key> <value> --reason "<why>" [--via pane]');
    if (!(key in HARNESS)) {
      console.error(`${key} isn't a harness setting. They are: ${HARNESS_KEYS.join(', ')}.`);
      return 1;
    }
    const reason = str(args.flags.reason)?.trim();
    if (!reason) {
      console.error('Give a reason with --reason "…": it goes with the change.');
      return 1;
    }
    const k = key as HarnessKey;
    const parsed = parseHarnessValue(k, value);
    const why = HARNESS[k].problem(parsed);
    if (why) {
      console.error(`${key} ${why}. Nothing was changed.`);
      return 1;
    }
    writeFileSync(file, withHarnessSetting(text, k, parsed));
    const via = str(args.flags.via) === 'pane' ? 'pane' : 'terminal';
    const logged = toolAdapters(ctx.root).flatMap((a) =>
      a.recordPersonsChange?.(ctx.root, { file: '.ctx/config.toml', reason: `${key} = ${JSON.stringify(parsed)}: ${reason}`, via }) ?? [],
    );
    console.log(
      env.json
        ? JSON.stringify({ key, value: parsed, logged }, null, 2)
        : `Set [harness] ${key} = ${JSON.stringify(parsed)} in .ctx/config.toml.${logged.length ? ` ${logged.join(' ')}` : ''}`,
    );
    return 0;
  }
  if (sub !== undefined) throw new Error('ctx settings [--json] | ctx settings set <key> <value> --reason "<why>"');
  const inForce = ctx.config.harness as unknown as Record<string, unknown>;
  // A tool sharing the repository may set the pause point itself (code-kit's harness): it wins.
  const pausedBy = toolAdapters(ctx.root).map((a) => ({ name: a.name, at: a.pauseAtPercent?.(ctx.root) })).find((p) => p.at !== undefined);
  const rows = HARNESS_KEYS.map((k) => ({
    key: k,
    value: inForce[k],
    default: HARNESS[k].default,
    about: HARNESS[k].about,
    ...(k === 'pause_at_percent' && pausedBy ? { inForce: pausedBy.at, from: pausedBy.name } : {}),
  }));
  const problems = harnessProblems(section);
  if (env.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  for (const r of rows) console.log(`${r.key} = ${JSON.stringify(r.value)}${r.value !== r.default ? `  (default ${JSON.stringify(r.default)})` : ''}\n  ${r.about}`);
  for (const p of problems) console.log(`problem: ${p}; the default holds`);
  return 0;
}
