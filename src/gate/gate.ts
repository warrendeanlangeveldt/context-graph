import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { ALIASES_FILE, DECISIONS_FILE, GRAPH_FILE, Graph, PROPOSALS_FILE } from '../graph/graph.js';
import { parseText } from '../graph/parse.js';
import { isPathId, type DRecord, type KRecord, type SRecord, type ZRecord } from '../graph/records.js';
import type { CoverageRecord } from '../observe/coverage.js';
import { ObservationStore } from '../observe/store.js';
import { git } from '../util/git.js';
import { walk } from '../walker/walk.js';

/**
 * Merge gate (design spec §11). A three-way semantic diff of the graph: base at the merge point,
 * main now, branch now. Git detects textual overlap; this detects the contradictions that merge
 * cleanly because they never touch the same line.
 */
export interface GateOptions { base: string; head?: string; runTests?: boolean }

export interface GateFinding {
  level: 'fail' | 'warn' | 'info';
  rule: string;
  title: string;
  lines: string[];
  suggest?: string;
}

export interface GateReport {
  base: string;
  head: string;
  mergeBase: string;
  changedFiles: string[];
  findings: GateFinding[];
  ok: boolean;
}

export function runGate(ctx: RepoContext, opts: GateOptions): GateReport {
  const root = ctx.root;
  const graphRel = graphRelativeDir(ctx);
  const head = opts.head ?? 'HEAD';
  const mergeBase = git(root, ['merge-base', opts.base, head]);
  if (!mergeBase) throw new Error(`cannot find a merge base between ${opts.base} and ${head}`);

  const atBase = loadAt(root, graphRel, mergeBase);
  const atMain = loadAt(root, graphRel, opts.base);
  const atHead = opts.head ? loadAt(root, graphRel, opts.head) : Graph.load(ctx.graphDir!);
  const changedFiles = (git(root, ['diff', '--name-only', `${mergeBase}`, ...(opts.head ? [opts.head] : [])]) ?? '').split('\n').filter(Boolean);
  const commitMessages = git(root, ['log', '--format=%B%n--end--', `${mergeBase}..${head}`]) ?? '';
  const findings: GateFinding[] = [];

  // 0. The head graph must be valid.
  for (const f of atHead.validate(root)) {
    if (f.level === 'error') findings.push({ level: 'fail', rule: 'graph-invalid', title: f.rule, lines: [f.message] });
  }

  const branchDecisions = added(atHead.decisions, atBase.decisions);
  const mainDecisions = added(atMain.decisions, atBase.decisions);

  // 1. Opposed arrows.
  for (const b of branchDecisions) {
    for (const m of mainDecisions) {
      const k = opposedOn(b, m);
      if (!k) continue;
      findings.push({
        level: 'fail',
        rule: 'opposed-arrows',
        title: `${b.node} / K ${k}`,
        lines: [`main   ${fmt(m)}`, `branch ${fmt(b)}`],
        suggest: 'one of these supersedes the other; record S and re-run',
      });
    }
  }

  // 2. Double supersession.
  const branchS = addedS(atHead.supersessions, atBase.supersessions);
  const mainS = addedS(atMain.supersessions, atBase.supersessions);
  for (const bs of branchS) {
    const ms = mainS.find((s) => s.oldId === bs.oldId && s.newId !== bs.newId);
    if (!ms) continue;
    findings.push({
      level: 'fail',
      rule: 'double-supersession',
      title: bs.oldId,
      lines: [`main   ${ms.newId} supersedes ${ms.oldId}: ${fmt(atMain.decisions.get(ms.newId))}`, `branch ${bs.newId} supersedes ${bs.oldId}: ${fmt(atHead.decisions.get(bs.newId))}`],
      suggest: `decide which replacement stands; supersede the other with an S record`,
    });
  }

  // 3. Stale basis.
  for (const b of branchDecisions) {
    const before = atBase.constraints.get(b.serves) ?? atBase.concepts.get(b.serves);
    const now = atMain.constraints.get(b.serves) ?? atMain.concepts.get(b.serves);
    if (!before) continue;
    const retiredNow = atMain.isRetired(b.serves);
    const changed = now && describe(before) !== describe(now);
    if (!changed && !retiredNow && now) continue;
    findings.push({
      level: ctx.config.gate.staleBasis,
      rule: 'stale-basis',
      title: `${b.id} -> ${b.serves}`,
      lines: [`was    ${describe(before)}`, `now    ${now ? describe(now) : '(removed)'}${retiredNow ? ' (retired)' : ''}`, `branch ${fmt(b)}`],
      suggest: 're-affirm the decision against the current basis, re-point it, or withdraw it',
    });
  }

  // 4. Context moved under the code.
  for (const f of changedFiles) {
    if (f.startsWith(graphRel + '/')) continue;
    const before = new Set(walk(atBase, f, { maxDecisions: 0 }).constraints.map((k) => k.id));
    const now = new Set(walk(atMain, f, { maxDecisions: 0 }).constraints.map((k) => k.id));
    const addedK = [...now].filter((k) => !before.has(k));
    const removedK = [...before].filter((k) => !now.has(k));
    if (!addedK.length && !removedK.length) continue;
    findings.push({
      level: ctx.config.gate.contextMoved,
      rule: 'context-moved',
      title: f,
      lines: [...addedK.map((k) => `added   ${k}  ${atMain.constraints.get(k)?.text ?? ''}`), ...removedK.map((k) => `removed ${k}`)],
      suggest: 'the file was edited under context that has since changed; re-check the edit against the constraints now in force',
    });
  }

  // 5. Enforced constraints: run their tests.
  const enforced = [...atHead.constraints.values()].filter((k) => k.mode === 'E' && !atHead.isRetired(k.id));
  if (opts.runTests) {
    const ran = new Set<string>();
    for (const k of enforced) {
      if (!k.test || ran.has(k.test)) continue;
      ran.add(k.test);
      const cmd = testCommand(ctx, k.test);
      if (!cmd) { findings.push({ level: 'fail', rule: 'enforced-test', title: k.id, lines: [`no test command for ${k.test}; set [gate] test_command`] }); continue; }
      const r = runCommand(root, cmd);
      if (!r.ok) findings.push({ level: 'fail', rule: 'enforced-test', title: `${k.id}  ${k.test}`, lines: [cmd, ...r.output.split('\n').slice(-8)] });
      else findings.push({ level: 'info', rule: 'enforced-test', title: `${k.id}  passed`, lines: [cmd] });
    }
  } else if (enforced.length) {
    findings.push({ level: 'info', rule: 'enforced-test', title: `${enforced.length} enforced constraint(s) not executed`, lines: ['pass --run-tests to run them'] });
  }

  // 6. Unratified proposals and retirements.
  const ratified = ratifiersIn(commitMessages, ctx.config.ratifiers);
  const newConcepts = [...atHead.concepts.values()].filter((c) => !atBase.concepts.has(c.id));
  const newEnforced = [...atHead.constraints.values()].filter((k) => k.mode === 'E' && !atBase.constraints.has(k.id));
  const changedEnforced = [...atHead.constraints.values()].filter((k) => k.mode === 'E' && atBase.constraints.has(k.id) && describe(atBase.constraints.get(k.id)!) !== describe(k));
  for (const c of newConcepts) {
    if (c.proposed) { findings.push({ level: 'info', rule: 'proposed', title: c.id, lines: ['merges as proposed'] }); continue; }
    if (!ratified.ok) findings.push({ level: ratified.configured ? 'fail' : 'warn', rule: 'unratified', title: `C ${c.id}`, lines: [c.name, ratified.configured ? `needs a commit trailer Ctx-Ratified-By: <${ctx.config.ratifiers.join('|')}>` : 'no ratifiers configured under [repo] ratifiers'] });
  }
  for (const k of [...newEnforced, ...changedEnforced]) {
    if (!ratified.ok) findings.push({ level: ratified.configured ? 'fail' : 'warn', rule: 'unratified', title: `K E ${k.id}`, lines: [k.text, ratified.configured ? 'needs a commit trailer Ctx-Ratified-By' : 'no ratifiers configured under [repo] ratifiers'] });
  }
  for (const k of [...atHead.constraints.values()].filter((k) => k.mode === 'G?' && !atBase.constraints.has(k.id))) {
    findings.push({ level: 'info', rule: 'proposed', title: `K G? ${k.id}`, lines: ['merges as proposed'] });
  }
  for (const z of addedZ(atHead.retirements, atBase.retirements)) {
    const target = atBase.constraints.get(z.target) ?? atHead.constraints.get(z.target);
    const isTop = z.target.startsWith('C:') || target?.mode === 'E';
    if (isTop && !ratified.ok) findings.push({ level: ratified.configured ? 'fail' : 'warn', rule: 'unratified-retirement', title: `Z ${z.target}`, lines: [z.reason, ratified.configured ? 'needs a commit trailer Ctx-Ratified-By' : 'no ratifiers configured'] });
  }

  // 7. Unlinked provenance.
  const unlinked = branchDecisions.filter((d) => d.sha === '-');
  if (unlinked.length) findings.push({ level: 'warn', rule: 'unlinked-provenance', title: `${unlinked.length} decision(s) without a commit`, lines: unlinked.map((d) => `${d.id} ${d.node}`), suggest: 'run ctx provenance after committing, or install the post-commit hook' });

  // 8. Orphaned basis, from validation.
  for (const f of atHead.validate(root)) if (f.rule === 'orphaned-basis') findings.push({ level: 'warn', rule: 'orphaned-basis', title: f.message, lines: [] });

  // 9. Coverage: edits in this branch made with no callers loaded and no decision.
  const decided = new Set(branchDecisions.map((d) => d.node.split('#')[0]));
  const dark = darkEdits(root, changedFiles.filter((f) => !decided.has(f)));
  for (const [path, c] of dark) findings.push({ level: 'warn', rule: 'coverage', title: path, lines: [`edited with ${c.callers_loaded}/${c.callers_total} callers in context and no decision recorded`] });

  const ok = !findings.some((f) => f.level === 'fail');
  return { base: opts.base, head, mergeBase, changedFiles, findings, ok };
}

