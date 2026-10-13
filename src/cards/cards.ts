import { createHash } from 'node:crypto';
import picomatch from 'picomatch';
import type { Graph } from '../graph/graph.js';
import type { FRecord } from '../graph/records.js';
import { appendRecord } from '../graph/write.js';
import { readRepoText } from '../util/paths.js';
import { estimateTokens } from '../util/tokens.js';

/**
 * File cards: the why of a file, kept beside the decisions that hold the why of each change. The loop
 * they close: before an edit, a file with a fresh card is understood through its card; a file without
 * one (or whose content has changed since) must be read in full first; after the edit, the card is
 * written or brought up to date. Understanding then accumulates per file instead of being rebuilt by
 * every session.
 */

/** Content hash of a file's text, as a card records it. */
export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}

export interface CardState {
  card?: FRecord;
  /** The card matches the file as it is now. */
  fresh: boolean;
  /** The file's current hash; undefined when it does not exist or isn't text. */
  hash?: string;
}

/**
 * A file's text as a card describes it; undefined when it doesn't exist or isn't text. A document, an
 * archive or an image (a NUL in its first 8000 bytes, as git decides) is never code, so it owes no card.
 */
function cardText(root: string, path: string): string | undefined {
  const text = readRepoText(root, path);
  return text === undefined || text.slice(0, 8000).includes('\0') ? undefined : text;
}

export function cardState(graph: Graph, root: string, path: string): CardState {
  const card = graph.cards.get(path);
  const text = cardText(root, path);
  const hash = text === undefined ? undefined : contentHash(text);
  const out: CardState = { fresh: Boolean(card && hash && card.hash === hash) };
  if (card) out.card = card;
  if (hash) out.hash = hash;
  return out;
}

/** Files that owe no card and need no read before an edit: generated, vendored, lockfiles, the graph itself. */
export function exemptFromCards(path: string, exclude: string[]): boolean {
  if (path.startsWith('/') || path === '.') return true;
  return picomatch(exclude, { dot: true })(path);
}

export interface CardInput { path: string; text: string; who: string; date: string; req?: string[] }

/** Write a card for the file as it is now. Throws when the file does not exist. */
export function writeCard(graph: Graph, root: string, input: CardInput): FRecord {
  const text = cardText(root, input.path);
  if (text === undefined)
    throw new Error(readRepoText(root, input.path) === undefined ? `${input.path} does not exist; a card describes a file as it is` : `${input.path} isn't text (a document, an archive or an image); cards are for code`);
  const body = input.text.replace(/\s+/g, ' ').trim();
  if (!body) throw new Error('card text is required: what the file is for, what it relies on, who relies on it, what it must keep true');
  const card: FRecord = { kind: 'F', path: input.path, hash: contentHash(text), date: input.date, who: input.who, text: body, line: 0 };
  if (input.req?.length) card.req = input.req;
  appendRecord(graph.cardsFile, card);
  graph.cards.set(card.path, card);
  return card;
}

/** The card as injected: fresh, or marked stale so the reader knows the file has moved on since. */
export function renderFileCard(path: string, state: CardState, facts: string[] = []): { text: string; tokens: number } | undefined {
  if (!state.card && !facts.length) return undefined;
  const lines = [`file ${path}`];
  if (state.card) {
    const c = state.card;
    lines.push(`  card  ${c.text}${c.req?.length ? `  [${c.req.join(', ')}]` : ''}  (${c.date.slice(5)} ${c.who}${state.fresh ? '' : '; STALE: the file changed since, read it in full'})`);
  }
  for (const f of facts) lines.push(`  ${f}`);
  const text = lines.join('\n');
  return { text, tokens: estimateTokens(text) };
}
