import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { packageRoot } from '../util/root.js';

/**
 * Installers. Each writes exactly the configuration a harness needs to load the adapter, merging
 * into files that already exist and marking every entry it owns so it can be found again.
 */

const MARK = 'context-graph';

function pluginRoot(): string {
  return packageRoot();
}

export interface InstallResult { changed: string[]; notes: string[] }

/** Codex: user-level hooks.json plus an MCP server entry in config.toml. Plugins do not reach the IDE, so this is the universal path. */
export function installCodexUser(home = homedir()): InstallResult {
  const changed: string[] = [];
  const notes: string[] = [];
  const codexDir = join(home, '.codex');
  mkdirSync(codexDir, { recursive: true });

  const hookScript = join(pluginRoot(), 'adapters', 'codex', 'scripts', 'ctx-hook');
  const mcpScript = join(pluginRoot(), 'adapters', 'codex', 'scripts', 'ctx-mcp');
  const hooksFile = join(codexDir, 'hooks.json');
  const ours = JSON.parse(readFileSync(join(pluginRoot(), 'adapters', 'codex', 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
  const rewritten = JSON.parse(JSON.stringify(ours).replaceAll('${PLUGIN_ROOT}/scripts/ctx-hook', hookScript)) as { hooks: Record<string, { hooks: { command?: string }[] }[]> };

  let existing: { description?: string; hooks: Record<string, { hooks: { command?: string }[] }[]> } = { hooks: {} };
  if (existsSync(hooksFile)) {
    try { existing = JSON.parse(readFileSync(hooksFile, 'utf8')); } catch { notes.push(`${hooksFile} was not valid JSON and was replaced`); }
    existing.hooks ??= {};
  }
  for (const [event, groups] of Object.entries(rewritten.hooks)) {
    const cur = (existing.hooks[event] ??= []);
    const filtered = cur.filter((g) => !g.hooks?.some((h) => h.command?.includes(MARK)));
    existing.hooks[event] = [...filtered, ...groups];
  }
  writeFileSync(hooksFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  changed.push(hooksFile);

  const configFile = join(codexDir, 'config.toml');
  const block = `\n[mcp_servers.ctx]\ncommand = "${mcpScript}"\n`;
  let cfg = existsSync(configFile) ? readFileSync(configFile, 'utf8') : '';
  if (!/^\[mcp_servers\.ctx\]/m.test(cfg)) {
    cfg = cfg.replace(/\s*$/, '\n') + block;
    writeFileSync(configFile, cfg, 'utf8');
    changed.push(configFile);
  } else notes.push('[mcp_servers.ctx] already present in config.toml');
  notes.push('Codex requires hooks to be trusted: open a Codex session and run /hooks to review and trust them.');
  return { changed, notes };
}

/** Claude Code: hooks and MCP server in the user's settings, for use without --plugin-dir. */
export function installClaudeUser(home = homedir()): InstallResult {
  const changed: string[] = [];
  const notes: string[] = [];
  const dir = join(home, '.claude');
  mkdirSync(dir, { recursive: true });
  const settingsFile = join(dir, 'settings.json');
  const hookScript = join(pluginRoot(), 'adapters', 'claude-code', 'scripts', 'ctx-hook');
  const ours = JSON.parse(readFileSync(join(pluginRoot(), 'adapters', 'claude-code', 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown[]> };
  const rewritten = JSON.parse(JSON.stringify(ours.hooks).replaceAll('${CLAUDE_PLUGIN_ROOT}/scripts/ctx-hook', hookScript)) as Record<string, { hooks: { command?: string }[] }[]>;

  let settings: Record<string, unknown> & { hooks?: Record<string, { hooks: { command?: string }[] }[]> } = {};
  if (existsSync(settingsFile)) {
    try { settings = JSON.parse(readFileSync(settingsFile, 'utf8')); } catch { throw new Error(`${settingsFile} is not valid JSON; not touching it`); }
  }
  settings.hooks ??= {};
  for (const [event, groups] of Object.entries(rewritten)) {
    const cur = (settings.hooks[event] ??= []);
    settings.hooks[event] = [...cur.filter((g) => !g.hooks?.some((h) => h.command?.includes(MARK))), ...groups];
  }
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  changed.push(settingsFile);
  notes.push(`MCP server: claude mcp add --scope user ctx -- ${join(pluginRoot(), 'adapters', 'claude-code', 'scripts', 'ctx-mcp')}`);
  return { changed, notes };
}

/**
 * Git hooks in a repository: post-commit refreshes the embedding index when enabled. It never writes the
 * graph: a decision's commit is resolved from git when it is shown, so a commit leaves the tree clean.
 * An older hook block (which rewrote decisions after each commit) is replaced.
 */
export function installGitHooks(root: string): InstallResult {
  const hooksDir = join(root, '.git', 'hooks');
  if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository root`);
  mkdirSync(hooksDir, { recursive: true });
  const bundled = join(pluginRoot(), 'adapters', 'claude-code', 'ctx.mjs');
  const cli = existsSync(join(pluginRoot(), 'dist', 'cli', 'main.js')) ? join(pluginRoot(), 'dist', 'cli', 'main.js') : bundled;
  const file = join(hooksDir, 'post-commit');
  const marker = `# ${MARK}`;
  const snippet = `${marker}\nnode "${cli}" embed update --repo "$(git rev-parse --show-toplevel)" --if-enabled >/dev/null 2>&1 || true\n`;
  let content = existsSync(file) ? readFileSync(file, 'utf8') : '#!/bin/sh\n';
  if (!content.startsWith('#!')) content = '#!/bin/sh\n' + content;
  // Drop any earlier block of ours (the marker and the ctx lines after it), then add the current one.
  const lines = content.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === marker) { while (i + 1 < lines.length && /\|\| true$/.test(lines[i + 1]!) && lines[i + 1]!.includes(cli.split('/').pop()!)) i++; continue; }
    kept.push(lines[i]!);
  }
  content = kept.join('\n').replace(/\s*$/, '\n') + snippet;
  writeFileSync(file, content, 'utf8');
  chmodSync(file, 0o755);
  return { changed: [file], notes: ['post-commit: embedding refresh (when enabled); provenance is read from git, never written after a commit'] };
}
