import { parseApplyPatch, parsePatchText } from '../../observe/patch.js';
import { parseShellCommand } from '../../observe/shell.js';
import { runHook, type EditTarget, type HarnessProfile, type HookInput, type HookOutput, type ToolContext, type TouchLike } from '../core.js';

/**
 * Codex profile (design spec §15.2). Every edit arrives as `apply_patch` with the patch text in
 * `tool_input.command`; every read arrives as shell through `Bash`. There is no read tool, so the
 * shell observer is the only observation path for reads. Compaction is signalled by `PreCompact`.
 */
export function codexProfile(agent = 'codex'): HarnessProfile {
  return {
    id: 'codex',
    agent,
    isEditTool: (tool) => tool === 'apply_patch' || tool === 'Edit' || tool === 'Write',
    preEditTargets(tool, ti, tc): EditTarget[] {
      if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
        return patchFiles(ti).filter((f) => f.kind !== 'delete').map((f) => ({ path: tc.rel(f.movedTo ?? f.path) }));
      }
      if (tool === 'Bash' && tc.shellParsing) {
        return parseShellCommand(commandOf(ti), tc.shellCwd, tc.cwd)
          .filter((t) => (t.mode === 'edit' || t.mode === 'write') && t.path !== '.')
          .map((t) => ({ path: tc.rel(t.path) }));
      }
      return [];
    },
    preReadTargets(tool, ti, tc): string[] {
      // Codex has no read tool: every read arrives as shell.
      if (tool !== 'Bash' || !tc.shellParsing) return [];
      return parseShellCommand(commandOf(ti), tc.shellCwd, tc.cwd)
        .filter((t) => t.mode === 'full' || t.mode === 'range')
        .map((t) => tc.rel(t.path));
    },
    touches: (tool, ti, tc) => codexTouches(tool, ti, tc),
    sessionStartReason: (input) => input.source ?? input.start_reason ?? 'startup',
    preCompactEvent: 'PreCompact',
    formatSessionStart: (text) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } }),
    formatPreToolUse: (context) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context } }),
    formatStopBlock: (reason) => JSON.stringify({ decision: 'block', reason }),
    formatPromptContext: (context) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
  };
}

function commandOf(ti: Record<string, unknown>): string {
  const c = ti.command;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return String(c ?? '');
}

function patchFiles(ti: Record<string, unknown>): ReturnType<typeof parseApplyPatch> {
  const text = typeof ti.command === 'string' ? ti.command : typeof ti.patch === 'string' ? ti.patch : typeof ti.input === 'string' ? ti.input : '';
  return parsePatchText(text) ?? parseApplyPatch(text);
}

function codexTouches(tool: string, ti: Record<string, unknown>, tc: ToolContext): TouchLike[] {
  if (tool === 'apply_patch' || tool === 'Edit' || tool === 'Write') {
    const out: TouchLike[] = [];
    for (const f of patchFiles(ti)) {
      const mode = f.kind === 'add' ? 'write' : f.kind === 'delete' ? 'delete' : 'edit';
      const path = tc.rel(f.movedTo ?? f.path);
      const first = f.ranges?.[0];
      const last = f.ranges?.[f.ranges.length - 1];
      out.push(first && last ? { path, mode, range: [first[0], last[1]] } : { path, mode });
      if (f.movedTo) out.push({ path: tc.rel(f.path), mode: 'delete' });
    }
    return out;
  }
  if (tool === 'Bash' || tool === 'exec_command' || tool === 'shell') {
    if (!tc.shellParsing) return [];
    return parseShellCommand(commandOf(ti), tc.shellCwd, tc.cwd).map((t) => ({ ...t, path: tc.rel(t.path) }));
  }
  return [];
}

export function runCodexHook(input: HookInput, opts: { agent?: string } = {}): Promise<HookOutput> {
  return runHook(input, codexProfile(opts.agent ?? 'codex'));
}
