import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RepoContext } from '../core/context.js';
import { INSTRUCTION_HEADING } from '../init/instructions.js';
import { localServer } from '../overlay/client.js';
import { ctxHome, repoHash } from '../util/paths.js';
import { packageRoot } from '../util/root.js';

/**
 * `ctx doctor`: is Context Graph actually working here, and if not, which link is missing. Every
 * line names one thing a person can act on. The commonest silent failure is a harness process
 * started before the plugin was installed or updated: it never loaded the hooks and looks, from
 * the inside, exactly like a plugin that is not wired.
 */
export interface DoctorLine { level: 'ok' | 'warn' | 'fail' | 'info'; text: string }

export function runDoctor(ctx: RepoContext, opts: { now?: number; claudeDir?: string; processes?: { pid: number; started: number; command: string }[] } = {}): DoctorLine[] {
  const out: DoctorLine[] = [];
  const now = opts.now ?? Date.now();
  const claudeDir = opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const sourceVersion = readVersion(join(packageRoot(), 'package.json'));

  // 1. Graph.
  const g = ctx.graph;
  if (!g) out.push({ level: 'fail', text: `no graph for ${ctx.root}: run ctx init --write (or ctx link a graph kept elsewhere); hooks observe but inject nothing` });
  else {
    const ks = [...g.constraints.values()];
    const proposed = ks.filter((k) => k.mode === 'G?').length;
    out.push({ level: 'ok', text: `graph at ${ctx.graphDir}: ${g.logicals.size} modules, ${ks.length} rules (${proposed} proposed), ${g.decisions.size} decisions` });
    if (!ctx.config.ratifiers.length) out.push({ level: 'warn', text: 'ratifiers is empty in config.toml, so nothing proposed can ever be ratified; add your git identity' });
    if (ks.length && proposed === ks.length && !g.decisions.size) out.push({ level: 'warn', text: 'every rule is still proposed and no decision has been recorded: the graph has not started earning its content yet' });
  }

  // 2. Instruction block.
  const ins = ['AGENTS.md', 'CLAUDE.md'].find((f) => existsSync(join(ctx.root, f)));
  if (!ins) out.push({ level: 'warn', text: 'no AGENTS.md or CLAUDE.md: the agent is never told to hydrate before reading; ctx install instructions writes the block once one exists' });
  else if (!readFileSync(join(ctx.root, ins), 'utf8').includes(INSTRUCTION_HEADING)) out.push({ level: 'warn', text: `${ins} lacks the Context Graph block: run ctx install instructions` });
  else out.push({ level: 'ok', text: `${ins} carries the Context Graph block` });

  // 3. Claude Code plugin: installed, enabled, current.
  let installedAt: number | undefined;
  const installed = readJson<{ plugins?: Record<string, { version?: string; installPath?: string; installedAt?: string; lastUpdated?: string }[]> }>(join(claudeDir, 'plugins', 'installed_plugins.json'));
  const entry = installed?.plugins?.['context-graph@context-graph']?.[0];
  if (!entry) out.push({ level: 'warn', text: 'Claude Code plugin not installed (no context-graph@context-graph in installed_plugins.json); /plugin marketplace add <path> then /plugin install context-graph@context-graph' });
  else {
    installedAt = Date.parse(entry.lastUpdated ?? entry.installedAt ?? '') || undefined;
    const settings = readJson<{ enabledPlugins?: Record<string, boolean> }>(join(claudeDir, 'settings.json'));
    const enabled = settings?.enabledPlugins?.['context-graph@context-graph'];
    if (enabled === false) out.push({ level: 'fail', text: 'Claude Code plugin is installed but disabled in settings.json' });
    const hooksFile = entry.installPath ? join(entry.installPath, 'hooks', 'hooks.json') : undefined;
    const hooks = hooksFile ? readJson<{ hooks?: Record<string, { matcher?: string }[]> }>(hooksFile) : undefined;
    const pre = hooks?.hooks?.PreToolUse?.map((h) => h.matcher).join('|') ?? '';
    const stale = sourceVersion && entry.version && entry.version !== sourceVersion;
    out.push({ level: stale ? 'warn' : 'ok', text: `Claude Code plugin ${entry.version ?? '?'} installed${stale ? ` but the source is ${sourceVersion}: /plugin marketplace update context-graph, then /plugin update context-graph@context-graph` : ''}${hooks ? `; hooks: ${Object.keys(hooks.hooks ?? {}).join(', ')}` : '; hooks.json not found in the installed copy'}` });
    if (hooks && !/Read/.test(pre)) out.push({ level: 'info', text: 'installed pre-hook covers edits only; module cards on first read arrive with 0.1.6 or later' });
  }

  // 4. Harness processes older than the plugin: they never loaded it.
  const procs = opts.processes ?? listClaudeProcesses();
  if (installedAt && procs.length) {
    const old = procs.filter((p) => p.started < installedAt!);
    if (old.length) out.push({ level: 'fail', text: `${old.length} of ${procs.length} running Claude Code session${procs.length === 1 ? '' : 's'} started before the plugin was installed or last updated (${new Date(installedAt).toLocaleString()}) and never loaded its hooks: exit each and start it again with claude --resume (pids ${old.map((p) => p.pid).join(', ')})` });
    else out.push({ level: 'ok', text: `${procs.length} running Claude Code session${procs.length === 1 ? '' : 's'}, all started after the plugin was installed` });
  }

  // 5. What the hooks have recorded here, lately.
  const obsDir = join(ctxHome(), 'observations', repoHash(ctx.root));
  const dayAgo = now - 24 * 3600_000;
  const recent: { session: string; harness: Set<string>; events: number; last: number; edits: number; slices: number; cards: number }[] = [];
  if (existsSync(obsDir)) {
    for (const f of readdirSync(obsDir).filter((x) => x.endsWith('.jsonl'))) {
      const file = join(obsDir, f);
      if (statSync(file).mtimeMs < dayAgo) continue;
      const row = { session: f.replace(/\.jsonl$/, ''), harness: new Set<string>(), events: 0, last: 0, edits: 0, slices: 0, cards: 0 };
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { t: string; ts: string; harness: string };
          row.events++; row.harness.add(e.harness); row.last = Math.max(row.last, Date.parse(e.ts) || 0);
          if (e.t === 'edit') row.edits++; if (e.t === 'slice') row.slices++; if (e.t === 'card') row.cards++;
        } catch { /* torn line */ }
      }
      recent.push(row);
    }
  }
  const hooked = recent.filter((r) => [...r.harness].some((h) => h === 'claude-code' || h === 'codex'));
  const replayed = recent.filter((r) => !hooked.includes(r) && [...r.harness].some((h) => h.endsWith('-replay')));
  const shellOnly = recent.filter((r) => !hooked.includes(r) && !replayed.includes(r) && r.events);
  if (!recent.length) out.push({ level: 'warn', text: 'no observations for this repository in the last 24 hours: no hook has fired here' });
  else {
    if (hooked.length) out.push({ level: 'ok', text: `hooks fired in ${hooked.length} session${hooked.length === 1 ? '' : 's'} in the last 24 hours: ${hooked.sort((a, b) => b.last - a.last).slice(0, 3).map((r) => `${r.session.slice(0, 8)} (${r.events} events, ${r.edits} edits, ${r.slices} slices, ${r.cards} cards, last ${ago(now - r.last)} ago)`).join('; ')}` });
    else out.push({ level: 'fail', text: 'no hook has fired here in the last 24 hours, though ctx was used' });
    if (shellOnly.length) out.push({ level: 'info', text: `ctx used from the shell or MCP without hooks: ${shellOnly.map((r) => `${r.session} (${r.events} events)`).join(', ')}; that is the instruction block working while the hooks are not` });
    if (replayed.length) out.push({ level: 'info', text: `${replayed.length} session${replayed.length === 1 ? '' : 's'} reconstructed with ctx replay, not observed live` });
  }

  // 6. Server and view.
  const srv = localServer();
  if (!srv) out.push({ level: 'info', text: 'no ctx serve running: hooks still record to files; start it for the live view and warm hints' });
  else out.push({ level: 'ok', text: `ctx serve on http://127.0.0.1:${srv.port} (pid ${srv.pid}); the view lists sessions as they fire` });

  return out;
}

export function formatDoctor(lines: DoctorLine[]): string {
  const mark: Record<DoctorLine['level'], string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', info: 'info' };
  return lines.map((l) => `${mark[l.level]}  ${l.text}`).join('\n');
}

function readJson<T>(file: string): T | undefined {
  try { return JSON.parse(readFileSync(file, 'utf8')) as T; } catch { return undefined; }
}
function readVersion(file: string): string | undefined { return readJson<{ version?: string }>(file)?.version; }
function ago(ms: number): string { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; }

/** Running `claude` CLI processes with their start times; empty where ps is unavailable. */
export function listClaudeProcesses(): { pid: number; started: number; command: string }[] {
  try {
    const text = execFileSync('ps', ['-eo', 'pid=,lstart=,command='], { encoding: 'utf8' });
    const out: { pid: number; started: number; command: string }[] = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
      if (!m) continue;
      const command = m[3]!;
      if (!/(^|\/)claude(\s|$)/.test(command) || /claude-in-chrome|Claude\.app|Helper/.test(command)) continue;
      const started = Date.parse(m[2]!);
      if (!Number.isFinite(started)) continue;
      out.push({ pid: Number(m[1]), started, command });
    }
    return out;
  } catch {
    return [];
  }
}
