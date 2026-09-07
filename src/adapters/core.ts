import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { openRepo, type RepoContext } from '../core/context.js';
import { callersOf, loadOrBuildImportIndex } from '../index/imports.js';
import { enclosingSymbol, lineRangeOf } from '../index/symbols.js';
import { computeCoverage } from '../observe/coverage.js';
import { envelope, isEditMode, type AccessMode, type CompactPayload, type SessionPayload, type SlicePayload, type Touch } from '../observe/event.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { Recorder } from '../record/recorder.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { toAbsolute, toRepoRelative } from '../util/paths.js';
import { renderSlice } from '../walker/slice.js';
import { walk, type WalkResult } from '../walker/walk.js';
import { liveLinesFor, notifyOverlay } from '../overlay/client.js';
import { hintsFor } from '../embed/hints.js';
import { hydrate } from '../hydrate/hydrate.js';

/**
 * Harness-agnostic hook core (design spec §15.3). A profile supplies what differs per harness:
 * which tools edit, how to read their inputs, and the response shapes. Everything else is shared.
 */

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  tool_use_id?: string;
  agent_id?: string;
  agent_type?: string;
  start_reason?: string;
  source?: string;
  end_reason?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  trigger?: string;
  prompt?: string;
}

export interface HookOutput { stdout?: string; exitCode: number }

export interface TouchLike { path: string; mode: AccessMode; range?: [number, number]; unparsed?: boolean }
export interface EditTarget { path: string; range?: [number, number] }

export interface ToolContext {
  root: string;
  cwd: string;
  shellParsing: boolean;
  rel: (p: string) => string;
  readFile: (repoRelative: string) => string | undefined;
}

export interface HarnessProfile {
  id: string;
  agent: string;
  /** Tools whose PreToolUse means "about to edit". */
  isEditTool(tool: string): boolean;
  /** Paths (repo-relative) about to be edited by this tool call, for the pre-edit slice. */
  preEditTargets(tool: string, ti: Record<string, unknown>, tc: ToolContext): EditTarget[];
  /** Touches implied by a completed tool call. */
  touches(tool: string, ti: Record<string, unknown>, tc: ToolContext): TouchLike[];
  sessionStartReason(input: HookInput): string;
  /** Event that signals compaction is about to happen, if the harness has one distinct from SessionStart. */
  preCompactEvent?: string;
  formatSessionStart(text: string): string;
  formatPreToolUse(context: string): string;
  formatStopBlock(reason: string): string;
  /** Context added to a user prompt before the model sees it (prompt-time hydrate). */
  formatPromptContext(context: string): string;
}

