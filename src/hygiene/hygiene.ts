import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { DECISIONS_FILE, GRAPH_FILE, Graph } from '../graph/graph.js';
import { parseLine, parseText } from '../graph/parse.js';
import { isPathId, splitSymbol, type DRecord, type GraphRecord, type KRecord, type SRecord, type ZRecord } from '../graph/records.js';
import { appendRecord, formatRecord } from '../graph/write.js';
import { detectBindings, loadPacks } from '../init/packs.js';
import { git, gitPerson } from '../util/git.js';
import { toAbsolute } from '../util/paths.js';

/**
 * Hygiene and evolution (design spec §21). The walker reads only the active set; the ledger
 * keeps everything. Hygiene proposes from evidence and never retires; archival moves only what
 * is already inactive; retirement is a record with a reason.
 */
export interface HygieneFinding {
  signal: string;
  target: string;
  evidence: string[];
  proposal: string;
  level: 'propose' | 'info';
}

export function hygieneReport(ctx: RepoContext): HygieneFinding[] {
  const g = ctx.graph;
  if (!g || !ctx.graphDir) throw new Error('no graph');
  const cfg = ctx.config.hygiene;
  const out: HygieneFinding[] = [];
  const today = Date.now();
  const ageDays = (date: string): number => Math.floor((today - new Date(date).getTime()) / 86_400_000);

  // Overridden in practice.
  for (const k of g.constraints.values()) {
    if (k.mode !== 'G' || g.isRetired(k.id)) continue;
    const recent = [...g.decisions.values()].filter((d) => g.isActiveDecision(d) && (d.serves === k.id || d.overrides === k.id) && !/^legacy:/.test(d.text)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, cfg.overrideStreak);
    if (recent.length >= cfg.overrideStreak && recent.every((d) => d.overrides === k.id)) {
      out.push({ signal: 'overridden-in-practice', target: k.id, evidence: recent.map((d) => `${d.id} ${d.date} ${d.who}: ${d.text}`), proposal: `retire ${k.id} (ctx retire ${k.id} --reason ...), or enforce it with a test and fix the code; the choice is a design decision`, level: 'propose' });
    }
  }

  // Unreachable attachments.
  for (const k of g.constraints.values()) {
    if (g.isRetired(k.id)) continue;
    if (isPathId(k.attachedTo) && !g.mapPath(k.attachedTo)) out.push({ signal: 'unreachable', target: k.id, evidence: [`attached to ${k.attachedTo}, which no mapping reaches`], proposal: 'add a mapping, or retire with reason unmapped', level: 'propose' });
    if (!isPathId(k.attachedTo) && !g.nodeExists(k.attachedTo)) out.push({ signal: 'unreachable', target: k.id, evidence: [`attached to ${k.attachedTo}, which does not exist`], proposal: 'attach to an existing node, or retire', level: 'propose' });
  }
  for (const d of g.decisions.values()) {
    if (!g.isActiveDecision(d) || !isPathId(d.node)) continue;
    if (!g.mapPath(d.node)) out.push({ signal: 'unreachable', target: d.id, evidence: [`on ${d.node}, which no mapping reaches`], proposal: 'add a mapping or archive the decision', level: 'propose' });
  }

  // Dormant modules with constraints.
  for (const l of g.logicals.values()) {
    const ks = g.constraintsOn(l.id);
    if (!ks.length) continue;
    const dirs = g.mappings.filter((m) => m.logical === l.id).map((m) => m.glob.replace(/\/\*\*$/, '').replace(/\*.*$/, '')).filter((d) => d && d !== '**');
    if (!dirs.length) continue;
    const ts = git(ctx.root, ['log', '-1', '--format=%ct', '--', ...dirs]);
    if (!ts) continue;
    const days = Math.floor((today - Number(ts) * 1000) / 86_400_000);
    if (days > cfg.dormantAfterDays) out.push({ signal: 'dormant', target: l.id, evidence: [`no commit under ${dirs.join(', ')} for ${days} days`, `${ks.length} constraint(s) attached`], proposal: 'informational; dormancy is not staleness', level: 'info' });
  }

  // Missing tests and deleted paths, from validation.
  for (const f of g.validate(ctx.root)) {
    if (f.rule === 'enforced-test') out.push({ signal: 'missing-test', target: f.message, evidence: [], proposal: 'restore the test, or downgrade the constraint to G', level: 'propose' });
    if (f.rule === 'deleted-path') out.push({ signal: 'deleted-path', target: f.message.split(' ')[1] ?? f.message, evidence: [f.message], proposal: 'archive with note path-deleted (ctx gc --deleted)', level: 'propose' });
    if (f.rule === 'orphaned-basis') out.push({ signal: 'orphaned-basis', target: f.message.split(' ')[1] ?? f.message, evidence: [f.message], proposal: 'supersede or re-point the decision', level: 'propose' });
  }

  // Expired proposals.
  const expired = (since: string | undefined): boolean => Boolean(since) && ageDays(since!) > cfg.proposalTtlDays;
  for (const k of g.constraints.values()) if (k.mode === 'G?' && expired(k.since)) out.push({ signal: 'expired-proposal', target: k.id, evidence: [`proposed ${k.since}, ${ageDays(k.since!)} days ago`], proposal: 'ratify it or drop it', level: 'propose' });
  for (const c of g.concepts.values()) if (c.proposed && expired(c.since)) out.push({ signal: 'expired-proposal', target: c.id, evidence: [`proposed ${c.since}`], proposal: 'ratify it or drop it', level: 'propose' });
  for (const e of g.edges) if (e.proposed && expired(e.since)) out.push({ signal: 'expired-proposal', target: `${e.from} ${e.rel} ${e.to}`, evidence: [`proposed ${e.since}`], proposal: 'dropped automatically by ctx gc (proposed edges from reach)', level: 'info' });

  // Superseded ADRs.
  for (const c of g.concepts.values()) {
    if (!c.adr || g.isRetired(c.id)) continue;
    const adr = findAdr(ctx.root, c.adr);
    if (!adr) continue;
    const status = /^\**\s*status\s*\**\s*[:|]?\s*\**\s*([^\n*]+)/im.exec(adr.text)?.[1]?.trim();
    if (!status || !/supersed/i.test(status)) continue;
    const succNum = /(\d{3,5})/.exec(status.replace(/supersed\w*\s*(by)?/i, ''))?.[1];
    const succ = succNum ? [...g.concepts.values()].find((x) => x.adr === succNum)?.id : undefined;
    out.push({ signal: 'superseded-adr', target: c.id, evidence: [`${adr.file}: status "${status}"`], proposal: `ctx retire ${c.id} --reason "ADR ${c.adr} superseded"${succ ? ` --succ ${succ}` : ''}`, level: 'propose' });
  }

  // Mapping drift for pack-derived constraints.
  const packs = loadPacks(['auto']);
  const files = (git(ctx.root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter(Boolean);
  for (const k of g.constraints.values()) {
    if (!k.from || g.isRetired(k.id)) continue;
    const packName = k.from.split('@')[0]!;
    const pack = packs.find((p) => p.name === packName);
    if (!pack) continue;
    const template = pack.records.find((r): r is KRecord => r.kind === 'K' && (r.id === k.id || k.id.startsWith(`${r.id}.`)));
    const role = template && /\{([^}]+)\}/.exec(template.attachedTo)?.[1];
    if (!role) continue;
    const { bindings } = detectBindings(pack, g, files, ctx.config.packBindings);
    if (!bindings.some((b) => b.role === role && b.logical === k.attachedTo)) {
      out.push({ signal: 'mapping-drift', target: k.id, evidence: [`bound to ${k.attachedTo} as {${role}} from ${k.from}; detection no longer matches`], proposal: 're-bind the role under [init.packs], or retire the binding', level: 'propose' });
    }
  }

  // Debt trend.
  const debt = new Map<string, { open: number; paid: number }>();
  for (const d of g.decisions.values()) {
    if (!/^legacy:/.test(d.text) || !d.overrides) continue;
    const e = debt.get(d.overrides) ?? { open: 0, paid: 0 };
    if (g.isActiveDecision(d)) e.open++; else e.paid++;
    debt.set(d.overrides, e);
  }
  for (const [k, e] of debt) out.push({ signal: 'debt-trend', target: k, evidence: [`${e.open} legacy exception(s) open, ${e.paid} paid`], proposal: 'informational; the open number should fall', level: 'info' });

  return out;
}

// ---- retirement ---------------------------------------------------------------------

/**
 * Retires a rule or concept, signed by the person, or with `delegated` by the project's delegated
 * ratifier: attributed to it, and only for what [delegate] may_ratify covers when a retirement needs
 * ratifying (a concept, or an enforced rule).
 */
export function retire(
  ctx: RepoContext,
  target: string,
  reason: string,
  succ?: string,
  opts: { delegated?: boolean } = {},
): { record: ZRecord; needsTrailer: boolean; trailer: string } {
  const g = ctx.graph;
  if (!g || !ctx.graphDir) throw new Error('no graph');
  if (!g.targetExists(target)) throw new Error(`${target} is not a constraint or concept`);
  if (g.isRetired(target)) throw new Error(`${target} is already retired`);
  if (succ && !g.targetExists(succ)) throw new Error(`successor ${succ} does not exist`);
  const needs = target.startsWith('C:') || g.constraints.get(target)?.mode === 'E';
  const delegate = opts.delegated ? ctx.config.delegate : null;
  if (opts.delegated && !delegate) throw new Error("This repository delegates no ratification ([delegate] ratifier isn't set in .ctx/config.toml). A person retires it.");
  if (delegate && needs && !delegate.mayRatify.includes('retirements'))
    throw new Error(`The delegated ratifier may ratify ${delegate.mayRatify.join(', ') || 'nothing'}, not retirements; a person retires ${target}.`);
  const who = delegate ? `${delegate.ratifier}/delegated` : `${gitPerson(ctx.root)}/human`;
  const record: ZRecord = { kind: 'Z', target, date: new Date().toISOString().slice(0, 10), who, reason, line: 0 };
  if (succ) record.succ = succ;
  appendRecord(join(ctx.graphDir, GRAPH_FILE), record);
  const k = g.constraints.get(target);
  const needsTrailer = target.startsWith('C:') || k?.mode === 'E';
  return { record, needsTrailer, trailer: `Ctx-Ratified-By: ${delegate ? `${delegate.ratifier} (delegated)` : gitPerson(ctx.root)}` };
}

// ---- archival ------------------------------------------------------------------------

export interface GcResult { archived: string[]; droppedProposals: string[]; archiveFile?: string }

export function gc(ctx: RepoContext, opts: { now?: Date; deleted?: boolean } = {}): GcResult {
  const g = ctx.graph;
  if (!g || !ctx.graphDir) throw new Error('no graph');
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - ctx.config.hygiene.archiveAfterDays * 86_400_000;
  const old = (date: string): boolean => new Date(date).getTime() < cutoff;
  const year = String(now.getFullYear());
  const archiveDir = join(ctx.graphDir, 'archive');
  const archiveFile = join(archiveDir, `${year}.ctx`);
  const toArchive: GraphRecord[] = [];
  const ids = new Set<string>();

  // Superseded decisions whose replacement is old enough, with their S records.
  for (const s of g.supersessions) {
    const newer = g.decisions.get(s.newId);
    const older = g.decisions.get(s.oldId);
    if (!newer || !older || !old(newer.date)) continue;
    toArchive.push(older, s);
    ids.add(older.id);
  }
  // Retired constraints and concepts old enough, with their Z records.
  for (const z of g.retirements) {
    if (!old(z.date)) continue;
    const k = g.constraints.get(z.target);
    const c = g.concepts.get(z.target);
    if (k) { toArchive.push(k, z); ids.add(k.id); }
    else if (c) { toArchive.push(c, z); ids.add(c.id); }
  }
  // Decisions on deleted paths, when asked.
  if (opts.deleted) {
    for (const d of g.decisions.values()) {
      if (ids.has(d.id) || !isPathId(d.node) || existsSync(toAbsolute(ctx.root, splitSymbol(d.node).path))) continue;
      toArchive.push(d);
      ids.add(d.id);
    }
  }
  // Proposed edges from reach that expired are dropped, not archived.
  const ttl = ctx.config.hygiene.proposalTtlDays * 86_400_000;
  const droppedProposals: string[] = [];

  const rewrite = (file: string): void => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]!;
      let rec: GraphRecord | null = null;
      try { rec = parseLine(raw, i + 1, file); } catch { kept.push(raw); continue; }
      if (!rec) { kept.push(raw); continue; }
      if (rec.kind === 'D' && ids.has(rec.id)) continue;
      if (rec.kind === 'K' && ids.has(rec.id)) continue;
      if (rec.kind === 'C' && ids.has(rec.id)) continue;
      if (rec.kind === 'S' && ids.has(rec.oldId)) continue;
      if (rec.kind === 'Z' && ids.has(rec.target)) continue;
      if (rec.kind === 'E' && rec.proposed && rec.since && now.getTime() - new Date(rec.since).getTime() > ttl) { droppedProposals.push(`${rec.from} ${rec.rel} ${rec.to}`); continue; }
      kept.push(raw);
    }
    writeFileSync(file, kept.join('\n').replace(/\n*$/, '\n'), 'utf8');
  };

  if (toArchive.length) {
    mkdirSync(archiveDir, { recursive: true });
    const header = existsSync(archiveFile) ? '' : `# archive ${year}: inactive records moved by ctx gc; ids stay resolvable, the walker never reads this file\n`;
    writeFileSync(archiveFile, (existsSync(archiveFile) ? readFileSync(archiveFile, 'utf8') : header) + toArchive.map(formatRecord).join('\n') + '\n', 'utf8');
  }
  for (const f of [join(ctx.graphDir, DECISIONS_FILE), join(ctx.graphDir, GRAPH_FILE), join(ctx.graphDir, 'proposals.ctx')]) rewrite(f);
  const res: GcResult = { archived: [...ids], droppedProposals };
  if (toArchive.length) res.archiveFile = archiveFile;
  return res;
}

