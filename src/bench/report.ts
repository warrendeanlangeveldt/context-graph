import type { Arm, RunRecord } from './runner.js';

/**
 * Benchmark report (design spec §20.6 and §20.7). Distributions per arm, the paired difference
 * per task, the effect per stratum, the mediators, and cross-run contradictions under arm C.
 * Medians throughout; means only where the quantity is a ratio.
 */
export interface ArmSummary { arm: Arm; n: number; passRate: number | null; medianDuration: number | null; medianTokens: number | null; medianTurns: number | null; medianRework: number | null; medianTestFailures: number | null; callersRatio: number | null; meanDark: number | null; slicesPerEdit: number | null; decisions: number; reach: number; harnessErrors: number }
export interface PairedRow { task: string; stratum: string; arms: Partial<Record<Arm, { passRate: number | null; rework: number | null; duration: number | null }>>; deltaPass?: number; deltaRework?: number; deltaDuration?: number }
export interface Report { arms: ArmSummary[]; paired: PairedRow[]; strata: { stratum: string; arm: Arm; n: number; passRate: number | null; medianRework: number | null }[]; contradictions: { task: string; pairs: number; contradictions: number; examples: string[] }[]; predictions: string[] }

export function buildReport(records: RunRecord[]): Report {
  const arms = [...new Set(records.map((r) => r.arm))].sort() as Arm[];
  const armSummaries = arms.map((arm) => summarise(arm, records.filter((r) => r.arm === arm)));

  const tasks = [...new Set(records.map((r) => r.task))];
  const paired: PairedRow[] = tasks.map((task) => {
    const rs = records.filter((r) => r.task === task);
    const row: PairedRow = { task, stratum: rs[0]!.stratum, arms: {} };
    for (const arm of arms) {
      const a = rs.filter((r) => r.arm === arm && r.harnessError === null);
      if (!a.length) continue;
      row.arms[arm] = { passRate: rate(a.map((r) => r.passed)), rework: median(a.map((r) => r.rework)), duration: median(a.map((r) => r.durationMs)) };
    }
    const a = row.arms.A, c = row.arms.C;
    if (a && c) {
      if (a.passRate !== null && c.passRate !== null) row.deltaPass = c.passRate - a.passRate;
      if (a.rework !== null && c.rework !== null) row.deltaRework = c.rework - a.rework;
      if (a.duration !== null && c.duration !== null) row.deltaDuration = c.duration - a.duration;
    }
    return row;
  });

  const strata: Report['strata'] = [];
  for (const stratum of [...new Set(records.map((r) => r.stratum))]) for (const arm of arms) {
    const rs = records.filter((r) => r.stratum === stratum && r.arm === arm && r.harnessError === null);
    if (rs.length) strata.push({ stratum, arm, n: rs.length, passRate: rate(rs.map((r) => r.passed)), medianRework: median(rs.map((r) => r.rework)) });
  }

  const contradictions: Report['contradictions'] = [];
  for (const task of tasks) {
    const runs = records.filter((r) => r.task === task && r.arm === 'C' && r.decisions.length);
    if (runs.length < 2) continue;
    let pairs = 0, n = 0;
    const examples: string[] = [];
    for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
      pairs++;
      for (const x of runs[i]!.decisions) for (const y of runs[j]!.decisions) {
        if (x.node !== y.node) continue;
        const opposed = (x.overrides && y.serves === x.overrides) || (y.overrides && x.serves === y.overrides);
        if (opposed) { n++; if (examples.length < 3) examples.push(`${x.node}: run ${runs[i]!.run} ${x.overrides ? `!${x.overrides}` : `->${x.serves}`} vs run ${runs[j]!.run} ${y.overrides ? `!${y.overrides}` : `->${y.serves}`}`); }
      }
    }
    contradictions.push({ task, pairs, contradictions: n, examples });
  }

  return { arms: armSummaries, paired, strata, contradictions, predictions: judgePredictions(armSummaries, strata) };
}

function summarise(arm: Arm, rs: RunRecord[]): ArmSummary {
  const ok = rs.filter((r) => r.harnessError === null);
  const withTokens = ok.filter((r) => r.tokensIn !== null);
  const callersTotal = ok.reduce((s, r) => s + r.callersTotal, 0);
  const edits = ok.reduce((s, r) => s + r.edits, 0);
  return {
    arm, n: rs.length,
    passRate: rate(ok.map((r) => r.passed)),
    medianDuration: median(ok.map((r) => r.durationMs)),
    medianTokens: withTokens.length ? median(withTokens.map((r) => (r.tokensIn ?? 0) + (r.tokensOut ?? 0))) : null,
    medianTurns: median(ok.map((r) => r.turns).filter((t): t is number => t !== null)),
    medianRework: median(ok.map((r) => r.rework)),
    medianTestFailures: median(ok.map((r) => r.testFailures)),
    callersRatio: callersTotal ? ok.reduce((s, r) => s + r.callersLoaded, 0) / callersTotal : null,
    meanDark: edits ? ok.reduce((s, r) => s + r.darkTotal, 0) / edits : null,
    slicesPerEdit: edits ? ok.reduce((s, r) => s + r.slicesInjected, 0) / edits : null,
    decisions: ok.reduce((s, r) => s + r.decisions.length, 0),
    reach: ok.reduce((s, r) => s + r.reach, 0),
    harnessErrors: rs.length - ok.length,
  };
}

