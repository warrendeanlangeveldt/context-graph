import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from '../graph/graph.js';
import { ctxHome, findRepoRoot, resolveGraphDir } from '../util/paths.js';
import { parseToml, tomlGet, type TomlValue } from '../util/toml.js';

export interface Config {
  /** 'on', 'off', or a probability for per-session random assignment. */
  sliceEnabled: 'on' | 'off' | number;
  maxTokens: number;
  maxDecisions: number;
  maxBlocks: number;
  shellParsing: boolean;
}

export interface RepoContext {
  root: string;
  graphDir?: string;
  graph?: Graph;
  config: Config;
}

const DEFAULTS: Config = { sliceEnabled: 'on', maxTokens: 300, maxDecisions: 4, maxBlocks: 2, shellParsing: true };

/**
 * Resolve the repository root, its graph directory (if any), and effective configuration.
 * A missing graph is not an error: it is observe-only mode.
 */
export function openRepo(opts: { cwd?: string; repo?: string; graph?: string } = {}): RepoContext {
  const start = opts.repo ?? process.env.CLAUDE_PROJECT_DIR ?? opts.cwd ?? process.cwd();
  const root = findRepoRoot(resolve(start));
  const graphDir = opts.graph ? resolve(opts.graph) : resolveGraphDir(root);
  const config = loadConfig(graphDir);
  const ctx: RepoContext = { root, config };
  if (graphDir) {
    ctx.graphDir = graphDir;
    ctx.graph = Graph.load(graphDir);
  }
  return ctx;
}

export function loadConfig(graphDir: string | undefined): Config {
  const cfg = { ...DEFAULTS };
  const apply = (file: string): void => {
    if (!existsSync(file)) return;
    const t = parseToml(readFileSync(file, 'utf8'));
    const enabled = tomlGet<TomlValue>(t, 'slice', 'enabled', cfg.sliceEnabled === 'on');
    if (enabled === true) cfg.sliceEnabled = 'on';
    else if (enabled === false) cfg.sliceEnabled = 'off';
    else if (typeof enabled === 'string' && enabled.startsWith('random:')) cfg.sliceEnabled = Number(enabled.slice(7));
    cfg.maxTokens = tomlGet(t, 'slice', 'max_tokens', cfg.maxTokens);
    cfg.maxDecisions = tomlGet(t, 'slice', 'max_decisions', cfg.maxDecisions);
    cfg.maxBlocks = tomlGet(t, 'record', 'max_blocks', cfg.maxBlocks);
    cfg.shellParsing = tomlGet(t, 'observe', 'shell_parsing', cfg.shellParsing);
  };
  if (graphDir) apply(join(graphDir, 'config.toml'));
  apply(join(ctxHome(), 'config.toml'));
  return cfg;
}
