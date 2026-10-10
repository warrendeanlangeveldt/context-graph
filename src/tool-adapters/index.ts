import { codeKitAdapter } from './code-kit.js';

/**
 * Tool adapters: what ctx knows about another tool that shares a repository, kept out of the core. Not to
 * be confused with harness adapters (src/adapters/), which translate one AI harness's events. A tool
 * adapter is detected per checkout and contributes facts about a file that anchor its why: the spec it
 * delivers, who owns it, the rules its layer keeps. The core only calls `toolAdapters()` and the methods
 * below; it never names a tool.
 */
export interface FileFacts {
  /** Lines shown with the file's card before a read or an edit. */
  lines: string[];
  /** Requirement ids the file delivers, carried on its card. */
  requirements: string[];
}

export interface ToolAdapter {
  name: string;
  detect(root: string): boolean;
  /** Facts about a file, or undefined when the tool has nothing to say (or cannot be reached). */
  fileFacts(root: string, path: string): FileFacts | undefined;
  /** One line for the session-start text, saying the tool is present and what that changes. */
  sessionNote?(root: string): string | undefined;
  /** Branches the tool protects, where a person's graph commit must not land. */
  protectedBranches?(root: string): string[];
  /**
   * Records a change the person made to a graph file the tool guards (a harness setting in
   * config.toml), so its log keeps it as theirs. Returns what it recorded, in a sentence, if anything.
   */
  recordPersonsChange?(root: string, change: { file: string; reason: string; via: 'pane' | 'terminal' }): string[];
  /** The plan use at which the tool pauses background agents, when it sets one: it wins over Context Graph's own. */
  pauseAtPercent?(root: string): number | undefined;
  /** Whether the person has paused the tool's own background loop: Context Graph's pauses with it. */
  backgroundPaused?(root: string): boolean;
}

export const TOOL_ADAPTERS: ToolAdapter[] = [codeKitAdapter];

export function toolAdapters(root: string): ToolAdapter[] {
  return TOOL_ADAPTERS.filter((a) => a.detect(root));
}

/** Every active adapter's facts about a file, merged. */
export function factsFor(root: string, path: string): FileFacts {
  const out: FileFacts = { lines: [], requirements: [] };
  for (const a of toolAdapters(root)) {
    const f = a.fileFacts(root, path);
    if (!f) continue;
    out.lines.push(...f.lines);
    for (const r of f.requirements) if (!out.requirements.includes(r)) out.requirements.push(r);
  }
  return out;
}

/** Every active adapter's protected branches. */
export function toolProtectedBranches(root: string): string[] {
  return [...new Set(toolAdapters(root).flatMap((a) => a.protectedBranches?.(root) ?? []))];
}
