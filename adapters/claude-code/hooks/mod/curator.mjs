// The curator (docs/specs/05-curator.md), the pure parts: when it's due, the request that reads the
// decisions recorded for the conventions nobody wrote down, how its reply is read, and the rules hygiene
// flags as overridden. The mod runs it itself, with its own model request (a mod can't start an agent in
// auto mode, and asking the lead to start one put Context Graph's request in the person's conversation).
// It adds only guidance, through `ctx propose`: ratifying, dropping and retiring stay the person's or the
// delegated ratifier's.

/** The curator's model when the setting names none. */
export const DEFAULT_MODEL = 'sonnet';
/** CUR-1: a convention is proposed from at least this many decisions. */
export const CITES = 3;
/** The most rules one run adds. */
export const MOST = 3;
/** It runs after this many new decisions (CUR-1). */
export const EVERY = 10;
const FLAGS = new Set(['overridden-in-practice', 'overridden-since-ratified']);

/**
 * CUR-1: whether a run is due: on, not running, and 10 decisions recorded since its last run (or the
 * session's start), or the person asked for one.
 */
export function curatorDue({ on, running, decisions, baseline, asked }) {
  if (!on || running) return false;
  return asked || decisions - baseline >= EVERY;
}

/** CUR-2: the rules hygiene flags as overridden, with their overriding decisions: [{ rule, evidence, proposal }]. */
export function flaggedRules(findings) {
  return (findings ?? []).filter((f) => FLAGS.has(f.signal)).map((f) => ({ rule: f.target, evidence: f.evidence, proposal: f.proposal }));
}

/**
 * CUR-1, CUR-3: the one request that reads the decisions on each module, with the rules already stated
 * there and those proposed, for a convention three or more decisions serve or describe that no rule
 * states. `modules`: [{ id, rules: [text], decisions: [{ id, text }] }].
 */
export function curatorPrompt({ modules, proposed = [] }) {
  return [
    "You are Context Graph's curator. Below are the decisions recorded on each module of a codebase, with the rules already stated there. Find conventions the decisions show that no rule states yet: where at least three decisions on one module serve or describe the same convention. Each becomes guidance agents see before they edit, so add only what the decisions clearly show, in one plain sentence. Never restate a rule that's there or proposed.",
    'Answer with one JSON object and nothing else: {"rules": [{"module": "L:…", "rule": "…", "cites": ["decision id", …]}]}, with at most ' + MOST + ' rules, or {"rules": []} when the decisions show none.',
    ...modules.flatMap((m) => [
      '',
      `## ${m.id}`,
      ...(m.rules.length ? ['Rules stated:', ...m.rules.map((r) => `- ${r}`)] : ['No rules stated.']),
      'Decisions:',
      ...m.decisions.map((d) => `- ${d.id}: ${d.text}`),
    ]),
    ...(proposed.length ? ['', 'Rules already proposed:', ...proposed.map((p) => `- ${p.module ?? ''} ${p.text}`)] : []),
  ].join('\n');
}

/**
 * CUR-1: the curator's reply as rules to propose: [{ module, rule, cites }], each on a module it was
 * shown, citing at least three of that module's decisions; anything else is left out.
 */
export function readCuration(text, modules) {
  const raw = String(text ?? '');
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  } catch {
    return [];
  }
  const byId = new Map(modules.map((m) => [m.id, new Set(m.decisions.map((d) => d.id))]));
  return (Array.isArray(parsed?.rules) ? parsed.rules : [])
    .map((r) => ({
      module: String(r?.module ?? ''),
      rule: String(r?.rule ?? '').replace(/\s+/g, ' ').trim(),
      cites: (Array.isArray(r?.cites) ? r.cites : []).map(String).filter((id) => byId.get(String(r?.module ?? ''))?.has(id)),
    }))
    .filter((r) => byId.has(r.module) && r.rule && new Set(r.cites).size >= CITES)
    .slice(0, MOST);
}

/** The pane's line for the curator: off, paused, running, or how many decisions until its next run. */
export function curatorLine({ on, paused, percent, heldBy = null, running, decisions, baseline }) {
  if (!on) return 'Curator: off (/graph-settings turns it on)';
  if (heldBy && !running) return `Curator: paused with ${heldBy}'s loop`;
  if (paused) return `Curator: paused, the plan at ${percent}%`;
  if (running) return 'Curator: reviewing the decisions';
  const left = Math.max(0, EVERY - (decisions - baseline));
  return left ? `Curator: runs after ${left} more decision${left === 1 ? '' : 's'}` : 'Curator: due; it runs in the background next';
}