export async function runHook(input: HookInput, profile: HarnessProfile): Promise<HookOutput> {
  const ctx = openRepo({ cwd: input.cwd });
  const root = ctx.root;
  const session = input.session_id || 'unknown';
  const meta = { session, who: `${gitPerson(root)}/${profile.agent}`, branch: currentBranch(root), harness: profile.id };
  const store = new ObservationStore(root, session);
  const state = new SessionState(root, session);
  decideArm(ctx, state);
  const injecting = Boolean(ctx.graph) && state.data.arm === 'on';
  const origin: Touch['origin'] = input.agent_id ? 'subagent' : 'main';
  const tc: ToolContext = {
    root,
    cwd: input.cwd,
    shellParsing: ctx.config.shellParsing,
    rel: (p) => toRepoRelative(root, p, input.cwd),
    readFile: (p) => readRepoFile(root, p),
  };

  const emitTouches = (touches: TouchLike[], tool: string, failed = false): Touch[] => {
    const out: Touch[] = [];
    for (const t of touches) {
      const touch: Touch = { path: t.path, mode: failed ? 'failed' : t.mode, tool, origin };
      if (t.range) touch.range = t.range;
      if (t.unparsed) touch.unparsed = true;
      if (input.agent_id) touch.agent = input.agent_id;
      const env = envelope(isEditMode(touch.mode) ? 'edit' : 'touch', meta, touch);
      store.append(env);
      notifyOverlay(ctx, env);
      out.push(touch);
    }
    return out;
  };

  const sliceFor = async (path: string, range?: [number, number], intent?: string): Promise<{ text: string; walk: WalkResult } | undefined> => {
    if (!ctx.graph) return undefined;
    const symbol = range ? symbolAt(tc, path, range[0]) : undefined;
    const w = walk(ctx.graph, path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
    const [live, hints] = await Promise.all([liveLinesFor(ctx, w, meta), hintsFor(ctx, w, intent)]);
    const s = renderSlice(ctx.graph, w, { maxTokens: ctx.config.maxTokens, live, hints });
    const payload: SlicePayload = { path, applicable: s.applicable, tokens: s.tokens, rendered: s.text, dropped: s.dropped };
    const env = envelope('slice', meta, payload);
    store.append(env);
    notifyOverlay(ctx, env);
    for (const warning of s.warnings) store.append(envelope('finding', meta, { rule: 'slice-budget', message: warning, path }));
    return { text: s.text, walk: w };
  };

  const event = input.hook_event_name;

  if (event === 'SessionStart') {
    const reason = profile.sessionStartReason(input);
    if (reason === 'compact' && !profile.preCompactEvent) emitCompact(store, meta);
    if (reason !== 'compact') {
      const payload: SessionPayload = { kind: 'start', cwd: input.cwd, arm: state.data.arm, reason };
      const env = envelope('session', meta, payload);
      store.append(env);
      notifyOverlay(ctx, env);
    }
    return { stdout: profile.formatSessionStart(sessionContext(ctx, injecting, reason === 'compact')), exitCode: 0 };
  }

  if (profile.preCompactEvent && event === profile.preCompactEvent) {
    emitCompact(store, meta);
    return { exitCode: 0 };
  }

  if (event === 'SessionEnd') {
    const payload: SessionPayload = { kind: 'end', cwd: input.cwd, arm: state.data.arm };
    if (input.end_reason) payload.reason = input.end_reason;
    const env = envelope('session', meta, payload);
    store.append(env);
    notifyOverlay(ctx, env);
    return { exitCode: 0 };
  }

  if (event === 'SubagentStart' || event === 'SubagentStop') {
    const kind = event === 'SubagentStart' ? 'subagent-start' : 'subagent-stop';
    const payload: SessionPayload = { kind, cwd: input.cwd, arm: state.data.arm };
    if (input.agent_id) payload.agent = input.agent_id;
    if (input.agent_type) payload.agentType = input.agent_type;
    store.append(envelope('session', meta, payload));
    if (input.agent_id) {
      if (kind === 'subagent-start') state.data.delegations[input.agent_id] = { since: new Date().toISOString(), ...(input.agent_type ? { agentType: input.agent_type } : {}) };
      else delete state.data.delegations[input.agent_id];
      state.save();
    }
    return { exitCode: 0 };
  }

  if (event === 'PreToolUse') {
    if (!injecting || !ctx.graph) return { exitCode: 0 };
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    const recorder = new Recorder(ctx.graph, state);
    const slices: string[] = [];
    const intent = intentOf(ti);
    for (const t of profile.preEditTargets(tool, ti, tc).slice(0, 3)) {
      if (t.path.startsWith('/') || t.path === '.') continue;
      const s = await sliceFor(t.path, t.range, intent);
      if (s) { slices.push(s.text); recorder.notePending(s.walk); }
    }
    if (!slices.length) return { exitCode: 0 };
    return { stdout: profile.formatPreToolUse(slices.join('\n\n')), exitCode: 0 };
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const failed = event === 'PostToolUseFailure';
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    const emitted = emitTouches(profile.touches(tool, ti, tc), tool, failed);
    // A test run that failed is a rework signal the benchmark counts (design spec §20.3).
    if ((tool === 'Bash' || tool === 'exec_command' || tool === 'shell') && looksLikeTestRun(String(ti.command ?? '')) && (failed || commandFailed(input.tool_response))) {
      store.append(envelope('finding', meta, { rule: 'test-failed', message: `test command failed: ${String(ti.command ?? '').slice(0, 160)}` }));
    }
    if (failed || !ctx.graph) return { exitCode: 0 };
    const edits = emitted.filter((t) => isEditMode(t.mode) && t.origin === 'main' && !t.path.startsWith('/') && t.path !== '.');
    if (!edits.length) return { exitCode: 0 };
    const events = store.readAll();
    const index = loadOrBuildImportIndex(root);
    const recorder = new Recorder(ctx.graph, state);
    for (const e of edits) {
      const symbol = e.range ? symbolAt(tc, e.path, e.range[0]) : undefined;
      const w = walk(ctx.graph, e.path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
      const injected = events.some((ev) => ev.t === 'slice' && (ev.p as SlicePayload).path === e.path);
      const cov = computeCoverage(events, w, callersOf(index, e.path), injected);
      const env = envelope('coverage', meta, cov);
      store.append(env);
      notifyOverlay(ctx, env);
      if (injecting && !profile.isEditTool(tool)) recorder.notePending(w);
      if (cov.callers_total > 0 && cov.callers_loaded === 0) {
        store.append(envelope('finding', meta, { rule: 'callers-dark', message: `edited ${e.path} with none of its ${cov.callers_total} callers in context`, path: e.path }));
      }
    }
    return { exitCode: 0 };
  }

  if (event === 'Stop') {
    if (!injecting || !ctx.graph) return { exitCode: 0 };
    const recorder = new Recorder(ctx.graph, state);
    const verdict = recorder.stopDecision({ maxBlocks: ctx.config.maxBlocks, who: meta.who, branch: meta.branch, ...(input.stop_hook_active !== undefined ? { stopHookActive: input.stop_hook_active } : {}) });
    for (const d of verdict.gaveUp) {
      store.append(envelope('decision', meta, d));
      store.append(envelope('finding', meta, { rule: 'no-decision', message: `${d.node}: ${d.text}`, path: d.node }));
    }
    if (verdict.block) return { stdout: profile.formatStopBlock(verdict.reason ?? ''), exitCode: 0 };
    return { exitCode: 0 };
  }

  if (event === 'UserPromptSubmit') {
    if (!injecting || !ctx.graph || !ctx.config.hydrateOnPrompt) return { exitCode: 0 };
    const scopes = promptScopes(ctx, String(input.prompt ?? ''), input.cwd);
    if (!scopes.length) return { exitCode: 0 };
    const blocks: string[] = [];
    for (const scope of scopes.slice(0, 2)) {
      try {
        const h = await hydrate(ctx, scope, { budget: Math.floor(ctx.config.hydrateBudget / Math.min(scopes.length, 2)), session, who: meta.who, branch: meta.branch, harness: meta.harness, cwd: input.cwd });
        blocks.push(h.text);
      } catch { /* a scope that fails to resolve is not worth blocking the prompt for */ }
    }
    if (!blocks.length) return { exitCode: 0 };
    return { stdout: profile.formatPromptContext(blocks.join('\n\n')), exitCode: 0 };
  }

  if (event === 'Interrupt') {
    const pending = Object.keys(state.data.pending);
    if (pending.length) store.append(envelope('finding', meta, { rule: 'interrupted', message: `turn interrupted with ${pending.length} node(s) owing a decision: ${pending.join(', ')}` }));
    return { exitCode: 0 };
  }

  return { exitCode: 0 };
}

// ---- shared helpers -----------------------------------------------------------------

function emitCompact(store: ObservationStore, meta: { session: string; who: string; branch: string; harness: string }): void {
  const paths = new Set<string>();
  for (const e of store.readAll()) {
    if ((e.t === 'touch' || e.t === 'edit') && (e.p as Touch).origin === 'main') {
      const p = e.p as Touch;
      if (p.mode === 'full' || p.mode === 'range' || p.mode === 'edit' || p.mode === 'write') paths.add(p.path);
    }
  }
  store.append(envelope<CompactPayload>('compact', meta, { paths: [...paths] }));
}

function decideArm(ctx: RepoContext, state: SessionState): void {
  if (state.data.armSet) return;
  const e = ctx.config.sliceEnabled;
  state.data.arm = e === 'on' ? 'on' : e === 'off' ? 'off' : Math.random() < e ? 'on' : 'off';
  state.data.armSet = true;
  state.save();
}

export function readRepoFile(root: string, path: string): string | undefined {
  const abs = toAbsolute(root, path);
  if (!existsSync(abs)) return undefined;
  try { return readFileSync(abs, 'utf8'); } catch { return undefined; }
}

export function rangeOfText(tc: ToolContext, path: string, needle: string | undefined): [number, number] | undefined {
  if (!needle) return undefined;
  const src = tc.readFile(path);
  return src ? lineRangeOf(src, needle) : undefined;
}

function symbolAt(tc: ToolContext, path: string, line: number): string | undefined {
  const src = tc.readFile(path);
  return src ? enclosingSymbol(src, line) : undefined;
}

const TEST_RUN = /\b(vitest|jest|mocha|pytest|npm test|pnpm test|yarn test|go test|cargo test|rspec|phpunit|dotnet test|gradle test|mvn test)\b/;
function looksLikeTestRun(command: string): boolean { return TEST_RUN.test(command); }

/** Harnesses report a shell failure in different shapes; any non-zero exit or error flag counts. */
function commandFailed(response: unknown): boolean {
  if (!response || typeof response !== 'object') return false;
  const r = response as { exit_code?: number; exitCode?: number; is_error?: boolean; isError?: boolean; interrupted?: boolean };
  if (typeof r.exit_code === 'number') return r.exit_code !== 0;
  if (typeof r.exitCode === 'number') return r.exitCode !== 0;
  return r.is_error === true || r.isError === true;
}

/** A short description of what the edit is about, for hint retrieval. */
function intentOf(ti: Record<string, unknown>): string | undefined {
  const candidates = [ti.new_string, ti.content, ti.command, ti.description];
  for (const c of candidates) if (typeof c === 'string' && c.trim()) return c.slice(0, 500);
  return undefined;
}

/** Files and module ids a prompt names outright. Only those: guessing from prose belongs to an explicit hydrate call. */
export function promptScopes(ctx: RepoContext, prompt: string, cwd: string): string[] {
  const g = ctx.graph;
  if (!g) return [];
  const out: string[] = [];
  for (const raw of prompt.split(/[\s,;()"'`]+/)) {
    const tok = raw.replace(/[:.]+$/, '');
    if (!tok) continue;
    if ((tok.startsWith('L:') && g.logicals.has(tok)) || (tok.startsWith('C:') && g.concepts.has(tok))) { if (!out.includes(tok)) out.push(tok); continue; }
    if (!/[\/.]/.test(tok) || /^https?:/.test(tok)) continue;
    const abs = tok.startsWith('/') ? tok : resolve(cwd, tok);
    if (!existsSync(abs) || !statSync(abs).isFile()) continue;
    const rel = toRepoRelative(ctx.root, abs, cwd);
    if (!out.includes(rel)) out.push(rel);
  }
  return out;
}

/** Plain text added to the session at start (design spec §15.1). Small: aliases, modules, how to record. */
export function sessionContext(ctx: RepoContext, injecting: boolean, afterCompact: boolean): string {
  const g = ctx.graph;
  if (!g) {
    return 'Context Graph: observing this session (no graph for this repository, so nothing is injected). Reads, greps, and edits are recorded for coverage.';
  }
  const lines: string[] = [];
  lines.push(
    injecting
      ? `Context Graph is active for this repository${afterCompact ? ' (context was compacted; slices will re-arrive at each edit)' : ''}. A context slice is injected before each file edit made with the edit tools. Before editing a file through the shell, run: ctx slice <path>. Before working on a file, module, or task you have not read this session, call the MCP tool hydrate (shell: ctx hydrate <scope>): it returns the slice, the callers with the lines that use the file, the rules with their decision history, and what this session already holds, in one bounded briefing. When a turn ends with edited files that carry constraints, you will be asked to record one decision per file (MCP tool: record; shell: ctx record).`
      : 'Context Graph: observe-only for this session. Reads and edits are recorded; nothing is injected and no decisions are demanded.',
  );
  const aliases = [...g.aliases.values()];
  if (aliases.length) lines.push('Aliases: ' + aliases.map((a) => `${a.alias} = ${a.node}`).join('; '));
  const modules = [...g.logicals.values()].slice(0, 24).map((l) => `${l.id} (${l.name})`);
  if (modules.length) lines.push('Modules: ' + modules.join('; '));
  const concepts = [...g.concepts.values()].filter((c) => !c.proposed).map((c) => `${c.id} ${c.name}${c.adr ? ` [adr:${c.adr}]` : ''}`);
  if (concepts.length) lines.push('Concepts: ' + concepts.join('; '));
  return lines.join('\n');
}
