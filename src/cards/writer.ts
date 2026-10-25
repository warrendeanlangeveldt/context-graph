import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutHash, ctxHome } from '../util/paths.js';

/**
 * COST-4 (docs/specs/10-cost.md): one session per checkout runs the card writer and the backfill. Seven
 * sessions in one checkout would otherwise each scan it and spend tokens on the same backlog. The first
 * session to claim the checkout runs them until it ends or hasn't been seen for two minutes; the others
 * start nothing. Kept under the ctx home, beside the hash cache.
 */

/** A writer not seen for this long has stopped: another session may take over. */
export const WRITER_STALE_MS = 2 * 60_000;

export interface WriterClaim {
  /** Whether this session runs the checkout's background work. */
  mine: boolean;
  /** The session that does, or null when none does. */
  session: string | null;
  since: string | null;
}

interface Record {
  session: string;
  since: string;
  seen: number;
}

const fileOf = (root: string): string => join(ctxHome(), 'writers', `${checkoutHash(root)}.json`);

function read(root: string): Record | null {
  try {
    return JSON.parse(readFileSync(fileOf(root), 'utf8')) as Record;
  } catch {
    return null;
  }
}

/** The checkout's writer as it stands, without claiming it. */
export function currentWriter(root: string, now = Date.now()): Record | null {
  const r = read(root);
  return r && now - r.seen < WRITER_STALE_MS ? r : null;
}

/**
 * Claims the checkout's background work for `session`, or renews its claim: taken when nobody holds it,
 * when the holder hasn't been seen for two minutes, or when it's this session's already.
 */
export function claimWriter(root: string, session: string, now = Date.now()): WriterClaim {
  const held = currentWriter(root, now);
  if (held && held.session !== session) return { mine: false, session: held.session, since: held.since };
  const record: Record = { session, since: held?.since ?? new Date(now).toISOString(), seen: now };
  try {
    mkdirSync(join(fileOf(root), '..'), { recursive: true });
    writeFileSync(fileOf(root), JSON.stringify(record), 'utf8');
  } catch {
    // A read-only home: nothing can be shared, so this session runs it.
  }
  return { mine: true, session, since: record.since };
}

/** Ends `session`'s claim, so another session takes over at once instead of in two minutes. */
export function releaseWriter(root: string, session: string): void {
  const r = read(root);
  if (r?.session !== session) return;
  try {
    rmSync(fileOf(root), { force: true });
  } catch {
    /* gone already */
  }
}
