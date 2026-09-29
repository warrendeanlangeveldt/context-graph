import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openRepo, type RepoContext } from '../core/context.js';
import { callersOf, loadOrBuildImportIndex } from '../index/imports.js';
import { enclosingSymbol, lineRangeOf } from '../index/symbols.js';
import { cardState, exemptFromCards, renderFileCard } from '../cards/cards.js';
import { checkEdit, describeMissing, type Requirement } from '../enforce/read-before-edit.js';
import { computeCoverage } from '../observe/coverage.js';
import { envelope, isEditMode, type AccessMode, type CardPayload, type CompactPayload, type HistoryPayload, type SessionPayload, type SlicePayload, type Touch } from '../observe/event.js';
import { parseShell } from '../observe/shell.js';
import { ancestorPids } from '../observe/session.js';
import { ObservationStore, SessionState } from '../observe/store.js';
import { Recorder } from '../record/recorder.js';
import { currentBranch, gitPerson } from '../util/git.js';
import { toAbsolute, toRepoRelative } from '../util/paths.js';
import { packageRoot } from '../util/root.js';
import { renderCard } from '../walker/card.js';
import { renderHistory } from '../walker/history.js';
import { renderSlice } from '../walker/slice.js';
import { walk, type WalkResult } from '../walker/walk.js';
import { liveLinesFor, notifyOverlay } from '../overlay/client.js';
import { hintsFor } from '../embed/hints.js';
import { hydrate } from '../hydrate/hydrate.js';
import { factsFor, toolAdapters } from '../tool-adapters/index.js';
import type { Envelope } from '../observe/event.js';

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
  /** The session's working directory, which tool paths are relative to. */
  cwd: string;
  /** Where the harness's shell is right now, which shell commands are relative to. Same as cwd unless the shell keeps state between calls. */
  shellCwd: string;
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
  /** Paths (repo-relative) about to be read by this tool call, for the pre-read decision history. */
  preReadTargets(tool: string, ti: Record<string, unknown>, tc: ToolContext): string[];
  /** Touches implied by a completed tool call. */
  touches(tool: string, ti: Record<string, unknown>, tc: ToolContext): TouchLike[];
  sessionStartReason(input: HookInput): string;
  /** Event that signals compaction is about to happen, if the harness has one distinct from SessionStart. */
  preCompactEvent?: string;
  formatSessionStart(text: string): string;
  formatPreToolUse(context: string): string;
  formatStopBlock(reason: string): string;
  /** Refuse a tool call before it runs, with the reason the model sees. */
  formatPreToolUseDeny(reason: string): string;
  /** The file's text after this edit tool call, when the call carries enough to know it. */
  proposedText?(tool: string, ti: Record<string, unknown>, tc: ToolContext, path: string): string | undefined;
  /** Context added to a user prompt before the model sees it (prompt-time hydrate). */
  formatPromptContext(context: string): string;
}

