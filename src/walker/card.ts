import type { Graph } from '../graph/graph.js';
import type { KRecord } from '../graph/records.js';
import { estimateTokens } from '../util/tokens.js';
import type { WalkResult } from './walk.js';

/**
 * The module card: what a session is told the first time it reads or greps under a module, before it
 * has read a line of the code there. Smaller than a slice and once per module per session, so the
 * cost is bounded by the module count. Enforced rules are never dropped; guided ones lose their text
 * before they are lost; proposed ones go first.
 */
export interface Card { module: string; text: string; tokens: number; dropped: string[] }

const MODE_ORDER: Record<KRecord['mode'], number> = { E: 0, G: 1, 'G?': 2, R: 3 };

export function renderCard(graph: Graph, w: WalkResult, opts: { maxTokens?: number } = {}): Card | undefined {
  const module = w.chain[0];
  if (!module) return undefined;
  const maxTokens = opts.maxTokens ?? 200;
  const l = graph.logicals.get(module);
  const rest = w.chain.slice(1);
  const head = `module ${module}${l ? `  ${l.name}` : ''}${rest.length ? `  in ${rest.join(' > ')}` : ''}${w.concepts.length ? `  impl ${w.concepts.join(' ')}` : ''}`;
  const rules = [...w.constraints].filter((k) => k.mode !== 'R').sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
  const decisions = graph.decisionsOn(w.nodes);
  const latest = decisions[0];
  const tail = [
    decisions.length ? `  decisions ${decisions.length}, latest ${latest!.id} ${latest!.date.slice(5)} ${latest!.overrides ? `!${latest!.overrides} ` : ''}${latest!.text.slice(0, 90)}` : undefined,
    `  hydrate ${module} for callers, history, and what this session already holds`,
  ].filter((x): x is string => Boolean(x));

  const line = (k: KRecord, withText: boolean): string => (k.mode === 'G?' ? `  must?  ${withText ? `${k.text}  ` : ''}[G? ${k.id} proposed]` : `  must   ${withText ? `${k.text}  ` : ''}[${k.mode} ${k.id}]`);
  const dropped: string[] = [];
  let proposedCap = rules.filter((k) => k.mode === 'G?').length;
  let guidedText = true;
  const assemble = (): string => {
    let seenProposed = 0;
    const lines = rules.flatMap((k) => {
      if (k.mode === 'G?') { seenProposed++; return seenProposed <= proposedCap ? [line(k, true)] : []; }
      return [line(k, k.mode === 'E' || guidedText)];
    });
    return [head, ...lines, ...tail].join('\n');
  };
  let text = assemble();
  let tokens = estimateTokens(text);
  while (tokens > maxTokens && proposedCap > 0) { proposedCap--; dropped.push('proposed'); text = assemble(); tokens = estimateTokens(text); }
  if (tokens > maxTokens && guidedText) { guidedText = false; dropped.push('guided text'); text = assemble(); tokens = estimateTokens(text); }
  return { module, text, tokens, dropped };
}