// ---- helpers ------------------------------------------------------------------------

function graphRelativeDir(ctx: RepoContext): string {
  if (!ctx.graphDir) throw new Error('no graph: the gate needs .ctx/ tracked in the repository');
  const rel = relative(ctx.root, ctx.graphDir);
  if (rel.startsWith('..')) throw new Error(`the gate needs the graph tracked in the repository; ${ctx.graphDir} is outside ${ctx.root}`);
  return rel.split('\\').join('/');
}

function loadAt(root: string, graphRel: string, ref: string): Graph {
  const records = [];
  for (const name of [GRAPH_FILE, DECISIONS_FILE, ALIASES_FILE, PROPOSALS_FILE]) {
    const text = git(root, ['show', `${ref}:${graphRel}/${name}`]);
    if (text !== undefined) records.push(...parseText(text, `${ref}:${graphRel}/${name}`));
  }
  if (!records.length) throw new Error(`no ${graphRel}/${GRAPH_FILE} at ${ref}`);
  return Graph.fromRecords(records, `${ref}:${graphRel}`);
}

function added(now: Map<string, DRecord>, before: Map<string, DRecord>): DRecord[] {
  return [...now.values()].filter((d) => !before.has(d.id));
}
function addedS(now: SRecord[], before: SRecord[]): SRecord[] {
  const key = (s: SRecord): string => `${s.newId}>${s.oldId}`;
  const b = new Set(before.map(key));
  return now.filter((s) => !b.has(key(s)));
}
function addedZ(now: ZRecord[], before: ZRecord[]): ZRecord[] {
  const b = new Set(before.map((z) => z.target));
  return now.filter((z) => !b.has(z.target));
}

