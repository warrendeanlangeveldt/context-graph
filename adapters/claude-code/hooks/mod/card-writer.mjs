// The card writer (docs/specs/04-card-writer.md), the pure parts: what it should work on, the request
// that writes one file's card, and how its reply is read. The mod writes the cards itself, a file at a
// time, with its own model requests: a mod can't start an agent in auto mode (Claude Code refuses a
// plugin's $.agent.spawn there), and asking the lead to start one put Context Graph's request in the
// person's conversation. Nothing it does reaches the lead.
/** A file an agent edited this recently waits: the card would describe a file still moving (CARDW-1). */
export const SETTLE_MS = 2 * 60000;

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

/** The card writer's model when the setting names none: a card is a short read of one file. */
export const DEFAULT_MODEL = 'sonnet';
/** What one card's prompt carries of the file, of each import, and of its last change. */
const FILE_CHARS = 60000;
const IMPORT_CHARS = 6000;
const IMPORTS = 8;
const DIFF_CHARS = 8000;

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}\n[… cut at ${n} characters]` : text);

/**
 * CARDW-2, CARDW-7: the one request that writes a file's card, made by the mod itself (a mod can't start
 * an agent in auto mode, and asking the lead to start one put the request in the person's conversation).
 * It carries the file in full, each import (by its current card, or its source), who imports it, and for
 * a file just changed its last commits and diff, so the card says what the change was for.
 */
export function cardPrompt({ path, text, imports = [], importers = [], commits = '', diff = '', card = null }) {
  return [
    `Write the Context Graph card for ${path}: what the file is for, what it relies on, who relies on it, and what it must keep true. Two to five plain sentences, no headings or lists. Say why the file is as it is, not a line-by-line summary.`,
    "If it isn't source code (a binary, media, generated output, a data or lookup table, a document), don't write a card: answer `SKIP: <why, in a few words>` and nothing else.",
    'Otherwise answer with the card text and nothing else.',
    '',
    `## ${path}`,
    '```',
    clip(text, FILE_CHARS),
    '```',
    ...(card ? ['', `Its card before this change: ${card}`] : []),
    ...(imports.length
      ? [
          '',
          '## What it imports',
          ...imports.slice(0, IMPORTS).flatMap((i) =>
            i.card ? [`- ${i.path}: ${i.card}`] : [`- ${i.path}:`, '```', clip(i.text ?? '', IMPORT_CHARS), '```'],
          ),
        ]
      : []),
    ...(importers.length ? ['', `## What imports it`, importers.map((p) => `- ${p}`).join('\n')] : []),
    ...(commits.trim() ? ['', '## Its last commits', commits.trim()] : []),
    ...(diff.trim() ? ['', '## Its uncommitted or last change', '```diff', clip(diff.trim(), DIFF_CHARS), '```'] : []),
  ].join('\n');
}

/** The reply as the card writer reads it: { card } to write, { skip } when it isn't code, or null. */
export function readCardReply(text) {
  const reply = String(text ?? '').trim().replace(/^```\w*\n?|\n?```$/g, '').trim();
  if (!reply) return null;
  const skip = /^SKIP:?\s*(.*)$/is.exec(reply);
  if (skip) return { skip: skip[1].trim() || "it isn't code" };
  const card = reply.replace(/\s+/g, ' ').trim();
  return card.length >= 20 ? { card } : null;
}

/** After a request fails, the card writer waits this long before the next. */
export const RETRY_MS = 60000;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * CARDW-8: the Overview's one status for explaining the code: how much is explained (from `ctx cards`,
 * the one count the header uses too), and the single thing the card writer is doing about the rest.
 * { explained, total, line, tone, act, skipped } where tone is 'busy', 'waiting', 'held' or 'quiet', and
 * act is the button beside the line: 'pause', 'resume', 'settings' or null. `skipped`: files it found
 * aren't code this session; `error`: why the last request failed, while it waits to try again.
 */
export function explainStatus({ cards, on, backfill = false, paused = false, percent = null, heldBy = null, backfillPaused = false, writing = [], waiting = [], skipped = 0, error = null, elsewhere = false }) {
  const explained = cards?.fresh.length ?? 0;
  const total = cards ? cards.fresh.length + cards.stale.length + cards.missing.length : 0;
  const files = (list) => `${list.slice(0, 3).join(', ')}${list.length > 3 ? ', …' : ''}`;
  const out = (line, tone, act = null) => ({ explained, total, line, tone, act, skipped });
  if (!on) return out('The card writer is off: a file is explained only when an agent writes its card.', 'quiet', 'settings');
  // COST-4: one session per checkout runs the card writer; the others show its progress.
  if (elsewhere) return out('Another session is explaining the files for this checkout; it carries on here if that one ends.', 'quiet');
  if (writing.length) return out(`Explaining ${files(writing)} now${waiting.length ? `; ${waiting.length} more queued` : ''}`, 'busy', backfill ? 'pause' : null);
  if (heldBy) return out(`Paused while ${heldBy}'s loop is paused; it carries on when that resumes.`, 'held');
  if (paused) return out(`Paused: the plan's 5-hour use is at ${percent}%; it carries on below the pause point.`, 'held');
  if (backfillPaused) return out(`Paused by you${waiting.length ? `; ${waiting.length} still queued` : ''}.`, 'held', 'resume');
  if (error && waiting.length) return out(`The last card couldn't be written (${error}); it tries again in a minute.`, 'held');
  if (waiting.length) return out(`${plural(waiting.length, 'file')} queued, written in the background one at a time.`, 'waiting', backfill ? 'pause' : null);
  if (total && explained === total) return out('Every file is explained.', 'quiet');
  if (!backfill) return out("Nothing queued. The existing code is explained only with the backfill on, in Settings.", 'quiet', 'settings');
  return out("Nothing queued: the files left are in modules nobody's changed lately, outside the backfill's scope.", 'quiet', 'settings');
}
