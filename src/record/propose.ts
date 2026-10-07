import { join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { PROPOSALS_FILE } from '../graph/graph.js';
import type { KRecord } from '../graph/records.js';
import { appendRecord } from '../graph/write.js';
import { walk } from '../walker/walk.js';

/**
 * Proposing a rule for a path's module (or a module named outright): appended to proposals.ctx as
 * `K G? …`, for the CLI (`ctx propose`) and the MCP tool (`propose`). Any agent may propose; nothing
 * changes until a person ratifies it, and the gate lets a proposal merge as proposed.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A short id for a rule: the module's name and the text's first words, made unique in the graph. */
export function proposalId(module: string, text: string, taken: (id: string) => boolean): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const words = slug(text).split('-').filter((w) => w.length > 2).slice(0, 3).join('-') || 'rule';
  const base = `${slug(module.replace(/^L:/, '')) || 'repo'}.${words}`;
  let id = base;
  for (let n = 2; taken(id); n++) id = `${base}-${n}`;
  return id;
}

export interface Proposal {
  target: string;
  text: string;
  id?: string | undefined;
  test?: string | undefined;
  rule?: string | undefined;
}

/** Proposes the rule; returns the record written, or why it wasn't. */
export function propose(ctx: RepoContext, p: Proposal, today = new Date().toISOString().slice(0, 10)): { record: KRecord } | { error: string } {
  const g = ctx.graph;
  if (!g) return { error: `No graph for ${ctx.root}: run ctx init first.` };
  const text = p.text.trim().replace(/\s+/g, ' ');
  if (!text) return { error: 'Say what the rule is: ctx propose <path or L:module> "<rule>"' };
  let module = p.target;
  if (!module.startsWith('L:')) {
    const w = walk(g, p.target);
    if (!w.mapped || !w.chain[0]) return { error: `${p.target} isn't mapped to a module in the graph. Name the module (L:…), or map the path first.` };
    module = w.chain[0];
  } else if (!g.logicals.has(module)) return { error: `${module} isn't a module in the graph.` };
  if (p.test && /\s/.test(p.test)) return { error: '--test takes the path of the test that checks the rule, with no spaces.' };
  const same = [...g.constraints.values()].find((k) => k.attachedTo === module && k.text === text && !g.isRetired(k.id));
  if (same) return { error: `${module} already has this rule${same.mode === 'G?' ? ' proposed' : ''}, as ${same.id}.` };
  if (p.id && !ID.test(p.id)) return { error: `${p.id} isn't a usable id: letters, digits, dots, dashes and underscores.` };
  if (p.id && g.constraints.has(p.id)) return { error: `${p.id} is already a rule's id; pick another, or leave --id out.` };
  const id = p.id ?? proposalId(module, text, (x) => g.constraints.has(x));
  const record: KRecord = { kind: 'K', mode: 'G?', id, attachedTo: module, text, since: today, line: 0, file: PROPOSALS_FILE };
  if (p.test) record.test = p.test;
  if (p.rule) record.rule = p.rule;
  appendRecord(join(ctx.graphDir!, PROPOSALS_FILE), record);
  return { record };
}

