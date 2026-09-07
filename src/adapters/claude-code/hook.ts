import { existsSync, readFileSync } from 'node:fs';
import { openRepo, type RepoContext } from '../../core/context.js';
import { callersOf, loadOrBuildImportIndex } from '../../index/imports.js';
import { enclosingSymbol, lineRangeOf } from '../../index/symbols.js';
import { computeCoverage } from '../../observe/coverage.js';
import { envelope, isEditMode, type AccessMode, type CompactPayload, type SessionPayload, type SlicePayload, type Touch } from '../../observe/event.js';
import { parseShellCommand } from '../../observe/shell.js';
import { ObservationStore, SessionState } from '../../observe/store.js';
import { Recorder } from '../../record/recorder.js';
import { currentBranch, gitPerson } from '../../util/git.js';
import { toAbsolute, toRepoRelative } from '../../util/paths.js';
import { renderSlice } from '../../walker/slice.js';
import { walk, type WalkResult } from '../../walker/walk.js';

/**
 * Claude Code hook adapter (design spec §15.1). One entrypoint; `hook_event_name` selects the
 * handler. Reads the hook JSON, writes the hook response, never throws into the session.
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
}

export interface HookOutput {
  stdout?: string;
  exitCode: number;
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function runClaudeHook(input: HookInput, opts: { agent?: string } = {}): HookOutput {
  const agent = opts.agent ?? 'claude';
  const ctx = openRepo({ cwd: input.cwd });
  const root = ctx.root;
  const session = input.session_id || 'unknown';
  const meta = { session, who: `${gitPerson(root)}/${agent}`, branch: currentBranch(root), harness: 'claude-code' };
  const store = new ObservationStore(root, session);
  const state = new SessionState(root, session);
  decideArm(ctx, state);
  const injecting = Boolean(ctx.graph) && state.data.arm === 'on';
  const origin: Touch['origin'] = input.agent_id ? 'subagent' : 'main';
  const rel = (p: string): string => toRepoRelative(root, p, input.cwd);

  const emitTouches = (touches: { path: string; mode: AccessMode; range?: [number, number]; unparsed?: boolean }[], tool: string, failed = false): Touch[] => {
    const out: Touch[] = [];
    for (const t of touches) {
      const touch: Touch = { path: t.path, mode: failed ? 'failed' : t.mode, tool, origin };
      if (t.range) touch.range = t.range;
      if (t.unparsed) touch.unparsed = true;
      if (input.agent_id) touch.agent = input.agent_id;
      store.append(envelope(isEditMode(touch.mode) ? 'edit' : 'touch', meta, touch));
      out.push(touch);
    }
    return out;
  };

  const sliceFor = (path: string, range?: [number, number]): { text: string; walk: WalkResult } | undefined => {
    if (!ctx.graph) return undefined;
    const symbol = range ? symbolAt(root, path, range[0]) : undefined;
    const w = walk(ctx.graph, path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
    const s = renderSlice(ctx.graph, w, { maxTokens: ctx.config.maxTokens });
    const payload: SlicePayload = { path, applicable: s.applicable, tokens: s.tokens, rendered: s.text, dropped: s.dropped };
    store.append(envelope('slice', meta, payload));
    for (const warning of s.warnings) store.append(envelope('finding', meta, { rule: 'slice-budget', message: warning, path }));
    return { text: s.text, walk: w };
  };

  switch (input.hook_event_name) {
    case 'SessionStart': {
      const reason = input.start_reason ?? input.source ?? 'startup';
      if (reason === 'compact') {
        const paths = new Set<string>();
        for (const e of store.readAll()) {
          if ((e.t === 'touch' || e.t === 'edit') && (e.p as Touch).origin === 'main') {
            const p = e.p as Touch;
            if (p.mode === 'full' || p.mode === 'range' || p.mode === 'edit' || p.mode === 'write') paths.add(p.path);
          }
        }
        store.append(envelope<CompactPayload>('compact', meta, { paths: [...paths] }));
      } else {
        const payload: SessionPayload = { kind: 'start', cwd: input.cwd, arm: state.data.arm, reason };
        store.append(envelope('session', meta, payload));
      }
      return { stdout: sessionContext(ctx, injecting, reason === 'compact'), exitCode: 0 };
    }

    case 'SessionEnd': {
      const payload: SessionPayload = { kind: 'end', cwd: input.cwd, arm: state.data.arm };
      if (input.end_reason) payload.reason = input.end_reason;
      store.append(envelope('session', meta, payload));
      return { exitCode: 0 };
    }

    case 'SubagentStart':
    case 'SubagentStop': {
      const kind = input.hook_event_name === 'SubagentStart' ? 'subagent-start' : 'subagent-stop';
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

    case 'PreToolUse': {
      if (!injecting || !ctx.graph) return { exitCode: 0 };
      const tool = input.tool_name ?? '';
      const ti = input.tool_input ?? {};
      const slices: string[] = [];
      const recorder = new Recorder(ctx.graph, state);
      if (EDIT_TOOLS.has(tool)) {
        const raw = (ti.file_path ?? ti.notebook_path) as string | undefined;
        if (!raw) return { exitCode: 0 };
        const path = rel(raw);
        const range = tool === 'Edit' ? rangeOfOldString(root, path, ti.old_string as string | undefined) : undefined;
        const s = sliceFor(path, range);
        if (s) { slices.push(s.text); recorder.notePending(s.walk); }
      } else if (tool === 'Bash' && ctx.config.shellParsing) {
        const command = String(ti.command ?? '');
        const targets = parseShellCommand(command, input.cwd).filter((t) => isEditMode(t.mode) && t.path !== '.');
        for (const t of targets.slice(0, 3)) {
          const path = rel(t.path);
          if (path.startsWith('/')) continue;
          const s = sliceFor(path);
          if (s) { slices.push(s.text); recorder.notePending(s.walk); }
        }
      }
      if (!slices.length) return { exitCode: 0 };
      const out = { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: slices.join('\n\n') } };
      return { stdout: JSON.stringify(out), exitCode: 0 };
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = input.hook_event_name === 'PostToolUseFailure';
      const tool = input.tool_name ?? '';
      const ti = input.tool_input ?? {};
      const touches = touchesForTool(tool, ti, root, input.cwd, ctx.config.shellParsing);
      const emitted = emitTouches(touches, tool, failed);
      if (failed || !ctx.graph) return { exitCode: 0 };
      const edits = emitted.filter((t) => isEditMode(t.mode) && t.origin === 'main' && !t.path.startsWith('/'));
      if (!edits.length) return { exitCode: 0 };
      const events = store.readAll();
      const index = loadOrBuildImportIndex(root);
      const recorder = new Recorder(ctx.graph, state);
      for (const e of edits) {
        const symbol = e.range ? symbolAt(root, e.path, e.range[0]) : undefined;
        const w = walk(ctx.graph, e.path, { maxDecisions: ctx.config.maxDecisions, ...(symbol ? { symbol } : {}) });
        const injected = events.some((ev) => ev.t === 'slice' && (ev.p as SlicePayload).path === e.path);
        const cov = computeCoverage(events, w, callersOf(index, e.path), injected);
        store.append(envelope('coverage', meta, cov));
        if (injecting && !EDIT_TOOLS.has(tool)) recorder.notePending(w);
        if (cov.callers_total > 0 && cov.callers_loaded === 0) {
          store.append(envelope('finding', meta, { rule: 'callers-dark', message: `edited ${e.path} with none of its ${cov.callers_total} callers in context`, path: e.path }));
        }
      }
      return { exitCode: 0 };
    }

    case 'Stop': {
      if (!injecting || !ctx.graph) return { exitCode: 0 };
      const recorder = new Recorder(ctx.graph, state);
      const verdict = recorder.stopDecision({ maxBlocks: ctx.config.maxBlocks, who: meta.who, branch: meta.branch, ...(input.stop_hook_active !== undefined ? { stopHookActive: input.stop_hook_active } : {}) });
      for (const d of verdict.gaveUp) {
        store.append(envelope('decision', meta, d));
        store.append(envelope('finding', meta, { rule: 'no-decision', message: `${d.node}: ${d.text}`, path: d.node }));
      }
      if (verdict.block) return { stdout: JSON.stringify({ decision: 'block', reason: verdict.reason }), exitCode: 0 };
      return { exitCode: 0 };
    }

    default:
      return { exitCode: 0 };
  }
}

// ---- helpers ------------------------------------------------------------------

function decideArm(ctx: RepoContext, state: SessionState): void {
  if (state.data.armSet) return;
  const e = ctx.config.sliceEnabled;
  state.data.arm = e === 'on' ? 'on' : e === 'off' ? 'off' : Math.random() < e ? 'on' : 'off';
  state.data.armSet = true;
  state.save();
}

function touchesForTool(tool: string, ti: Record<string, unknown>, root: string, cwd: string, shellParsing: boolean): { path: string; mode: AccessMode; range?: [number, number]; unparsed?: boolean }[] {
  const rel = (p: string): string => toRepoRelative(root, p, cwd);
  switch (tool) {
    case 'Read': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const offset = ti.offset as number | undefined;
      const limit = ti.limit as number | undefined;
      if (offset === undefined && limit === undefined) return [{ path: rel(fp), mode: 'full' }];
      const start = offset ?? 1;
      const end = limit === undefined ? -1 : start + limit - 1;
      return [{ path: rel(fp), mode: 'range', range: [start, end] }];
    }
    case 'Grep': return [{ path: rel((ti.path as string | undefined) ?? cwd), mode: 'grep' }];
    case 'Glob': return [{ path: rel((ti.path as string | undefined) ?? cwd), mode: 'name' }];
    case 'Bash': {
      if (!shellParsing) return [];
      return parseShellCommand(String(ti.command ?? ''), cwd).map((t) => ({ ...t, path: rel(t.path) }));
    }
    case 'Edit': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const path = rel(fp);
      const range = rangeOfNewString(root, path, ti.new_string as string | undefined);
      return [range ? { path, mode: 'edit', range } : { path, mode: 'edit' }];
    }
    case 'MultiEdit': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const path = rel(fp);
      const edits = (ti.edits as { new_string?: string }[] | undefined) ?? [];
      let lo = Infinity, hi = -Infinity;
      for (const e of edits) {
        const r = rangeOfNewString(root, path, e.new_string);
        if (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); }
      }
      return [Number.isFinite(lo) ? { path, mode: 'edit', range: [lo, hi] } : { path, mode: 'edit' }];
    }
    case 'Write': {
      const fp = ti.file_path as string | undefined;
      return fp ? [{ path: rel(fp), mode: 'write' }] : [];
    }
    case 'NotebookEdit': {
      const fp = ti.notebook_path as string | undefined;
      return fp ? [{ path: rel(fp), mode: 'edit' }] : [];
    }
    default: return [];
  }
}

function readFile(root: string, path: string): string | undefined {
  const abs = toAbsolute(root, path);
  if (!existsSync(abs)) return undefined;
  try { return readFileSync(abs, 'utf8'); } catch { return undefined; }
}

function rangeOfOldString(root: string, path: string, oldString: string | undefined): [number, number] | undefined {
  if (!oldString) return undefined;
  const src = readFile(root, path);
  return src ? lineRangeOf(src, oldString) : undefined;
}

function rangeOfNewString(root: string, path: string, newString: string | undefined): [number, number] | undefined {
  if (!newString) return undefined;
  const src = readFile(root, path);
  return src ? lineRangeOf(src, newString) : undefined;
}

function symbolAt(root: string, path: string, line: number): string | undefined {
  const src = readFile(root, path);
  return src ? enclosingSymbol(src, line) : undefined;
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
      ? `Context Graph is active for this repository${afterCompact ? ' (context was compacted; slices will re-arrive at each edit)' : ''}. A context slice is injected before each file edit made with the edit tools. Before editing a file through the shell, run: ctx slice <path>. When a turn ends with edited files that carry constraints, you will be asked to record one decision per file (MCP tool: record; shell: ctx record).`
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
