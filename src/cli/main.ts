#!/usr/bin/env node
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runClaudeHook } from '../adapters/claude-code/hook.js';
import { runCodexHook } from '../adapters/codex/hook.js';
import type { HookInput } from '../adapters/core.js';
import { openRepo, type RepoContext } from '../core/context.js';
import { buildEmbedIndex, openStore } from '../embed/index.js';
import { makeProvider } from '../embed/provider.js';
import { hydrate } from '../hydrate/hydrate.js';
import { installClaudeUser, installCli, installCodexUser, installGitHooks } from '../install/install.js';
import { INSTRUCTION_BLOCK, appendInstructionBlock } from '../init/instructions.js';
import { startMcpServer } from '../mcp/server.js';
import type { CoverageRecord } from '../observe/coverage.js';
import { envelope } from '../observe/event.js';
import { parsePatchText } from '../observe/patch.js';
import { replayTranscript } from '../observe/replay.js';
import { parseShellCommand } from '../observe/shell.js';
import { resolveSession } from '../observe/session.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { publishDecision } from '../overlay/client.js';
import { commitOf, linkProvenance } from '../record/provenance.js';
import { RecordError, Recorder } from '../record/recorder.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { ctxHome, repoHash, toRepoRelative } from '../util/paths.js';
import { cardState, renderFileCard, writeCard } from '../cards/cards.js';
import { factsFor } from '../tool-adapters/index.js';
import { renderSlice } from '../walker/slice.js';
import { walk } from '../walker/walk.js';
import { extraCommands } from './commands.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { ctxVersion } from '../util/version.js';

const USAGE = `ctx — Context Graph

Start here
  ctx next [--json]                                the one thing to do now, and the skill that does it
  ctx cards [--changed] [--missing|--stale]        which files have a card matching them

Graph
  ctx slice <path> [--symbol name]                 slice injected before an edit
  ctx hydrate <scope> [--budget n] [--no-record]  one briefing: slices, callers with usage lines, rules with history, session state
  ctx slice-patch <file|->                         slices for every file in a patch
  ctx applies <path>                               the applicable set, as ids
  ctx why <node>                                   active decisions and constraints on a node
  ctx history <node> [--timeline]                  every decision on a node; --timeline includes the archive
  ctx check [--conformance]                        validate the graph; --conformance counts rule violations
  ctx record --node <n> --serves <id> --text "<why>" [--overrides <k-id>] [--agent <name>]
  ctx card <path> --text "<why the file exists>" [--req ID,ID]   write or update a file's card
  ctx retire <id> --reason "<why>" [--succ <id>]   retire a constraint or concept
  ctx ratify <id>... [--delegated --reason "…"]    accept proposed records (the delegated ratifier: within [delegate])
  ctx ratify <id>... --commit                      the person: ratify and commit the graph with their trailer
  ctx drop <id> --reason "<why>" [--commit]        the person: turn a proposal down, with the reason kept
  ctx proposals                                    proposed rules and concepts, with their evidence
  ctx module <L:id> --paths "<glob>…" [--in <L:parent>] [--name "…"] [--delegated --reason "…"]
                                                   give paths their own module, so rules can attach to them
  ctx propose <path|L:module> "<rule>" [--id x] [--test <path>] [--rule <checkable>]
                                                   propose a rule for a path's module; a person ratifies it
  ctx file <path> [--agent <id>]                   a file's card, rules, decisions, and whether an agent understood it
  ctx agents [--session <id>]                      each agent's coverage: read, searched, edited, cards owed
  ctx neighbours <path>                            what a file imports and what imports it, with their cards and broken rules
  ctx settings [set <key> <value> --reason "…"]     the mod's harness settings; set is the person's change
  ctx provenance                                   which of this branch's decisions are committed, and where

Observation
  ctx pending [--session <id>]                     nodes owing a decision
  ctx coverage [--session <id>]                    coverage records for a session
  ctx doctor                                       is Context Graph working here; names the missing link if not
  ctx sessions                                     observed sessions for this repository
  ctx replay <transcript> [--harness auto|claude-code|codex]
  ctx parse-shell "<command>" [--cwd <dir>]
  ctx parse-patch <file|->

Lifecycle
  ctx init [--packs auto|none|<names>] [--write]   bootstrap a graph from the tree, with pack detection
  ctx pack export --name <name> [--out <file>]     turn a ratified graph into a pack
  ctx gate --base <ref> [--head <ref>] [--run-tests] merge gate: three-way semantic diff
  ctx hygiene                                      proposals from evidence; never retires
  ctx gc                                           archive inactive records older than the threshold
  ctx embed build|update|query <text>|status
  ctx bench corpus|run|report                      replay benchmark (see --help on each)

Runtime
  ctx serve [--hosted] [--port <n>] [--token <t>]  event server, stream, and the synapse view
  ctx overlay tail                                 one line per live finding, for harness monitors
  ctx install cli|codex|claude-code|git-hooks|instructions   the ctx command on the PATH, harness or repository hooks, or the agent-instruction block
  ctx adopt [--force]                              move a linked graph into the repository's .ctx, where git carries it
  ctx link --graph <dir> [--repo <dir>]            use a graph kept outside the repository
  ctx info
  ctx hook --harness claude-code|codex [--agent <name>]
  ctx mcp [--agent <name>]
  ctx version | --version                          the installed version

Global: --repo <dir>  --graph <dir>  --json`;

