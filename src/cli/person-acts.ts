/**
 * Shell commands that are the person's own acts on the graph: ratifying with a commit, and dropping a
 * proposal. The hooks refuse them from every agent. Only a command in command position counts (the start
 * of the command or of a segment after `;`, `&&`, `||`, `|` or a newline), so text that merely mentions
 * them, such as documentation written through a heredoc, does not. Kept apart from present.ts so the
 * hook path, which runs on every tool call, loads nothing else.
 */
const CTX = String.raw`(?:ctx|node\s+["']?[^\s"']*ctx\.mjs["']?|npx\s+(?:--yes\s+)?@warren-dean/context-graph(?:@\S+)?)`;
const ACT = new RegExp(String.raw`(?:^|[;&|\n]\s*)${CTX}\s+(?:ratify\b[^;&|\n]*\s--commit\b|drop\b)`);

export function isPersonsGraphAct(command: string): boolean {
  return ACT.test(command.trimStart());
}
