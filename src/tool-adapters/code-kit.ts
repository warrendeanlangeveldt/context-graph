import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FileFacts, ToolAdapter } from './index.js';

/**
 * code-kit enforces lanes, layers, specs and proof-before-finish in the same repositories. Present when
 * `.claude/code-kit.json` exists. ctx asks it, through its command line and nothing else, what a file is
 * for in spec terms (`code-kit trace <path> --json`): the requirements it delivers, the lane that owns
 * it, and its layer with what that layer may import. Those facts anchor the file's card in the spec, and
 * put the layer rule in front of the agent before it drafts an edit. code-kit refuses a write that would
 * break a layer; ctx makes it rare that an agent tries.
 */

export interface Trace {
  path: string;
  owner: string | null;
  lane: { name: string; agent: string } | null;
  layer: { name: string; mayImport: string[]; denyPackages: string[] } | null;
  requirements: { id: string; title: string; spec: string; stories: string[] }[];
}

let cli: string | null | undefined;

/** code-kit's CLI: CODE_KIT_CLI, else the installed plugin Claude Code records. */
export function codeKitCli(): string | null {
  if (cli !== undefined) return cli;
  cli = null;
  const env = process.env.CODE_KIT_CLI;
  if (env && existsSync(env)) return (cli = env);
  const registry = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'plugins', 'installed_plugins.json');
  try {
    const plugins = (JSON.parse(readFileSync(registry, 'utf8')) as { plugins?: Record<string, { installPath?: string; lastUpdated?: string }[]> }).plugins ?? {};
    const installs = Object.entries(plugins).filter(([k]) => k.startsWith('code-kit@')).flatMap(([, v]) => v);
    installs.sort((a, b) => (b.lastUpdated ?? '').localeCompare(a.lastUpdated ?? ''));
    for (const i of installs) {
      const bin = i.installPath ? join(i.installPath, 'bin', 'code-kit.mjs') : '';
      if (bin && existsSync(bin)) return (cli = bin);
    }
  } catch { /* no registry: code-kit is not installed as a plugin here */ }
  return cli;
}

const traces = new Map<string, Trace | null>();

export function traceFile(root: string, path: string): Trace | null {
  const key = `${root}\0${path}`;
  if (traces.has(key)) return traces.get(key)!;
  const bin = codeKitCli();
  let trace: Trace | null = null;
  if (bin) {
    const r = spawnSync(process.execPath, [bin, 'trace', path, '--json'], { cwd: root, encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) { try { trace = JSON.parse(r.stdout) as Trace; } catch { trace = null; } }
  }
  traces.set(key, trace);
  return trace;
}

export const codeKitAdapter: ToolAdapter = {
  name: 'code-kit',
  detect: (root) => existsSync(join(root, '.claude', 'code-kit.json')),
  fileFacts(root, path): FileFacts | undefined {
    const t = traceFile(root, path);
    if (!t) return undefined;
    const lines: string[] = [];
    for (const r of t.requirements.slice(0, 3)) lines.push(`spec  ${r.id} ${r.title}  (${r.spec}${r.stories.length ? `; ${r.stories.join(', ')}` : ''})`);
    if (t.requirements.length > 3) lines.push(`spec  and ${t.requirements.length - 3} more: code-kit trace ${path}`);
    const owner = t.lane ? `lane ${t.lane.name} (${t.lane.agent})` : t.owner ? `owner ${t.owner}` : 'no owner: nobody may write it';
    const layer = t.layer
      ? `; layer ${t.layer.name}, may import ${t.layer.mayImport.length ? t.layer.mayImport.join(', ') : 'only itself'}${t.layer.denyPackages.length ? `, never ${t.layer.denyPackages.join(', ')}` : ''}`
      : '';
    lines.push(`code-kit  ${owner}${layer}`);
    return { lines, requirements: t.requirements.map((r) => r.id) };
  },
  protectedBranches(root) {
    try {
      const c = JSON.parse(readFileSync(join(root, '.claude', 'code-kit.json'), 'utf8')) as { branches?: { protected?: string[] } };
      return c.branches?.protected ?? ['main', 'master'];
    } catch {
      return ['main', 'master'];
    }
  },
  sessionNote: () => 'code-kit is active here: file cards and slices carry the spec requirement a file delivers, its lane, and its layer rules. code-kit refuses writes outside a lane or across a layer; ctx records the why.',
};
