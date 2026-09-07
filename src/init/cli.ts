import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { needGraph, openFromArgs, str, type Args } from '../cli/main.js';
import { openRepo } from '../core/context.js';
import { GRAPH_FILE, Graph, PROPOSALS_FILE } from '../graph/graph.js';
import type { GraphRecord } from '../graph/records.js';
import { appendRecord, formatRecord } from '../graph/write.js';
import { gitPerson } from '../util/git.js';
import { INSTRUCTION_BLOCK, appendInstructionBlock } from './instructions.js';
import { bootstrap, newRecordsOnly } from './bootstrap.js';
import { conformanceReport, violationsFor } from './conformance.js';
import { detectBindings, exportPack, instantiate, loadPacks } from './packs.js';
import { ratify } from './ratify.js';

const CONFIG_TEMPLATE = `# Context Graph configuration. See docs/design-spec.md §17.
[repo]
ratifiers = [{RATIFIERS}]  # git identities (email local part or name) allowed to ratify concepts and enforced constraints
default_branch = "main"

[slice]
enabled = true            # true | false (observe-only) | "random:0.5"
max_tokens = 300
max_decisions = 4

[record]
max_blocks = 2

[observe]
shell_parsing = true
forward = false

[gate]
stale_basis = "warn"
context_moved = "warn"

[embed]
enabled = false
provider = "minilm"       # in-process; or local:<ollama-model>, openai:<model>, <url>#<model>
min_score = 0.45          # cosine threshold; MiniLM scores related passages around 0.45 to 0.6
include = ["docs/**/*.md"]
exclude = ["**/generated/**", "**/*.lock", "**/package-lock.json"]
in_process_hooks = false  # hints in hooks come from a running ctx serve; set true to embed inside each hook instead

[init]
packs = ["auto"]
`;

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  if (args.cmd === 'init') return init(args, env);
  if (args.cmd === 'ratify') return doRatify(args, env);
  if (args.cmd === 'pack') return pack(args, env);
  return 1;
}

async function init(args: Args, env: { json: boolean }): Promise<number> {
  const repoOpt = str(args.flags.repo);
  const ctx = openRepo({ ...(repoOpt ? { repo: repoOpt } : {}), ...(str(args.flags.graph) ? { graph: str(args.flags.graph)! } : {}) });
  const target = ctx.graphDir ?? join(ctx.root, '.ctx');
  const minFiles = str(args.flags['min-files']);
  const maxModules = str(args.flags['max-modules']);
  const result = bootstrap(ctx, { ...(minFiles ? { minFiles: Number(minFiles) } : {}), ...(maxModules ? { maxModules: Number(maxModules) } : {}) });
  const fresh = newRecordsOnly(result, ctx.graph);

  // Packs bind against the graph as it would be after bootstrap.
  const packNames = str(args.flags.packs)?.split(',') ?? ctx.config.packs;
  const merged = Graph.fromRecords([...(ctx.graph ? allRecords(ctx.graph) : []), ...fresh]);
  const today = new Date().toISOString().slice(0, 10);
  const packRecords: GraphRecord[] = [];
  const packReport: string[] = [];
  if (!packNames.includes('none')) {
    for (const p of loadPacks(packNames)) {
      const { bindings, unbound } = detectBindings(p, merged, result.files, ctx.config.packBindings);
      if (!bindings.length) { packReport.push(`${p.name}: no roles bound`); continue; }
      // One directory called `routes` is not evidence for a whole framework's conventions. An auto-selected
      // pack applies only when at least half its roles bind; naming the pack in config forces it.
      const boundRoles = new Set(bindings.map((b) => b.role)).size;
      const explicit = packNames.includes(p.name);
      if (!explicit && boundRoles < Math.ceil(p.roles.length / 2)) {
        packReport.push(`${p.name}: ${boundRoles} of ${p.roles.length} roles bind (${bindings.map((b) => `{${b.role}}=${b.logical}`).join(', ')}); too little to apply automatically, set packs = ["${p.name}"] to force`);
        continue;
      }
      const inst = instantiate(p, bindings, unbound, today);
      const usable = inst.records.filter((r) => !(r.kind === 'K' && merged.constraints.has(r.id)) && !(r.kind === 'C' && merged.concepts.has(r.id)));
      packReport.push(`${p.name}@${p.version}: ${bindings.map((b) => `{${b.role}}=${b.logical} (${b.evidence})`).join(', ')}${unbound.length ? `; unbound: ${unbound.join(', ')}` : ''}; ${usable.length} record(s)`);
      packRecords.push(...usable);
    }
  }

  // Conformance for every proposed checkable constraint.
  const proposedGraph = Graph.fromRecords([...allRecords(merged), ...packRecords]);
  const conformance: string[] = [];
  for (const r of packRecords) {
    if (r.kind !== 'K' || !r.rule) continue;
    const vs = violationsFor(proposedGraph, r, result.index);
    conformance.push(`${r.id}: ${vs.length} current violation(s)${vs.length ? `, e.g. ${vs[0]!.detail}` : ''}`);
  }

  const all = [...fresh, ...packRecords];
  if (env.json) {
    console.log(JSON.stringify({ target, records: all, notes: result.notes, packs: packReport, conformance }, null, 2));
  } else {
    console.log(`bootstrap for ${ctx.root}`);
    console.log(`  ${result.mappings.length} mappings, ${result.logicals.length} modules, ${result.edges.filter((e) => e.rel === 'in').length} containment edges, ${result.edges.filter((e) => e.rel === 'dep').length} dependency edges`);
    console.log(`  ${result.constraints.length} proposed constraints, ${result.concepts.length} proposed concepts, ${packRecords.length} pack records`);
    for (const n of result.notes) console.log(`  note: ${n}`);
    for (const p of packReport) console.log(`  pack: ${p}`);
    for (const c of conformance) console.log(`  conformance: ${c}`);
    if (!args.flags.write) {
      console.log(`\n--- proposal (${all.length} records; pass --write to write) ---`);
      for (const r of all) console.log(formatRecord(r));
    }
  }

  if (args.flags.write) {
    mkdirSync(target, { recursive: true });
    const graphFile = join(target, GRAPH_FILE);
    if (!existsSync(graphFile)) {
      const header = `# Context Graph, bootstrapped ${today} by ctx init. Everything here is a proposal until ratified (ctx ratify).\n`;
      writeFileSync(graphFile, header + all.map(formatRecord).join('\n') + '\n', 'utf8');
      // The person who bootstraps can ratify; an empty list would leave every proposal stuck as proposed.
      if (!existsSync(join(target, 'config.toml'))) writeFileSync(join(target, 'config.toml'), CONFIG_TEMPLATE.replace('{RATIFIERS}', JSON.stringify(gitPerson(ctx.root))), 'utf8');
      console.log(`wrote ${graphFile} (${all.length} records) and config.toml`);
      const ins = appendInstructionBlock(ctx.root);
      if (ins.status === 'appended') console.log(`appended the Context Graph block to ${ins.file}`);
      else if (ins.status === 'present') console.log(`${ins.file} already carries the Context Graph block`);
      else console.log(`no AGENTS.md or CLAUDE.md to carry the Context Graph block; add this to your agent instructions:\n\n${INSTRUCTION_BLOCK}`);
    } else {
      for (const r of all) appendRecord(join(target, PROPOSALS_FILE), r);
      console.log(`appended ${all.length} proposal(s) to ${join(target, PROPOSALS_FILE)}`);
    }
  }
  return 0;
}

