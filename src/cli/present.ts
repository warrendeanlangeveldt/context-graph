import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { cardState } from '../cards/cards.js';
import type { RepoContext } from '../core/context.js';
import { checkEdit, heldInFull } from '../enforce/read-before-edit.js';
import { GRAPH_FILE, PROPOSALS_FILE } from '../graph/graph.js';
import type { KRecord } from '../graph/records.js';
import { retire } from '../hygiene/hygiene.js';
import { loadOrBuildImportIndex } from '../index/imports.js';
import { violationsFor } from '../init/conformance.js';
import type { Envelope, Touch } from '../observe/event.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { factsFor, toolProtectedBranches } from '../tool-adapters/index.js';
import { git, gitPerson } from '../util/git.js';
import { readRepoText } from '../util/paths.js';
import { walk } from '../walker/walk.js';
import { latestSession, needGraph, openFromArgs, str, type Args } from './main.js';

/**
 * What a person sees about Context Graph while they work, as JSON for the Context Graph mod (and readable
 * text for a terminal): a file's context and whether an agent understood it (`ctx file`), each agent's
 * coverage (`ctx agents`), and the proposals waiting with their evidence (`ctx proposals`). `ctx drop`
 * turns a proposal down with a reason. Ratifying and dropping with a commit are the person's acts; the
 * hooks refuse them from agents.
 */

const eventsOf = (ctx: RepoContext, session: string | undefined): Envelope[] =>
  session ? new ObservationStore(ctx.root, session).readAll() : [];

/** A file's context, and, for an agent, whether it holds the file well enough to edit it. */
export function fileContext(ctx: RepoContext, path: string, opts: { session?: string | undefined; agent?: string | undefined } = {}) {
  const g = needGraph(ctx);
  const w = walk(g, path, { maxDecisions: 4 });
  const state = cardState(g, ctx.root, path);
  const events = eventsOf(ctx, opts.session);
  const check = checkEdit({ graph: g, root: ctx.root, config: ctx.config, events, agent: opts.agent, path, index: loadOrBuildImportIndex(ctx.root) });
  const facts = factsFor(ctx.root, path);
  return {
    path,
    mapped: w.mapped,
    chain: w.chain,
    card: state.card ? { text: state.card.text, fresh: state.fresh, date: state.card.date, who: state.card.who } : null,
    rules: w.constraints.map((k) => ({ id: k.id, mode: k.mode, text: k.text, test: k.test ?? null })),
    decisions: [...w.decisions].reverse().slice(0, 4).map((d) => ({ id: d.id, date: d.date, who: d.who, serves: d.serves, overrides: d.overrides ?? null, text: d.text })),
    understood: { ok: check.missing.length === 0, missing: check.missing.map((m) => ({ path: m.path, why: m.why })) },
    tools: { lines: facts.lines, requirements: facts.requirements },
  };
}

interface AgentCoverage {
  agent: string;
  agentType: string | null;
  read: string[];
  searched: string[];
  edited: { path: string; understood: boolean; missing: string[] }[];
  cardsOwed: string[];
}

/**
 * Each agent's coverage in a session: what it read in full, what it only searched, what it edited, and
 * whether each edit's file was understood when it was made (judged from the agent's own reads up to then,
 * and the cards as they stand now), with the cards it still owes.
 */
