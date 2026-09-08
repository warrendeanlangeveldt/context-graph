import type { ShellTouch } from './shell.js';
import { isPathLike } from './shell.js';

/**
 * Touches implied by a script an interpreter reads from a heredoc or an inline argument. In an
 * agent's shell this is the standard way to make a precise multi-line edit (`python3 - <<'PY'`),
 * so leaving it unobserved made a day of edits look like a clean session. The body is not parsed
 * as a language; it is scanned for path literals and for the calls that read, write, or delete
 * them, with one level of variable resolution. What cannot be attributed is still recorded as an
 * unparsed touch on `.`, so coverage says unknown rather than nothing.
 */
export type ScriptLang = 'python' | 'js' | 'other';

const LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

export function scriptTouches(body: string, lang: ScriptLang, opts: { heredoc?: boolean } = {}): ShellTouch[] {
  const vars = new Map<string, string>();

  // 1. Path-like literals, minus module specifiers, URLs, globs, and format strings.
  const literals: { text: string; index: number }[] = [];
  for (const m of body.matchAll(LITERAL)) {
    const text = m[2]!;
    const before = body.slice(Math.max(0, m.index! - 12), m.index!);
    if (/(?:from\s*|require\(\s*|import\(\s*|import\s+)$/.test(before)) continue;
    if (!isPathLike(text) || /\s|[*?{}%]|^https?:/.test(text) || text.startsWith('./') && !/\.[a-z]+$/i.test(text) && !text.includes('/', 2)) continue;
    literals.push({ text, index: m.index! });
  }

  // 2. Variables bound to a literal: p = 'x', const p = 'x', p = Path('x').
  const assign = lang === 'python'
    ? /(?:^|[;\n])\s*([A-Za-z_]\w*)\s*=\s*(?:Path\(\s*)?(['"])([^'"\n]+)\2/g
    : /(?:^|[;\n])\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*=\s*(['"`])([^'"`\n]+)\2/g;
  for (const m of body.matchAll(assign)) if (isPathLike(m[3]!)) vars.set(m[1]!, m[3]!);
  const resolve = (arg: string): string | undefined => {
    const t = arg.trim();
    const lit = /^(['"`])(.*)\1$/.exec(t);
    if (lit) return isPathLike(lit[2]!) ? lit[2] : undefined;
    const inner = /^Path\(\s*(.+?)\s*\)$/.exec(t);
    if (inner) return resolve(inner[1]!);
    return vars.get(t);
  };

  // 3. Calls that read, write, or delete a path. ARG is a literal, an identifier, or Path(...).
  const ARG = String.raw`(Path\(\s*(?:['"\`][^'"\`\n]+['"\`]|[A-Za-z_$][\w$.]*)\s*\)|['"\`][^'"\`\n]+['"\`]|[A-Za-z_$][\w$.]*)`;
  const patterns: { re: RegExp; mode: 'read' | 'write' | 'delete' }[] = lang === 'python'
    ? [
        { re: new RegExp(String.raw`\bopen\(\s*${ARG}\s*,\s*(?:mode\s*=\s*)?['"][wax]`, 'g'), mode: 'write' },
        { re: new RegExp(String.raw`\bopen\(\s*${ARG}\s*(?:\)|,\s*(?:mode\s*=\s*)?['"]r)`, 'g'), mode: 'read' },
        { re: new RegExp(String.raw`${ARG}\.write_(?:text|bytes)\(`, 'g'), mode: 'write' },
        { re: new RegExp(String.raw`${ARG}\.read_(?:text|bytes)\(`, 'g'), mode: 'read' },
        { re: new RegExp(String.raw`\bos\.(?:remove|unlink)\(\s*${ARG}`, 'g'), mode: 'delete' },
        { re: new RegExp(String.raw`${ARG}\.unlink\(`, 'g'), mode: 'delete' },
        { re: new RegExp(String.raw`\bshutil\.copy\w*\([^,]+,\s*${ARG}`, 'g'), mode: 'write' },
      ]
    : lang === 'js'
      ? [
          { re: new RegExp(String.raw`\b(?:writeFileSync|writeFile|appendFileSync|appendFile|mkdirSync)\(\s*${ARG}`, 'g'), mode: 'write' },
          { re: new RegExp(String.raw`\b(?:readFileSync|readFile)\(\s*${ARG}`, 'g'), mode: 'read' },
          { re: new RegExp(String.raw`\b(?:unlinkSync|unlink|rmSync|rm)\(\s*${ARG}`, 'g'), mode: 'delete' },
          { re: new RegExp(String.raw`\bcopyFileSync\([^,]+,\s*${ARG}`, 'g'), mode: 'write' },
        ]
      : [
          { re: new RegExp(String.raw`\b(?:File\.(?:write|open)|open|fopen)\(\s*${ARG}\s*,\s*['"][wa]`, 'g'), mode: 'write' },
          { re: new RegExp(String.raw`\b(?:File\.read|open|fopen)\(\s*${ARG}`, 'g'), mode: 'read' },
        ];
  const reads = new Set<string>();
  const writes = new Set<string>();
  const deletes = new Set<string>();
  for (const { re, mode } of patterns) {
    for (const m of body.matchAll(re)) {
      const p = resolve(m[1]!);
      if (!p) continue;
      (mode === 'read' ? reads : mode === 'write' ? writes : deletes).add(p);
    }
  }

  const out: ShellTouch[] = [];
  const done = new Set<string>();
  for (const p of deletes) { out.push({ path: p, mode: 'delete' }); done.add(p); }
  for (const p of writes) { if (done.has(p)) continue; out.push({ path: p, mode: reads.has(p) ? 'edit' : 'write' }); done.add(p); }
  for (const p of reads) { if (done.has(p)) continue; out.push({ path: p, mode: 'full' }); done.add(p); }
  // A literal seen but never passed to a call the scanner knows: a sighting, marked as such.
  for (const l of literals) { if (done.has(l.text)) continue; out.push({ path: l.text, mode: 'name', unparsed: true }); done.add(l.text); }

  if (!out.length) {
    const writes = /\bopen\([^)]*['"][wax]|writeFile|appendFile|write_(?:text|bytes)|\.write\(|shutil\.copy|fopen\([^)]*['"][wa]/.test(body);
    // A heredoc script always ran something; an inline one-liner with no path and no write is nothing to record.
    if (writes || opts.heredoc || body.includes('\n')) out.push({ path: '.', mode: writes ? 'edit' : 'name', unparsed: true });
  }
  return out;
}

/** Which scanner a command name implies, if it is an interpreter that runs a script it is given. */
export function interpreterLang(cmd: string): ScriptLang | 'shell' | undefined {
  if (/^(python|python3|python2|pypy|pypy3)$/.test(cmd)) return 'python';
  if (/^(node|nodejs|deno|bun|tsx|ts-node)$/.test(cmd)) return 'js';
  if (/^(sh|bash|zsh|dash|ksh)$/.test(cmd)) return 'shell';
  if (/^(ruby|perl|php)$/.test(cmd)) return 'other';
  return undefined;
}
