# Context Graph

A standalone plugin for AI coding harnesses that does two things a session cannot do for itself:

1. **Observes** what context the agent actually built before each change: which files it read in full, which it saw only through grep, which it edited on the strength of a name alone, and which of the edited file's callers were ever in context.
2. **Anchors** the engineering context that should have applied, in a small graph kept in git, and injects the applicable slice at the moment the agent is about to edit a file. Before a turn ends, it asks for one decision per constrained file: what changed, and why, pointing at the constraint or concept the change honours.

The design specification is in `docs/design-spec.md`. This README covers what is built and how to run it.

## What is built

Every delivery step of the specification has an implementation:

| Step | Capability | Where |
|---|---|---|
| 1 | The `.ctx` line grammar: parser, validator, writer | `src/graph/` |
| 2 | Shell and patch observers | `src/observe/shell.ts`, `src/observe/patch.ts` |
| 3 | Claude Code adapter: hooks, MCP pull surface, plugin packaging, observe-only mode | `src/adapters/`, `adapters/claude-code/` |
| 4 | Replay benchmark: corpus from history, three arms, temporal cut, paired report | `src/bench/` |
| 5 | Codex adapter and user-level installer | `src/adapters/codex/`, `adapters/codex/`, `ctx install codex` |
| 6 | Transcript replay for Claude Code JSONL, Codex rollouts, and `codex exec --json` | `src/observe/replay.ts` |
| 7 | Merge gate: three-way semantic diff, ratification trailers, enforced tests | `src/gate/` |
| 8 | Bootstrap with conformance counts, style packs, ratification, pack export | `src/init/`, `packs/` |
| 9 | Retirement, hygiene report, archival, timeline | `src/hygiene/` |
| 10 | Event server: ingest, tail, stream, live queries, graph snapshot | `src/overlay/server.ts` |
| 11 | Synapse view: Three.js force graph, 2D mode, coverage table, scrubber, evolution | `view/` |
| 12 | Embeddings: provider, symbol-boundary chunker, SQLite vector store, hints in the slice | `src/embed/` |
| 13 | Hosted mode: token, forwarding, provisional decisions, cross-branch findings, monitor tail | `src/overlay/` |

Also: commit provenance linking (`ctx provenance`, and a post-commit hook installer), and a real graph for this repository under `.ctx/`.

## Install

Three ways, none of which point at a particular machine.

**As a Claude Code plugin, from the marketplace in this repository.** The plugin directory carries its own bundled CLI, so nothing has to be built:

```
/plugin marketplace add <owner>/context-graph
/plugin install context-graph@context-graph
```

A team pins it in the repository's `.claude/settings.json` so everyone gets the same version:

```json
{ "extraKnownMarketplaces": { "context-graph": { "source": { "source": "github", "repo": "<owner>/context-graph" } } },
  "enabledPlugins": { "context-graph@context-graph": true } }
```

**As a Codex plugin.** The same repository is a Codex marketplace through `.agents/plugins/marketplace.json`:

```sh
codex plugin marketplace add <owner>/context-graph
```

Codex requires hooks to be trusted once, with `/hooks` inside a session. Plugins do not reach the Codex IDE extension; `ctx install codex` writes user-level hooks for that case.

**As an npm package**, for the `ctx` command line, CI, the server, and the view:

```sh
npm pack                            # a tarball with dist/, adapters/, packs/, and the built view
npm install -g ./context-graph-0.1.0.tgz
ctx --help
```

The package is marked private until a registry and scope are chosen; remove that flag to publish.

## Build from a clone

```sh
npm install && npm run build        # generates the embedded packs, then tsc -> dist/
npm test                            # vitest
npm run bundle                      # the single-file CLI each adapter directory carries; CI checks it is current
cd view && npm install && npm run build   # the synapse view, served by ctx serve
```

Node 22.5 or later, for the built-in SQLite the vector store uses. Installing pulls the ONNX runtime for in-process embeddings, which is about 200MB on disk; hooks never load it unless embeddings are enabled.

## Give a repository a graph

Three ways, from most to least committed:

```sh
ctx init --repo <dir>                 # propose a graph from the tree, the import graph, tests, instruction files, ADRs, and packs
ctx init --repo <dir> --write         # write it as proposals; then ratify what you accept
ctx ratify hex.domain-pure C:ports-and-adapters   # or --all-proposed
```

