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

/** Cut at a word boundary so a pointer to the full text does not end mid-word. */
function clip(t: string, max: number): string {
  if (t.length <= max) return t;
  const cut = t.lastIndexOf(' ', max - 1);
  return `${t.slice(0, cut > max / 2 ? cut : max - 1)}…`;
}

export function renderCard(graph: Graph, w: WalkResult, opts: { maxTokens?: number } = {}): Card | undefined {
  const module = w.chain[0];
  if (!module) return undefined;
  const maxTokens = opts.maxTokens ?? 200;
  const l = graph.logicals.get(module);
  const rest = w.chain.slice(1);
  const head = `module ${module}${l ? `  ${l.name}` : ''}${rest.length ? `  in ${rest.join(' > ')}` : ''}${w.concepts.length ? `  impl ${w.concepts.join(' ')}` : ''}`;
  // What the module itself says is the card; what it inherits arrives with every slice anyway, so ids suffice.
  const rules = [...w.constraints].filter((k) => k.mode !== 'R').sort((a, b) => MODE_ORDER[a.mode] - MODE_ORDER[b.mode]);
  const ownRules = rules.filter((k) => k.attachedTo === module);
  const inheritedActive = rules.filter((k) => k.attachedTo !== module && k.mode !== 'G?');
  const inheritedProposed = rules.filter((k) => k.attachedTo !== module && k.mode === 'G?').length;
  const decisions = [...graph.decisions.values()].filter((d) => graph.isActiveDecision(d) && (d.node === module || graph.mapPath(d.node.split('#')[0]!)?.logical === module)).sort((a, b) => b.date.localeCompare(a.date));
  const latest = decisions[0];
  const specific = ownRules.length > 0 || decisions.length > 0;
  const tail = [
    decisions.length ? `  decisions ${decisions.length} in this module, latest ${latest!.id} ${latest!.date.slice(5)} ${latest!.overrides ? `!${latest!.overrides} ` : ''}${clip(latest!.text, 90)}` : undefined,
    specific ? `  hydrate ${module} for callers, history, and what this session already holds` : undefined,
  ].filter((x): x is string => Boolean(x));

  const line = (k: KRecord, withText: boolean): string => (k.mode === 'G?' ? `  must?  ${withText ? `${k.text}  ` : ''}[G? ${k.id} proposed]` : `  must   ${withText ? `${k.text}  ` : ''}[${k.mode} ${k.id}]`);
  const dropped: string[] = [];
  let inheritedIds = true;
  let proposedText = true;
  let guidedText = true;
  const assemble = (): string => {
    const ownProposed = ownRules.filter((k) => k.mode === 'G?');
    const lines = ownRules.filter((k) => k.mode !== 'G?').map((k) => (k.mode === 'E' ? line(k, true) : line(k, guidedText)));
    if (ownProposed.length) lines.push(...(proposedText ? ownProposed.map((k) => line(k, true)) : [`  must?  ${ownProposed.length} proposed: ${ownProposed.map((k) => k.id).join(', ')}  (ctx why <id> for the text)`]));
    const inh: string[] = [];
    if (inheritedActive.length || inheritedProposed) {
      const from = [...new Set(inheritedActive.map((k) => k.attachedTo))].join(', ');
      inh.push(`  inherits ${inheritedActive.length} rule${inheritedActive.length === 1 ? '' : 's'}${from ? ` from ${from}` : ''}${inheritedIds && inheritedActive.length ? `: ${inheritedActive.map((k) => k.id).join(', ')}` : ''}${inheritedProposed ? `; ${inheritedProposed} proposed` : ''}`);
    }
    return [head, ...lines, ...inh, ...tail].join('\n');
  };
  let text = assemble();
  let tokens = estimateTokens(text);
  const step = (label: string, apply: () => void): void => { if (tokens <= maxTokens) return; apply(); dropped.push(label); text = assemble(); tokens = estimateTokens(text); };
  step('inherited ids', () => { inheritedIds = false; });
  step('proposed text', () => { proposedText = false; });
  step('guided text', () => { guidedText = false; });
  return { module, text, tokens, dropped };
}
