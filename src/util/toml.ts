/**
 * Minimal TOML reader for `.ctx/config.toml`. Supports tables, dotted-quoted keys inside
 * tables, strings, numbers, booleans, and arrays of strings. Everything the plugin's
 * configuration uses, and nothing it does not.
 */
export type TomlValue = string | number | boolean | string[];
export type TomlTable = Record<string, TomlValue | Record<string, TomlValue>>;

export function parseToml(text: string): Record<string, Record<string, TomlValue>> {
  const out: Record<string, Record<string, TomlValue>> = {};
  let table = '';
  out[table] = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) {
      table = t[1]!.trim();
      out[table] ??= {};
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = unquoteKey(line.slice(0, eq).trim());
    const value = parseValue(line.slice(eq + 1).trim());
    out[table]![key] = value;
  }
  return out;
}

function stripComment(line: string): string {
  let inStr: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === inStr) inStr = null;
    } else if (ch === '"' || ch === "'") inStr = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function unquoteKey(k: string): string {
  return k.replace(/^"(.*)"$/, '$1');
}

function parseValue(v: string): TomlValue {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[')) {
    const inner = v.slice(1, v.lastIndexOf(']'));
    return inner
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/^["'](.*)["']$/, '$1'));
  }
  return v.replace(/^["'](.*)["']$/, '$1');
}

export function tomlGet<T extends TomlValue>(
  cfg: Record<string, Record<string, TomlValue>>,
  table: string,
  key: string,
  fallback: T,
): T {
  const v = cfg[table]?.[key];
  return (v === undefined ? fallback : v) as T;
}