Or commit a `.ctx/` directory you wrote by hand, or keep a graph elsewhere and link it without touching the repository:

```sh
ctx link --graph ../graphs/my-service/.ctx --repo ~/code/my-service
ctx check --repo ~/code/my-service
ctx slice src/services/booking-service.ts --repo ~/code/my-service
```

`CTX_GRAPH_DIR` overrides both. Ratifying a checkable constraint records its current violations as legacy decisions, so the walker tells the next agent a file is a known exception rather than letting it discover a contradiction.

What a bootstrap finds, in order of how much it is worth: the repository's own rule-stating tests (`no-*.test.ts`, `never-*`, boundary, architecture, contract, invariant, policy suites; a describe block or header sentence written as a rule becomes a proposed constraint with `test:` set, so ratifying it makes it enforced); imperative lines in instruction files; ADRs as concepts; file headers that carry a rationale, kept as notes on that file; then packs. Modules are named by their leaf directory, prefixed with the enclosing module when leaves collide (`L:web-app`, `L:mobile-app`), and a `src` directory is treated as a convention rather than a module. An auto-selected pack applies only when at least half its roles bind; name it in `[init] packs` to force it. The bootstrapping git identity becomes the first ratifier. A proposed rule asks for a decision at turn end like a ratified one: decisions that serve it are what ratify it, and the graph would never grow otherwise. If a graph is created while a session is already running, the next tool call announces it.

## Use it in Claude Code

```sh
claude --plugin-dir ~/workspace/context-graph/adapters/claude-code
```

or, without the plugin directory, `ctx install claude-code` writes the hooks into your user settings and prints the MCP registration command. The plugin registers the hooks and the `ctx` MCP server. On session start it prints the aliases, modules, and concepts, and tells the agent to call `hydrate` before working on a file, module, or task it has not read. Before each edit it injects the slice. After each tool call it records what was touched. When a turn ends with edited files that carry constraints, it asks for a decision per file until one is recorded or the loop guard gives up and records a no-decision entry.

## Use it in Codex

```sh
ctx install codex      # user-level hooks.json and the MCP server entry; then trust the hooks with /hooks inside Codex
```

The Codex plugin directory is `adapters/codex/` for marketplace distribution. Edits arrive as `apply_patch` and reads as shell, so the shell observer is the only read path there.

## Hydrate before you work

The slice is the floor: what applies to one file, in 300 tokens. Hydrate is the briefing an agent never assembles on its own. One call, one scope, one bounded text:

```sh
ctx hydrate src/services/booking-service.ts   # a file
ctx hydrate L:orchestration                                              # a module: its most connected files
ctx hydrate C:engine-pure                                                # a concept: the modules that implement it
ctx hydrate "why does the sla monitor write the workspace key directly"  # a task: the files it names, or whose names match
ctx hydrate <scope> --budget 800 --no-record
```

It returns, in this order: the slice for each file (one per distinct chain, so a module does not repeat itself); the callers of each file with the lines that import and use it, runtime callers before tests, marked when they are already in this session's context; the decision history behind the rules in force, including legacy exceptions; what this session has already read or edited, pending decisions, and the last compaction; hints from the embedding index when enabled; and what teammates have open when an overlay is reachable. Under the budget (default 1,500 tokens) it drops hints, then callee lists, then older decisions, then caller usage lines, then callers beyond three, then live lines, then files beyond three. Rules are never dropped.

The same tool is `hydrate` on the MCP server. Every call is observed: a `reach` event, and a `range` touch for each caller whose lines were returned, because that content did enter context. To hydrate automatically for the files and module ids a prompt names outright, set `hydrate_on_prompt = true` under `[slice]` in `config.toml` (`hydrate_budget` bounds it). It is off by default because it spends tokens on every prompt.

## Record and inspect decisions

```sh
ctx record --node <path> --serves <constraint-or-concept> --text "<why>" [--overrides <constraint>]
ctx why <node>              ctx history <node> [--timeline]
ctx pending                 ctx coverage [--session <id>]
ctx provenance              # after committing: link provisional decisions to the commit
ctx install git-hooks       # do that automatically on every commit
```

## Keep the graph honest