export async function runHook(input: HookInput, profile: HarnessProfile): Promise<HookOutput> {
  const ctx = openRepo({ cwd: input.cwd });
  const root = ctx.root;
  const session = input.session_id || 'unknown';
  const meta = { session, who: `${gitPerson(root)}/${profile.agent}`, branch: currentBranch(root), harness: profile.id };
  const store = new ObservationStore(root, session);
  // Each agent has its own context window, so its own state: what it has been shown, what it owes.
  const agent = input.agent_id || undefined;
  const state = new SessionState(root, session, agent);
  decideArm(ctx, state);
  if (!agent && !state.data.pids) { state.data.pids = ancestorPids(); state.save(); }
  const injecting = Boolean(ctx.graph) && state.data.arm === 'on';
  const origin: Touch['origin'] = input.agent_id ? 'subagent' : 'main';
  const shellCwd = state.data.shellCwd && existsSync(state.data.shellCwd) ? state.data.shellCwd : input.cwd;
  const tc: ToolContext = {
    root,
    cwd: input.cwd,
    shellCwd,
    shellParsing: ctx.config.shellParsing,
    rel: (p) => toRepoRelative(root, p, input.cwd),
    readFile: (p) => readRepoFile(root, p),
  };
  const isShell = (tool: string): boolean => tool === 'Bash' || tool === 'exec_command' || tool === 'shell';
  // Follow the shell: a harness that resets the directory says so in the tool result; one that keeps it is tracked through cd.
  const followShell = (command: string, response: unknown): void => {
    const said = /Shell cwd was reset to (\S+)/.exec(typeof response === 'string' ? response : JSON.stringify(response ?? ''));
    const next = said ? said[1]!.replace(/[",\\]+$/, '') : parseShell(command, shellCwd, input.cwd).cwd;
    if (next && next !== state.data.shellCwd) { state.data.shellCwd = next; state.save(); }
  };

  const emitTouches = (touches: TouchLike[], tool: string, failed = false, toolUseId?: string): Touch[] => {
    const out: Touch[] = [];
    for (const t of touches) {
      if (t.path === '/dev/null') continue;
      // A path outside the repository is not this codebase's context: keep it as a sighting, never as an edit.
      const outside = t.path.startsWith('/');
      const touch: Touch = { path: t.path, mode: failed ? 'failed' : outside ? 'external' : t.mode, tool, origin };
      if (t.range) touch.range = t.range;
      if (t.unparsed) touch.unparsed = true;
      if (input.agent_id) touch.agent = input.agent_id;
      if (toolUseId) touch.toolUseId = toolUseId;
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

  /**
   * The turn-end demand, for the main session at Stop and for a subagent at SubagentStop: decisions for
   * edited files that carry rules, and cards for edited files, each as configured. Returns the block, or
   * undefined to let the agent finish.
   */
  const turnEnd = (s: SessionState): HookOutput | undefined => {
    if (!injecting || !ctx.graph) return undefined;
    const recorder = new Recorder(ctx.graph, s, root);
    recorder.dropProvisional();
    const cards = ctx.config.enforce.cards;
    if (!ctx.config.demand) {
      // Demand off: the gap is recorded and visible in the view, but the turn is never held open.
      for (const p of recorder.pending()) store.append(envelope('finding', meta, { rule: 'no-decision', message: `${p.path} edited under ${p.constraints.length} rule(s) with no decision recorded`, path: p.path }));
      s.data.pending = {};
      s.save();
    }
    if (cards === 'nudge') {
      for (const path of recorder.cardsOwed()) store.append(envelope('finding', meta, { rule: 'no-card', message: `${path} edited with no card matching it`, path }));
      s.data.cardsOwed = {};
      s.save();
    }
    const verdict = recorder.stopDecision({ maxBlocks: ctx.config.maxBlocks, who: meta.who, branch: meta.branch, decisions: ctx.config.demand, cards: cards === 'block', ...(input.stop_hook_active !== undefined ? { stopHookActive: input.stop_hook_active } : {}) });
    for (const d of verdict.gaveUp) {
      store.append(envelope('decision', meta, d));
      store.append(envelope('finding', meta, { rule: 'no-decision', message: `${d.node}: ${d.text}`, path: d.node }));
    }
    for (const path of verdict.cardsUnwritten) store.append(envelope('finding', meta, { rule: 'no-card', message: `${path} edited and its card never written`, path }));
    return verdict.block ? { stdout: profile.formatStopBlock(verdict.reason ?? ''), exitCode: 0 } : undefined;
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
    if (ctx.graph) { state.data.graphAnnounced = true; state.save(); }
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
    // A subagent owes its own decisions and cards before it hands back, like the main session at Stop.
    if (kind === 'subagent-stop' && agent) {
      const verdict = turnEnd(state);
      if (verdict) return verdict;
    }
    const payload: SessionPayload = { kind, cwd: input.cwd, arm: state.data.arm };
    if (agent) payload.agent = agent;
    if (input.agent_type) payload.agentType = input.agent_type;
    store.append(envelope('session', meta, payload));
    if (agent) {
      const main = new SessionState(root, session);
      if (kind === 'subagent-start') main.data.delegations[agent] = { since: new Date().toISOString(), ...(input.agent_type ? { agentType: input.agent_type } : {}) };
      else delete main.data.delegations[agent];
      main.save();
    }
    return { exitCode: 0 };
  }

  if (event === 'PreToolUse') {
    // Reads are recorded as the call starts. The completion hook runs asynchronously, and an agent that
    // reads a file and edits it next must find its read already on record, or the edit would be refused.
    {
      const tool = input.tool_name ?? '';
      const reads = profile.isEditTool(tool) || !input.tool_use_id ? [] : profile.touches(tool, input.tool_input ?? {}, tc).filter((t) => READ_MODES.has(t.mode));
      if (reads.length) {
        emitTouches(reads, tool, false, input.tool_use_id);
        state.data.readsRecorded = [...(state.data.readsRecorded ?? []), input.tool_use_id!].slice(-100);
        state.save();
      }
    }
    // A graph created after the session started (ctx init mid-session) was never announced; say so once.
    const announce = ctx.graph && !state.data.graphAnnounced ? `Context Graph became active during this session: a graph now exists for this repository.\n${sessionContext(ctx, injecting, false)}` : undefined;
    if (announce) { state.data.graphAnnounced = true; state.save(); }
    if (!injecting || !ctx.graph) return announce ? { stdout: profile.formatPreToolUse(announce), exitCode: 0 } : { exitCode: 0 };
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    const g = ctx.graph;
    const recorder = new Recorder(g, state);
    const slices: string[] = announce ? [announce] : [];
    // A decision owed from an earlier edit is asked for here, on the next tool call, where it costs a few
    // tokens and no interruption. The turn-end block only fires for a turn that ends without one.
    const owed = ctx.config.demand || ctx.config.enforce.cards !== 'off' ? recorder.nudge({ cards: ctx.config.enforce.cards !== 'off' }) : undefined;
    if (owed) slices.push(owed);

    const intent = intentOf(ti);
    const announced = new Set(state.data.modulesAnnounced ?? []);
    const targets = profile.preEditTargets(tool, ti, tc).slice(0, 3).filter((t) => !t.path.startsWith('/') && t.path !== '.');

    // Read before edit: an edit tool call whose file (and, on a miss, its dependencies) is not in this
    // agent's context and has no fresh card is refused, or noted, before it runs.
    if (profile.isEditTool(tool) && targets.length) {
      const e = ctx.config.enforce;
      const modeOf = (r: Requirement['rule']): string => (r === 'read-before-edit' ? e.readBeforeEdit : e.dependencies);
      const rules: Requirement['rule'][] = ['read-before-edit', 'dependencies'];
      if (rules.some((r) => modeOf(r) !== 'off')) {
        const events = store.readAll();
        const index = targets.some((t) => /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/.test(t.path)) ? loadOrBuildImportIndex(root) : undefined;
        const checks = targets.map((t) => {
          const after = profile.proposedText?.(tool, ti, tc, t.path);
          return checkEdit({ graph: g, root, config: ctx.config, events, agent, path: t.path, ...(index ? { index } : {}), ...(after !== undefined ? { after } : {}) });
        });
        const refusal = describeMissing(checks, rules.filter((r) => modeOf(r) === 'block'));
        if (refusal) {
          for (const c of checks) for (const m of c.missing) store.append(envelope('finding', meta, { rule: m.rule, message: `refused edit of ${c.path}: ${m.path} ${m.why}`, path: c.path }));
          return { stdout: profile.formatPreToolUseDeny(refusal), exitCode: 0 };
        }
        const note = describeMissing(checks, rules.filter((r) => modeOf(r) === 'nudge'));
        if (note) slices.push(note);
        for (const c of checks) {
          for (const dep of c.depCards.slice(0, 3)) {
            const r = renderFileCard(dep, cardState(g, root, dep));
            if (r) slices.push(r.text);
          }
        }
      }
    }

    for (const t of targets) {
      const s = await sliceFor(t.path, t.range, intent);
      const card = renderFileCard(t.path, cardState(g, root, t.path), factsFor(root, t.path).lines);
      if (card) slices.push(card.text);
      if (s) { slices.push(s.text); recorder.notePending(s.walk, input.tool_use_id, { provisional: true }); if (s.walk.chain[0]) announced.add(s.walk.chain[0]); }
    }
    // The decision history: the first time this session reads a file that carries decisions, say what was
    // decided there and why, before its text is in context. A wrong model is built by reading, not writing,
    // so this is the read-time half of the pair. Silent for a file with no decisions, once per file.
    const answered = new Set(state.data.filesAnnounced ?? []);
    let histories = 0;
    for (const path of profile.preReadTargets(tool, ti, tc)) {
      if (histories >= 2) break;
      if (path.startsWith('/') || path === '.' || answered.has(path)) continue;
      if (slices.some((t) => t.startsWith(`edit ${g.aliasFor(path) ?? path}`))) continue;
      answered.add(path);
      // What the file is for comes first (its card, and what code-kit knows of it), then what was decided in it.
      const exempt = exemptFromCards(path, ctx.config.cardsExclude);
      const state_ = cardState(g, root, path);
      const card = exempt ? undefined : renderFileCard(path, state_, factsFor(root, path).lines);
      const h = renderHistory(g, path, { root });
      const noCard = !exempt && !state_.card && state_.hash !== undefined && ctx.config.enforce.readBeforeEdit !== 'off'
        ? `file ${path}\n  no card yet: read it in full (no offset or limit) before editing it, and write its card after.`
        : undefined;
      const text = [card?.text ?? noCard, h?.text].filter(Boolean).join('\n');
      if (!text) continue;
      histories++;
      slices.push(text);
      if (h) {
        const payload: HistoryPayload = { path: h.path, decisions: h.decisions, tokens: h.tokens, rendered: h.text };
        const env = envelope('history', meta, payload);
        store.append(env);
        notifyOverlay(ctx, env);
      }
    }
    if (answered.size !== (state.data.filesAnnounced ?? []).length) { state.data.filesAnnounced = [...answered]; state.save(); }

    // The module card: the first time this session reads or greps under a module, say what governs it,
    // before a line of its code is in context. Once per module per session, at most two per call.
    let cards = 0;
    for (const t of profile.touches(tool, ti, tc)) {
      if (cards >= 2) break;
      if (!(t.mode === 'full' || t.mode === 'range' || t.mode === 'grep' || t.mode === 'name') || t.path.startsWith('/')) continue;
      const w = walk(g, walkablePath(root, t.path), { maxDecisions: ctx.config.maxDecisions });
      const mod = w.chain[0];
      if (!mod || announced.has(mod)) continue;
      const card = renderCard(g, w, { maxTokens: Math.min(200, ctx.config.maxTokens) });
      if (!card) continue;
      announced.add(mod);
      cards++;
      slices.push(card.text);
      const payload: CardPayload = { module: mod, path: t.path, tokens: card.tokens, rendered: card.text, dropped: card.dropped };
      const env = envelope('card', meta, payload);
      store.append(env);
      notifyOverlay(ctx, env);
    }
    if (announced.size !== (state.data.modulesAnnounced ?? []).length) { state.data.modulesAnnounced = [...announced]; state.save(); }
    if (!slices.length) return { exitCode: 0 };
    return { stdout: profile.formatPreToolUse(slices.join('\n\n')), exitCode: 0 };
  }

  if (event === 'PostToolUse' || event === 'PostToolUseFailure') {
    const tool = input.tool_name ?? '';
    const ti = input.tool_input ?? {};
    // A shell command that exited non-zero edited nothing we can vouch for, whichever event reported it.
    const failed = event === 'PostToolUseFailure' || (isShell(tool) && commandFailed(input.tool_response));
    const all = profile.touches(tool, ti, tc);
    // Reads recorded when this call started are not recorded again; if the call failed, they are marked failed.
    const early = input.tool_use_id !== undefined && (state.data.readsRecorded ?? []).includes(input.tool_use_id);
    const emitted = emitTouches(early && !failed ? all.filter((t) => !READ_MODES.has(t.mode)) : all, tool, failed, input.tool_use_id);
    if (isShell(tool)) followShell(String(ti.command ?? ''), input.tool_response);
    if (ctx.graph) {
      // Edits noted before the call are real only if it completed; a failed call edited nothing.
      const r = new Recorder(ctx.graph, state, root);
      if (failed) r.dropPendingFrom(input.tool_use_id);
      else r.confirm(input.tool_use_id);
    }
    // A test run that failed is a rework signal the benchmark counts (design spec §20.3).
    if ((tool === 'Bash' || tool === 'exec_command' || tool === 'shell') && looksLikeTestRun(String(ti.command ?? '')) && (failed || commandFailed(input.tool_response))) {
      store.append(envelope('finding', meta, { rule: 'test-failed', message: `test command failed: ${String(ti.command ?? '').slice(0, 160)}` }));
    }
    if (failed || !ctx.graph) return { exitCode: 0 };
    const edits = emitted.filter((t) => isEditMode(t.mode) && !t.path.startsWith('/') && t.path !== '.');
    if (!edits.length) return { exitCode: 0 };
    // Coverage is this agent's: its own reads are in context, anyone else's are delegated.
    const events = asSeenBy(store.readAll(), agent);
    const index = loadOrBuildImportIndex(root);
    const recorder = new Recorder(ctx.graph, state, root);
    for (const e of edits) {
      if (injecting && ctx.config.enforce.cards !== 'off' && e.mode !== 'delete' && !exemptFromCards(e.path, ctx.config.cardsExclude)) recorder.owesCard(e.path);
      const symbol = e.range ? symbolAt(tc, e.path, e.range[0]) : undefined;
      const w = walk(ctx.graph, e.path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
      const injected = events.some((ev) => ev.t === 'slice' && (ev.p as SlicePayload).path === e.path);
      const cov = computeCoverage(events, w, callersOf(index, e.path), injected);
      const env = envelope('coverage', meta, cov);
      store.append(env);
      notifyOverlay(ctx, env);
      if (injecting && !profile.isEditTool(tool)) recorder.notePending(w, input.tool_use_id);
      if (cov.callers_total > 0 && cov.callers_loaded === 0) {
        store.append(envelope('finding', meta, { rule: 'callers-dark', message: `edited ${e.path} with none of its ${cov.callers_total} callers in context`, path: e.path }));
      }
    }
    return { exitCode: 0 };
  }

  if (event === 'Stop') return turnEnd(state) ?? { exitCode: 0 };

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

const READ_MODES: ReadonlySet<AccessMode> = new Set(['full', 'range', 'grep', 'name']);

/** The session's events as one agent's context sees them: its own reads direct, everyone else's delegated. */
function asSeenBy(events: Envelope[], agent: string | undefined): Envelope[] {
  return events.map((e) => {
    if (e.t !== 'touch' && e.t !== 'edit') return e;
    const t = e.p as Touch;
    const mine = (t.agent ?? undefined) === agent;
    const origin: Touch['origin'] = mine ? 'main' : 'subagent';
    return t.origin === origin ? e : { ...e, p: { ...t, origin } };
  });
}

/** A directory maps through a synthetic child, so a grep under `api/src/platform` finds that module; `.` is the root. */
function walkablePath(root: string, p: string): string {
  if (p === '.' || p === '') return '_';
  try { if (statSync(join(root, p)).isDirectory()) return `${p}/_`; } catch { /* a path that does not exist yet walks as itself */ }
  return p;
}

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

let versionCache: string | undefined;
function ctxVersion(): string {
  if (versionCache) return versionCache;
  try { versionCache = (JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: string }).version ?? ''; } catch { versionCache = ''; }
  return versionCache;
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

/** The context loop, in the words an agent needs: what is checked before an edit, and what is owed after it. */
function loopText(ctx: RepoContext): string {
  const e = ctx.config.enforce;
  const parts: string[] = [];
  if (e.readBeforeEdit !== 'off') parts.push(`Before you edit a file, it must be understood: either it has a fresh card (shown when you first read it), or you read it in full (no offset or limit)${e.dependencies !== 'off' ? ', along with the files it imports (or their cards), and, when your edit changes what it exports, the files that import it' : ''}. ${e.readBeforeEdit === 'block' ? 'An edit without that is refused, with the list of what to read.' : 'An edit without that gets a note.'}`);
  if (e.cards !== 'off') parts.push(`After editing a file, write or update its card while it is in your context (MCP tool: card; shell: ctx card <path> --text "..."): what the file is for, what it relies on, who relies on it, and what it must keep true.${e.cards === 'block' ? ' The turn will not end with a card owed.' : ''}`);
  return parts.join(' ');
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
      ? `Context Graph ${ctxVersion()} is active for this repository${afterCompact ? ' (context was compacted; slices will re-arrive at each edit, and files must be read again before editing)' : ''}. ${loopText(ctx)} A context slice is injected before each file edit made with the edit tools. Before editing a file through the shell, run: ctx slice <path>. Before working on a file, module, or task you have not read this session, call the MCP tool hydrate (shell: ctx hydrate <scope>): it returns the slice, the callers with the lines that use the file, the rules with their decision history, and what this session already holds, in one bounded briefing. When a turn ends with edited files that carry constraints, you will be asked to record one decision per file (MCP tool: record; shell: ctx record).`
      : 'Context Graph: observe-only for this session. Reads and edits are recorded; nothing is injected and no decisions are demanded.',
  );
  for (const a of toolAdapters(ctx.root)) { const note = a.sessionNote?.(ctx.root); if (note) lines.push(note); }
  const aliases = [...g.aliases.values()];
  if (aliases.length) lines.push('Aliases: ' + aliases.map((a) => `${a.alias} = ${a.node}`).join('; '));
  const modules = [...g.logicals.values()].slice(0, 24).map((l) => `${l.id} (${l.name})`);
  if (modules.length) lines.push('Modules: ' + modules.join('; '));
  const concepts = [...g.concepts.values()].filter((c) => !c.proposed).map((c) => `${c.id} ${c.name}${c.adr ? ` [adr:${c.adr}]` : ''}`);
  if (concepts.length) lines.push('Concepts: ' + concepts.join('; '));
  return lines.join('\n');
}
