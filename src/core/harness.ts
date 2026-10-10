import type { TomlValue } from '../util/toml.js';

/**
 * Context Graph's harness settings (docs/specs/09-panes.md, VIEW-6): the `[harness]` section of
 * `.ctx/config.toml`, read by the mod's background agents and side questions. Each has a default, a
 * check, and a line saying what it does. A value that fails its check gives way to the default, and
 * `ctx settings` and `ctx doctor` report it.
 */
export interface HarnessSettings {
  card_writer: boolean;
  card_writer_model: string;
  backfill: 'off' | 'active' | 'all';
  curator: boolean;
  curator_model: string;
  side_questions: boolean;
  side_questions_model: string;
  pause_at_percent: number;
}

export type HarnessKey = keyof HarnessSettings;

interface Setting {
  default: HarnessSettings[HarnessKey];
  /** Why a value is wrong, or null when it's right. */
  problem: (v: TomlValue) => string | null;
  about: string;
}

const onOff = (v: TomlValue): string | null => (typeof v === 'boolean' ? null : 'must be true or false');
const model = (v: TomlValue): string | null =>
  typeof v === 'string' ? null : 'must be a model (haiku, sonnet, opus, or an id), or "" for the session\'s';

export const HARNESS: Record<HarnessKey, Setting> = {
  card_writer: { default: false, problem: onOff, about: 'A background agent that writes the cards owed, from full reads' },
  card_writer_model: { default: '', problem: model, about: "The card writer's model; empty means the session's" },
  backfill: {
    default: 'off',
    problem: (v) => (v === 'off' || v === 'active' || v === 'all' ? null : 'must be off, active (the modules changed in the last 90 days) or all'),
    about: 'The card writer also cards the existing code, leaves first: off, active (modules changed in the last 90 days) or all',
  },
  curator: { default: false, problem: onOff, about: 'A background agent that proposes rules from the decisions and flags overridden ones' },
  curator_model: { default: '', problem: model, about: "The curator's model; empty means the session's" },
  side_questions: { default: true, problem: onOff, about: '/why answers questions from the graph, beside the conversation' },
  side_questions_model: { default: '', problem: model, about: "The side questions' model; empty means the session's" },
  pause_at_percent: {
    default: 80,
    problem: (v) => (typeof v === 'number' && v > 0 && v <= 100 ? null : 'must be a percentage from 1 to 100'),
    about: "The plan's 5-hour use at which the background agents pause (code-kit's setting wins when it's installed)",
  },
};

export const HARNESS_KEYS = Object.keys(HARNESS) as HarnessKey[];

export function defaultHarness(): HarnessSettings {
  return Object.fromEntries(HARNESS_KEYS.map((k) => [k, HARNESS[k].default])) as unknown as HarnessSettings;
}

/** The settings in force, from the parsed `[harness]` section: values over the defaults. */
export function harnessFrom(section: Record<string, TomlValue> | undefined): HarnessSettings {
  const out = defaultHarness() as unknown as Record<string, TomlValue>;
  for (const k of HARNESS_KEYS) {
    const v = section?.[k];
    if (v !== undefined && !HARNESS[k].problem(v)) out[k] = v;
  }
  return out as unknown as HarnessSettings;
}

/** The section's problems, in the config's words. */
export function harnessProblems(section: Record<string, TomlValue> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(section ?? {})) {
    if (!(k in HARNESS)) {
      out.push(`[harness] ${k} isn't a harness setting (they are ${HARNESS_KEYS.join(', ')})`);
      continue;
    }
    const why = HARNESS[k as HarnessKey].problem(v);
    if (why) out.push(`[harness] ${k} ${why}`);
  }
  return out;
}

/** A value typed on the command line, as the setting's type. */
export function parseHarnessValue(key: HarnessKey, text: string): TomlValue {
  const d = HARNESS[key].default;
  if (typeof d === 'boolean') return text === 'true' ? true : text === 'false' ? false : text;
  if (typeof d === 'number') return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
  return text;
}

const literal = (v: TomlValue): string => (typeof v === 'string' ? JSON.stringify(v) : String(v));

/**
 * The config file's text with one `[harness]` setting set, everything else as it was: the key's line
 * replaced where it is, else added at the end of the section, else a `[harness]` section added.
 */
export function withHarnessSetting(text: string, key: HarnessKey, value: TomlValue): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^\s*\[harness\]\s*(#.*)?$/.test(l));
  const line = `${key} = ${literal(value)}`;
  if (start < 0) {
    const body = text.replace(/\n*$/, '');
    return `${body}${body ? '\n\n' : ''}[harness]\n${line}\n`;
  }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[[^\]]+\]/.test(l));
  if (end < 0) end = lines.length;
  const at = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (at >= 0) {
    const comment = lines[at]!.match(/\s+#.*$/)?.[0] ?? '';
    lines[at] = `${line}${comment}`;
  } else {
    // After the section's last setting, before the blank lines that close it.
    let last = end - 1;
    while (last > start && !lines[last]!.trim()) last -= 1;
    lines.splice(last + 1, 0, line);
  }
  return lines.join('\n');
}
