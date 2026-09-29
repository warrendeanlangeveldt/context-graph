import { cardState } from '../cards/cards.js';
import type { Graph } from '../graph/graph.js';
import { isActiveMode, isPathId, type DRecord, type ERecord } from '../graph/records.js';
import { appendRecord } from '../graph/write.js';
import type { PendingEntry, SessionState } from '../observe/store.js';
import { readRepoText } from '../util/paths.js';
import { walk, demandsDecision, type WalkResult } from '../walker/walk.js';

export interface RecordInput {
  node: string;
  serves: string;
  overrides?: string;
  text: string;
  who: string;
  branch: string;
  date?: string;
}

export interface RecordResult {
  decision: DRecord;
  proposedEdge?: ERecord;
  outsideApplicable: boolean;
  warnings: string[];
}

export class RecordError extends Error {
  constructor(message: string, readonly applicable: string[] = []) { super(message); }
}

/**
 * Decision recording (design spec §9). Tracks which edited nodes still owe a decision, validates
 * and appends decisions, and implements the turn-end demand with its loop guard.
 */
export class Recorder {
  /** `root` is the checkout the agent edits in; cards are checked against its files. */
  constructor(readonly graph: Graph, readonly state: SessionState, readonly root?: string) {}

  /**
   * Register an edit. Only nodes with an enforced or guided constraint owe a decision. Noted before the
   * tool runs (`provisional`), an entry counts only once the same call completes (`confirm`): another
   * hook may refuse the call, and a refused edit owes nothing.
   */
  notePending(w: WalkResult, toolUseId?: string, opts: { provisional?: boolean } = {}): boolean {
    if (!demandsDecision(w, this.graph)) return false;
    const key = w.path;
    const existing = this.state.data.pending[key];
    const entry: PendingEntry = {
      path: w.path,
      constraints: w.constraints.filter((k) => isActiveMode(k) || k.mode === 'G?').map((k) => k.id),
      since: existing?.since ?? new Date().toISOString(),
      known: existing?.known ?? this.decisionIdsOn(w.path),
    };
    if (existing?.sinceId) entry.sinceId = existing.sinceId;
    if (w.symbol) entry.symbol = w.symbol;
    // A confirmed entry keeps the call that made it; one still waiting follows the latest call (a retry
    // after a refusal is the edit that happens).
    const tu = existing && !existing.provisional ? (existing.toolUseId ?? toolUseId) : (toolUseId ?? existing?.toolUseId);
    if (tu) entry.toolUseId = tu;
    // An entry already confirmed stays confirmed; a new one noted ahead of its tool call waits.
    // Without a call id there is no completion to wait for, so the entry counts at once.
    if (opts.provisional && tu && (!existing || existing.provisional)) entry.provisional = true;
    this.state.data.pending[key] = entry;
    this.state.save();
    return true;
  }

  /** The tool call completed: the edits it announced happened. */
  confirm(toolUseId: string | undefined): void {
    if (!toolUseId) return;
    let changed = false;
    for (const p of Object.values(this.state.data.pending)) if (p.toolUseId === toolUseId && p.provisional) { delete p.provisional; changed = true; }
    if (changed) this.state.save();
  }

  /** At turn end: edits announced but never completed (refused, interrupted) owe nothing. */
  dropProvisional(): void {
    let changed = false;
    for (const [key, p] of Object.entries(this.state.data.pending)) if (p.provisional) { delete this.state.data.pending[key]; changed = true; }
    if (changed) this.state.save();
  }

  private decisionIdsOn(path: string): string[] {
    return [...this.graph.decisions.values()].filter((d) => d.node.split('#')[0] === path).map((d) => d.id);
  }

  /**
   * What still owes a decision. A decision recorded on the path since the edit was noted settles it,
   * whichever process recorded it: the MCP server, a shell command, or this hook. Without this, a
   * decision recorded elsewhere left the entry here and the turn-end give-up wrote a decline beside it.
   * Edits noted ahead of a tool call that has not completed are not owed yet.
   */
  pending(): PendingEntry[] {
    let changed = false;
    for (const [key, p] of Object.entries(this.state.data.pending)) {
      const known = p.known ? new Set(p.known) : undefined;
      const settled = [...this.graph.decisions.values()].some((d) =>
        d.node.split('#')[0] === p.path && (known ? !known.has(d.id) : p.sinceId !== undefined && idNumber(d.id) >= idNumber(p.sinceId)));
      if (settled) { delete this.state.data.pending[key]; changed = true; }
    }
    if (changed) this.state.save();
    return Object.values(this.state.data.pending).filter((p) => !p.provisional);
  }

  /** A tool call that failed edited nothing: forget the edits it announced, keep any it merely repeated. */
  dropPendingFrom(toolUseId: string | undefined): void {
    if (!toolUseId) return;
    let changed = false;
    for (const [key, p] of Object.entries(this.state.data.pending)) if (p.toolUseId === toolUseId) { delete this.state.data.pending[key]; changed = true; }
    if (changed) this.state.save();
  }

