/** Observation model (design spec §8 and §14.2). One envelope per line in the session's JSONL. */

export type AccessMode =
  | 'full' | 'range' | 'grep' | 'name'
  | 'edit' | 'write' | 'delete'
  | 'delegated' | 'summarized' | 'failed' | 'external';

export interface Touch {
  path: string;
  mode: AccessMode;
  range?: [number, number];
  bytes?: number;
  tool: string;
  origin: 'main' | 'subagent';
  agent?: string;
  /** The observer could not classify the command; the path was inferred from an argument. */
  unparsed?: boolean;
}

export type EnvelopeType =
  | 'touch' | 'edit' | 'slice' | 'card' | 'decision' | 'coverage' | 'session' | 'compact' | 'reach' | 'finding';

export interface Envelope<T = unknown> {
  t: EnvelopeType;
  ts: string;
  session: string;
  who: string;
  branch: string;
  harness: string;
  p: T;
}

export interface SlicePayload { path: string; applicable: string[]; tokens: number; rendered: string; dropped: string[] }
/** A module card, injected the first time a session reads under a module. */
export interface CardPayload { module: string; path: string; tokens: number; rendered: string; dropped: string[] }
export interface SessionPayload { kind: 'start' | 'end' | 'subagent-start' | 'subagent-stop'; cwd: string; worktree?: string; arm: 'on' | 'off'; agent?: string; agentType?: string; reason?: string }
export interface CompactPayload { paths: string[] }
export interface ReachPayload { tool: string; nodes: string[] }
export interface FindingPayload { rule: string; message: string; path?: string }

export const EDIT_MODES: ReadonlySet<AccessMode> = new Set(['edit', 'write', 'delete']);
export const isEditMode = (m: AccessMode): boolean => EDIT_MODES.has(m);

/** How much of a file a mode puts in context. Higher wins when merging touches on one path. */
export const MODE_RANK: Record<AccessMode, number> = {
  full: 6, write: 6, range: 5, edit: 5, grep: 3, delegated: 2, summarized: 1, name: 1, external: 0, failed: 0, delete: 0,
};

export function envelope<T>(t: EnvelopeType, meta: { session: string; who: string; branch: string; harness: string }, p: T): Envelope<T> {
  return { t, ts: new Date().toISOString(), ...meta, p };
}
