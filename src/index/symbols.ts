/**
 * Symbol lookup for JavaScript and TypeScript sources: which top-level declaration encloses a
 * line, and where a substring sits. Brace-counting with string and comment stripping; it is an
 * approximation that is right for ordinary code and says nothing rather than guessing otherwise.
 */

const DECL_RE = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/;

interface Span { name: string; start: number; end: number }

export function topLevelSymbols(source: string): Span[] {
  const spans: Span[] = [];
  const lines = source.split(/\r?\n/);
  let depth = 0;
  let open: Span | undefined;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    let code = raw;
    if (inBlockComment) {
      const end = code.indexOf('*/');
      if (end < 0) continue;
      code = code.slice(end + 2);
      inBlockComment = false;
    }
    code = stripStringsAndComments(code);
    if (code.includes('/*') && !code.includes('*/')) { inBlockComment = true; code = code.slice(0, code.indexOf('/*')); }

    if (depth === 0) {
      if (open && open.end === -1) { open.end = i; open = undefined; }
      const m = DECL_RE.exec(raw.trimStart());
      if (m) {
        open = { name: m[1]!, start: i + 1, end: -1 };
        spans.push(open);
      }
    }
    for (const ch of code) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    if (open && open.end === -1 && depth === 0) {
      open.end = i + 1;
      open = undefined;
    }
  }
  if (open && open.end === -1) open.end = lines.length;
  return spans;
}

export function enclosingSymbol(source: string, line: number): string | undefined {
  for (const s of topLevelSymbols(source)) if (line >= s.start && line <= s.end) return s.name;
  return undefined;
}

/** 1-based first and last line of the first occurrence of `needle`, or undefined. */
export function lineRangeOf(source: string, needle: string): [number, number] | undefined {
  if (!needle) return undefined;
  const at = source.indexOf(needle);
  if (at < 0) return undefined;
  const start = source.slice(0, at).split('\n').length;
  const end = start + needle.split('\n').length - 1;
  return [start, end];
}

function stripStringsAndComments(line: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '/' && line[i + 1] === '/') break;
    out += ch;
  }
  return out;
}
