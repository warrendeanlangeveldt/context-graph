import type { Graph } from '../graph/graph.js';
import { isActiveMode, isPathId, type DRecord, type ERecord } from '../graph/records.js';
import { appendRecord } from '../graph/write.js';
import type { PendingEntry, SessionState } from '../observe/store.js';
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
  constructor(readonly graph: Graph, readonly state: SessionState) {}

  /** Register an edit. Only nodes with an enforced or guided constraint owe a decision. */
  notePending(w: WalkResult): boolean {
    if (!demandsDecision(w)) return false;
    const key = w.path;
    const existing = this.state.data.pending[key];
    const entry: PendingEntry = {
      path: w.path,
      constraints: w.constraints.filter((k) => isActiveMode(k) || k.mode === 'G?').map((k) => k.id),
      since: existing?.since ?? new Date().toISOString(),
      sinceId: existing?.sinceId ?? this.graph.nextDecisionId(),
    };
    if (w.symbol) entry.symbol = w.symbol;
    this.state.data.pending[key] = entry;
    this.state.save();
    return true;
  }

  /**
   * What still owes a decision. A decision recorded on the path since the edit was noted settles it,
   * whichever process recorded it: the MCP server, a shell command, or this hook. Without this, a
   * decision recorded elsewhere left the entry here and the turn-end give-up wrote a decline beside it.
   */
  pending(): PendingEntry[] {
    let changed = false;
    for (const [key, p] of Object.entries(this.state.data.pending)) {
      if (!p.sinceId) continue;
      const settled = [...this.graph.decisions.values()].some((d) => d.node.split('#')[0] === p.path && idNumber(d.id) >= idNumber(p.sinceId!));
      if (settled) { delete this.state.data.pending[key]; changed = true; }
    }
    if (changed) this.state.save();
    return Object.values(this.state.data.pending);
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
    g.decisions.set(decision.id, decision);

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
  stopDecision(opts: { maxBlocks: number; stopHookActive?: boolean; who: string; branch: string }): { block: boolean; reason?: string; gaveUp: DRecord[] } {
    const pending = this.pending();
    if (!pending.length) {
      this.state.data.blocks = 0;
      this.state.data.lastPendingKey = '';
      this.state.save();
      return { block: false, gaveUp: [] };
    }
    const key = pending.map((p) => p.path).sort().join('|');
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
      this.state.data.blocks = 0;
      this.state.data.lastPendingKey = '';
      this.state.save();
      return { block: false, gaveUp };
    }

    const lines = pending.map((p) => {
      const active = p.constraints.filter((id) => this.graph.constraints.get(id)?.mode !== 'G?');
      const proposed = p.constraints.length - active.length;
      const shown = [...active.slice(0, 6), ...(active.length > 6 ? [`+${active.length - 6} more`] : []), ...(proposed ? [`+${proposed} proposed`] : [])];
      return `  ${p.path}${p.symbol ? `#${p.symbol}` : ''}  [${shown.join(', ')}]`;
    });
    const proposedOnly = pending.every((p) => p.constraints.every((id) => this.graph.constraints.get(id)?.mode === 'G?'));
    const reason = [
      `Context Graph: ${pending.length} edited ${pending.length === 1 ? 'file has' : 'files have'} constraints and no recorded decision.`,
      ...lines,
      ...(proposedOnly ? ['These rules are proposed, not yet ratified. A decision that serves one is the evidence that ratifies it; one that overrides it is the evidence that retires it. Record what you actually did and why.'] : []),
      'Record one decision per file with the ctx MCP tool `record` (node, serves = the constraint or concept it honours, text = why; add overrides when you deliberately broke a guided constraint), or from the shell: ctx record --node <path> --serves <id> --text "<why>".',
      'To decline, point serves at the most specific constraint and set text to "no-decision: <reason>".',
    ].join('\n');
    return { block: true, reason, gaveUp: [] };
  }
}

function idNumber(id: string): number { return Number(/(\d+)$/.exec(id)?.[1] ?? 0); }

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