  // ---- cards ------------------------------------------------------------------------------

  /** This agent edited `path`: its card is owed until one matches the file's new content. */
  owesCard(path: string): void {
    const owed = (this.state.data.cardsOwed ??= {});
    if (owed[path]) return;
    owed[path] = { path, since: new Date().toISOString() };
    this.state.save();
  }

  /** Files whose card is still owed. A card matching the file settles it, whoever wrote it; a deleted file owes nothing. */
  cardsOwed(): string[] {
    const owed = this.state.data.cardsOwed ?? {};
    let changed = false;
    for (const path of Object.keys(owed)) {
      const gone = this.root !== undefined && readRepoText(this.root, path) === undefined;
      const settled = this.root !== undefined && cardState(this.graph, this.root, path).fresh;
      if (gone || settled) { delete owed[path]; changed = true; }
    }
    if (changed) this.state.save();
    return Object.keys(owed).sort();
  }

  /**
   * The ask, made once on the next tool call rather than by holding the turn open. Most decisions are
   * recorded from here, which is the point: the turn-end block is a backstop, and a backstop that rarely
   * fires is the difference between a prompt and an interruption.
   */
  nudge(opts: { cards?: boolean } = {}): string | undefined {
    const pending = this.pending();
    const cards = opts.cards ? this.cardsOwed() : [];
    if (!pending.length && !cards.length) return undefined;
    const key = [...pending.map((p) => p.path).sort(), '|cards|', ...cards].join('|');
    if (this.state.data.nudgedKey === key) return undefined;
    this.state.data.nudgedKey = key;
    this.state.save();
    const out: string[] = [];
    if (pending.length) {
      out.push(
        `Context Graph: ${pending.length === 1 ? 'a file you edited carries rules' : `${pending.length} files you edited carry rules`} and owes a decision.`,
        ...pending.map((p) => `  ${p.path}${p.symbol ? `#${p.symbol}` : ''}  [${activeFirst(this.graph, p.constraints)}]`),
        'Record it now with the `record` tool (node, serves, text = why) while the reason is fresh. The turn will otherwise stop to ask.',
      );
    }
    if (cards.length) out.push(cardAsk(cards));
    return out.join('\n');
  }

  clearPending(node: string): void {
    const path = node.split('#')[0]!;
    delete this.state.data.pending[path];
    delete this.state.data.pending[node];
    this.state.save();
  }

  record(input: RecordInput): RecordResult {
    const g = this.graph;
    const warnings: string[] = [];
    const node = g.resolve(input.node);
    const w = isPathId(node) ? walk(g, node) : undefined;
    const applicable = w?.applicable ?? [];

    let serves = input.serves;
    if (!g.targetExists(serves) && g.targetExists(`C:${serves}`)) serves = `C:${serves}`;
    if (!g.targetExists(serves)) {
      throw new RecordError(`-> target ${input.serves} does not exist as a constraint or concept`, applicable);
    }
    if (g.isRetired(serves)) warnings.push(`${serves} is retired; point at its successor if one exists`);

    let overrides = input.overrides;
    if (overrides) {
      const k = g.activeConstraint(overrides);
      if (!k) throw new RecordError(`!${overrides} is not an active constraint`, applicable);
      if (k.mode === 'E') throw new RecordError(`!${overrides} overrides an enforced constraint; change its test instead of recording an override`, applicable);
      overrides = k.id;
    }

    const outsideApplicable = w !== undefined && !applicable.includes(serves) && !(serves.startsWith('C:') && w.concepts.includes(serves));

    const decision: DRecord = {
      kind: 'D',
      id: g.nextDecisionId(),
      date: input.date ?? today(),
      who: input.who,
      sha: '-',
      branch: input.branch,
      node,
      serves,
      text: input.text.replace(/\s+/g, ' ').trim(),
      line: 0,
    };
    if (overrides) decision.overrides = overrides;
    if (!decision.text) throw new RecordError('decision text is required', applicable);
    appendRecord(g.decisionsFile, decision);
    g.addDecision(decision);

    let proposedEdge: ERecord | undefined;
    if (outsideApplicable && w) {
      const from = w.chain[0] ?? node;
      const target = serves.startsWith('C:') ? serves : (g.constraints.get(serves)?.attachedTo ?? serves);
      if (from !== target) {
        proposedEdge = { kind: 'E', from, rel: serves.startsWith('C:') ? 'impl' : 'dep', to: target, proposed: true, line: 0 };
        appendRecord(g.proposalsFile, proposedEdge);
        warnings.push(`-> ${serves} is outside the applicable set for ${node}; proposed edge ${from} ${proposedEdge.rel} ${target}`);
      }
    }

    this.clearPending(node);
    const result: RecordResult = { decision, outsideApplicable, warnings };
    if (proposedEdge) result.proposedEdge = proposedEdge;
    return result;
  }

  /**
   * Turn-end demand (design spec §9.1 and §15.1 loop guard). Blocks while nodes owe decisions,
   * up to `maxBlocks` consecutive times on the same pending set, then records no-decision
   * entries so the session can end.
   */
  stopDecision(opts: { maxBlocks: number; stopHookActive?: boolean; who: string; branch: string; decisions?: boolean; cards?: boolean }): { block: boolean; reason?: string; gaveUp: DRecord[]; cardsUnwritten: string[] } {
    this.dropProvisional();
    const pending = opts.decisions === false ? [] : this.pending();
    const cards = opts.cards ? this.cardsOwed() : [];
    if (!pending.length && !cards.length) {
      this.state.data.blocks = 0;
      this.state.data.lastPendingKey = '';
      this.state.save();
      return { block: false, gaveUp: [], cardsUnwritten: [] };
    }
    const key = [...pending.map((p) => p.path).sort(), '|cards|', ...cards].join('|');
    if (this.state.data.lastPendingKey === key) this.state.data.blocks += 1;
    else { this.state.data.lastPendingKey = key; this.state.data.blocks = 1; }
    this.state.save();

    const exhausted = this.state.data.blocks > opts.maxBlocks || (opts.stopHookActive === true && this.state.data.blocks >= opts.maxBlocks);
    if (exhausted) {
      const gaveUp: DRecord[] = [];
      for (const p of pending) {
        const serves = p.constraints[0];
        if (!serves) continue;
        const r = this.record({
          node: p.path,
          serves,
          text: `no-decision: unrecorded after ${this.state.data.blocks} prompts`,
          who: opts.who,
          branch: opts.branch,
        });
        gaveUp.push(r.decision);
      }
      this.state.data.pending = {};
      // A card is never invented to end a turn: an unwritten one stays owed as a finding, and the next
      // agent to edit the file reads it in full because no fresh card exists.
      const cardsUnwritten = cards;
      this.state.data.cardsOwed = {};
      this.state.data.blocks = 0;
      this.state.data.lastPendingKey = '';
      this.state.save();
      return { block: false, gaveUp, cardsUnwritten };
    }

    const out: string[] = [`Context Graph is asking for ${pending.length && cards.length ? 'decisions and cards' : pending.length ? 'a decision' : 'file cards'} before this turn ends. This is the demand working, not a failure.`];
    if (pending.length) {
      const proposedOnly = pending.every((p) => p.constraints.every((id) => this.graph.constraints.get(id)?.mode === 'G?'));
      out.push(
        `${pending.length} edited ${pending.length === 1 ? 'file carries rules' : 'files carry rules'} and has no recorded decision:`,
        ...pending.map((p) => `  ${p.path}${p.symbol ? `#${p.symbol}` : ''}  [${activeFirst(this.graph, p.constraints)}]`),
        ...(proposedOnly ? ['These rules are proposed, not yet ratified. A decision that serves one is the evidence that ratifies it; one that overrides it is the evidence that retires it. Record what you actually did and why.'] : []),
        'Record one decision per file with the ctx MCP tool `record` (node, serves = the constraint or concept it honours, text = why; add overrides when you deliberately broke a guided constraint), or from the shell: ctx record --node <path> --serves <id> --text "<why>".',
        'To decline, point serves at the most specific constraint and set text to "no-decision: <reason>".',
      );
    }
    if (cards.length) out.push(cardAsk(cards));
    return { block: true, reason: out.join('\n'), gaveUp: [], cardsUnwritten: [] };
  }
}

/** The ask for cards: what a card holds, and both ways to write one. */
function cardAsk(paths: string[]): string {
  return [
    `${paths.length === 1 ? 'A file you edited has' : `${paths.length} files you edited have`} no card matching its content:`,
    ...paths.map((p) => `  ${p}`),
    'Write or update each card while you still hold the file in context: what it is for, what it relies on, who relies on it, and what it must keep true. The next agent reads this instead of rediscovering it.',
    'MCP tool `card` (path, text), or from the shell in the checkout you edited: ctx card <path> --text "<why the file exists and what it must keep true>". If the card is still right, rewrite it as it is so it matches the new content.',
  ].join('\n');
}

/** Ratified rules named, proposed ones counted: a file under thirty proposals should not print thirty ids. */
function activeFirst(graph: Graph, ids: string[]): string {
  const active = ids.filter((id) => graph.constraints.get(id)?.mode !== 'G?');
  const proposed = ids.length - active.length;
  return [...active.slice(0, 6), ...(active.length > 6 ? [`+${active.length - 6} more`] : []), ...(proposed ? [`+${proposed} proposed`] : [])].join(', ');
}

function idNumber(id: string): number { return Number(/(\d+)$/.exec(id)?.[1] ?? 0); }

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
