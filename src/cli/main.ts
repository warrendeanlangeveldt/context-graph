#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, lstatSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runClaudeHook, type HookInput } from '../adapters/claude-code/hook.js';
import { openRepo, type RepoContext } from '../core/context.js';
import { computeCoverage, type CoverageRecord } from '../observe/coverage.js';
import type { Envelope } from '../observe/event.js';
import { parsePatchText } from '../observe/patch.js';
import { parseShellCommand } from '../observe/shell.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { RecordError, Recorder } from '../record/recorder.js';
import { startMcpServer } from '../mcp/server.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { ctxHome, repoHash } from '../util/paths.js';
import { renderSlice } from '../walker/slice.js';
import { walk } from '../walker/walk.js';

const USAGE = `ctx — Context Graph

  ctx slice <path> [--range a:b] [--symbol name]   slice injected before an edit
  ctx slice-patch <file|->                         slices for every file in a patch
  ctx applies <path>                               the applicable set, as ids
  ctx why <node>                                   active decisions and constraints on a node
  ctx history <node>                               every decision on a node, superseded included
  ctx check                                        validate the graph
  ctx record --node <n> --serves <id> --text "<why>" [--overrides <k-id>] [--agent <name>]
  ctx pending [--session <id>]                     nodes owing a decision in a session
  ctx coverage [--session <id>]                    coverage records for a session
  ctx sessions                                     observed sessions for this repository
  ctx parse-shell "<command>" [--cwd <dir>]        what the observer sees in a shell command
  ctx parse-patch <file|->                         files and ranges in a patch
  ctx link --graph <dir> [--repo <dir>]            use a graph kept outside the repository
  ctx info                                         repository, graph, and config in effect
  ctx hook --harness claude-code [--agent <name>]  hook entrypoint (reads the hook JSON on stdin)
  ctx mcp [--agent <name>]                         MCP server on stdio

Global: --repo <dir>  --graph <dir>  --json`;

interface Args { cmd: string; positional: string[]; flags: Record<string, string | boolean> }

