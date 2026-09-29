import type {
  ARecord, CRecord, ConstraintMode, DRecord, ERecord, GraphRecord, KRecord, LRecord, MRecord,
  RRecord, Relation, SRecord, ZRecord, FRecord,
} from './records.js';

export class ParseError extends Error {
  constructor(public readonly file: string | undefined, public readonly line: number, message: string) {
    super(`${file ?? '<memory>'}:${line}: ${message}`);
  }
}

const MODES: ReadonlySet<string> = new Set(['E', 'G', 'R', 'G?']);
const RELATIONS: ReadonlySet<string> = new Set(['in', 'impl', 'dep']);

/** Parse one line. Returns null for blank lines and comments. */
export function parseLine(raw: string, line: number, file?: string): GraphRecord | null {
  const text = raw.replace(/\s+$/, '');
  if (!text.trim() || text.trimStart().startsWith('#')) return null;
  const tokens = text.trim().split(/\s+/);
  const kind = tokens[0]!;
  const rest = tokens.slice(1);
  const fail = (msg: string): never => { throw new ParseError(file, line, msg); };
  const need = (n: number, what: string): void => { if (rest.length < n) fail(`${kind} record needs ${what}`); };
  const base = file === undefined ? { line } : { line, file };

  switch (kind) {
    case 'M': {
      need(2, '<glob> <logical-id>');
      const r: MRecord = { kind: 'M', glob: rest[0]!, logical: rest[1]!, ...base };
      if (!r.logical.startsWith('L:')) fail(`mapping target must be a logical id (L:...), got ${r.logical}`);
      return r;
    }
    case 'L': {
      need(2, '<logical-id> <name>');
      const r: LRecord = { kind: 'L', id: rest[0]!, name: rest.slice(1).join(' '), ...base };
      if (!r.id.startsWith('L:')) fail(`logical id must start with L:, got ${r.id}`);
      return r;
    }
    case 'C': {
      need(2, '<concept-id> <name>');
      const id = rest[0]!;
      if (!id.startsWith('C:')) fail(`concept id must start with C:, got ${id}`);
      const { words, adr, proposed, since } = takeTrailing(rest.slice(1));
      const r: CRecord = { kind: 'C', id, name: words.join(' '), ...base };
      if (adr) r.adr = adr;
      if (proposed) r.proposed = true;
      if (since) r.since = since;
      return r;
    }
    case 'E': {
      need(3, '<from> <rel> <to>');
      const rel = rest[1]!;
      if (!RELATIONS.has(rel)) fail(`edge relation must be in|impl|dep, got ${rel}`);
      const r: ERecord = { kind: 'E', from: rest[0]!, rel: rel as Relation, to: rest[2]!, ...base };
      const { proposed, since } = takeTrailing(rest.slice(3));
      if (proposed) r.proposed = true;
      if (since) r.since = since;
      return r;
    }
    case 'K': {
      need(4, '<mode> <k-id> <attached-to> <text>');
      const mode = rest[0]!;
      if (!MODES.has(mode)) fail(`constraint mode must be E|G|R|G?, got ${mode}`);
      const { words, test, from, rule, since } = takeTrailing(rest.slice(3));
      if (words.length === 0) fail('constraint text is required');
      const r: KRecord = { kind: 'K', mode: mode as ConstraintMode, id: rest[1]!, attachedTo: rest[2]!, text: words.join(' '), ...base };
      if (test) r.test = test;
      if (from) r.from = from;
      if (rule) r.rule = rule;
      if (since) r.since = since;
      if (mode === 'E' && !test) fail(`enforced constraint ${r.id} must carry test:<path>`);
      return r;
    }
    case 'D': {
      need(8, '<d-id> <date> <who> <sha> <branch> <node> -><target> <text>');
      const [id, date, who, sha, branch, node] = rest as [string, string, string, string, string, string];
      let i = 6;
      const arrow = rest[i++]!;
      if (!arrow.startsWith('->')) fail(`decision must carry -> after the node, got ${arrow}`);
      let serves: string;
      if (arrow === '->K') serves = rest[i++] ?? fail('->K needs a constraint id');
      else if (arrow === '->C') serves = 'C:' + (rest[i++] ?? fail('->C needs a concept id'));
      else serves = arrow.slice(2);
      if (!serves) fail('decision -> target is empty');
      let overrides: string | undefined;
      const maybeBang = rest[i];
      if (maybeBang && maybeBang.startsWith('!')) {
        i++;
        if (maybeBang === '!K' || maybeBang === '!') overrides = rest[i++] ?? fail('! needs a constraint id');
        else overrides = maybeBang.replace(/^!K?/, '');
      }
      const text = rest.slice(i).join(' ');
      if (!text) fail('decision text is required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`decision date must be YYYY-MM-DD, got ${date}`);
      const r: DRecord = { kind: 'D', id, date, who, sha, branch, node, serves, text, ...base };
      if (overrides) r.overrides = overrides;
      return r;
    }
    case 'S': {
      need(2, '<new-d-id> <old-d-id>');
      const r: SRecord = { kind: 'S', newId: rest[0]!, oldId: rest[1]!, ...base };
      if (r.newId === r.oldId) fail('a decision cannot supersede itself');
      return r;
    }
    case 'Z': {
      need(4, '<k-id|c-id> <date> <who> <reason>');
      const words: string[] = [];
      let succ: string | undefined;
      for (const t of rest.slice(3)) {
        if (t.startsWith('succ:')) succ = t.slice(5);
        else words.push(t);
      }
      if (words.length === 0) fail('retirement reason is required');
      const r: ZRecord = { kind: 'Z', target: rest[0]!, date: rest[1]!, who: rest[2]!, reason: words.join(' '), ...base };
      if (succ) r.succ = succ;
      return r;
    }
    case 'A': {
      need(2, '<alias> <node>');
      const r: ARecord = { kind: 'A', alias: rest[0]!, node: rest[1]!, ...base };
      return r;
    }
    case 'R': {
      need(2, '<{role}> <heuristic>');
      const role = rest[0]!;
      if (!/^\{[^}]+\}$/.test(role)) fail(`pack role must be written as {role}, got ${role}`);
      const r: RRecord = { kind: 'R', role, heuristic: rest.slice(1).join(' '), ...base };
      return r;
    }
    case 'F': {
      need(5, '<path> <hash> <date> <who> <text>');
      const [path, hash, date, who] = rest as [string, string, string, string];
      if (!/^[0-9a-f]{8,64}$/.test(hash)) fail(`file card hash must be hex, got ${hash}`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(`file card date must be YYYY-MM-DD, got ${date}`);
      const words = rest.slice(4);
      const last = words[words.length - 1];
      const req = last?.startsWith('req:') ? words.pop()!.slice(4).split(',').filter(Boolean) : undefined;
      const text = words.join(' ');
      if (!text) fail('file card text is required');
      const r: FRecord = { kind: 'F', path, hash, date, who, text, ...base };
      if (req?.length) r.req = req;
      return r;
    }
    default:
      return fail(`unknown record kind ${kind}`);
  }
}

/** Pull trailing `key:value` markers and the `proposed` flag off a token list. */
function takeTrailing(tokens: string[]): { words: string[]; test?: string; from?: string; adr?: string; rule?: string; since?: string; proposed: boolean } {
  const words = [...tokens];
  const out: { words: string[]; test?: string; from?: string; adr?: string; rule?: string; since?: string; proposed: boolean } = { words, proposed: false };
  for (;;) {
    const last = words[words.length - 1];
    if (!last) break;
    if (last === 'proposed') { out.proposed = true; words.pop(); continue; }
    if (last.startsWith('test:')) { out.test = last.slice(5); words.pop(); continue; }
    if (last.startsWith('from:')) { out.from = last.slice(5); words.pop(); continue; }
    if (last.startsWith('adr:')) { out.adr = last.slice(4); words.pop(); continue; }
    if (last.startsWith('rule:')) { out.rule = last.slice(5); words.pop(); continue; }
    if (last.startsWith('since:')) { out.since = last.slice(6); words.pop(); continue; }
    break;
  }
  return out;
}

export function parseText(text: string, file?: string): GraphRecord[] {
  const out: GraphRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const r = parseLine(lines[i]!, i + 1, file);
    if (r) out.push(r);
  }
  return out;
}
