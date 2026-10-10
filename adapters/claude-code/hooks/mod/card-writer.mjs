// The card writer (docs/specs/04-card-writer.md), the pure parts: what it should work on, its
// definition for $.agent.register, and the lead's prompt that starts it. The mod
// can't start an agent itself in auto mode (the harness spikes), so the lead does, in the background.
// Both run under Context Graph's hooks like any agent: the card writer writes cards and decisions only,
// the curator only proposes.

export const CARD_WRITER = 'card-writer';
/** A file an agent edited this recently waits: the card would describe a file still moving (CARDW-1). */
export const SETTLE_MS = 2 * 60000;
/** The most files one card writer takes at a time. */
export const BATCH = 10;

/**
 * CARDW-1, CARDW-4: the card jobs, in order: files the person asked for, files owed a card this
 * session, files changed on the branch without a current card, then the backfill's (existing code,
 * leaves first); none edited in the last 2 minutes, none twice. [{ path, reason }], reason `asked`,
 * `owed`, `changed` or `backfill`.
 */
export function cardJobs({ asked = [], owed = [], changed = [], backfill = [], editedAt = {}, now }) {
  const seen = new Set();
  const jobs = [];
  for (const [list, reason] of [
    [asked, 'asked'],
    [owed, 'owed'],
    [changed, 'changed'],
    [backfill, 'backfill'],
  ])
    for (const path of list) {
      if (seen.has(path)) continue;
      seen.add(path);
      if (editedAt[path] !== undefined && now - editedAt[path] < SETTLE_MS) continue;
      jobs.push({ path, reason });
    }
  return jobs;
}

/** CARDW-5, CUR-4: whether background agents pause: the plan's 5-hour use past the pause point. */
export function pausedAt(rateLimits, pauseAtPercent) {
  const percent = (rateLimits ?? []).find((r) => r.kind === 'five_hour')?.percentUsed ?? null;
  return { percent, paused: percent !== null && percent > pauseAtPercent };
}

/** The card writer's definition: it reads, and writes only cards and decisions, through ctx (CARDW-2). */
export function cardWriterSpec({ ctx, skill, model }) {
  return {
    name: CARD_WRITER,
    description:
      "Context Graph's card writer: writes the cards owed and missing, each from a full reading of the file. Started by the lead when Context Graph's mod asks for it.",
    disallowedTools: ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'],
    ...(model ? { model } : {}),
    prompt: [
      "You are Context Graph's card writer. For each file you are given, write its card: what the file is for, what it relies on, who relies on it, and what it must keep true.",
      '',
      `Follow the cards skill (${skill}). For each file:`,
      '1. Read it in full, with what it imports; where its exports changed, read what imports it too. Never write a card from a partial read: a card is only as good as the reading behind it.',
      `2. Write the card with the MCP tool \`card\`, or \`node "${ctx}" card <path> --text "…"\`.`,
      '3. Record a decision only where the file shows one nobody recorded.',
      '',
      "You never edit a file (the tools are withheld), ratify, drop or retire anything. If a file is being edited as you read it, skip it: it's written later.",
      'End with one line per file: written, or skipped and why.',
    ].join('\n'),
  };
}

/** The description the card writer's batch is started with: how the mod knows its own batch's agent. */
export const batchDescription = (n) => `Write ${n} card${n === 1 ? '' : 's'} (Context Graph)`;

/**
 * The lead's prompt that starts the card writer on its batch, in the background (CARDW-1). It says the
 * lead may decline, and that a declined batch isn't offered again this session.
 */
export function startCardWriterPrompt({ agent, jobs }) {
  const files = jobs.map((j) => j.path);
  return `Start Context Graph's card writer in the background: use the Agent tool with subagent_type "${agent}", run_in_background true, description "${batchDescription(files.length)}", and the prompt "Write the cards for: ${files.join(', ')}." Then carry on; it only writes cards. If the person has asked you not to card these now, say so and don't start it: Context Graph won't offer these files again this session.`;
}

/** The backfill's line, for the band and the Map tab: how much of the existing code is carded. */
export function backfillLine({ scope, left, inScope, paused }) {
  if (!scope || scope === 'off' || !inScope) return null;
  const where = scope === 'all' ? 'all modules' : 'modules changed in the last 90 days';
  if (!left) return `Card backfill done: ${inScope} files carded (${where})`;
  return `Card backfill${paused ? ' paused' : ''}: ${inScope - left} of ${inScope} carded (${where})`;
}

/** The pane's line for the card writer: off, paused, writing, or waiting. */
export function cardWriterLine({ on, paused, percent, writing = [], waiting = [] }) {
  if (!on) return 'Card writer: off (/graph-settings turns it on)';
  if (paused) return `Card writer: paused, the plan at ${percent}%`;
  if (writing.length) return `Card writer: writing ${writing.length} (${writing.slice(0, 3).join(', ')}${writing.length > 3 ? ', …' : ''})${waiting.length ? `, ${waiting.length} waiting` : ''}`;
  return waiting.length ? `Card writer: ${waiting.length} waiting for the lead to be idle` : 'Card writer: nothing owed';
}