function parseArgs(argv: string[]): Args {
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

function str(v: string | boolean | undefined): string | undefined { return typeof v === 'string' ? v : undefined; }

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const json = args.flags.json === true;
  const open = (): RepoContext => openRepo({ ...(str(args.flags.repo) ? { repo: str(args.flags.repo)! } : {}), ...(str(args.flags.graph) ? { graph: str(args.flags.graph)! } : {}) });
  const needGraph = (ctx: RepoContext): NonNullable<RepoContext['graph']> => {
    if (!ctx.graph) throw new Error(`no graph for ${ctx.root}: add .ctx/graph.ctx, set CTX_GRAPH_DIR, or run ctx link`);
    return ctx.graph;
  };

  switch (args.cmd) {
    case '':
    case 'help':
    case '--help':
      console.log(USAGE);
      return 0;

    case 'info': {
      const ctx = open();
      const info = { root: ctx.root, repoHash: repoHash(ctx.root), graphDir: ctx.graphDir ?? null, config: ctx.config, ctxHome: ctxHome(), branch: currentBranch(ctx.root), person: gitPerson(ctx.root) };
      console.log(json ? JSON.stringify(info, null, 2) : Object.entries(info).map(([k, v]) => `${k.padEnd(10)} ${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`).join('\n'));
      return 0;
    }

    case 'check': {
      const ctx = open();
      const g = needGraph(ctx);
      const findings = g.validate(ctx.root);
      if (json) console.log(JSON.stringify(findings, null, 2));
      else if (!findings.length) console.log(`ok: ${g.mappings.length} mappings, ${g.logicals.size} logical, ${g.concepts.size} concepts, ${g.constraints.size} constraints, ${g.decisions.size} decisions`);
      else for (const f of findings) console.log(`${f.level.padEnd(5)} ${f.rule.padEnd(20)} ${f.file ? `${f.file}:${f.line} ` : ''}${f.message}`);
      return findings.some((f) => f.level === 'error') ? 1 : 0;
    }

    case 'slice': {
      const ctx = open();
      const g = needGraph(ctx);
      const path = args.positional[0];
      if (!path) throw new Error('ctx slice <path>');
      const symbol = str(args.flags.symbol);
      const w = walk(g, path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
      const s = renderSlice(g, w, { maxTokens: ctx.config.maxTokens });
      if (json) console.log(JSON.stringify({ ...s, walk: w }, null, 2));
      else {
        console.log(s.text);
        for (const wmsg of s.warnings) console.error(`warning: ${wmsg}`);
      }
      return 0;
    }

    case 'slice-patch': {
      const ctx = open();
      const g = needGraph(ctx);
      const src = readInput(args.positional[0]);
      const files = parsePatchText(src);
      if (!files) throw new Error('input is not an apply_patch or unified diff');
      const texts = files.filter((f) => f.kind !== 'delete').map((f) => renderSlice(g, walk(g, f.movedTo ?? f.path, { maxDecisions: ctx.config.maxDecisions }), { maxTokens: ctx.config.maxTokens }).text);
      console.log(texts.join('\n\n'));
      return 0;
    }

    case 'applies': {
      const ctx = open();
      const g = needGraph(ctx);
      const path = args.positional[0];
      if (!path) throw new Error('ctx applies <path>');
      const w = walk(g, path, { maxDecisions: 1000 });
      console.log(json ? JSON.stringify(w, null, 2) : w.applicable.join('\n'));
      return 0;
    }

    case 'why':
    case 'history': {
      const ctx = open();
      const g = needGraph(ctx);
      const node = g.resolve(args.positional[0] ?? '');
      if (!node) throw new Error(`ctx ${args.cmd} <node>`);
      const w = walk(g, node, { maxDecisions: 1000 });
      const decisions = args.cmd === 'why' ? w.decisions : g.allDecisionsOn(node);
      if (json) { console.log(JSON.stringify({ node, constraints: w.constraints, decisions }, null, 2)); return 0; }
      if (args.cmd === 'why') {
        console.log(`${node}`);
        for (const k of w.constraints) console.log(`  [${k.mode}] ${k.id}  ${k.text}${k.test ? `  test:${k.test}` : ''}${g.isRetired(k.id) ? '  (retired)' : ''}`);
      }
      if (!decisions.length) console.log('  (no decisions)');
      for (const d of decisions) {
        const flags = [g.superseded.has(d.id) ? 'superseded' : '', d.sha === '-' ? 'provisional' : ''].filter(Boolean).join(', ');
        console.log(`  ${d.id} ${d.date} ${d.who} ${d.sha} ${d.branch}  ->${d.serves}${d.overrides ? ` !${d.overrides}` : ''}  ${d.text}${flags ? `  (${flags})` : ''}`);
      }
      return 0;
    }

    case 'record': {
      const ctx = open();
      const g = needGraph(ctx);
      const node = str(args.flags.node);
      const serves = str(args.flags.serves);
      const text = str(args.flags.text);
      if (!node || !serves || !text) throw new Error('ctx record --node <n> --serves <id> --text "<why>" [--overrides <k-id>]');
      const session = str(args.flags.session) ?? process.env.CLAUDE_SESSION_ID ?? 'cli';
      const state = new SessionState(ctx.root, session);
      const recorder = new Recorder(g, state);
      const who = `${gitPerson(ctx.root)}/${str(args.flags.agent) ?? 'human'}`;
      try {
        const r = recorder.record({ node, serves, text, who, branch: currentBranch(ctx.root), ...(str(args.flags.overrides) ? { overrides: str(args.flags.overrides)! } : {}) });
        const store = new ObservationStore(ctx.root, session);
        store.append({ t: 'decision', ts: new Date().toISOString(), session, who, branch: r.decision.branch, harness: 'cli', p: r.decision });
        if (json) console.log(JSON.stringify(r, null, 2));
        else {
          console.log(`recorded ${r.decision.id} on ${r.decision.node} -> ${r.decision.serves}`);
          for (const w of r.warnings) console.log(`warning: ${w}`);
        }
        return 0;
      } catch (e) {
        if (e instanceof RecordError) {
          console.error(`rejected: ${e.message}`);
          if (e.applicable.length) console.error(`applicable: ${e.applicable.join(', ')}`);
          return 2;
        }
        throw e;
      }
    }

    case 'pending': {
      const ctx = open();
      const session = str(args.flags.session) ?? latestSession(ctx.root);
      if (!session) { console.log('(no sessions)'); return 0; }
      const state = new SessionState(ctx.root, session);
      const pending = Object.values(state.data.pending);
      if (json) console.log(JSON.stringify({ session, pending }, null, 2));
      else if (!pending.length) console.log(`${session}: nothing pending`);
      else for (const p of pending) console.log(`${p.path}${p.symbol ? `#${p.symbol}` : ''}  [${p.constraints.join(', ')}]  since ${p.since}`);
      return 0;
    }

    case 'coverage': {
      const ctx = open();
      const session = str(args.flags.session) ?? latestSession(ctx.root);
      if (!session) { console.log('(no sessions)'); return 0; }
      const events = new ObservationStore(ctx.root, session).readAll();
      const covs = events.filter((e) => e.t === 'coverage').map((e) => e.p as CoverageRecord);
      if (json) { console.log(JSON.stringify(covs, null, 2)); return 0; }
      if (!covs.length) console.log(`${session}: no edits with coverage yet`);
      for (const c of covs) {
        const loadedModes = Object.entries(c.loaded).filter(([p]) => p === c.path || c.callers.includes(p)).map(([p, m]) => `${p.split('/').pop()}:${m}`).join(' ');
        console.log(`${c.path}\n  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}  dark ${c.dark.length}${c.summarized_since ? '  summarized-since' : ''}\n  ${loadedModes || '(nothing loaded)'}`);
      }
      return 0;
    }

    case 'sessions': {
      const ctx = open();
      const list = ObservationStore.sessions(ctx.root);
      if (json) console.log(JSON.stringify(list, null, 2));
      else if (!list.length) console.log('(no sessions)');
      else for (const s of list) console.log(`${s.session}  ${s.mtime.toISOString()}  ${s.size} bytes`);
      return 0;
    }

    case 'parse-shell': {
      const command = args.positional.join(' ');
      const cwd = str(args.flags.cwd);
      const touches = parseShellCommand(command, cwd);
      console.log(json ? JSON.stringify(touches, null, 2) : touches.map((t) => `${t.mode.padEnd(8)} ${t.path}${t.range ? `  [${t.range.join(':')}]` : ''}${t.unparsed ? '  (unparsed)' : ''}`).join('\n') || '(no paths)');
      return 0;
    }

    case 'parse-patch': {
      const files = parsePatchText(readInput(args.positional[0]));
      if (!files) throw new Error('input is not an apply_patch or unified diff');
      console.log(json ? JSON.stringify(files, null, 2) : files.map((f) => `${f.kind.padEnd(7)} ${f.path}${f.movedTo ? ` -> ${f.movedTo}` : ''}${f.ranges?.length ? `  ${f.ranges.map((r) => r.join(':')).join(' ')}` : ''}`).join('\n'));
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

    case 'hook': {
      const harness = str(args.flags.harness) ?? 'claude-code';
      if (harness !== 'claude-code') throw new Error(`unknown harness ${harness}`);
      const raw = readInput('-');
      let input: HookInput;
      try { input = JSON.parse(raw) as HookInput; } catch { return 0; }
      try {
        const out = runClaudeHook(input, { agent: str(args.flags.agent) ?? 'claude' });
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

    default:
      console.error(`unknown command: ${args.cmd}\n\n${USAGE}`);
      return 1;
  }
}

function readInput(arg: string | undefined): string {
  if (!arg || arg === '-') return readFileSync(0, 'utf8');
  return readFileSync(arg, 'utf8');
}

function latestSession(root: string): string | undefined {
  return ObservationStore.sessions(root)[0]?.session;
}

function isSymlink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

export { computeCoverage, type Envelope };

main().then(
  (code) => { process.exitCode = code; },
  (err: Error) => { console.error(err.message); process.exitCode = 1; },
);