/** The constraint two decisions disagree about, if they do: one serves it and the other overrides it. */
function opposedOn(a: DRecord, b: DRecord): string | undefined {
  if (a.overrides && b.serves === a.overrides) return a.overrides;
  if (b.overrides && a.serves === b.overrides) return b.overrides;
  return undefined;
}

function describe(r: KRecord | { id: string; name: string; adr?: string }): string {
  if ('mode' in r) return `${r.mode} ${r.id} on ${r.attachedTo}: ${r.text}`;
  return `${r.id}: ${r.name}${r.adr ? ` adr:${r.adr}` : ''}`;
}

function fmt(d: DRecord | undefined): string {
  if (!d) return '(unknown decision)';
  return `${d.id} ${d.date} ${d.who}  ${d.overrides ? `!K ${d.overrides}` : `->${d.serves}`}  ${d.text}`;
}

function ratifiersIn(messages: string, ratifiers: string[]): { ok: boolean; configured: boolean } {
  if (!ratifiers.length) return { ok: false, configured: false };
  const trailers = [...messages.matchAll(/^Ctx-Ratified-By:\s*(.+)$/gim)].map((m) => m[1]!.trim().toLowerCase());
  const ok = trailers.some((t) => ratifiers.some((r) => t.includes(r.toLowerCase()) || r.toLowerCase().includes(t)));
  return { ok, configured: true };
}

