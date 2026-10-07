import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Graph } from '../graph/graph.js';
import { ctxHome, findRepoRoot, isLinkedWorktree, mainCheckout, resolveGraphDir } from '../util/paths.js';
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
  /** Globs never indexed: generated code and lockfiles produce large chunks that crowd out real hints. */
  exclude: string[];
  includeArchived: boolean;
  /** Embed inside hook processes when no local server is running. Off by default: loading a model per edit costs more than the hint is worth. */
  inProcessHooks: boolean;
}

/** How a rule of the context loop acts: not at all, as a note on the next tool call, or by refusing. */
export type EnforceMode = 'off' | 'nudge' | 'block';

export interface EnforceConfig {
  /** Before editing a file: its fresh card, or the file read in full. */
  readBeforeEdit: EnforceMode;
  /** On a miss, what the file imports; when an edit changes its exports, what imports it. Each read, or its fresh card. */
  dependencies: EnforceMode;
  /** After editing a file, its card is written or brought up to date. `block` holds the turn like a decision. */
  cards: EnforceMode;
  /** At most this many importers are required, the ones without fresh cards first. */
  maxImporters: number;
}

export interface Config {
  /** 'on', 'off', or a probability for per-session random assignment. */
  sliceEnabled: 'on' | 'off' | number;
  maxTokens: number;
  maxDecisions: number;
  maxBlocks: number;
  /** Hold the turn open until an edited file's decision is recorded. Off records the gap as a finding and lets the turn end. */
  demand: boolean;
  /** Hydrate the files and modules a user prompt names, before the first tool call. Off by default: it spends tokens on every prompt. */
  hydrateOnPrompt: boolean;
  hydrateBudget: number;
  shellParsing: boolean;
  /** Forward observations to the hosted overlay. Opt-in per developer. */
  forward: boolean;
  overlayUrl: string;
  defaultBranch: string;
  ratifiers: string[];
  /**
   * A delegated ratifier: an agent identity that may ratify the kinds of record listed, on its own,
   * for a project whose lead runs without a person watching. Set only in the repository's own
   * config.toml. Null when nothing is delegated.
   */
  delegate: { ratifier: string; mayRatify: DelegateKind[] } | null;
  gate: { staleBasis: 'warn' | 'fail'; contextMoved: 'warn' | 'fail'; testCommand: string; cards: 'off' | 'warn' | 'fail' };
  hygiene: { archiveAfterDays: number; dormantAfterDays: number; overrideStreak: number; proposalTtlDays: number };
  serve: { port: number; bufferEvents: number };
  view: { expandThreshold: number };
  embed: EmbedConfig;
  packs: string[];
  packBindings: Record<string, string>;
  enforce: EnforceConfig;
  /** Globs that owe no card and need no read before an edit. A config's `[cards] exclude` adds to the defaults. */
  cardsExclude: string[];
}

/** What a delegated ratifier may ratify: guidance rules, enforced rules, concepts, retirements of either, and modules (a module's containment edge). */
export type DelegateKind = 'guidance' | 'enforced' | 'concepts' | 'retirements' | 'modules';
export const DELEGATE_KINDS: readonly DelegateKind[] = ['guidance', 'enforced', 'concepts', 'retirements', 'modules'];

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
    demand: true,
    hydrateOnPrompt: false,
    hydrateBudget: 1500,
    shellParsing: true,
    forward: false,
    overlayUrl: '',
    defaultBranch: 'main',
    ratifiers: [],
    delegate: null,
    gate: { staleBasis: 'warn', contextMoved: 'warn', testCommand: '', cards: 'warn' },
    hygiene: { archiveAfterDays: 90, dormantAfterDays: 180, overrideStreak: 3, proposalTtlDays: 30 },
    serve: { port: 7399, bufferEvents: 50_000 },
    view: { expandThreshold: 1500 },
    embed: { enabled: false, provider: 'minilm', apiKeyEnv: 'OPENAI_API_KEY', minScore: 0.45, maxHints: 2, include: ['docs/**/*.md'], exclude: ['**/generated/**', '**/*.lock', '**/package-lock.json', '**/*.min.js'], includeArchived: false, inProcessHooks: false },
    packs: ['auto'],
    packBindings: {},
    enforce: { readBeforeEdit: 'block', dependencies: 'block', cards: 'block', maxImporters: 5 },
    cardsExclude: [
      '.ctx/**', '.claude/**', '.git/**', '.github/**', '**/node_modules/**', '**/dist/**', '**/build/**', '**/generated/**',
      '**/*.lock', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/*.min.js', '**/*.map',
      '**/*.md', '**/*.{png,jpg,jpeg,gif,svg,ico,webp,pdf,woff,woff2,ttf}',
      // Configuration and manifests: settings, not code whose why gets lost.
      '**/.*', '**/*.json', '**/*.{yml,yaml,toml,ini,cfg}', '**/*.snap', '**/LICENSE*', '**/*.txt',
    ],
  };
}

/**
 * Resolve the repository root, its graph directory (if any), and effective configuration.
 * A missing graph is not an error: it is observe-only mode.
 */
