import type { Graph } from '../graph/graph.js';
import type { DRecord } from '../graph/records.js';
import { estimateTokens } from '../util/tokens.js';

/**
 * The read-time injection (design spec §7.3). A slice is edit-shaped: it states the rules in force
 * because an edit is about to test them. A read needs the other half, and only the other half: what
 * was decided about this file and why, which is the one thing grep cannot show and the thing a
 * wrong mental model is built without. Nothing is injected for a file that carries no decisions,
 * so a read of ordinary code stays silent.
 */
export interface History { path: string; text: string; tokens: number; decisions: string[] }

export function renderHistory(graph: Graph, path: string, opts: { maxDecisions?: number; maxTokens?: number } = {}): History | undefined {
  const file = path.split('#')[0]!;
  const maxDecisions = opts.maxDecisions ?? 3;
  const maxTokens = opts.maxTokens ?? 160;
  // Decisions on the file and on symbols within it. Not the module's: those arrive once, on its card.
  const all = [...graph.decisions.values()]
    .filter((d) => (d.node === file || d.node.startsWith(`${file}#`)) && graph.isActiveDecision(d))
    .sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));
  if (!all.length) return undefined;

  const shown = all.slice(0, maxDecisions);
  const name = graph.aliasFor(file) ?? file;
  const line = (d: DRecord, withWho: boolean): string => {
    const symbol = d.node.includes('#') ? `${d.node.split('#')[1]}  ` : '';
    const prov = d.sha === '-' ? `${d.branch} provisional` : d.sha;
    return `  decided  ${d.id} ${d.date.slice(5)}${withWho ? ` ${d.who}` : ''}  ${symbol}${d.overrides ? `!${d.overrides}  ` : ''}${d.text}  (${prov})`;
  };
  const tail = all.length > shown.length ? `  and ${all.length - shown.length} more: ctx history ${name}` : undefined;

  let withWho = true;
  let count = shown.length;
  const assemble = (): string => [
    `read ${name}`,
    ...shown.slice(0, count).map((d) => line(d, withWho)),
    ...(count < all.length ? [`  and ${all.length - count} more: ctx history ${name}`] : tail ? [tail] : []),
  ].join('\n');

  let text = assemble();
  let tokens = estimateTokens(text);
  if (tokens > maxTokens && withWho) { withWho = false; text = assemble(); tokens = estimateTokens(text); }
  // The newest decision is the point of the injection; trimming stops before it goes.
  while (tokens > maxTokens && count > 1) { count--; text = assemble(); tokens = estimateTokens(text); }
  return { path: file, text, tokens, decisions: shown.slice(0, count).map((d) => d.id) };
}