export function agentCoverage(ctx: RepoContext, session: string): AgentCoverage[] {
  const g = needGraph(ctx);
  const events = eventsOf(ctx, session);
  const index = loadOrBuildImportIndex(ctx.root);
  const types: Record<string, string> = {};
  for (const e of events) if (e.t === 'session') { const p = e.p as { agent?: string; agentType?: string }; if (p.agent && p.agentType) types[p.agent] = p.agentType; }
  const byAgent = new Map<string, AgentCoverage>();
  const of = (agent: string | undefined): AgentCoverage => {
    const key = agent ?? 'main';
    if (!byAgent.has(key)) byAgent.set(key, { agent: key, agentType: agent ? (types[agent] ?? null) : null, read: [], searched: [], edited: [], cardsOwed: [] });
    return byAgent.get(key)!;
  };
  events.forEach((e, i) => {
    if (e.t !== 'touch' && e.t !== 'edit') return;
    const t = e.p as Touch;
    if (t.mode === 'failed' || t.mode === 'external') return;
    const a = of(t.agent);
    const add = (list: string[]) => { if (!list.includes(t.path)) list.push(t.path); };
    if (t.mode === 'full' || (t.mode === 'range' && t.range?.[0] === 1 && t.range?.[1] === -1)) add(a.read);
    else if (t.mode === 'grep' || t.mode === 'name') add(a.searched);
    else if (t.mode === 'edit' || t.mode === 'write') {
      if (a.edited.some((x) => x.path === t.path)) return;
      const before = events.slice(0, i);
      const held = heldInFull(before, t.agent);
      if (t.mode === 'write' && !held.has(t.path) && !before.some((b) => (b.p as Touch | undefined)?.path === t.path)) {
        a.edited.push({ path: t.path, understood: true, missing: [] }); // a new file has nothing to understand yet
        return;
      }
      const c = checkEdit({ graph: g, root: ctx.root, config: ctx.config, events: before, agent: t.agent, path: t.path, index });
      a.edited.push({ path: t.path, understood: c.missing.length === 0, missing: c.missing.map((m) => m.path) });
    }
  });
  for (const a of byAgent.values()) {
    const s = new SessionState(ctx.root, session, a.agent === 'main' ? undefined : a.agent);
    // Owed only until a card matches the file, whoever wrote it, or the file is gone: the session's
    // record keeps an edit's card as owed until its agent next acts, so it's settled here as the
    // recorder settles it.
    a.cardsOwed = Object.keys(s.data.cardsOwed ?? {}).filter(
      (path) => readRepoText(ctx.root, path) !== undefined && !cardState(g, ctx.root, path).fresh,
    );
  }
  return [...byAgent.values()];
}

/** Every proposed rule and concept, with the evidence a person decides on. */
export function proposals(ctx: RepoContext) {
  const g = needGraph(ctx);
  const index = loadOrBuildImportIndex(ctx.root);
  const decisions = [...g.decisions.values()];
  // The decisions that served or overrode it, counted and dated (the Proposals queue's sparklines, VIEW-3).
  const evidence = (id: string) => {
    const serving = decisions.filter((d) => d.serves === id);
    const overriding = decisions.filter((d) => d.overrides === id);
    return {
      served: serving.length,
      overridden: overriding.length,
      servedOn: serving.map((d) => d.date).sort(),
      overriddenOn: overriding.map((d) => d.date).sort(),
    };
  };
  const rules = [...g.constraints.values()].filter((k) => k.mode === 'G?' && !g.isRetired(k.id)).map((k: KRecord) => ({
    id: k.id, kind: k.test ? 'enforced' : 'guidance', module: k.attachedTo, text: k.text,
    ...evidence(k.id), violations: k.rule ? violationsFor(g, k, index).length : null,
  }));
  const concepts = [...g.concepts.values()].filter((c) => c.proposed && !g.isRetired(c.id)).map((c) => ({
    id: c.id, kind: 'concepts', module: null, text: c.name, ...evidence(c.id), violations: null,
  }));
  return [...rules, ...concepts];
}

/** Branches a person's graph commit may not land on: the repository's default, and those other tools protect. */
export function protectedBranches(ctx: RepoContext): string[] {
  return [...new Set([ctx.config.defaultBranch, ...toolProtectedBranches(ctx.root)])];
}

/** Whether `person` is among the ratifiers, matched the way the merge gate matches trailers. */
export function isRatifier(ctx: RepoContext, person: string): boolean {
  const p = person.toLowerCase();
  return ctx.config.ratifiers.some((r) => p.includes(r.toLowerCase()) || r.toLowerCase().includes(p));
}

/**
 * Checks a person's graph commit may happen here, before anything changes: an in-repository graph, a
 * branch that isn't protected, and a person among the ratifiers. Returns why not, or undefined.
 */
export function commitRefusal(ctx: RepoContext): string | undefined {
  if (!ctx.graphDir || !ctx.graphDir.startsWith(ctx.root)) return 'The graph is linked from outside the repository; commit its changes there yourself.';
  const branch = git(ctx.root, ['branch', '--show-current']) ?? '';
  if (!branch) return 'The repository has no current branch; check one out first.';
  if (protectedBranches(ctx).includes(branch)) return `${branch} is protected. Switch to a branch, then ratify or drop there.`;
  const person = gitPerson(ctx.root);
  if (!isRatifier(ctx, person)) return `${person} isn't among the ratifiers. Add them to [repo] ratifiers in .ctx/config.toml first.`;
  return undefined;
}

