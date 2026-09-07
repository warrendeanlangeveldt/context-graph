import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from '../graph/graph.js';
import { ctxHome, findRepoRoot, resolveGraphDir } from '../util/paths.js';
import { parseToml, tomlGet, type TomlValue } from '../util/toml.js';

export interface EmbedConfig {
  enabled: boolean;
  /** `local:<model>` (Ollama), `openai:<model>`, or `<base-url>#<model>` for any OpenAI-compatible endpoint. */
  provider: string;
  baseUrl?: string;
  apiKeyEnv: string;
  minScore: number;
  maxHints: number;
  include: string[];
  includeArchived: boolean;
}

export interface Config {
  /** 'on', 'off', or a probability for per-session random assignment. */
  sliceEnabled: 'on' | 'off' | number;
  maxTokens: number;
  maxDecisions: number;
  maxBlocks: number;
  shellParsing: boolean;
  /** Forward observations to the hosted overlay. Opt-in per developer. */
  forward: boolean;
  overlayUrl: string;
  defaultBranch: string;
  ratifiers: string[];
  gate: { staleBasis: 'warn' | 'fail'; contextMoved: 'warn' | 'fail'; testCommand: string };
  hygiene: { archiveAfterDays: number; dormantAfterDays: number; overrideStreak: number; proposalTtlDays: number };
  serve: { port: number; bufferEvents: number };
  view: { expandThreshold: number };
  embed: EmbedConfig;
  packs: string[];
  packBindings: Record<string, string>;
}

export interface RepoContext {
  root: string;
  graphDir?: string;
  graph?: Graph;
  config: Config;
}

export function defaultConfig(): Config {
  return {
    sliceEnabled: 'on',
    maxTokens: 300,
    maxDecisions: 4,
    maxBlocks: 2,
    shellParsing: true,
    forward: false,
    overlayUrl: '',
    defaultBranch: 'main',
    ratifiers: [],
    gate: { staleBasis: 'warn', contextMoved: 'warn', testCommand: '' },
    hygiene: { archiveAfterDays: 90, dormantAfterDays: 180, overrideStreak: 3, proposalTtlDays: 30 },
    serve: { port: 7399, bufferEvents: 50_000 },
    view: { expandThreshold: 1500 },
    embed: { enabled: false, provider: 'local:nomic-embed-text', apiKeyEnv: 'OPENAI_API_KEY', minScore: 0.75, maxHints: 2, include: ['docs/**/*.md'], includeArchived: false },
    packs: ['auto'],
    packBindings: {},
  };
}

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

function days(v: TomlValue, fallback: number): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const m = /^(\d+)d?$/.exec(v.trim()); if (m) return Number(m[1]); }
  return fallback;
}

export function loadConfig(graphDir: string | undefined): Config {
  const cfg = defaultConfig();
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
    cfg.forward = tomlGet(t, 'observe', 'forward', cfg.forward);
    cfg.overlayUrl = tomlGet(t, 'overlay', 'url', cfg.overlayUrl);
    cfg.defaultBranch = tomlGet(t, 'repo', 'default_branch', cfg.defaultBranch);
    cfg.ratifiers = tomlGet(t, 'repo', 'ratifiers', cfg.ratifiers);
    cfg.gate.staleBasis = tomlGet(t, 'gate', 'stale_basis', cfg.gate.staleBasis) as 'warn' | 'fail';
    cfg.gate.contextMoved = tomlGet(t, 'gate', 'context_moved', cfg.gate.contextMoved) as 'warn' | 'fail';
    cfg.gate.testCommand = tomlGet(t, 'gate', 'test_command', cfg.gate.testCommand);
    cfg.hygiene.archiveAfterDays = days(tomlGet<TomlValue>(t, 'hygiene', 'archive_after', cfg.hygiene.archiveAfterDays), cfg.hygiene.archiveAfterDays);
    cfg.hygiene.dormantAfterDays = days(tomlGet<TomlValue>(t, 'hygiene', 'dormant_after', cfg.hygiene.dormantAfterDays), cfg.hygiene.dormantAfterDays);
    cfg.hygiene.overrideStreak = tomlGet(t, 'hygiene', 'override_streak', cfg.hygiene.overrideStreak);
    cfg.hygiene.proposalTtlDays = days(tomlGet<TomlValue>(t, 'hygiene', 'proposal_ttl', cfg.hygiene.proposalTtlDays), cfg.hygiene.proposalTtlDays);
    cfg.serve.port = tomlGet(t, 'serve', 'port', cfg.serve.port);
    cfg.serve.bufferEvents = tomlGet(t, 'serve', 'buffer_events', cfg.serve.bufferEvents);
    cfg.view.expandThreshold = tomlGet(t, 'view', 'expand_threshold', cfg.view.expandThreshold);
    cfg.embed.enabled = tomlGet(t, 'embed', 'enabled', cfg.embed.enabled);
    cfg.embed.provider = tomlGet(t, 'embed', 'provider', cfg.embed.provider);
    const baseUrl = tomlGet(t, 'embed', 'base_url', '');
    if (baseUrl) cfg.embed.baseUrl = baseUrl;
    cfg.embed.apiKeyEnv = tomlGet(t, 'embed', 'api_key_env', cfg.embed.apiKeyEnv);
    cfg.embed.minScore = tomlGet(t, 'embed', 'min_score', cfg.embed.minScore);
    cfg.embed.maxHints = tomlGet(t, 'embed', 'max_hints', cfg.embed.maxHints);
    cfg.embed.include = tomlGet(t, 'embed', 'include', cfg.embed.include);
    cfg.embed.includeArchived = tomlGet(t, 'embed', 'include_archived', cfg.embed.includeArchived);
    cfg.packs = tomlGet(t, 'init', 'packs', cfg.packs);
    const bindings = t['init.packs'];
    if (bindings) for (const [k, v] of Object.entries(bindings)) if (typeof v === 'string') cfg.packBindings[k] = v;
  };
  if (graphDir) apply(join(graphDir, 'config.toml'));
  apply(join(ctxHome(), 'config.toml'));
  return cfg;
}
