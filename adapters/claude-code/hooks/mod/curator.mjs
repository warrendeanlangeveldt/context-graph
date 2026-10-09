// The curator (docs/specs/05-curator.md), the pure parts: when it's due, its definition for
// $.agent.register, the lead's prompt that starts it, and the rules hygiene flags as overridden. The
// lead starts it, in the background (a mod can't, in auto mode). It only proposes: ratifying, dropping
// and retiring stay the person's or the delegated ratifier's, and the hooks keep it so.

export const CURATOR = 'curator';
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

/** The curator's definition (CUR-3): it reads and proposes; it never edits, ratifies, drops or retires. */
export function curatorSpec({ ctx, model }) {
  return {
    name: CURATOR,
    description:
      "Context Graph's curator: reviews the decisions recorded and the graph's evidence, and proposes the rules the code follows that nobody wrote down. Started by the lead when Context Graph's mod asks for it.",
    disallowedTools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    ...(model ? { model } : {}),
    prompt: [
      "You are Context Graph's curator. You keep the graph in step with how the team works. You only propose; a person, or the delegated ratifier, decides.",
      '',
      `1. Read the decisions recorded (\`node "${ctx}" history <module or path>\`, the MCP tools \`why\` and \`history\`) and the rules in force (\`node "${ctx}" proposals\`, \`node "${ctx}" file <path>\`).`,
      `2. Where three or more decisions on one module serve or describe the same convention and no rule states it, propose it: \`node "${ctx}" propose <L:module> "<the rule, in one sentence>"\` (or the MCP tool \`propose\`). Cite the decisions in your report.`,
      `3. Where files that belong together have no module of their own, propose one: \`node "${ctx}" module <L:id> --paths "<glob>…" --name "…"\` (without --delegated).`,
      '4. Read `node "' + ctx + '" hygiene` for rules overridden again and again: name them in your report with what you would reword. Never retire one.',
      '',
      'You never edit files, ratify, drop, retire or change settings: those are refused to you, and they are not yours to do. End with a short report: what you proposed and why, citing decision ids, and which rules look overridden.',
    ].join('\n'),
  };
}

/** The lead's prompt that starts the curator in the background (CUR-1). */
export function startCuratorPrompt({ agent, since }) {
  return `Start Context Graph's curator in the background: use the Agent tool with subagent_type "${agent}", run_in_background true, description "Curate the graph (Context Graph)", and the prompt "Review the ${since} decisions recorded since you last ran and the graph's evidence; propose the rules they show." Then carry on; it only proposes.`;
}

/** The pane's line for the curator: off, paused, running, or how many decisions until its next run. */
export function curatorLine({ on, paused, percent, running, decisions, baseline }) {
  if (!on) return 'Curator: off (/graph-settings turns it on)';
  if (paused) return `Curator: paused, the plan at ${percent}%`;
  if (running) return 'Curator: reviewing the decisions';
  const left = Math.max(0, EVERY - (decisions - baseline));
  return left ? `Curator: runs after ${left} more decision${left === 1 ? '' : 's'}` : 'Curator: due when the lead is idle';
}