/** Commits only the graph's own files, with the person's ratification trailer. Returns the commit's id. */
export function commitGraph(ctx: RepoContext, message: string): string {
  const dir = ctx.graphDir!;
  const files = [GRAPH_FILE, PROPOSALS_FILE, 'decisions.ctx'].map((f) => join(dir, f)).filter((f) => existsSync(f));
  const person = gitPerson(ctx.root);
  git(ctx.root, ['add', '--', ...files]);
  const out = git(ctx.root, ['commit', '-q', '-m', message, '--trailer', `Ctx-Ratified-By: ${person}`, '--', ...files]);
  if (out === undefined) throw new Error('The commit failed; the graph is changed but not committed.');
  return git(ctx.root, ['rev-parse', '--short', 'HEAD']) ?? '';
}

export async function run(args: Args, env: { json: boolean }): Promise<number> {
  const ctx = openFromArgs(args);
  const print = (value: unknown, text: string) => console.log(env.json ? JSON.stringify(value, null, 2) : text);
  if (args.cmd === 'file') {
    const path = args.positional[0];
    if (!path) throw new Error('ctx file <path> [--agent <id>] [--session <id>]');
    const f = fileContext(ctx, path, { session: str(args.flags.session) ?? latestSession(ctx.root), agent: str(args.flags.agent) });
    print(f, [
      f.path,
      `  card: ${f.card ? `${f.card.fresh ? 'current' : 'stale'}: ${f.card.text}` : 'none yet'}`,
      `  chain: ${f.chain.join(' > ') || '(unmapped)'}`,
      ...f.rules.map((r) => `  rule ${r.id} (${r.mode}): ${r.text}`),
      ...f.decisions.map((d) => `  ${d.id} ${d.date} ${d.who}: ${d.text}`),
      `  understood: ${f.understood.ok ? 'yes' : `no; still to read: ${f.understood.missing.map((m) => m.path).join(', ')}`}`,
      ...f.tools.lines.map((l) => `  ${l}`),
    ].join('\n'));
    return 0;
  }
  if (args.cmd === 'agents') {
    const session = str(args.flags.session) ?? latestSession(ctx.root);
    if (!session) { print([], '(no sessions)'); return 0; }
    const list = agentCoverage(ctx, session);
    print(list, list.map((a) => `${a.agent}${a.agentType ? ` (${a.agentType})` : ''}: read ${a.read.length}, searched ${a.searched.length}, edited ${a.edited.length} (${a.edited.filter((e) => !e.understood).length} without understanding), cards owed ${a.cardsOwed.length}`).join('\n') || `${session}: nothing observed yet`);
    return 0;
  }
  if (args.cmd === 'proposals') {
    const list = proposals(ctx);
    print(list, list.map((p) => `${p.id} (${p.kind}${p.module ? `, ${p.module}` : ''}): ${p.text}\n  served ${p.served}, overridden ${p.overridden}${p.violations !== null ? `, ${p.violations} violation(s)` : ''}`).join('\n') || 'No proposals.');
    return 0;
  }
  if (args.cmd === 'drop') {
    const id = args.positional[0];
    const reason = str(args.flags.reason);
    if (!id || !reason?.trim()) throw new Error('ctx drop <id> --reason "<why it is turned down>" [--commit]');
    needGraph(ctx);
    if (!proposals(ctx).some((p) => p.id === id)) throw new Error(`${id} is not a proposal; ratified rules and concepts are retired with ctx retire.`);
    const commit = args.flags.commit === true;
    const refused = commit ? commitRefusal(ctx) : undefined;
    if (refused) { console.error(refused); return 1; }
    retire(ctx, id, `dropped proposal: ${reason.trim()}`);
    const sha = commit ? commitGraph(ctx, `Drop ${id}: ${reason.trim()}`) : undefined;
    print({ dropped: id, reason: reason.trim(), commit: sha ?? null }, `dropped ${id}${sha ? ` (committed ${sha})` : ''}`);
    return 0;
  }
  return 1;
}