export interface Args { cmd: string; positional: string[]; flags: Record<string, string | boolean> }

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { cmd: positional[0] ?? '', positional: positional.slice(1), flags };
}

export function str(v: string | boolean | undefined): string | undefined { return typeof v === 'string' ? v : undefined; }

export function readInput(arg: string | undefined): string {
  if (!arg || arg === '-') return readFileSync(0, 'utf8');
  return readFileSync(arg, 'utf8');
}

export function latestSession(root: string): string | undefined {
  return ObservationStore.sessions(root)[0]?.session;
}

export function openFromArgs(args: Args): RepoContext {
  return openRepo({ ...(str(args.flags.repo) ? { repo: str(args.flags.repo)! } : {}), ...(str(args.flags.graph) ? { graph: str(args.flags.graph)! } : {}) });
}

export function needGraph(ctx: RepoContext): NonNullable<RepoContext['graph']> {
  if (!ctx.graph) throw new Error(`no graph for ${ctx.root}: add .ctx/graph.ctx, set CTX_GRAPH_DIR, run ctx link, or run ctx init`);
  return ctx.graph;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.json === true;

  switch (args.cmd) {
    case '':
    case 'help':
    case '--help':
      if (args.flags.version === true) { console.log(ctxVersion()); return 0; }
      console.log(USAGE);
      return 0;

    case 'version':
      console.log(ctxVersion());
      return 0;

    case 'info': {
      const ctx = openFromArgs(args);
      const info = { root: ctx.root, repoHash: repoHash(ctx.root), graphDir: ctx.graphDir ?? null, config: ctx.config, ctxHome: ctxHome(), branch: currentBranch(ctx.root), person: gitPerson(ctx.root) };
      console.log(json ? JSON.stringify(info, null, 2) : Object.entries(info).map(([k, v]) => `${k.padEnd(10)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`).join('\n'));
      return 0;
    }

    case 'check': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const findings = g.validate(ctx.root);
      if (args.flags.conformance) {
        const { conformanceFindings } = await import('../init/conformance.js');
        findings.push(...conformanceFindings(ctx));
      }
      if (json) console.log(JSON.stringify(findings, null, 2));
      else if (!findings.length) console.log(`ok: ${g.mappings.length} mappings, ${g.logicals.size} logical, ${g.concepts.size} concepts, ${g.constraints.size} constraints, ${g.decisions.size} decisions`);
      else for (const f of findings) console.log(`${f.level.padEnd(5)} ${f.rule.padEnd(20)} ${f.file ? `${f.file}:${f.line} ` : ''}${f.message}`);
      return findings.some((f) => f.level === 'error') ? 1 : 0;
    }

    case 'slice': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const path = args.positional[0];
      if (!path) throw new Error('ctx slice <path>');
      const symbol = str(args.flags.symbol);
      const w = walk(g, path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
      const s = renderSlice(g, w, { maxTokens: ctx.config.maxTokens });
      if (json) console.log(JSON.stringify({ ...s, walk: w }, null, 2));
      else { console.log(s.text); for (const m of s.warnings) console.error(`warning: ${m}`); }
      return 0;
    }

    case 'hydrate': {
      const ctx = openFromArgs(args);
      needGraph(ctx);
      const scope = args.positional.join(' ').trim();
      if (!scope) throw new Error('ctx hydrate <file | L:module | C:concept | task description>');
      const budget = args.flags.budget !== undefined ? Number(args.flags.budget) : undefined;
      const h = await hydrate(ctx, scope, { ...(budget ? { budget } : {}), record: args.flags['no-record'] !== true, cwd: process.cwd(), session: resolveSession(ctx.root, 'cli'), harness: 'cli' });
      if (json) console.log(JSON.stringify(h, null, 2));
      else { console.log(h.text); if (h.dropped.length) console.error(`dropped under budget: ${h.dropped.join(', ')}`); }
      return 0;
    }

    case 'slice-patch': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const files = parsePatchText(readInput(args.positional[0]));
      if (!files) throw new Error('input is not an apply_patch or unified diff');
      console.log(files.filter((f) => f.kind !== 'delete').map((f) => renderSlice(g, walk(g, f.movedTo ?? f.path, { maxDecisions: ctx.config.maxDecisions }), { maxTokens: ctx.config.maxTokens }).text).join('\n\n'));
      return 0;
    }

    case 'applies': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const path = args.positional[0];
      if (!path) throw new Error('ctx applies <path>');
      const w = walk(g, path, { maxDecisions: 1000 });
      console.log(json ? JSON.stringify(w, null, 2) : w.applicable.join('\n'));
      return 0;
    }

    case 'why':
    case 'history': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const node = g.resolve(args.positional[0] ?? '');
      if (!node) throw new Error(`ctx ${args.cmd} <node>`);
      if (args.cmd === 'history' && args.flags.timeline) {
        const { timeline } = await import('../hygiene/hygiene.js');
        const rows = timeline(ctx, node);
        console.log(json ? JSON.stringify(rows, null, 2) : rows.map((r) => `${r.date}  ${r.kind.padEnd(11)} ${r.id.padEnd(8)} ${r.text}${r.archived ? '  (archived)' : ''}`).join('\n') || '(no history)');
        return 0;
      }
      // A rule's "why" is the decisions that serve or override it, wherever they were recorded; a file's or
      // module's is the decisions on it. Asking a rule for decisions recorded *on* it always found none.
      const isRule = g.constraints.has(node) || g.concepts.has(node);
      const w = walk(g, node, { maxDecisions: 1000 });
      const decisions = isRule
        ? g.decisionsFor(node, { includeSuperseded: args.cmd === 'history' })
        : args.cmd === 'why' ? w.decisions : g.allDecisionsOn(node);
      const card = isRule ? undefined : renderFileCard(node, cardState(g, ctx.root, node), factsFor(ctx.root, node).lines);
      if (json) { console.log(JSON.stringify({ node, card: g.cards.get(node) ?? null, constraints: w.constraints, decisions }, null, 2)); return 0; }
      if (card && args.cmd === 'why') console.log(card.text);
      if (args.cmd === 'why') {
        console.log(node);
        const own = g.constraints.get(node);
        if (own) console.log(`  [${own.mode}] ${own.id}  ${own.text}${own.test ? `  test:${own.test}` : ''}${g.isRetired(own.id) ? '  (retired)' : ''}  on ${own.attachedTo}`);
        else for (const k of w.constraints) console.log(`  [${k.mode}] ${k.id}  ${k.text}${k.test ? `  test:${k.test}` : ''}${g.isRetired(k.id) ? '  (retired)' : ''}`);
      }
      if (!decisions.length) console.log('  (no decisions)');
      for (const d of decisions) {
        const sha = commitOf(g, ctx.root, d);
        const flags = [g.superseded.has(d.id) ? 'superseded' : '', sha === '-' ? 'not committed' : ''].filter(Boolean).join(', ');
        console.log(`  ${d.id} ${d.date} ${d.who} ${sha} ${d.branch}  ->${d.serves}${d.overrides ? ` !${d.overrides}` : ''}  ${d.text}${flags ? `  (${flags})` : ''}`);
      }
      return 0;
    }

    case 'record': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const node = str(args.flags.node);
      const serves = str(args.flags.serves);
      const text = str(args.flags.text);
      if (!node || !serves || !text) throw new Error('ctx record --node <n> --serves <id> --text "<why>" [--overrides <k-id>]');
      const session = str(args.flags.session) ?? resolveSession(ctx.root, 'cli');
      const recorder = new Recorder(g, new SessionState(ctx.root, session));
      const who = `${gitPerson(ctx.root)}/${str(args.flags.agent) ?? 'human'}`;
      try {
        const r = recorder.record({ node, serves, text, who, branch: currentBranch(ctx.root), ...(str(args.flags.overrides) ? { overrides: str(args.flags.overrides)! } : {}) });
        const env = envelope('decision', { session, who, branch: r.decision.branch, harness: 'cli' }, r.decision);
        new ObservationStore(ctx.root, session).append(env);
        publishDecision(ctx, env);
        if (json) console.log(JSON.stringify(r, null, 2));
        else { console.log(`recorded ${r.decision.id} on ${r.decision.node} -> ${r.decision.serves}`); for (const w of r.warnings) console.log(`warning: ${w}`); }
        return 0;
      } catch (e) {
        if (e instanceof RecordError) { console.error(`rejected: ${e.message}`); if (e.applicable.length) console.error(`applicable: ${e.applicable.join(', ')}`); return 2; }
        throw e;
      }
    }

    case 'card': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const path = args.positional[0] ?? str(args.flags.node);
      const text = str(args.flags.text);
      if (!path || !text) throw new Error('ctx card <path> --text "<what the file is for, what it relies on, who relies on it, what it must keep true>" [--req ID,ID]');
      const rel = toRepoRelative(ctx.root, path, process.cwd());
      const req = str(args.flags.req)?.split(',').map((s) => s.trim()).filter(Boolean) ?? factsFor(ctx.root, rel).requirements;
      const who = `${gitPerson(ctx.root)}/${str(args.flags.agent) ?? 'human'}`;
      try {
        const c = writeCard(g, ctx.root, { path: rel, text, who, date: todayIso(), ...(req.length ? { req } : {}) });
        console.log(json ? JSON.stringify(c) : `card ${c.path} @ ${c.hash}${c.req?.length ? `  [${c.req.join(', ')}]` : ''}`);
        return 0;
      } catch (e) {
        console.error(`rejected: ${(e as Error).message}`);
        return 2;
      }
    }

    case 'provenance': {
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const r = linkProvenance(g, ctx.root);
      console.log(json ? JSON.stringify(r) : `${r.linked.length} of this branch's decision(s) committed${r.linked.length ? ` (${r.linked.join(', ')})` : ''}, ${r.skipped.length} not yet committed`);
      return 0;
    }

    case 'pending': {
      const ctx = openFromArgs(args);
      const session = str(args.flags.session) ?? latestSession(ctx.root);
      if (!session) { console.log('(no sessions)'); return 0; }
      const pending = Object.values(new SessionState(ctx.root, session).data.pending);
      if (json) console.log(JSON.stringify({ session, pending }, null, 2));
      else if (!pending.length) console.log(`${session}: nothing pending`);
      else for (const p of pending) console.log(`${p.path}${p.symbol ? `#${p.symbol}` : ''}  [${p.constraints.join(', ')}]  since ${p.since}`);
      return 0;
    }

    case 'coverage': {
      const ctx = openFromArgs(args);
      const session = str(args.flags.session) ?? latestSession(ctx.root);
      if (!session) { console.log('(no sessions)'); return 0; }
      const covs = new ObservationStore(ctx.root, session).readAll().filter((e) => e.t === 'coverage').map((e) => e.p as CoverageRecord);
      if (json) { console.log(JSON.stringify(covs, null, 2)); return 0; }
      if (!covs.length) console.log(`${session}: no edits with coverage yet`);
      for (const c of covs) {
        const loadedModes = Object.entries(c.loaded).filter(([p]) => p === c.path || c.callers.includes(p)).map(([p, m]) => `${p.split('/').pop()}:${m}`).join(' ');
        console.log(`${c.path}\n  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}  dark ${c.dark.length}${c.summarized_since ? '  summarized-since' : ''}\n  ${loadedModes || '(nothing loaded)'}`);
      }
      return 0;
    }

    case 'doctor': {
      const ctx = openFromArgs(args);
      const lines = runDoctor(ctx);
      if (json) console.log(JSON.stringify(lines, null, 2));
      else console.log(formatDoctor(lines));
      return lines.some((l) => l.level === 'fail') ? 1 : 0;
    }

    case 'sessions': {
      const ctx = openFromArgs(args);
      const list = ObservationStore.sessions(ctx.root);
      if (json) console.log(JSON.stringify(list, null, 2));
      else if (!list.length) console.log('(no sessions)');
      else for (const s of list) console.log(`${s.session}  ${s.mtime.toISOString()}  ${s.size} bytes`);
      return 0;
    }

    case 'replay': {
      const file = args.positional[0];
      if (!file) throw new Error('ctx replay <transcript.jsonl> [--harness auto|claude-code|codex]');
      const r = await replayTranscript(resolve(file), { ...(str(args.flags.repo) ? { repo: str(args.flags.repo)! } : {}), ...(str(args.flags.graph) ? { graph: str(args.flags.graph)! } : {}), ...(str(args.flags.harness) ? { harness: str(args.flags.harness)! } : {}) });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`${r.harness} session ${r.session}: ${r.events} events, ${r.edits} edits, ${r.coverage} coverage records${r.cliVersion ? `, cli ${r.cliVersion}` : ''}\n  -> ${r.file}`);
        for (const w of r.warnings) console.log(`warning: ${w}`);
      }
      return 0;
    }

    case 'parse-shell': {
      const touches = parseShellCommand(args.positional.join(' '), str(args.flags.cwd));
      console.log(json ? JSON.stringify(touches, null, 2) : touches.map((t) => `${t.mode.padEnd(8)} ${t.path}${t.range ? `  [${t.range.join(':')}]` : ''}${t.unparsed ? '  (unparsed)' : ''}`).join('\n') || '(no paths)');
      return 0;
    }

    case 'parse-patch': {
      const files = parsePatchText(readInput(args.positional[0]));
      if (!files) throw new Error('input is not an apply_patch or unified diff');
      console.log(json ? JSON.stringify(files, null, 2) : files.map((f) => `${f.kind.padEnd(7)} ${f.path}${f.movedTo ? ` -> ${f.movedTo}` : ''}${f.ranges?.length ? `  ${f.ranges.map((r) => r.join(':')).join(' ')}` : ''}`).join('\n'));
      return 0;
    }

    case 'adopt': {
      // The link was the trial door: a graph kept elsewhere, the repository untouched. Once decisions accumulate,
      // the graph belongs in the repository, where git carries it to every checkout and every teammate.
      const ctx = openFromArgs(args);
      const g = needGraph(ctx);
      const from = ctx.graphDir!;
      const dest = join(ctx.root, '.ctx');
      if (resolve(from) === resolve(dest)) { console.log(`the graph already lives in ${dest}`); return 0; }
      if (existsSync(dest) && readdirSync(dest).length && args.flags.force !== true) throw new Error(`${dest} already exists; pass --force to overwrite it with the linked graph`);
      mkdirSync(dest, { recursive: true });
      const copied: string[] = [];
      for (const f of readdirSync(from)) { if (!lstatSync(join(from, f)).isFile()) continue; copyFileSync(join(from, f), join(dest, f)); copied.push(f); }
      const link = join(ctxHome(), 'graphs', repoHash(ctx.root));
      if (isSymlink(link)) unlinkSync(link);
      console.log(`moved the graph into ${dest} (${copied.join(', ')}): ${g.logicals.size} modules, ${g.constraints.size} rules, ${g.decisions.size} decisions`);
      console.log(`${from} is no longer read for this repository. Commit .ctx so every checkout and teammate carries it:\n  git add .ctx && git commit -m "chore: adopt the context graph"`);
      return 0;
    }

    case 'link': {
      const graph = str(args.flags.graph);
      if (!graph) throw new Error('ctx link --graph <dir> [--repo <dir>]');
      const ctx = openRepo({ ...(str(args.flags.repo) ? { repo: str(args.flags.repo)! } : {}) });
      const target = resolve(graph);
      if (!existsSync(join(target, 'graph.ctx'))) throw new Error(`${target} has no graph.ctx`);
      const linkDir = join(ctxHome(), 'graphs');
      mkdirSync(linkDir, { recursive: true });
      const link = join(linkDir, repoHash(ctx.root));
      if (existsSync(link) || isSymlink(link)) unlinkSync(link);
      symlinkSync(target, link);
      console.log(`${ctx.root}\n  -> ${target}\n  (link at ${link})`);
      return 0;
    }

    case 'install': {
      const target = args.positional[0];
      if (target === 'instructions') {
        const ins = appendInstructionBlock(openFromArgs(args).root);
        if (ins.status === 'appended') console.log(`appended the Context Graph block to ${ins.file}`);
        else if (ins.status === 'present') console.log(`${ins.file} already carries the Context Graph block`);
        else console.log(`no AGENTS.md or CLAUDE.md here; add this to your agent instructions:\n\n${INSTRUCTION_BLOCK}`);
        return 0;
      }
      const r = target === 'codex' ? installCodexUser()
        : target === 'claude-code' ? installClaudeUser()
        : target === 'git-hooks' ? installGitHooks(openFromArgs(args).root)
        : target === 'cli' ? installCli()
        : undefined;
      if (!r) throw new Error('ctx install cli|codex|claude-code|git-hooks|instructions');
      for (const c of r.changed) console.log(`wrote ${c}`);
      for (const n of r.notes) console.log(`note: ${n}`);
      return 0;
    }

    case 'embed': {
      const sub = args.positional[0];
      const ctx = openFromArgs(args);
      if (sub === 'build' || sub === 'update') {
        if (args.flags['if-enabled'] && !ctx.config.embed.enabled) return 0;
        if (!ctx.config.embed.enabled) throw new Error('embedding is disabled: set [embed] enabled = true in config.toml');
        const r = await buildEmbedIndex(ctx, { log: (s) => { if (!json) process.stderr.write(`${s}\n`); } });
        console.log(json ? JSON.stringify(r) : `${r.provider}: ${r.embedded} embedded, ${r.unchanged} unchanged, ${r.removed} removed, ${r.total} total`);
        return 0;
      }
      if (sub === 'status') {
        const store = openStore(ctx);
        console.log(store ? `${ctx.config.embed.provider}: ${store.count()} chunks at ${store.file}` : `no index for ${ctx.config.embed.provider}; run ctx embed build`);
        store?.close();
        return 0;
      }
      if (sub === 'query') {
        const q = args.positional.slice(1).join(' ');
        if (!q) throw new Error('ctx embed query <text>');
        const store = openStore(ctx);
        if (!store) throw new Error('no index; run ctx embed build');
        const [vec] = await makeProvider(ctx.config.embed).embed([q]);
        const hits = store.query(vec!, Number(str(args.flags.k) ?? 8), { includeArchived: ctx.config.embed.includeArchived });
        store.close();
        console.log(json ? JSON.stringify(hits.map(({ score, ref, kind, path }) => ({ score, ref, kind, path })), null, 2) : hits.map((h) => `${h.score.toFixed(3)}  ${h.kind.padEnd(10)} ${h.ref}`).join('\n'));
        return 0;
      }
      throw new Error('ctx embed build|update|query <text>|status');
    }

    case 'hook': {
      const harness = str(args.flags.harness) ?? 'claude-code';
      const raw = readInput('-');
      let input: HookInput;
      try { input = JSON.parse(raw) as HookInput; } catch { return 0; }
      try {
        const out = harness === 'codex'
          ? await runCodexHook(input, { agent: str(args.flags.agent) ?? 'codex' })
          : await runClaudeHook(input, { agent: str(args.flags.agent) ?? 'claude' });
        if (out.stdout) process.stdout.write(out.stdout);
        return out.exitCode;
      } catch (e) {
        process.stderr.write(`ctx hook: ${(e as Error).message}\n`);
        return 0;
      }
    }

    case 'mcp': {
      await startMcpServer({ agent: str(args.flags.agent) ?? 'claude', ...(str(args.flags.repo) ? { repo: str(args.flags.repo)! } : {}), ...(str(args.flags.graph) ? { graph: str(args.flags.graph)! } : {}) });
      return 0;
    }

    default: {
      const handled = await extraCommands(args, { json, usage: USAGE });
      if (handled !== undefined) return handled;
      console.error(`unknown command: ${args.cmd}\n\n${USAGE}`);
      return 1;
    }
  }
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

main().then(
  (code) => { process.exitCode = code; },
  (err: Error) => { console.error(err.message); process.exitCode = 1; },
);

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
