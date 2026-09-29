/**
 * Record types for the `.ctx` line grammar (design spec §6).
 *
 *   M <glob> <logical-id>
 *   L <logical-id> <name>
 *   C <concept-id> <name> [adr:<ref>] [proposed]
 *   E <from> <rel> <to> [proposed]
 *   K <mode> <k-id> <attached-to> <text> [test:<path>] [from:<pack>@<version>]
 *   D <d-id> <date> <who> <sha> <branch> <node> -><target> [!<k-id>] <text>
 *   S <new-d-id> <old-d-id>
 *   Z <k-id|c-id> <date> <who> [succ:<id>] <reason>
 *   A <alias> <node>
 *   R <{role}> <detection heuristic>
 *   F <path> <hash> <date> <who> <text> [req:<id>,<id>]
 */

export type ConstraintMode = 'E' | 'G' | 'R' | 'G?';
export type Relation = 'in' | 'impl' | 'dep';

interface Base {
  /** 1-based line in the source file. 0 for records created in memory. */
  line: number;
  file?: string;
}

export interface MRecord extends Base { kind: 'M'; glob: string; logical: string }
export interface LRecord extends Base { kind: 'L'; id: string; name: string }
export interface CRecord extends Base { kind: 'C'; id: string; name: string; adr?: string; proposed?: boolean; since?: string }
export interface ERecord extends Base { kind: 'E'; from: string; rel: Relation; to: string; proposed?: boolean; since?: string }
export interface KRecord extends Base {
  kind: 'K';
  mode: ConstraintMode;
  id: string;
  attachedTo: string;
  text: string;
  test?: string;
  from?: string;
  /** Machine-checkable rule, e.g. `noimport:L:domain:L:infra` or `public-entry:L:core`. */
  rule?: string;
  since?: string;
}
export interface DRecord extends Base {
  kind: 'D';
  id: string;
  date: string;
  who: string;
  sha: string;
  branch: string;
  node: string;
  /** Constraint id, or concept id with its `C:` prefix. */
  serves: string;
  overrides?: string;
  text: string;
}
export interface SRecord extends Base { kind: 'S'; newId: string; oldId: string }
export interface ZRecord extends Base { kind: 'Z'; target: string; date: string; who: string; succ?: string; reason: string }
export interface ARecord extends Base { kind: 'A'; alias: string; node: string }
export interface RRecord extends Base { kind: 'R'; role: string; heuristic: string }
/**
 * A file card: what a file is for, what it relies on, who relies on it, the invariants it keeps.
 * Decisions hold the why of each change; a card holds the why of the file. `hash` is the file's content
 * hash when the card was written, so a card is fresh only while the file is unchanged. The latest card
 * for a path is the one in force. `req` names requirements the file delivers, from a spec tool.
 */
export interface FRecord extends Base { kind: 'F'; path: string; hash: string; date: string; who: string; text: string; req?: string[] }

export type GraphRecord =
  | MRecord | LRecord | CRecord | ERecord | KRecord | DRecord | SRecord | ZRecord | ARecord | RRecord | FRecord;

export const isLogicalId = (id: string): boolean => id.startsWith('L:');
export const isConceptId = (id: string): boolean => id.startsWith('C:');
export const isPathId = (id: string): boolean => !isLogicalId(id) && !isConceptId(id);

/** Split `path#symbol` into its parts. */
export function splitSymbol(id: string): { path: string; symbol?: string } {
  const i = id.indexOf('#');
  if (i < 0) return { path: id };
  return { path: id.slice(0, i), symbol: id.slice(i + 1) };
}

export function isEnforced(k: KRecord): boolean { return k.mode === 'E'; }
export function isGuided(k: KRecord): boolean { return k.mode === 'G'; }
export function isProposed(k: KRecord): boolean { return k.mode === 'G?'; }
export function isRecorded(k: KRecord): boolean { return k.mode === 'R'; }
/** Constraints that the slice must never drop and that the recorder demands decisions for. */
export function isActiveMode(k: KRecord): boolean { return k.mode === 'E' || k.mode === 'G'; }
