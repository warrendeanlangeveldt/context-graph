import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The instruction block a repository's agent instructions should carry. The hooks push the floor;
 * this is what makes an agent pull the rest before it starts reading code. It sits in the
 * instruction file because that is re-read every turn, where a session-start note is read once.
 */
export const INSTRUCTION_HEADING = '## Context Graph';

export const INSTRUCTION_BLOCK = `${INSTRUCTION_HEADING}

Before working in a module you have not read this session, call the \`hydrate\` MCP tool with the file or module id (shell: \`ctx hydrate <scope>\`). It returns each file's card (why the file exists), the rules in force with their history, the callers with the lines that use the file, and what this session already holds. Before editing a file through the shell, run \`ctx slice <path>\` first.

Before you edit a file, understand it: through its fresh card, or by reading it in full along with what it imports (and, when you change its exports, what imports it). An edit without that, through the edit tools or a shell script that writes the file, is refused with the list of what to read. After the edit, the file's card is brought up to date: by Context Graph's card writer in the background, from the file, its diff and your commit messages (so say why in them), unless the session start says this project has you write it yourself with the \`card\` tool (shell: \`ctx card <path> --text "..."\`). When a turn ends owing a decision, record it with the \`record\` tool: what you did and why, pointing at the rule or concept it serves. When unsure what Context Graph needs next, run \`ctx next\`.
`;

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];

/** Where the Context Graph block sits in an instruction file's text: [start, end), or null. */
function blockSpan(text: string): [number, number] | null {
  const start = text.indexOf(INSTRUCTION_HEADING);
  if (start < 0) return null;
  const after = text.slice(start + INSTRUCTION_HEADING.length);
  const next = after.search(/\n#{1,2} /);
  return [start, next < 0 ? text.length : start + INSTRUCTION_HEADING.length + next + 1];
}

/** Whether an instruction file's text carries the block as it is now, an older one, or none. */
export function instructionBlockState(text: string): 'current' | 'outdated' | 'missing' {
  const span = blockSpan(text);
  if (!span) return 'missing';
  return text.slice(span[0], span[1]).trimEnd() === INSTRUCTION_BLOCK.trimEnd() ? 'current' : 'outdated';
}

export interface InstructionResult { file?: string; status: 'appended' | 'updated' | 'present' | 'missing' }

/** Append the block to the repository's instruction file, once. AGENTS.md first; CLAUDE.md when that is what exists. */
export function appendInstructionBlock(root: string): InstructionResult {
  const seen = new Set<string>();
  for (const name of CANDIDATES) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    let real = file;
    try { real = realpathSync(file); } catch { /* keep */ }
    if (seen.has(real)) continue;
    seen.add(real);
    const text = readFileSync(file, 'utf8');
    if (text.includes(INSTRUCTION_HEADING)) {
      // An older block is brought up to date in place: agents re-read this file every turn, so a block
      // that says something the hooks no longer do misleads every one of them.
      if (instructionBlockState(text) === 'current') return { file: name, status: 'present' };
      const [start, end] = blockSpan(text)!;
      const updated = `${text.slice(0, start)}${INSTRUCTION_BLOCK}${end < text.length ? '\n' : ''}${text.slice(end)}`;
      writeFileSync(lstatSync(file).isSymbolicLink() ? real : file, updated, 'utf8');
      return { file: name, status: 'updated' };
    }
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(lstatSync(file).isSymbolicLink() ? real : file, `${text}${sep}${INSTRUCTION_BLOCK}`, 'utf8');
    return { file: name, status: 'appended' };
  }
  return { status: 'missing' };
}