function testCommand(ctx: RepoContext, test: string): string | undefined {
  if (ctx.config.gate.testCommand) return ctx.config.gate.testCommand.replaceAll('{test}', test);
  if (/\.test\.[cm]?[jt]sx?$/.test(test) || /\.spec\.[cm]?[jt]sx?$/.test(test)) return `npx vitest run ${test}`;
  if (/(^|\/)test_.*\.py$|_test\.py$/.test(test)) return `pytest ${test}`;
  if (/_test\.go$/.test(test)) return `go test ${test.replace(/\/[^/]+$/, '')}`;
  return undefined;
}

function runCommand(root: string, cmd: string): { ok: boolean; output: string } {
  try {
    const out = execFileSync('sh', ['-c', cmd], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000 });
    return { ok: true, output: out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    return { ok: false, output: `${err.stdout ?? ''}${err.stderr ?? ''}` || err.message };
  }
}

/** Coverage records from any local session for the given paths, where no caller was loaded. */
function darkEdits(root: string, paths: string[]): Map<string, CoverageRecord> {
  const out = new Map<string, CoverageRecord>();
  if (!paths.length) return out;
  const want = new Set(paths);
  for (const s of ObservationStore.sessions(root)) {
    for (const e of new ObservationStore(root, s.session).readAll()) {
      if (e.t !== 'coverage') continue;
      const c = e.p as CoverageRecord;
      if (want.has(c.path) && c.callers_total > 0 && c.callers_loaded === 0) out.set(c.path, c);
    }
  }
  return out;
}

export function formatGate(report: GateReport): string {
  const lines: string[] = [];
  lines.push(`gate ${report.base}..${report.head} (merge base ${report.mergeBase.slice(0, 8)}), ${report.changedFiles.length} changed file(s)`);
  for (const f of report.findings) {
    lines.push(`${f.level.toUpperCase().padEnd(4)} ${f.rule.padEnd(22)} ${f.title}`);
    for (const l of f.lines) lines.push(`  ${l}`);
    if (f.suggest) lines.push(`  suggest: ${f.suggest}`);
  }
  lines.push(report.ok ? 'ok: no failing findings' : `FAILED: ${report.findings.filter((f) => f.level === 'fail').length} failing finding(s)`);
  return lines.join('\n');
}

export function isPathNode(id: string): boolean { return isPathId(id); }
export function readIfExists(p: string): string | undefined { return existsSync(p) ? readFileSync(p, 'utf8') : undefined; }
export { join };