function allRecords(g: Graph): GraphRecord[] {
  return [...g.mappings, ...g.logicals.values(), ...g.concepts.values(), ...g.edges, ...g.constraints.values(), ...g.decisions.values(), ...g.supersessions, ...g.retirements, ...g.aliases.values()];
}

async function doRatify(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  needGraph(ctx);
  const ids = args.positional;
  const all = args.flags['all-proposed'] === true;
  if (!ids.length && !all) throw new Error('ctx ratify <id>... | --all-proposed');
  const r = ratify(ctx, ids, { all });
  if (env.json) { console.log(JSON.stringify(r, null, 2)); return r.missing.length ? 1 : 0; }
  for (const id of r.ratified) console.log(`ratified ${id}`);
  for (const d of r.legacy) console.log(`legacy   ${d.id} on ${d.node}: ${d.text}`);
  for (const id of r.missing) console.log(`not found or not proposed: ${id}`);
  console.log(`\ninclude this trailer in the commit that carries the change:\n  ${r.trailer}`);
  return r.missing.length ? 1 : 0;
}

async function pack(args: Args, env: { json: boolean }): Promise<number> {
  const sub = args.positional[0];
  if (sub === 'list') {
    const packs = loadPacks(['auto']);
    console.log(env.json ? JSON.stringify(packs.map((p) => ({ name: p.name, version: p.version, roles: p.roles.map((r) => r.role), records: p.records.length }))) : packs.map((p) => `${p.name}@${p.version}  roles ${p.roles.map((r) => r.role).join(' ')}  ${p.records.length} records`).join('\n'));
    return 0;
  }
  if (sub === 'export') {
    const ctx = openFromArgs(args);
    const g = needGraph(ctx);
    const name = str(args.flags.name);
    if (!name) throw new Error('ctx pack export --name <name> [--out <file>]');
    const text = exportPack(g, name, str(args.flags.version) ?? '1');
    const out = str(args.flags.out);
    if (out) { writeFileSync(resolve(out), text, 'utf8'); console.log(`wrote ${resolve(out)}`); } else process.stdout.write(text);
    return 0;
  }
  if (sub === 'conformance') {
    const ctx = openFromArgs(args);
    needGraph(ctx);
    const report = conformanceReport(ctx, { includeProposed: true });
    for (const [id, vs] of report) console.log(`${id}: ${vs.length} violation(s)${vs.length ? '\n  ' + vs.slice(0, 10).map((v) => v.detail).join('\n  ') : ''}`);
    return 0;
  }
  throw new Error('ctx pack list | export --name <name> | conformance');
}
