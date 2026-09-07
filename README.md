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

## Build

```sh
npm install && npm run build        # tsc -> dist/
npm test                            # vitest
cd view && npm install && npm run build   # the synapse view, served by ctx serve
```

Node 20 or later. The vector store uses Node's built-in SQLite.

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

## Use it in Claude Code

```sh
claude --plugin-dir ~/workspace/context-graph/adapters/claude-code
```

or, without the plugin directory, `ctx install claude-code` writes the hooks into your user settings and prints the MCP registration command. The plugin registers the hooks and the `ctx` MCP server. On session start it prints the aliases, modules, and concepts. Before each edit it injects the slice. After each tool call it records what was touched. When a turn ends with edited files that carry constraints, it asks for a decision per file until one is recorded or the loop guard gives up and records a no-decision entry.

## Use it in Codex

```sh
ctx install codex      # user-level hooks.json and the MCP server entry; then trust the hooks with /hooks inside Codex
```

The Codex plugin directory is `adapters/codex/` for marketplace distribution. Edits arrive as `apply_patch` and reads as shell, so the shell observer is the only read path there.

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

The view collapses to modules by default, expands a module on click or when a session touches it, lights files by how much of them entered context, pulses on edits, flags applicable files that stayed dark, and replays a session with the scrubber. The evolution panel lists decisions and retirements over time.

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
ctx embed build     # [embed] enabled = true, provider = local:<model> | openai:<model> | <url>#<model>
ctx embed query "retry handling for queue consumers"
```

Hints appear in the slice below the constraints, scored, and are dropped first under budget.

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
