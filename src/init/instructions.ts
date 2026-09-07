import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The instruction block a repository's agent instructions should carry. The hooks push the floor;
 * this is what makes an agent pull the rest before it starts reading code. It sits in the
 * instruction file because that is re-read every turn, where a session-start note is read once.
 */
export const INSTRUCTION_HEADING = '## Context Graph';

export const INSTRUCTION_BLOCK = `${INSTRUCTION_HEADING}

Before working in a module you have not read this session, call the \`hydrate\` MCP tool with the file or module id (shell: \`ctx hydrate <scope>\`). It returns the rules in force with their history, the callers with the lines that use the file, and what this session already holds. Before editing a file through the shell, run \`ctx slice <path>\` first. When a turn ends owing a decision, record it with the \`record\` tool: what you did and why, pointing at the rule or concept it serves.
`;

const CANDIDATES = ['AGENTS.md', 'CLAUDE.md'];

export interface InstructionResult { file?: string; status: 'appended' | 'present' | 'missing' }

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
    if (text.includes(INSTRUCTION_HEADING)) return { file: name, status: 'present' };
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    writeFileSync(lstatSync(file).isSymbolicLink() ? real : file, `${text}${sep}${INSTRUCTION_BLOCK}`, 'utf8');
    return { file: name, status: 'appended' };
  }
  return { status: 'missing' };
}