// ---- timeline -------------------------------------------------------------------------

export interface TimelineRow { date: string; kind: 'decision' | 'superseded' | 'retired' | 'constraint'; id: string; text: string; archived: boolean }

export function loadArchive(graphDir: string): GraphRecord[] {
  const dir = join(graphDir, 'archive');
  if (!existsSync(dir)) return [];
  const out: GraphRecord[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.ctx')).sort()) out.push(...parseText(readFileSync(join(dir, f), 'utf8'), join(dir, f)));
  return out;
}

export function timeline(ctx: RepoContext, node: string): TimelineRow[] {
  const g = ctx.graph;
  if (!g || !ctx.graphDir) throw new Error('no graph');
  const archive = loadArchive(ctx.graphDir);
  const rows: TimelineRow[] = [];
  const decisions = new Map<string, { d: DRecord; archived: boolean }>();
  // Archived first: they are the older records, and position is the order within a day.
  for (const r of archive) if (r.kind === 'D' && r.node === node) decisions.set(r.id, { d: r, archived: true });
  for (const d of g.decisions.values()) if (d.node === node && !decisions.has(d.id)) decisions.set(d.id, { d, archived: false });
  // Position in file order: a supersession sits right after the decision it retires, since ids carry no order.
  const seq = new Map<string, number>();
  const order = new Map<TimelineRow, number>();
  for (const { d, archived } of decisions.values()) {
    seq.set(d.id, seq.size);
    const row: TimelineRow = { date: d.date, kind: 'decision', id: d.id, text: `${d.who} ->${d.serves}${d.overrides ? ` !${d.overrides}` : ''}  ${d.text}`, archived };
    order.set(row, seq.size);
    rows.push(row);
  }
  const sup: SRecord[] = [...g.supersessions, ...archive.filter((r): r is SRecord => r.kind === 'S')];
  for (const s of sup) {
    if (!decisions.has(s.oldId)) continue;
    const newer = g.decisions.get(s.newId) ?? archive.find((r): r is DRecord => r.kind === 'D' && r.id === s.newId);
    const row: TimelineRow = { date: newer?.date ?? '', kind: 'superseded', id: s.oldId, text: `superseded by ${s.newId}`, archived: !g.decisions.has(s.oldId) };
    order.set(row, (seq.get(s.oldId) ?? 0) + 1.5);
    rows.push(row);
  }
  const attached = new Set([...g.constraints.values(), ...archive.filter((r): r is KRecord => r.kind === 'K')].filter((k) => k.attachedTo === node).map((k) => k.id));
  for (const z of [...g.retirements, ...archive.filter((r): r is ZRecord => r.kind === 'Z')]) if (attached.has(z.target)) rows.push({ date: z.date, kind: 'retired', id: z.target, text: `${z.who} ${z.reason}${z.succ ? ` -> ${z.succ}` : ''}`, archived: !g.constraints.has(z.target) });
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
}

function findAdr(root: string, num: string): { file: string; text: string } | undefined {
  const files = (git(root, ['ls-files', '--cached', '--others', '--exclude-standard']) ?? '').split('\n').filter((f) => /(^|\/)(adr|adrs|decisions)\/[^/]*\.md$/i.test(f) && basename(f).includes(num));
  const f = files[0];
  if (!f) return undefined;
  try { return { file: f, text: readFileSync(toAbsolute(root, f), 'utf8') }; } catch { return undefined; }
}

export function reloadGraph(ctx: RepoContext): Graph { return Graph.load(ctx.graphDir!); }
