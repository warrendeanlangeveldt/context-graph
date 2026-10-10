/**
 * Shell commands that are the person's own acts on the graph: ratifying with a commit, dropping a
 * proposal, and changing the harness settings. The hooks refuse them from every agent. Only a command in
 * command position counts (the start of the command or of a segment after `;`, `&&`, `||`, `|`, a
 * newline, a parenthesis or a backtick), and heredoc bodies and quoted text are data, not commands: a
 * commit message or a document that mentions one isn't refused. Kept apart from present.ts so the hook
 * path, which runs on every tool call, loads nothing else.
 */
const CTX = String.raw`(?:ctx|node\s+["']?[^\s"']*ctx\.mjs["']?|npx\s+(?:--yes\s+)?@warren-dean/context-graph(?:@\S+)?)`;
const ACT = new RegExp(String.raw`^\s*${CTX}\s+(?:ratify\b[^;&|\n]*\s--commit\b|drop\b|settings\s+set\b)`);

/** The command with each heredoc's body taken out: the lines after `<<WORD` up to the line `WORD`. */
function withoutHeredocs(command: string): string {
  const out: string[] = [];
  let until: string | null = null;
  for (const line of command.split('\n')) {
    if (until) {
      if (line.trim() === until) until = null;
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<-?\s*(['"]?)([\w.-]+)\1(?!<)/.exec(line);
    if (m && !line.includes('<<<')) until = m[2]!;
  }
  return out.join('\n');
}

/** The simple commands a shell line runs, each from its own start: split where the shell would, outside quotes. */
function segments(command: string): string[] {
  const text = withoutHeredocs(command);
  const out: string[] = [];
  let start = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (/[;&|\n()`]/.test(c)) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

export function isPersonsGraphAct(command: string): boolean {
  return segments(command).some((s) => ACT.test(s));
}
