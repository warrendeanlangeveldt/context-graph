import { parseShellCommand } from '../../observe/shell.js';
import { rangeOfText, runHook, type EditTarget, type HarnessProfile, type HookInput, type HookOutput, type ToolContext, type TouchLike } from '../core.js';

export type { HookInput, HookOutput } from '../core.js';
export { sessionContext } from '../core.js';

/**
 * Claude Code profile (design spec §15.1). Edits arrive through Edit, Write, MultiEdit, and
 * NotebookEdit with explicit paths; reads through Read, Grep, Glob, and Bash.
 */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function claudeProfile(agent = 'claude'): HarnessProfile {
  return {
    id: 'claude-code',
    agent,
    isEditTool: (tool) => EDIT_TOOLS.has(tool),
    preEditTargets(tool, ti, tc): EditTarget[] {
      if (EDIT_TOOLS.has(tool)) {
        const raw = (ti.file_path ?? ti.notebook_path) as string | undefined;
        if (!raw) return [];
        const path = tc.rel(raw);
        const range = tool === 'Edit' ? rangeOfText(tc, path, ti.old_string as string | undefined) : undefined;
        return [range ? { path, range } : { path }];
      }
      if (tool === 'Bash' && tc.shellParsing) {
        return parseShellCommand(String(ti.command ?? ''), tc.cwd)
          .filter((t) => (t.mode === 'edit' || t.mode === 'write') && t.path !== '.')
          .map((t) => ({ path: tc.rel(t.path) }));
      }
      return [];
    },
    touches: (tool, ti, tc) => claudeTouches(tool, ti, tc),
    sessionStartReason: (input) => input.start_reason ?? input.source ?? 'startup',
    formatSessionStart: (text) => text,
    formatPreToolUse: (context) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }),
    formatStopBlock: (reason) => JSON.stringify({ decision: 'block', reason }),
  };
}

function claudeTouches(tool: string, ti: Record<string, unknown>, tc: ToolContext): TouchLike[] {
  switch (tool) {
    case 'Read': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const offset = ti.offset as number | undefined;
      const limit = ti.limit as number | undefined;
      if (offset === undefined && limit === undefined) return [{ path: tc.rel(fp), mode: 'full' }];
      const start = offset ?? 1;
      const end = limit === undefined ? -1 : start + limit - 1;
      return [{ path: tc.rel(fp), mode: 'range', range: [start, end] }];
    }
    case 'Grep': return [{ path: tc.rel((ti.path as string | undefined) ?? tc.cwd), mode: 'grep' }];
    case 'Glob': return [{ path: tc.rel((ti.path as string | undefined) ?? tc.cwd), mode: 'name' }];
    case 'Bash':
      if (!tc.shellParsing) return [];
      return parseShellCommand(String(ti.command ?? ''), tc.cwd).map((t) => ({ ...t, path: tc.rel(t.path) }));
    case 'Edit': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const path = tc.rel(fp);
      const range = rangeOfText(tc, path, ti.new_string as string | undefined);
      return [range ? { path, mode: 'edit', range } : { path, mode: 'edit' }];
    }
    case 'MultiEdit': {
      const fp = ti.file_path as string | undefined;
      if (!fp) return [];
      const path = tc.rel(fp);
      const edits = (ti.edits as { new_string?: string }[] | undefined) ?? [];
      let lo = Infinity, hi = -Infinity;
      for (const e of edits) {
        const r = rangeOfText(tc, path, e.new_string);
        if (r) { lo = Math.min(lo, r[0]); hi = Math.max(hi, r[1]); }
      }
      return [Number.isFinite(lo) ? { path, mode: 'edit', range: [lo, hi] } : { path, mode: 'edit' }];
    }
    case 'Write': {
      const fp = ti.file_path as string | undefined;
      return fp ? [{ path: tc.rel(fp), mode: 'write' }] : [];
    }
    case 'NotebookEdit': {
      const fp = ti.notebook_path as string | undefined;
      return fp ? [{ path: tc.rel(fp), mode: 'edit' }] : [];
    }
    default: return [];
  }
}

export function runClaudeHook(input: HookInput, opts: { agent?: string } = {}): Promise<HookOutput> {
  return runHook(input, claudeProfile(opts.agent ?? 'claude'));
}
