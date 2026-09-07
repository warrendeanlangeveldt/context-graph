# Context Graph

A standalone plugin for AI coding harnesses that does two things a session cannot do for itself:

1. **Observes** what context the agent actually built before each change: which files it read in full, which it saw only through grep, which it edited on the strength of a name alone, and which of the edited file's callers were ever in context.
2. **Anchors** the engineering context that should have applied, in a small graph kept in git, and injects the applicable slice at the moment the agent is about to edit a file. Before a turn ends, it asks for one decision per constrained file: what changed, and why, pointing at the constraint or concept the change honours.

The design specification is in `docs/design-spec.md`. This README covers what is built and how to run it.

## What is built

Delivery steps 1 to 3 of the specification:

- The `.ctx` line grammar: parser, validator, writer.
- The walker and the slice renderer with its token budget.
- The shell and patch observers, the observation store, session state, coverage records, and the import and symbol indexes.
- The recorder with the turn-end demand and its loop guard.
- The Claude Code adapter: hooks for session start, pre-edit, post-tool, subagents, and Stop; the MCP pull surface; plugin packaging.
- The `ctx` command line.
- A real graph for this repository under `.ctx/`.

Not yet built: the benchmark runner, the Codex adapter, transcript replay, the merge gate, bootstrap, hygiene, the live server, the synapse view, embeddings.

## Build

```sh
npm install
npm run build        # tsc -> dist/
npm test             # vitest
```

Node 20 or later.

## Give a repository a graph

Either commit a `.ctx/` directory at the repository root with `graph.ctx`, optionally `decisions.ctx`, `aliases.ctx`, and `config.toml`, or keep the graph elsewhere and link it:

```sh
node dist/cli/main.js link --graph ../graphs/my-service/.ctx --repo ~/code/my-service
node dist/cli/main.js check --repo ~/code/my-service
node dist/cli/main.js slice src/services/booking-service.ts --repo ~/code/my-service
```

`link` records the graph's location under `~/.ctx/graphs/` keyed by the repository, so the hooks find it without touching the repository. `CTX_GRAPH_DIR` overrides both.

## Use it in Claude Code

From the repository you want observed:

```sh
claude --plugin-dir ~/workspace/context-graph/adapters/claude-code
```

The plugin registers the hooks and the `ctx` MCP server. On session start it prints the aliases, modules, and concepts. Before each edit made with the edit tools it injects the slice. After each tool call it records what was touched. When a turn ends with edited files that carry constraints, it asks for a decision per file until one is recorded or the loop guard gives up and records a no-decision entry.

Record a decision either through the MCP tool `record` or from the shell:

```sh
ctx record --node src/services/booking-service.ts \
  --serves orch.store-mutation --text "purge goes through a blackboard event; direct delete rejected"
```

Observe-only mode, which records everything and injects nothing, is `enabled = false` under `[slice]` in the graph's `config.toml`. `enabled = "random:0.5"` assigns each session an arm at random and records it.

## Look at what was observed

```sh
ctx sessions --repo <dir>
ctx coverage --repo <dir> [--session <id>]
ctx pending  --repo <dir> [--session <id>]
ctx parse-shell "sed -n '340,420p' api/src/x.ts | grep foo"
```

Observation files live under `~/.ctx/observations/<repo-hash>/<session>.jsonl`, one JSON envelope per line, in the stream format the specification's section 14.2 describes.

## The graph grammar, in one screen

```
M <glob> <logical-id>                                   path to module
L <logical-id> <name>                                   module
C <concept-id> <name> [adr:<ref>] [proposed]            concept
E <from> <rel> <to> [proposed]                          in | impl | dep
K <mode> <k-id> <attached-to> <text> [test:<path>]      E enforced | G guided | R recorded | G? proposed
D <d-id> <date> <who> <sha> <branch> <node> ->K <k-id> [!K <k-id>] <text>
S <new-d-id> <old-d-id>                                 supersession
Z <k-id|c-id> <date> <who> [succ:<id>] <reason>         retirement
A <alias> <node>                                        alias
```

See `.ctx/graph.ctx` for a complete, real example.