export function openRepo(opts: { cwd?: string; repo?: string; graph?: string } = {}): RepoContext {
  const root = opts.repo ? findRepoRoot(resolve(opts.repo)) : sessionRoot(opts.cwd ?? process.cwd());
  const graphDir = opts.graph ? resolve(opts.graph) : resolveGraphDir(root);
  const config = loadConfig(graphDir);
  const ctx: RepoContext = { root, config };
  if (graphDir) {
    ctx.graphDir = graphDir;
    ctx.graph = Graph.load(graphDir);
  }
  return ctx;
}

/**
 * The checkout a session or agent works in. The harness's project directory wins over the working
 * directory, because a shell can wander out of the repository; except when the working directory is a
 * linked worktree of that same project, which is where an isolated agent (or a lane) does its work.
 * Its files, its branch and its `.ctx/` are the ones that agent reads, edits and records into.
 */
export function sessionRoot(cwd: string): string {
  const here = findRepoRoot(resolve(cwd));
  const project = process.env.CLAUDE_PROJECT_DIR;
  if (!project) return here;
  const projectRoot = findRepoRoot(resolve(project));
  if (here !== projectRoot && isLinkedWorktree(here) && mainCheckout(here) === mainCheckout(projectRoot)) return here;
  return projectRoot;
}

function mode(v: TomlValue, fallback: EnforceMode): EnforceMode {
  return v === 'off' || v === 'nudge' || v === 'block' ? v : v === false ? 'off' : v === true ? 'block' : fallback;
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
    cfg.demand = tomlGet(t, 'record', 'demand', cfg.demand);
    cfg.hydrateOnPrompt = tomlGet(t, 'slice', 'hydrate_on_prompt', cfg.hydrateOnPrompt);
    cfg.hydrateBudget = tomlGet(t, 'slice', 'hydrate_budget', cfg.hydrateBudget);
    cfg.shellParsing = tomlGet(t, 'observe', 'shell_parsing', cfg.shellParsing);
    cfg.forward = tomlGet(t, 'observe', 'forward', cfg.forward);
    cfg.overlayUrl = tomlGet(t, 'overlay', 'url', cfg.overlayUrl);
    cfg.defaultBranch = tomlGet(t, 'repo', 'default_branch', cfg.defaultBranch);
    cfg.ratifiers = tomlGet(t, 'repo', 'ratifiers', cfg.ratifiers);
    cfg.gate.staleBasis = tomlGet(t, 'gate', 'stale_basis', cfg.gate.staleBasis) as 'warn' | 'fail';
    cfg.gate.contextMoved = tomlGet(t, 'gate', 'context_moved', cfg.gate.contextMoved) as 'warn' | 'fail';
    cfg.gate.testCommand = tomlGet(t, 'gate', 'test_command', cfg.gate.testCommand);
    cfg.gate.cards = tomlGet(t, 'gate', 'cards', cfg.gate.cards) as 'off' | 'warn' | 'fail';
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
    cfg.embed.exclude = tomlGet(t, 'embed', 'exclude', cfg.embed.exclude);
    cfg.embed.includeArchived = tomlGet(t, 'embed', 'include_archived', cfg.embed.includeArchived);
    cfg.embed.inProcessHooks = tomlGet(t, 'embed', 'in_process_hooks', cfg.embed.inProcessHooks);
    cfg.packs = tomlGet(t, 'init', 'packs', cfg.packs);
    cfg.enforce.readBeforeEdit = mode(tomlGet<TomlValue>(t, 'enforce', 'read_before_edit', cfg.enforce.readBeforeEdit), cfg.enforce.readBeforeEdit);
    cfg.enforce.dependencies = mode(tomlGet<TomlValue>(t, 'enforce', 'dependencies', cfg.enforce.dependencies), cfg.enforce.dependencies);
    cfg.enforce.cards = mode(tomlGet<TomlValue>(t, 'enforce', 'cards', cfg.enforce.cards), cfg.enforce.cards);
    cfg.enforce.maxImporters = tomlGet(t, 'enforce', 'max_importers', cfg.enforce.maxImporters);
    // A project's exclusions add to the defaults: listing one generated folder should not drop the rest.
    for (const g of tomlGet<string[]>(t, 'cards', 'exclude', [])) if (!cfg.cardsExclude.includes(g)) cfg.cardsExclude.push(g);
    const bindings = t['init.packs'];
    if (bindings) for (const [k, v] of Object.entries(bindings)) if (typeof v === 'string') cfg.packBindings[k] = v;
  };
  if (graphDir) {
    apply(join(graphDir, 'config.toml'));
    cfg.delegate = delegateFrom(join(graphDir, 'config.toml'));
  }
  apply(join(ctxHome(), 'config.toml'));
  return cfg;
}

/** The repository's `[delegate]` section: `ratifier` and `may_ratify` (unknown kinds are dropped). */
function delegateFrom(file: string): Config['delegate'] {
  if (!existsSync(file)) return null;
  const t = parseToml(readFileSync(file, 'utf8'));
  const ratifier = tomlGet(t, 'delegate', 'ratifier', '').trim();
  if (!ratifier) return null;
  const kinds = tomlGet<string[]>(t, 'delegate', 'may_ratify', ['guidance']);
  return { ratifier, mayRatify: DELEGATE_KINDS.filter((k) => kinds.includes(k)) };
}
