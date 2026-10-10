// Side questions (docs/specs/07-side-questions.md), the pure parts: what a question names, the records
// the graph holds on it (from `ctx why --json`), the side call's prompt, and the answer's pane. The
// answer comes only from those records (ASKQ-3), and goes in a pane beside the conversation, never into
// it (ASKQ-1).

export const WHY_ID = 'context-graph-why';
const MAX_TARGETS = 5;

/**
 * The graph nodes a question names, in order, at most five: module ids (`L:billing`), rule ids
 * (`billing.cents`) and paths (`src/billing/invoice.ts`). The whole question when it is one of these.
 */
export function targetsOf(question) {
  const words = String(question).trim().split(/[\s,;?()"'`]+/).filter(Boolean);
  const named = words.filter((w) => /^L:[\w.-]+$/.test(w) || /^[\w.-]+\/[\w./-]+$/.test(w) || /^[\w-]+\.[\w.-]*[a-z][\w-]*$/.test(w));
  return [...new Set(named.map((w) => w.replace(/[.:]+$/, '')))].slice(0, MAX_TARGETS);
}

/** The records an answer may rest on (ASKQ-1): cards, rules and decisions, once each: [{ id, kind, text }]. */
export function sourcesOf(found) {
  const out = new Map();
  for (const r of found) {
    if (r.card) out.set(`card:${r.node}`, { id: r.node, kind: 'card', text: r.card.text });
    for (const k of r.constraints ?? []) out.set(`rule:${k.id}`, { id: k.id, kind: k.mode === 'G?' ? 'proposed rule' : 'rule', text: k.text });
    for (const d of r.decisions ?? []) out.set(`decision:${d.id}`, { id: d.id, kind: 'decision', text: `${d.date} ${d.who}: ${d.text}` });
  }
  return [...out.values()];
}

/** ASKQ-1, ASKQ-3: the side call's prompt: the question and the graph's records, and nothing to guess from. */
export function whyPrompt(question, sources) {
  return [
    "Answer this side question from Context Graph's records only, in a few sentences. Cite each record you rely on by its id in square brackets, like [billing.cents] or [d-3fa91c]. If the records don't answer it, say the graph holds nothing on that, and don't guess. This answer goes to a side pane, not into the conversation; don't act on it.",
    '',
    `Question: ${question}`,
    '',
    'Records:',
    ...sources.map((s) => `- [${s.id}] (${s.kind}) ${s.text}`),
  ].join('\n');
}

/** ASKQ-2: the answer's cost as a person reads it: "4.2 s · 1,200 tokens in, 180 out (900 from the cache)". */
export function costText(ms, usage) {
  if (!usage) return `${(ms / 1000).toFixed(1)} s`;
  const n = (x) => (x ?? 0).toLocaleString('en');
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  return `${(ms / 1000).toFixed(1)} s · ${n(input)} tokens in, ${n(usage.output_tokens)} out${usage.cache_read_input_tokens ? ` (${n(usage.cache_read_input_tokens)} from the cache)` : ''}`;
}

/**
 * The side pane: the question, the answer (or why there is none), its cost, and its sources, each a
 * press away (a file opens in the Context pane). `state`: { question, targets, sources, answer?,
 * error?, ms?, usage?, pending }. `on.onSource(source)`.
 */
export function whyPane(state, { Box, Text, Button, Markdown }, on) {
  const text = (value, style = {}) => Text({ ...style, children: [value] });
  if (!state) return text('Ask with /why <path, module, rule or question>.', { dimColor: true });
  const body = state.pending
    ? [text('Asking the graph…', { dimColor: true })]
    : state.error
      ? [text(state.error, { color: state.empty ? 'yellow' : 'red' })]
      : [Markdown ? Markdown({ key: 'why-answer', text: state.answer }) : text(state.answer), text(costText(state.ms, state.usage), { key: 'why-cost', dimColor: true })];
  return Box({
    flexDirection: 'column',
    rowGap: 1,
    children: [
      text(`Why: ${state.question}`, { bold: true, color: 'cyan' }),
      ...body,
      ...(state.sources?.length
        ? [
            Box({
              key: 'why-sources',
              flexDirection: 'column',
              children: [
                text('From the graph', { bold: true }),
                ...state.sources.map((s) =>
                  Button({ key: `source-${s.id}`, label: `${s.kind}  ${s.id}  ${s.text}`, plain: true, onPress: () => on.onSource(s) }),
                ),
              ],
            }),
          ]
        : []),
    ],
  });
}