/** The spec's predictions (§20.7), each judged against the numbers when both arms exist. */
function judgePredictions(arms: ArmSummary[], strata: Report['strata']): string[] {
  const a = arms.find((x) => x.arm === 'A'), b = arms.find((x) => x.arm === 'B'), c = arms.find((x) => x.arm === 'C');
  const out: string[] = [];
  const cmp = (label: string, lhs: number | null, rhs: number | null, better: 'lower' | 'higher'): void => {
    if (lhs === null || rhs === null) { out.push(`${label}: not measurable (missing data)`); return; }
    const holds = better === 'lower' ? rhs < lhs : rhs > lhs;
    out.push(`${label}: ${holds ? 'HOLDS' : 'DOES NOT HOLD'} (A ${fmt(lhs)} vs C ${fmt(rhs)})`);
  };
  if (a && c) {
    cmp('rework falls under C', a.medianRework, c.medianRework, 'lower');
    cmp('hidden tests pass more under C', a.passRate, c.passRate, 'higher');
    cmp('time to result falls under C', a.medianDuration, c.medianDuration, 'lower');
    cmp('turns fall under C', a.medianTurns, c.medianTurns, 'lower');
    if (a.medianTokens !== null && c.medianTokens !== null) out.push(`total tokens roughly flat: A ${fmt(a.medianTokens)} vs C ${fmt(c.medianTokens)} (${Math.round(((c.medianTokens - a.medianTokens) / Math.max(1, a.medianTokens)) * 100)}%)`);
    const cross = strata.filter((s) => s.stratum === 'cross-module');
    const single = strata.filter((s) => s.stratum === 'single-file');
    const effect = (rows: typeof strata): number | null => { const ra = rows.find((r) => r.arm === 'A')?.medianRework ?? null; const rc = rows.find((r) => r.arm === 'C')?.medianRework ?? null; return ra === null || rc === null ? null : ra - rc; };
    const ec = effect(cross), es = effect(single);
    if (ec !== null && es !== null) out.push(`effect larger on cross-module than single-file: ${ec > es ? 'HOLDS' : 'DOES NOT HOLD'} (rework reduction ${fmt(ec)} vs ${fmt(es)})`);
  }
  if (b && c) cmp('slice at edit beats whole graph at start (rework)', b.medianRework, c.medianRework, 'lower');
  if (c) out.push(`mediators under C: slices per edit ${fmt(c.slicesPerEdit)}, callers in context ${fmt(c.callersRatio)}, dark per edit ${fmt(c.meanDark)}, decisions ${c.decisions}, reach ${c.reach}`);
  return out;
}

export function formatReport(r: Report): string {
  const lines: string[] = [];
  lines.push('## Arms', '', '| arm | n | pass | median s | median tokens | turns | rework | test fails | callers in ctx | dark/edit | slices/edit | decisions | reach | errors |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const a of r.arms) lines.push(`| ${a.arm} | ${a.n} | ${pct(a.passRate)} | ${a.medianDuration === null ? '' : Math.round(a.medianDuration / 1000)} | ${fmt(a.medianTokens)} | ${fmt(a.medianTurns)} | ${fmt(a.medianRework)} | ${fmt(a.medianTestFailures)} | ${pct(a.callersRatio)} | ${fmt(a.meanDark)} | ${fmt(a.slicesPerEdit)} | ${a.decisions} | ${a.reach} | ${a.harnessErrors} |`);
  lines.push('', '## Paired, per task', '', '| task | stratum | A pass | C pass | Δpass | A rework | C rework | Δrework | Δ seconds |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of r.paired) lines.push(`| ${p.task} | ${p.stratum} | ${pct(p.arms.A?.passRate ?? null)} | ${pct(p.arms.C?.passRate ?? null)} | ${p.deltaPass === undefined ? '' : pct(p.deltaPass)} | ${fmt(p.arms.A?.rework ?? null)} | ${fmt(p.arms.C?.rework ?? null)} | ${fmt(p.deltaRework ?? null)} | ${p.deltaDuration === undefined ? '' : Math.round(p.deltaDuration / 1000)} |`);
  lines.push('', '## Per stratum', '', '| stratum | arm | n | pass | median rework |', '|---|---|---|---|---|');
  for (const s of r.strata) lines.push(`| ${s.stratum} | ${s.arm} | ${s.n} | ${pct(s.passRate)} | ${fmt(s.medianRework)} |`);
  if (r.contradictions.length) {
    lines.push('', '## Cross-run contradictions under C', '', '| task | run pairs | opposed decisions |', '|---|---|---|');
    for (const c of r.contradictions) lines.push(`| ${c.task} | ${c.pairs} | ${c.contradictions}${c.examples.length ? ` (${c.examples.join('; ')})` : ''} |`);
  }
  lines.push('', '## Predictions (design spec §20.7)', '');
  for (const p of r.predictions) lines.push(`- ${p}`);
  return lines.join('\n') + '\n';
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function rate(xs: (boolean | null)[]): number | null {
  const v = xs.filter((x): x is boolean => x !== null);
  return v.length ? v.filter(Boolean).length / v.length : null;
}
function fmt(n: number | null): string { return n === null ? '' : Number.isInteger(n) ? String(n) : n.toFixed(2); }
function pct(n: number | null): string { return n === null ? '' : `${Math.round(n * 100)}%`; }
