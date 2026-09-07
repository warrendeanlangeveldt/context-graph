import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { openRepo, type RepoContext } from '../core/context.js';
import { toRepoRelative } from '../util/paths.js';
import { hydrate } from '../hydrate/hydrate.js';
import type { Graph } from '../graph/graph.js';
import type { CoverageRecord } from '../observe/coverage.js';
import { envelope, type ReachPayload } from '../observe/event.js';
import { parsePatchText } from '../observe/patch.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { RecordError, Recorder } from '../record/recorder.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { renderSlice } from '../walker/slice.js';
import { walk } from '../walker/walk.js';

/**
 * The pull surface (design spec §13). Hooks push the slice; these tools let the agent traverse
 * above the floor. Every pull is recorded as a `reach` event so the difference between what was
 * pushed and what the agent went and found stays visible.
 */
export async function startMcpServer(opts: { agent: string; repo?: string; graph?: string }): Promise<void> {
  const server = new McpServer({ name: 'ctx', version: '0.1.0' });
  const session = process.env.CLAUDE_SESSION_ID ?? process.env.CTX_SESSION ?? 'mcp';

  const open = (): RepoContext => openRepo({ ...(opts.repo ? { repo: opts.repo } : {}), ...(opts.graph ? { graph: opts.graph } : {}) });
  const need = (ctx: RepoContext): Graph => {
    if (!ctx.graph) throw new Error(`no graph for ${ctx.root}; add .ctx/graph.ctx or run ctx link`);
    return ctx.graph;
  };
  const text = (t: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: t }] });
  /**
   * Sessions often run in a subdirectory of the repository. A path is taken as repository-relative
   * when it resolves there, otherwise relative to the process working directory, and absolute paths
   * are converted. Node ids (L:, C:, aliases) pass through untouched.
   */
  const norm = (ctx: RepoContext, p: string): string => {
    const g = ctx.graph;
    if (!p || p.startsWith('L:') || p.startsWith('C:') || g?.aliases.has(p)) return p;
    if (isAbsolute(p)) return toRepoRelative(ctx.root, p);
    const bare = p.split('#')[0]!;
    if (existsSync(join(ctx.root, bare)) || g?.mapPath(bare)) return p;
    const fromCwd = resolve(process.cwd(), bare);
    if (existsSync(fromCwd)) return toRepoRelative(ctx.root, fromCwd) + (p.includes('#') ? '#' + p.split('#')[1] : '');
    return p;
  };
  const reach = (ctx: RepoContext, tool: string, nodes: string[]): void => {
    const store = new ObservationStore(ctx.root, session);
    const p: ReachPayload = { tool, nodes };
    store.append(envelope('reach', { session, who: `${gitPerson(ctx.root)}/${opts.agent}`, branch: currentBranch(ctx.root), harness: 'mcp' }, p));
  };

  server.registerTool(
    'hydrate',
    {
      description: 'One bounded briefing for a scope before you work on it: the context slice for each file, its callers with the lines that use it (and whether they are already in this session), the rules in force with their decision history and legacy exceptions, what this session has already read or edited, hints from the index when enabled, and what teammates have open. Scope is a file path, a module id (L:...), a concept id (C:...), or a short task description. Prefer this over reading callers one by one.',
      inputSchema: { scope: z.string(), budget: z.number().int().positive().optional() },
    },
    async ({ scope, budget }) => {
      const ctx = open();
      need(ctx);
      const h = await hydrate(ctx, /\s/.test(scope.trim()) ? scope : norm(ctx, scope), { ...(budget ? { budget } : {}), session, who: `${gitPerson(ctx.root)}/${opts.agent}`, branch: currentBranch(ctx.root), harness: 'mcp', cwd: process.cwd() });
      return text(h.dropped.length ? `${h.text}\n(dropped under budget: ${h.dropped.join(', ')})` : h.text);
    },
  );

  server.registerTool(
    'slice',
    { description: 'The context slice for a file path (relative to the repository root, relative to the current directory, or absolute): module chain, constraints that apply, and the latest decisions. Same text the pre-edit hook injects.', inputSchema: { path: z.string(), symbol: z.string().optional() } },
    async ({ path, symbol }) => {
      const ctx = open();
      const g = need(ctx);
      const w = walk(g, norm(ctx, path), { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
      const s = renderSlice(g, w, { maxTokens: ctx.config.maxTokens });
      reach(ctx, 'slice', w.nodes);
      return text(s.text);
    },
  );

  server.registerTool(
    'slice_patch',
    { description: 'Slices for every file named in an apply_patch or unified diff.', inputSchema: { patch: z.string() } },
    async ({ patch }) => {
      const ctx = open();
      const g = need(ctx);
      const files = parsePatchText(patch);
      if (!files) return text('not a recognised patch format');
      const out = files.filter((f) => f.kind !== 'delete').map((f) => renderSlice(g, walk(g, f.movedTo ?? f.path), { maxTokens: ctx.config.maxTokens }).text);
      reach(ctx, 'slice_patch', files.map((f) => f.path));
      return text(out.join('\n\n'));
    },
  );

  server.registerTool(
    'applies',
    { description: 'The applicable set for a file path (repository-relative, current-directory-relative, or absolute), as ids: module chain, concepts, constraints, active decisions.', inputSchema: { path: z.string() } },
    async ({ path }) => {
      const ctx = open();
      const g = need(ctx);
      const w = walk(g, norm(ctx, path), { maxDecisions: 1000 });
      reach(ctx, 'applies', w.nodes);
      return text(JSON.stringify({ chain: w.chain, concepts: w.concepts, constraints: w.constraints.map((k) => `${k.mode} ${k.id}`), decisions: w.decisions.map((d) => d.id), mapped: w.mapped }, null, 2));
    },
  );

  server.registerTool(
    'why',
    { description: 'Active constraints and decisions on a node (a file path in any form, an L: module id, or a C: concept id), with provenance.', inputSchema: { node: z.string() } },
    async ({ node }) => {
      const ctx = open();
      const g = need(ctx);
      const id = g.resolve(norm(ctx, node));
      const w = walk(g, id, { maxDecisions: 1000 });
      reach(ctx, 'why', [id]);
      const lines = [id];
      for (const k of w.constraints) lines.push(`  [${k.mode}] ${k.id}  ${k.text}${k.test ? `  test:${k.test}` : ''}`);
      if (!w.decisions.length) lines.push('  (no active decisions)');
      for (const d of w.decisions) lines.push(`  ${d.id} ${d.date} ${d.who} ${d.sha} ${d.branch}  ->${d.serves}${d.overrides ? ` !${d.overrides}` : ''}  ${d.text}`);
      return text(lines.join('\n'));
    },
  );

  server.registerTool(
    'history',
    { description: 'Every decision ever recorded on a node, superseded ones included, oldest first.', inputSchema: { node: z.string(), limit: z.number().int().positive().optional() } },
    async ({ node, limit }) => {
      const ctx = open();
      const g = need(ctx);
      const id = g.resolve(norm(ctx, node));
      reach(ctx, 'history', [id]);
      const all = g.allDecisionsOn(id).slice(-(limit ?? 50));
      if (!all.length) return text(`${id}: no decisions`);
      return text(all.map((d) => `${d.id} ${d.date} ${d.who} ${d.sha} ${d.branch}  ->${d.serves}${d.overrides ? ` !${d.overrides}` : ''}  ${d.text}${g.superseded.has(d.id) ? '  (superseded)' : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'record',
    {
      description: 'Record a decision on a node: what changed and why. `serves` names the constraint or concept the change honours. Add `overrides` only when the change deliberately breaks a guided constraint.',
      inputSchema: { node: z.string(), serves: z.string(), text: z.string(), overrides: z.string().optional() },
    },
    async ({ node, serves, text: why, overrides }) => {
      const ctx = open();
      const g = need(ctx);
      const state = new SessionState(ctx.root, session);
      const recorder = new Recorder(g, state);
      const who = `${gitPerson(ctx.root)}/${opts.agent}`;
      try {
        const r = recorder.record({ node: norm(ctx, node), serves, text: why, who, branch: currentBranch(ctx.root), ...(overrides ? { overrides } : {}) });
        new ObservationStore(ctx.root, session).append(envelope('decision', { session, who, branch: r.decision.branch, harness: 'mcp' }, r.decision));
        const lines = [`recorded ${r.decision.id} on ${r.decision.node} -> ${r.decision.serves}`];
        for (const w of r.warnings) lines.push(`warning: ${w}`);
        return text(lines.join('\n'));
      } catch (e) {
        if (e instanceof RecordError) return text(`rejected: ${e.message}${e.applicable.length ? `\napplicable: ${e.applicable.join(', ')}` : ''}`);
        throw e;
      }
    },
  );

  server.registerTool(
    'coverage',
    { description: 'Coverage of edits in a session: whether a slice was injected, callers in context, and applicable files that stayed dark.', inputSchema: { session: z.string().optional() } },
    async ({ session: s }) => {
      const ctx = open();
      const id = s ?? ObservationStore.sessions(ctx.root)[0]?.session;
      if (!id) return text('no observed sessions');
      const covs = new ObservationStore(ctx.root, id).readAll().filter((e) => e.t === 'coverage').map((e) => e.p as CoverageRecord);
      if (!covs.length) return text(`${id}: no edits with coverage`);
      return text(covs.map((c) => `${c.path}  slice ${c.slice_injected ? 'injected' : 'absent'}  callers ${c.callers_loaded}/${c.callers_total}  dark ${c.dark.length}${c.summarized_since ? '  summarized-since' : ''}`).join('\n'));
    },
  );

  server.registerTool(
    'check',
    { description: 'Validate the graph and report findings.', inputSchema: {} },
    async () => {
      const ctx = open();
      const g = need(ctx);
      const f = g.validate(ctx.root);
      if (!f.length) return text(`ok: ${g.constraints.size} constraints, ${g.decisions.size} decisions, ${g.logicals.size} modules`);
      return text(f.map((x) => `${x.level} ${x.rule}: ${x.message}`).join('\n'));
    },
  );

  await server.connect(new StdioServerTransport());
}
