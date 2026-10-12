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
 * CARDW-1, CARDW-4, CARDW-7: the card jobs, in order: files the person asked for, files owed a card
 * this session, files changed on the branch without a current card, files merged in the last 14 days
 * without one, then the backfill's (existing code, leaves first); none edited in the last 2 minutes,
 * none twice. [{ path, reason }], reason `asked`, `owed`, `changed`, `recent` or `backfill`.
 */
export function cardJobs({ asked = [], owed = [], changed = [], recent = [], backfill = [], editedAt = {}, now }) {
  const seen = new Set();
  const jobs = [];
  for (const [list, reason] of [
    [asked, 'asked'],
    [owed, 'owed'],
    [changed, 'changed'],
    [recent, 'recent'],
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
      '2. For a file someone just changed, find out why before you write: its last commits (`git log -3 --format="%s%n%b" -- <path>`) and its diff since (`git diff HEAD~1 -- <path>`, or against the base on a branch), and the story or requirement they name. The card says what the change was for, not only what the file does.',
      `3. Write the card with the MCP tool \`card\`, or \`node "${ctx}" card <path> --text "…"\`.`,
      '4. Record a decision only where the file shows one nobody recorded.',
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
 * lead may decline, and that a declined batch's files are skipped this session (CARDW-6).
 */
export function startCardWriterPrompt({ agent, jobs }) {
  const files = jobs.map((j) => j.path);
  return `Start Context Graph's card writer in the background: use the Agent tool with subagent_type "${agent}", run_in_background true, description "${batchDescription(files.length)}", and the prompt "Write the cards for: ${files.join(', ')}." Then carry on; it only writes cards. If these files shouldn't be carded (they aren't code, or the person has asked you not to now), say so and don't start it: Context Graph skips them this session.`;
}

/** Two batches in a row turned down: the lead (or the person through it) means stop, so nothing more is offered this session. */
export const STOP_AFTER = 2;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * CARDW-8: the Overview's one status for explaining the code: how much is explained (from `ctx cards`,
 * the one count the header uses too), and the single thing the card writer is doing about the rest.
 * { explained, total, line, tone, act, skipped } where tone is 'busy', 'waiting', 'held' or 'quiet', and
 * act is the button beside the line: 'pause', 'resume', 'askAgain', 'settings' or null.
 */
export function explainStatus({ cards, on, backfill = false, paused = false, percent = null, heldBy = null, backfillPaused = false, stopped = false, writing = [], waiting = [], skipped = 0 }) {
  const explained = cards?.fresh.length ?? 0;
  const total = cards ? cards.fresh.length + cards.stale.length + cards.missing.length : 0;
  const files = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`;
  const out = (line, tone, act = null) => ({ explained, total, line, tone, act, skipped: stopped ? 0 : skipped });
  if (!on) return out('The card writer is off: a file is explained only when an agent writes its card.', 'quiet', 'settings');
  if (stopped) return out(`Stopped: the lead turned down ${plural(STOP_AFTER, 'batch', 'batches')} in a row, so nothing more is offered this session.`, 'held', 'askAgain');
  if (writing.length) return out(`Explaining ${plural(writing.length, 'file')} now: ${files(writing)}${waiting.length ? `; ${waiting.length} more queued` : ''}`, 'busy', backfill ? 'pause' : null);
  if (heldBy) return out(`Paused while ${heldBy}'s loop is paused; it carries on when that resumes.`, 'held');
  if (paused) return out(`Paused: the plan's 5-hour use is at ${percent}%; it carries on below the pause point.`, 'held');
  if (backfillPaused) return out(`Paused by you${waiting.length ? `; ${waiting.length} still queued` : ''}.`, 'held', 'resume');
  if (waiting.length) return out(`${plural(waiting.length, 'file')} queued; the next batch starts when the lead finishes its turn.`, 'waiting', backfill ? 'pause' : null);
  if (total && explained === total) return out('Every file is explained.', 'quiet');
  if (!backfill) return out("Nothing queued. The existing code is explained only with the backfill on, in Settings.", 'quiet', 'settings');
  return out("Nothing queued: the files left are in modules nobody's changed lately, outside the backfill's scope.", 'quiet', 'settings');
}