```sh
ctx gate --base origin/main [--run-tests]   # in CI: opposed arrows, double supersession, stale basis, context moved, ratification
ctx hygiene                                 # proposals from evidence; never retires
ctx retire <id> --reason "<why>" [--succ <id>]
ctx gc                                      # archive inactive records older than the threshold
ctx check --conformance                     # violations of rule-bearing constraints, minus recorded legacy exceptions
```

Concepts and enforced constraints need a commit trailer `Ctx-Ratified-By: <person>` from an identity listed under `[repo] ratifiers`; the gate checks it.

## See what was observed

```sh
ctx serve                       # local server on 127.0.0.1:7399 with the synapse view at /
ctx replay <transcript.jsonl>   # reconstruct a session that ran before the plugin
ctx sessions                    ctx coverage
```

The view collapses to modules by default, expands a module on click or when a session touches it, lights files by how much of them entered context, pulses on edits, flags applicable files that stayed dark, and replays a session with the scrubber. The evolution panel lists decisions and retirements over time. The status line says whether the stream is live and how long ago the last event arrived; the window control (all time, today, last hour) keeps a long history from burying what is happening now. Times are shown in your zone. A tab left open across a server restart reloads itself.

## Hosted mode

```sh
ctx serve --hosted --port 7400 --token <secret>      # on a shared host
```

Developers opt in with `[overlay] url` and `[observe] forward = true` and `CTX_OVERLAY_TOKEN`. The server keeps provisional decisions and in-flight touches per branch, runs the opposed-arrows check across branches as decisions arrive, and answers the pre-edit `live` query so a slice can say who has a file open and which provisional decision conflicts with what the agent is about to honour. `ctx overlay tail` prints one line per finding for a harness monitor; `ctx overlay retire --branch <name>` retires a branch's provisional entries after merge.

## Benchmark

```sh
ctx bench corpus --since 2026-06-01 --limit 20 --write   # tasks from commits that touched tests
ctx bench run --arms A,B,C --runs 3 --harness claude     # fresh worktree per run, graph cut at the base commit
ctx bench report
```

Arm A has no graph, B has the whole graph in the instruction file, C has slices at edit time. `--harness command --command "<cmd>"` runs any driver in the worktree, which is how the pipeline is tested without a model.

## Embeddings

```sh
ctx embed build     # [embed] enabled = true; provider = minilm (default) | onnx:<model> | local:<ollama-model> | openai:<model> | <url>#<model>
ctx embed query "retry handling for queue consumers"
```

The default provider runs MiniLM in-process through the ONNX runtime: no service, no key, and the model (about 23MB) is fetched once into `~/.ctx/models`. Hints appear in the slice below the constraints, scored, and are dropped first under budget.

Hooks are short-lived processes, so they do not load the model themselves. A running `ctx serve` keeps it warm and answers hint queries; with no server there are no hints unless `in_process_hooks = true`, which costs a model load per edit. In a team, the hosted overlay is the natural place for one shared index, and the compose file adds an Ollama service for teams that prefer a served model.

## Hosted overlay in a container

```sh
docker build -t context-graph .
docker run -p 7400:7400 -e CTX_OVERLAY_TOKEN=change-me -v ctx-data:/data context-graph
# or: CTX_OVERLAY_TOKEN=change-me docker compose up -d
```

## The graph grammar, in one screen

```
M <glob> <logical-id>                                   path to module
L <logical-id> <name>                                   module
C <concept-id> <name> [adr:<ref>] [since:<date>] [proposed]
E <from> <rel> <to> [since:<date>] [proposed]           in | impl | dep
K <mode> <k-id> <attached-to> <text> [test:<path>] [rule:<expr>] [from:<pack>@<ver>] [since:<date>]
D <d-id> <date> <who> <sha> <branch> <node> ->K <k-id> [!K <k-id>] <text>
S <new-d-id> <old-d-id>                                 supersession
Z <k-id|c-id> <date> <who> [succ:<id>] <reason>         retirement
A <alias> <node>                                        alias
R <{role}> <heuristic>                                  pack roles: dir:<name>|<name>, file:<glob>, root
```

Rules a constraint can carry: `noimport:<A>:<B>` and `public-entry:<A>`, evaluated against the import graph. Test files are excluded unless the rule ends in `+tests`.

See `.ctx/graph.ctx` for a complete, real example and `packs/` for the style packs.
