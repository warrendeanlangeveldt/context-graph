import { cardState, exemptFromCards, type CardState } from '../cards/cards.js';
import type { Config } from '../core/context.js';
import type { Graph } from '../graph/graph.js';
import { changedExports } from '../index/exports.js';
import { callersOf, type ImportIndex } from '../index/imports.js';
import type { Envelope, Touch } from '../observe/event.js';
import { readRepoText } from '../util/paths.js';

/**
 * Read before edit: the loop's gate. Before an agent edits a file, the file must be understood, either
 * through a fresh card (its context is already written down) or by reading it in full. On a miss, what it
 * imports must be understood the same way; and when the edit changes what the file exports, so must what
 * imports it. Each agent's own reads count for it alone: a subagent has its own context window.
 */

export interface Requirement {
  path: string;
  /** Why this file is required, in a phrase. */
  why: string;
  rule: 'read-before-edit' | 'dependencies';
}

export interface EditCheck {
  path: string;
  state: CardState;
  missing: Requirement[];
  /** Dependencies satisfied by their fresh cards, to show alongside the slice. */
  depCards: string[];
  /** Importers beyond the cap that were not required. */
  uncheckedImporters: number;
}

/** Paths this agent holds in context: read in full, or written whole, since its last compaction. */
export function heldInFull(events: Envelope[], agent: string | undefined): Set<string> {
  let lastCompact = -1;
  if (!agent) events.forEach((e, i) => { if (e.t === 'compact') lastCompact = i; });
  // A read recorded as its call started, whose call then failed, never reached the context.
  const failed = new Set<string>();
  for (const e of events) if ((e.t === 'touch' || e.t === 'edit') && (e.p as Touch).mode === 'failed' && (e.p as Touch).toolUseId) failed.add((e.p as Touch).toolUseId!);
  const held = new Set<string>();
  events.forEach((e, i) => {
    if (i < lastCompact || (e.t !== 'touch' && e.t !== 'edit')) return;
    const t = e.p as Touch;
    if ((t.agent ?? undefined) !== agent) return;
    if (t.toolUseId && failed.has(t.toolUseId)) return;
    const whole = t.mode === 'full' || t.mode === 'write' || (t.mode === 'range' && t.range?.[0] === 1 && t.range?.[1] === -1);
    if (whole) held.add(t.path);
  });
  return held;
}

export function checkEdit(opts: {
  graph: Graph;
  root: string;
  config: Config;
  events: Envelope[];
  agent: string | undefined;
  path: string;
  index?: ImportIndex;
  /** The file's text after the edit, when the tool call says enough to know it. */
  after?: string;
}): EditCheck {
  const { graph, root, config, path } = opts;
  const state = cardState(graph, root, path);
  const out: EditCheck = { path, state, missing: [], depCards: [], uncheckedImporters: 0 };
  const before = readRepoText(root, path);
  // A new file has nothing to read yet; it owes its card once written.
  if (before === undefined || exemptFromCards(path, config.cardsExclude)) return out;

  const held = heldInFull(opts.events, opts.agent);
  const understood = (p: string): 'held' | 'card' | undefined =>
    held.has(p) ? 'held' : cardState(graph, root, p).fresh ? 'card' : undefined;

  const hit = state.fresh;
  if (!hit && !held.has(path)) {
    out.missing.push({ path, rule: 'read-before-edit', why: state.card ? 'its card is stale: the file changed since it was written, so read it in full' : 'it has no card yet, so read it in full' });
  }

  const index = opts.index;
  if (!index) return out;
  const deps: { path: string; why: string }[] = [];
  if (!hit) {
    for (const imp of index.imports[path] ?? []) deps.push({ path: imp, why: `imported by ${path}` });
  }
  const changed = opts.after !== undefined ? changedExports(before, opts.after) : [];
  if (changed.length) {
    const importers = callersOf(index, path).filter((p) => !exemptFromCards(p, config.cardsExclude));
    // The cap spends reads where there is no card to lean on.
    const needing = importers.filter((p) => !understood(p));
    const required = needing.slice(0, Math.max(0, config.enforce.maxImporters));
    out.uncheckedImporters = needing.length - required.length;
    const what = changed[0]!.length > 70 ? `${changed[0]!.slice(0, 67)}...` : changed[0]!;
    for (const imp of required) deps.push({ path: imp, why: `imports ${path}, and this edit changes \`${what}\`` });
    for (const imp of importers) if (understood(imp) === 'card' && !out.depCards.includes(imp)) out.depCards.push(imp);
  }
  for (const d of deps) {
    if (exemptFromCards(d.path, config.cardsExclude)) continue;
    const u = understood(d.path);
    if (u === 'card') { if (!out.depCards.includes(d.path)) out.depCards.push(d.path); continue; }
    if (u) continue;
    if (!out.missing.some((m) => m.path === d.path)) out.missing.push({ path: d.path, rule: 'dependencies', why: `${d.why}; it has no fresh card, so read it in full` });
  }
  return out;
}

/** The refusal (or the note, when nudging), naming exactly what to read. */
export function describeMissing(checks: EditCheck[], rules: Requirement['rule'][]): string | undefined {
  const lines: string[] = [];
  for (const c of checks) {
    const missing = c.missing.filter((m) => rules.includes(m.rule));
    if (!missing.length) continue;
    lines.push(`Before editing ${c.path}, its context has to be in this agent's context:`);
    for (const m of missing) lines.push(`  - ${m.path}: ${m.why}`);
    if (c.uncheckedImporters > 0) lines.push(`  (${c.uncheckedImporters} more importer(s) without cards were not required; consider them before changing the export.)`);
  }
  if (!lines.length) return undefined;
  lines.push('Read those, then make the edit again. After the edit, write or update the file\'s card (MCP tool `card`, or ctx card <path> --text "...") so the next agent starts from it.');
  return ['Context Graph: read before you edit.', ...lines].join('\n');
}
