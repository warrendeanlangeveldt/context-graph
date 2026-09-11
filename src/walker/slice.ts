import type { Graph } from '../graph/graph.js';
import type { KRecord } from '../graph/records.js';
import { estimateTokens } from '../util/tokens.js';
import type { WalkResult } from './walk.js';

export interface SliceOptions {
  maxTokens?: number;
  /** Optional live and hint lines already rendered by an overlay or retriever. Dropped first under budget. */
  live?: string[];
  hints?: string[];
  /**
   * How proposed rules render. `own` (the default for injection): a proposal on the file's own module in
   * full, the ones inherited from ancestors as one line of ids. `full`: every proposal with its text, for
   * an explicit pull. Proposals are skimmed when they crowd the ratified rules; ids keep them reachable.
   */
  proposed?: 'own' | 'full';
}

export interface Slice {
  text: string;
  tokens: number;
  dropped: string[];
  warnings: string[];
  applicable: string[];
}

const MODE_ORDER: Record<KRecord['mode'], number> = { E: 0, G: 1, 'G?': 2, R: 3 };

/**
 * Render a walk result as the imperative slice injected before an edit (design spec §7.2).
 * Order is fixed: header, chain, must (E then G then proposed), note (R), last (decisions),
 * live, hint. Budget drops hints first, then oldest decisions, then R lines. E and G are never dropped.
 */
export function renderSlice(graph: Graph, w: WalkResult, opts: SliceOptions = {}): Slice {
  const maxTokens = opts.maxTokens ?? 300;
  const name = graph.aliasFor(w.path) ?? w.path;
  const header = `edit ${name}${w.symbol ? `#${w.symbol}` : ''}`;

  const chainParts: string[] = [];
  if (w.chain.length) chainParts.push(w.chain.join(' > '));
  if (w.concepts.length) chainParts.push(`impl ${w.concepts.join(' ')}`);
  const chainLine = w.mapped ? `  chain  ${chainParts.join('  ')}` : '  chain  (no mapping covers this path)';

  const sorted = [...w.constraints].sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
  const own = new Set([w.chain[0], w.path.split('#')[0]]);
  const mustLines: string[] = [];
  const noteLines: string[] = [];
  const ownProposed: KRecord[] = [];
  const inherited: KRecord[] = [];
  for (const k of sorted) {
    if (k.mode === 'R') noteLines.push(`  note   ${k.text}  [R ${k.id}]`);
    else if (k.mode === 'G?') { if (opts.proposed === 'full' || own.has(k.attachedTo)) ownProposed.push(k); else inherited.push(k); }
    else mustLines.push(`  must   ${k.text}  [${k.mode} ${k.id}]`);
  }
  let proposedLines = ownProposed.map((k) => `  must?  ${k.text}  [G? ${k.id} proposed]`);
  const inheritedFrom = [...new Set(inherited.map((k) => k.attachedTo))].join(', ');
  let inheritedLines = inherited.length ? [`  also   ${inherited.length} proposed on ${inheritedFrom}: ${inherited.slice(0, 6).map((k) => k.id).join(', ')}${inherited.length > 6 ? ` +${inherited.length - 6}` : ''}  (ctx why <id> for the text)`] : [];

  const lastLines = w.decisions.map((d) => {
    const when = d.date.slice(5);
    const bang = d.overrides ? `!${d.overrides}  ` : '';
    const prov = d.sha === '-' ? `${d.branch} provisional` : d.sha;
    return `  last   ${d.id} ${when} ${d.who}  ${bang}${d.text}  (${prov})`;
  });

  const liveLines = (opts.live ?? []).map((l) => `  live   ${l}`);
  const hintLines = (opts.hints ?? []).map((h) => `  hint   ${h}`);

  const dropped: string[] = [];
  const warnings: string[] = [];
  const assemble = (): string =>
    [header, chainLine, ...mustLines, ...proposedLines, ...inheritedLines, ...noteLines, ...lastLines, ...liveLines, ...hintLines].join('\n');

  let text = assemble();
  let tokens = estimateTokens(text);
  const over = (): boolean => tokens > maxTokens;
  const recount = (): void => { text = assemble(); tokens = estimateTokens(text); };

  while (over() && hintLines.length) { dropped.push(`hint:${hintLines.pop()!.trim()}`); recount(); }
  while (over() && liveLines.length) { dropped.push(`live:${liveLines.pop()!.trim()}`); recount(); }
  // The newest decision survives the budget like an enforced rule does. A file rich enough in rules to
  // exhaust the budget is exactly the one whose history the next agent cannot reconstruct from the code.
  while (over() && lastLines.length > 1) { dropped.push(`decision:${w.decisions[lastLines.length - 1]!.id}`); lastLines.pop(); recount(); }
  while (over() && noteLines.length) { noteLines.pop(); dropped.push('note'); recount(); }
  if (over() && inheritedLines.length) { inheritedLines = [`  also   ${inherited.length} proposed on ${inheritedFrom}  (ctx why)`]; dropped.push('inherited ids'); recount(); }
  if (over() && inheritedLines.length) { inheritedLines = []; dropped.push('inherited'); recount(); }
  if (over() && ownProposed.length && proposedLines.length > 1) { proposedLines = [`  must?  ${ownProposed.length} proposed: ${ownProposed.map((k) => k.id).join(', ')}  (ctx why <id> for the text)`]; dropped.push('proposed text'); recount(); }
  if (over()) warnings.push(`enforced and guided constraints plus the newest decision exceed the ${maxTokens}-token budget at ${w.path}; the graph is too fine-grained at this node`);

  return { text, tokens, dropped, warnings, applicable: w.applicable };
}
