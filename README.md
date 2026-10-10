<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/warrendeanlangeveldt/context-graph/main/assets/logo-dark.png">
    <img src="https://raw.githubusercontent.com/warrendeanlangeveldt/context-graph/main/assets/logo.png" alt="Context Graph" width="380">
  </picture>
</p>

# Context Graph

A plugin for Claude Code and Codex that gives AI coding agents the why behind a codebase, and makes them keep it. It does three things a session cannot do for itself:

1. **Observes** what context the agent actually built before each change: which files it read in full, which it saw only through grep, which it edited on the strength of a name alone, and which of the edited file's callers were ever in context.
2. **Anchors** the engineering context that should have applied, in a small graph kept in git, and injects the applicable slice at the moment the agent is about to edit a file. Before a turn ends, it asks for one decision per constrained file: what changed, and why, pointing at the constraint or concept the change honours.
3. **Closes the loop** around every edit. Before it, the file must be understood: either through its **card** (the file's why, kept current with a content hash), or by reading it in full with what it imports. An edit without that is refused, with the list of what to read. After it, the card is written or brought up to date. Understanding then builds up per file, so the next agent starts from the why instead of rediscovering it.

**Pairs with [code-kit](https://github.com/warrendeanlangeveldt/code-kit).** Context Graph explains why a file is the way it is; code-kit decides who may change it, and what has to be proved. code-kit gives each lane agent its own paths, layer rules and a spec-check before code, enforced by hooks and in CI. Each detects the other: with both, a file's card and slice carry its spec requirement and layer rule. See [Working alongside code-kit](#working-alongside-code-kit).

<p align="center">
  <img src="https://raw.githubusercontent.com/warrendeanlangeveldt/context-graph/main/assets/loop.svg" alt="How Context Graph works: context kept in git (modules and concepts, rules and constraints, decision history, file cards) is delivered to the agent; before an edit the file needs a fresh card or sufficient reading, and an edit with missing context is refused until the agent reads the file and its dependencies; the agent makes the change, then refreshes the card and records the decisions required, back into git. Reads, searches and edits are observed for each agent." width="820">
</p>

The design specification is in `docs/design-spec.md`. This README covers why and when to use Context Graph, how to start, and how each part works.

## Quick start

In Claude Code:

```text
/plugin marketplace add warrendeanlangeveldt/context-graph
/plugin install context-graph@context-graph
/context-graph:next
```

`/context-graph:next` looks at the repository and takes you through the next step. With no graph yet, that means proposing one from your tree, tests and docs, and reviewing it with you. Nothing is enforced until a graph exists. Want to see one first? `examples/booking-service/` is a real one, built by an agent.

## Why

An agent works out "what good looks like" from whatever it happens to read in a session. That understanding is local, invisible, and lost when the session ends. Two failures follow:
- **Locally right, contextually wrong.** A change can be correct line by line and still wrong for its module or domain, because the agent never found out what those require. The rule was in a file it didn't open. The reason was in someone's head, or in a pull request from last year.
- **Rediscovered every time.** The next session rebuilds the same understanding from scratch, and may land somewhere different. The codebase piles up decisions that are each defensible and jointly inconsistent, and nothing records that a decision was ever made.

Context Graph keeps that understanding outside any session, next to the code in git. It puts the part that applies in front of the agent at the moment it's about to change something, and makes it add what it learned before it moves on. A benchmark (`ctx-bench-lab`) measured the effect: rules that existed only as recorded decisions were applied 78% of the time with Context Graph, against 17% without, and earlier features broke less often.

## When to use it

Use it when:
- **The codebase has rules the code doesn't state:** money rounding, what an event must carry, which module may call which. These rules are broken by people who never saw them.
- **Decisions get lost:** "why is it like this?" has no answer but a person's memory, or the answer is spread across old pull requests.
- **Several agents or sessions work on the same code** and should build on each other's understanding, not start from zero.
- **You want evidence of how an agent worked:** which files it read in full, what it edited blind, which callers it never opened.

It costs something. Enforced reading and writing cards took about 2.5 times the time and tokens in the benchmark. For a throwaway script or a one-off spike, leave it observe-only (`[slice] enabled = false`) or don't give the repository a graph.

## Where it runs

- **In Claude Code and in Codex,** as a plugin: hooks, an MCP server named `ctx`, and skills. With no graph in the repository, it only observes.
- **In the repository:** `.ctx/` holds the graph (modules, rules, concepts), decisions and file cards as plain text, committed with the code. Observation data stays on your machine, in `~/.ctx`.
- **In CI:** `ctx gate` checks a branch's graph changes, ratification, and whether changed files have current cards.
- **Next to code-kit,** when both are installed. See [Working alongside code-kit](#working-alongside-code-kit).

## Start: `/context-graph:next`

Not sure what to do? Run `/context-graph:next`, in a new repository or at any point after. It reads where the repository stands and runs the right skill. It carries on until something needs you: a proposal to ratify, a commit to make, or nothing left to do.

| The repository has | `next` runs |
| --- | --- |
| No graph | `init`: propose one from the tree, tests, instruction files and ADRs, and review it with you |
| A broken graph or setup | `status`: what's wrong and how to fix it |
| Cards or decisions owed by the last session | `cards` |
| No Context Graph block in AGENTS.md or CLAUDE.md | `ctx install instructions` |
| Files this branch changed without a current card | `cards` |
| Proposed rules, or hygiene findings, waiting for a person | `curate` |
| None of that | nothing: a summary of the graph and its cards |

`ctx next` on the command line shows the same decision without running anything, and `ctx cards` shows which files have a current card.

| Skill | What it's for |
| --- | --- |
| `/context-graph:next` | The next step, from the repository's state |
| `/context-graph:init` | Set up a graph, ratifiers, the loop's settings and the instruction block |
| `/context-graph:cards` | Write the cards and decisions the work owes, from a full read |
| `/context-graph:curate` | Ratify, reword, retire and tidy the graph, with you deciding |
| `/context-graph:status` | Is it working, is the graph valid, what it holds, what the last session did |
| `/context-graph:ctx` | Ask why a file is the way it is, what applies, what was decided |

## Install

**Requirements:** Node 22.5 or later, and git. Claude Code, or Codex.

**Claude Code plugin**, from this repository's marketplace. It carries its own bundled CLI, so nothing has to be built:

```text
/plugin marketplace add warrendeanlangeveldt/context-graph
/plugin install context-graph@context-graph
```

To update, run `/plugin marketplace update context-graph`, then restart Claude Code: sessions started before an update keep the old hooks. To pin it for a whole team, add it to the repository's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": { "context-graph": { "source": { "source": "github", "repo": "warrendeanlangeveldt/context-graph" } } },
  "enabledPlugins": { "context-graph@context-graph": true }
}
```

**Codex plugin.** The same repository is a Codex marketplace, through `.agents/plugins/marketplace.json`:

```sh
codex plugin marketplace add warrendeanlangeveldt/context-graph
```

Codex asks you to trust hooks once, with `/hooks` inside a session. Plugins don't reach the Codex IDE extension; `ctx install codex` writes user-level hooks for that case.

**The `ctx` command.** A plugin install doesn't put `ctx` on your PATH. The hooks cope: they write every command they give an agent so it runs anyway. To have `ctx` for yourself, and for the plain `ctx` commands the instruction block names, use one of:

```sh
npm i -g @warren-dean/context-graph                    # from npm (in-process embeddings are a separate install: npm i -g @huggingface/transformers)
node <plugin dir>/ctx.mjs install cli     # or a launcher in ~/.local/bin that follows plugin updates
```

`/context-graph:init` offers the second, and `ctx doctor` tells you when `ctx` is missing.

**Its companion, [code-kit](https://github.com/warrendeanlangeveldt/code-kit)** (Claude Code), installs the same way. Nothing needs configuring between the two:

```text
/plugin marketplace add warrendeanlangeveldt/code-kit
/plugin install code-kit@code-kit
```

## Build from a clone

```sh
npm install && npm run build        # generates the embedded packs, then tsc -> dist/
npm test                            # vitest
npm run bundle                      # the single-file CLI each adapter directory carries; CI checks it is current
cd view && npm install && npm run build   # the synapse view, served by ctx serve
```

Node 22.5 or later, for the built-in SQLite the vector store uses. The ONNX runtime for in-process embeddings (about 350MB on disk) is an optional peer dependency, installed only when you want it; hooks never load it unless embeddings are enabled.

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

A linked graph is a trial: nothing in the repository changes, and nobody else sees it. Once it holds decisions worth keeping, move it in with `ctx adopt`, which copies it to `.ctx/`, drops the link, and leaves you one commit away from every checkout and teammate carrying it. `ctx doctor` warns while a graph is still linked. `CTX_GRAPH_DIR` overrides both. Ratifying a checkable constraint records its current violations as legacy decisions, so the walker tells the next agent a file is a known exception rather than letting it discover a contradiction.

What a bootstrap finds, in order of how much it is worth: the repository's own rule-stating tests (`no-*.test.ts`, `never-*`, boundary, architecture, contract, invariant, policy suites; a describe block or header sentence written as a rule becomes a proposed constraint with `test:` set, so ratifying it makes it enforced); imperative lines in instruction files; ADRs as concepts; file headers that carry a rationale, kept as notes on that file; then packs. Modules are named by their leaf directory, prefixed with the enclosing module when leaves collide (`L:web-app`, `L:mobile-app`), and a `src` directory is treated as a convention rather than a module. An auto-selected pack applies only when at least half its roles bind; name it in `[init] packs` to force it. The bootstrapping git identity becomes the first ratifier. A proposed rule on the file's own module asks for a decision at turn end like a ratified one: decisions that serve it are what ratify it, and the graph would never grow otherwise. A proposal pinned to the top of the chain applies to every file and asks nothing; it earns its place through ratification. Test files owe no decision unless they are the test behind a ratified rule. Re-running `ctx init` on a graph that already names its modules proposes no modules: rules, notes, and concepts attach to the modules the graph has, and lines from AGENTS.md or CLAUDE.md are kept only when they name a module, because the harness already puts the rest in front of the model every turn. If a graph is created while a session is already running, the next tool call announces it. `ctx init --write` also appends a Context Graph block to the repository's AGENTS.md or CLAUDE.md (`ctx install instructions` does it for a repository that already has a graph): the hooks push the floor, and the instruction file is what makes an agent pull the rest before it starts reading code, because it is re-read every turn where a session-start note is read once.

## Use it in Claude Code

```sh
claude --plugin-dir <clone>/adapters/claude-code     # straight from a clone, without the marketplace
```

Or, without the plugin directory, `ctx install claude-code` writes the hooks into your user settings and prints the MCP registration command. The plugin registers the hooks, the `ctx` MCP server and the skills. What a session then sees:

- **At session start:** the aliases, modules and concepts, how the context loop works, and an instruction to call `hydrate` before working on a file, module or task it hasn't read.
- **On the first read of a file:** its card, what tool adapters know of it (with code-kit, the spec requirement and layer rules), and its recorded decisions: what was decided there, by whom and why, newest first, three at most. A wrong mental model is built by reading, not writing, and a decision is the one thing grep can't show. A file with nothing recorded gets nothing, and each file is answered once per agent.
- **On the first read or grep under a module:** that module's card. That's the module and its place in the chain, its rules (enforced first), the rules it inherits as ids, its latest decision, and a pointer to `hydrate`. Once per module per agent, so the cost is bounded by the number of modules.
- **Before each edit:** the slice. It carries the file's rules, the newest decisions, and what reaches the file through its imports.
  - The newest decision on a file is never dropped, whatever the budget: a file with enough rules to fill the budget is exactly the one whose history the next agent can't reconstruct.
  - A proposed rule on the file's own module appears in full. Inherited proposals appear as one line of ids, since proposals crowded next to ratified rules get skimmed. `hydrate` shows them all.
  - If the file isn't understood yet, the edit is refused instead (see [The context loop](#the-context-loop)).
- **After each tool call:** what was touched is recorded.
- **When something is owed:** an edited file that carries rules owes a decision, and every edited file owes its card. The next tool call carries the ask, which costs a few tokens and interrupts nothing; most are recorded from there. Only a turn that ends still owing one is held open. Claude Code shows any blocking Stop hook as an error, so the message says plainly that it's the demand, not a failure. Set `demand = false` under `[record]` to record the gap as a finding and never hold a turn.

### In the session

With Claude Code 2.1.287 or later, the plugin's mod shows the graph to you while agents work, in the terminal (VS Code's terminal included) and the Desktop app. Older versions skip it; the hooks above work the same either way.

- **`/graph`** opens the Context pane; `/graph <path>` opens it on that file and keeps it there until you follow the agents again. `/graph` again, or Escape, closes it (Escape goes back first when you've opened something from a list). Its first line sums up the graph's health: the share of files with a current card, cards owed this session, proposals waiting, as ☀, ⛅ or ⛈. It turns ⛅ or ⛈ only for cards owed and rules overridden, never for a low carded share: a project that already has code starts near 0% carded, and that's fine. Tabs on **1** to **4**, with **j**/**k** to move in a list and **Enter** (or **o**) to open:
  - **File:** the file an agent last read or edited, and which agent: its card (current or stale, drawn as Markdown), the rules on it as chips by kind, its module chain, its newest decisions, whether that agent has understood it, with what it still has to read, and its neighbourhood: what it imports and what imports it, each marked ● current, ◐ stale or ○ missing card and ✗ when it breaks a rule, a press away. With code-kit installed, also the file's lane, layer and requirement, with a button for code-kit's Lanes pane. A file without a current card has **Write card** (or **Update card**), and its module has **Cards for this module**: each asks the lead to run `/context-graph:cards`, which it does itself or hands to the agent working on those files. Writing cards isn't only yours: the lead may ask for them, and the hooks ask every agent for the card of each file it edits.
  - **Proposals:** the rules Context Graph found in your code and decisions, waiting for you, grouped by module. Each has its evidence (decisions that served it, decisions that overrode it, current violations), with a sparkline of those decisions week by week once there are any. **Accept** (**a**) makes it an agreed rule that agents are held to: it asks you to confirm, then runs `ctx ratify <id> --commit`, which commits it with your name. **Accept all on L:…** does a whole module's in one commit. **Reject…** (**r**) asks why, then runs `ctx drop <id> --reason … --commit`, removing it and keeping your reason. **Later** (**l**) puts it at the back of the queue for the session. Accepting and rejecting refuse on a protected branch or for someone not among the ratifiers, and change nothing then. The hooks refuse both from every agent.
  - **Coverage:** for each agent this session, files read in full, files only searched, files edited, and cards owed. An edit made without understanding is marked, with what was still unread; Enter on an agent opens the file it edited without understanding.
  - **Map:** the modules as a tree, each with its rules (proposals marked), its decisions over the last 30 days as a sparkline, and the share of its files with a current card. **Enter** on a module shows its files as a heat map, a cell each, current, stale, missing or owed this session, with a legend; **Enter** on a file opens it in the File tab.
- **Read-assist:** when an edit is refused because the file isn't understood yet, the refusal is drawn as a card listing the files still to read, ticked as the agent reads them ("1 of 2 read", then "understood"), and the agent is told to read them in full and edit again. Only its own full reads count. Edit rows in the transcript carry a tag while they're "not understood" or have a "card owed". The Coverage tab lists each reading list's progress.
- **The band** above the prompt shows the same health line while proposals or cards wait, or the graph's health isn't good, with a button that opens the pane.
- **The card writer,** when `/graph-settings` turns it on: when the lead finishes a turn, the lead is asked to start it in the background on the cards owed this session and the files the branch changed without a current card, up to ten at a time. It reads each file in full, with what it imports, before writing its card, and never edits a file. A file an agent edited in the last 2 minutes waits. With it on, **Write card** and **Cards for this module** queue files for it instead of asking the lead. It pauses while the plan's 5-hour use is past the pause point (code-kit's, when code-kit is installed). The Coverage tab says what it's doing.
- **The backfill,** for a project that already has code: with `[harness] backfill` set to `active` (the modules changed in the last 90 days) or `all`, the card writer also cards the existing files, leaves first, so each file's imports are carded before it's read. `/context-graph:init` offers it, and `ctx cards --backfill` shows what it would take. Its progress shows in the band, with **Pause**, and in the Map tab.
- **The curator,** when turned on: after every 10 new decisions, or when you press **Curate now** in the Proposals tab, the lead is asked to start it in the background. It reviews the decisions and the graph's evidence and proposes the rules three or more decisions on one module follow that nobody wrote down, citing them. It only proposes: ratifying, dropping and retiring stay yours. Agreed rules the team keeps overriding (three times since ratified, or on a streak) are flagged in the Proposals tab with the decisions that overrode them, and count against the health line. It pauses with the card writer.
- **`/why <path, module, rule or question>`** (or **Why?** on the file in view, on **w**) asks the graph why, beside the conversation: the records on what it names (cards, rules, decisions) are looked up, and a side call over the session's own context answers from them alone, citing them, in a pane of its own with its time and tokens. The lead's conversation gains nothing. When the graph holds nothing on it, it says so and makes no call.
- **`/graph-settings`** opens the harness settings: the card writer, the curator and side questions, each on or off with its model, and the pause point. A change asks your reason, and is written to `.ctx/config.toml` as yours. With code-kit's mod as well, both plugins' lines stand together.

The pane stays current within 2 seconds of a read, an edit or a change to the graph, and never calls a model. It isn't `/context`, which is Claude Code's own command, or `/ctx`, which is the plugin's `ctx` skill. In a repository with no graph, `/graph` says how to start one. Mods don't draw in the VS Code extension's chat panel, the Agent SDK or `claude -p`.

## Use it in Codex

```sh
ctx install codex      # user-level hooks.json and the MCP server entry; then trust the hooks with /hooks inside Codex
```

The Codex plugin directory is `adapters/codex/` for marketplace distribution. Edits arrive as `apply_patch` and reads as shell, so the shell observer is the only read path there.

## The context loop

For every edit of a file:

```
1. is the file understood by this agent?
     its card is fresh (the file is unchanged since the card)        → yes; the card is shown with the slice
     otherwise: read in full this session, and what it imports too   → yes (an import with a fresh card counts)
     even with a fresh card: an import carrying decisions or rules   → read, or its own fresh card
     and if the edit changes what the file exports: its importers     → read, or their fresh cards (at most max_importers)
   no → the edit is refused, naming each file to read and why
2. the edit
3. the card is owed: what the file is for, what it relies on, who relies on it, what it must keep true
   asked for on the next tool call; the turn (or a subagent's hand-back) does not end until it matches the file
```

The slice before an edit also carries what reaches the file **through its imports**. For each imported file, it shows that file's own decisions and the rules of its module that the edited file doesn't already see. A rule is often obeyed away from where it's written: an event's shape is defined in one module and recorded in another.

A **card** is an `F` record in `.ctx/cards.ctx`, written with the `card` MCP tool or `ctx card <path> --text "..."`. It carries the file's content hash, so it is fresh only while the file is unchanged; the latest card for a path is the one in force. The first time an agent reads a file, it is shown the card (or told there is none and that it must read the file in full before editing). `hydrate` and `why` show it too.

Each agent's context is its own. A subagent's reads count for that subagent only, since it has its own context window; it is shown its own cards and histories, and owes its own decisions and cards when it stops (SubagentStop). A subagent isolated in a git worktree maps its paths through its worktree, reads its own branch's files, and records into its own branch's `.ctx/`: with an absolute path, the MCP `card` and `record` tools write to the worktree the path is in.

Reads are recorded as the tool call starts, so a read followed at once by an edit is never refused while the asynchronous completion hook is still running. An edit that another hook refuses owes nothing: it is only noted as provisional until its call completes.

```toml
[enforce]
read_before_edit = "block"   # off | nudge | block
dependencies     = "block"   # imports on a miss; importers when an edit changes exports
cards            = "block"   # off | nudge (a finding) | block (held like a decision)
max_importers    = 5

[cards]
exclude = ["src/generated/**"]   # adds to the defaults: lockfiles, docs, config, dotfiles, build output, the graph itself
```

## Working alongside code-kit

[code-kit](https://github.com/warrendeanlangeveldt/code-kit) enforces lanes, layers, specs and proof-before-finish in the same repositories. Each knows the other through an adapter, and neither imports the other's code.

- **ctx's tool adapter** (`src/tool-adapters/code-kit.ts`) switches on when `.claude/code-kit.json` exists. It asks `code-kit trace <path> --json` what a file is for: the spec requirements it delivers, its lane, its layer, and what that layer may import. It finds code-kit through `CODE_KIT_CLI`, or through the plugin Claude Code has installed. Cards and slices then say `spec BOOK-4 Cancel a booking (docs/specs/03-booking.md; ST-4)` and `code-kit lane web; layer domain, may import schemas`, and a card's `req:` is filled in from the trace. code-kit refuses writes outside a lane or across a layer; ctx makes it rare that an agent tries. With code-kit layers present, `ctx init` keeps pack import rules as guidance rather than a second machine check.
- **code-kit's adapter for ctx** switches on when `.ctx/` exists. It lets every agent write `decisions.ctx` and `cards.ctx`, makes `graph.ctx` and `config.toml` the lead's protected files, blocks agents from writing a `Ctx-Ratified-By` trailer, and has init add `merge=union` for the decision and card files.

## Hydrate before you work

The slice is the floor: what applies to one file, in 300 tokens. Hydrate is the briefing an agent never assembles on its own. One call, one scope, one bounded text:

```sh
ctx hydrate src/services/booking-service.ts                            # a file
ctx hydrate L:services                                                   # a module: its most connected files
ctx hydrate C:event-log                                                  # a concept: the modules that implement it
ctx hydrate "why are staff never charged a cancellation fee"              # a task: the files it names, or whose names match
ctx hydrate <scope> --budget 800 --no-record
```

It returns, in this order: the slice for each file (one per distinct chain, so a module does not repeat itself); the callers of each file with the lines that import and use it, runtime callers before tests, marked when they are already in this session's context; the decision history behind the rules in force, including legacy exceptions; what this session has already read or edited, pending decisions, and the last compaction; hints from the embedding index when enabled; and what teammates have open when an overlay is reachable. Under the budget (default 1,500 tokens) it drops hints, then callee lists, then older decisions, then caller usage lines, then callers beyond three, then live lines, then files beyond three. Rules are never dropped.

The same tool is `hydrate` on the MCP server. Every call is observed: a `reach` event, and a `range` touch for each caller whose lines were returned, because that content did enter context. To hydrate automatically for the files and module ids a prompt names outright, set `hydrate_on_prompt = true` under `[slice]` in `config.toml` (`hydrate_budget` bounds it). It is off by default because it spends tokens on every prompt.

Shell observation sees through interpreter scripts as well: a heredoc fed to `python3 -`, `node -`, or `bash`, a `cat <<EOF |` handed on, or an inline `-c` / `-e`. The body is scanned for path literals and the calls that read, write, or delete them, with one level of variable resolution, so `p='src/a.ts'; open(p,'w').write(...)` is an edit of that file. A script that names no file the scanner can attribute is still recorded as an unparsed edit on `.`, and the view counts those as "edits, file unknown", because a silent zero looks like a clean session.

The MCP server and a `ctx` command run from the agent's shell are not told which session they serve. The hooks note their process ancestry once per session, and both match against it, so a decision recorded through either clears that session's pending list and hydrate sees what that session has read. A decision recorded on a path by any route settles the turn-end demand for it.

Shell commands resolve against where the harness's shell actually is. A harness that keeps the shell's directory between calls is followed through every `cd`; one that resets it says so in the tool result and is believed. When a relative path does not exist against the tracked directory but does against the session root, the one that exists wins. A shell command that fails, or that the harness reports as non-zero, edited nothing: its touches are recorded as failed and the edits it announced before running owe no decision.

## Is it working?

```sh
ctx doctor
```

One line per link in the chain: the graph and its ratifiers, the instruction block, the installed plugin version against the source, running Claude Code processes that started before the plugin was installed or updated (they never loaded its hooks and look exactly like a plugin that is not wired; exit them and start again with `claude --resume`), which sessions the hooks fired in during the last 24 hours with their edit, slice, and card counts, whether ctx was only reached from the shell, and whether `ctx serve` is up. The session-start text also carries the plugin version, so asking a session what Context Graph said at start answers the same question from inside.

## Record and inspect decisions

```sh
ctx record --node <path> --serves <constraint-or-concept> --text "<why>" [--overrides <constraint>]
ctx why <node>              ctx history <node> [--timeline]     # a path or module gives its own decisions; a rule id gives every decision that serves or overrides it
ctx card <path> --text "<why the file exists, what it relies on, what it must keep true>" [--req ID,ID]
ctx pending                 ctx coverage [--session <id>]
ctx provenance              # which of this branch's decisions are committed, and in which commit
ctx install git-hooks       # post-commit: refresh the embedding index when enabled
```

A decision's commit is read from git (`git blame` on `decisions.ctx`) when it is shown, never written into the file after a commit, so committing leaves the working tree clean. Decision ids are random (`d-3fa91c`), so decisions recorded on parallel branches never collide; order comes from date and file position. Add `.ctx/decisions.ctx merge=union` and `.ctx/cards.ctx merge=union` to `.gitattributes` so merges keep every record.

## Keep the graph honest

```sh
ctx gate --base origin/main [--run-tests]   # in CI: opposed arrows, double supersession, stale basis, context moved, ratification, cards
ctx hygiene                                 # proposals from evidence; never retires
ctx retire <id> --reason "<why>" [--succ <id>] [--delegated]
ctx module <L:id> --paths "<glob>…" [--in <L:parent>] [--name "…"] [--delegated --reason "…"]
ctx gc                                      # archive inactive records older than the threshold
ctx settings [set <key> <value> --reason "…"]  # the mod's harness: card writer, curator, side questions; set is your change
ctx check --conformance                     # violations of rule-bearing constraints, minus recorded legacy exceptions
```

Concepts and enforced constraints need a commit trailer `Ctx-Ratified-By: <person>` from an identity listed under `[repo] ratifiers`; the gate checks it.

**Giving paths their own module.** A rule attaches to a module, never to a glob. So when some paths need rules of their own, give them a module first:

```sh
ctx module L:billing --paths "src/billing/** src/invoices/**" --name "Billing"
```

- **Mappings:** it writes the mappings ahead of any broader one that would claim the same paths, since a path belongs to the first mapping that matches it.
- **Parent:** the module sits in the module those paths belonged to, or `--in L:parent`.
- **Edge:** its containment edge is proposed until a person ratifies it, and its files inherit the parent's rules through it meanwhile. With `modules` in `[delegate] may_ratify`, the lead adds it agreed, with `--delegated --reason "…"`.
- **On a graph that already names its modules,** `ctx init` proposes modules for the folders nothing maps yet, other than the root or a parent folder's glob, in the same way.

**Proposing a rule.** Any agent, or you, can propose a rule for a path's module: `ctx propose src/billing/invoice.ts "Money is stored as integer cents"` (or the MCP tool `propose`). Name the module as `L:…` instead of a path if you like; add `--test <path>` for a test that checks it, or `--rule` for a checkable rule. It goes into `proposals.ctx` and applies as proposed until a person ratifies it.

**Proposals, ratifying and dropping, as the person.** `ctx proposals` lists the proposed rules and concepts with their evidence: decisions that served each, decisions that overrode it, and current violations of a checkable rule.

- **`ctx ratify <id>... --commit`** ratifies, then commits only the graph's files with your `Ctx-Ratified-By` trailer.
- **`ctx drop <id> --reason "…" [--commit]`** turns a proposal down. It's recorded as a retirement, so the reason stays in the graph's history.
- **Where it refuses:** both refuse, before changing anything, on the default branch or one code-kit protects, and when you aren't among the ratifiers.
- **Agents can't:** both are your own acts, and the hooks refuse them from every agent.

**What the session shows.** `ctx file <path> [--agent <id>]` gives a file's card (current or stale), rules, chain and newest decisions, and whether an agent has understood it, with what it still has to read. `ctx agents` gives each agent's coverage for the session: files read in full, files only searched, files edited (and whether each was understood first), and cards still owed. Both take `--json`, which the coming Context Graph mod reads (`docs/brief.md`).

**Delegated ratification.** For a lead that runs without a person watching, such as an autonomous team, the repository's `.ctx/config.toml` can name a delegated ratifier and the kinds it may ratify:

```toml
[delegate]
ratifier = "sidequest-lead"          # the agent identity in its trailer
may_ratify = ["guidance", "concepts"]  # of guidance, enforced, concepts, retirements, modules; default guidance
```

- The lead runs `ctx ratify <id>... --delegated --reason "<why it should hold>"`.
- It's all or nothing: if any record is of a kind outside `may_ratify`, nothing is ratified, and the person decides. A module's containment edge is `modules`; any other proposed edge goes to the person.
- It retires the same way: `ctx retire <id> --reason "<why>" --delegated` is recorded as `<ratifier>/delegated`, and a retirement that needs ratifying (a concept, an enforced rule) needs `retirements` in `may_ratify`.
- Each ratified record gets a decision by `<ratifier>/delegated`, reading `ratified <id> (delegated: <kind>): <reason>`, so the why travels with the graph.
- The commit carries `Ctx-Ratified-By: <ratifier> (delegated)`. The gate accepts that trailer only for the kinds delegated, and never counts it as a person's.
- It's read only from the repository's own config. Without `[delegate]`, `--delegated` is refused. The gate also reports each file the branch changed that has no card matching its content (`[gate] cards = "warn"`, or `"fail"`, or `"off"`), so the loop holds for changes made outside a session too.

## See what was observed

```sh
ctx serve                       # local server on 127.0.0.1:7399 with the synapse view at /
ctx replay <transcript.jsonl>   # reconstruct a session that ran before the plugin
ctx sessions                    ctx coverage
```

The view opens on the map: one plate per containment depth, every module a district that keeps its place for the life of the graph, sized by how many files it holds and lit by how much of it this session read. Amber is the session and nothing else, a red ring is an edit whose callers were never opened, a dashed red arc is an import a `rule:noimport:` constraint forbids, and the headline is one sentence naming the most alarming thing that is true. Clicking a district opens its reading. The force layouts are still there behind the 3D and 2D buttons, for the question the map cannot answer: what is connected to what, at file level. The view collapses to modules in those modes, expands a module on click or when a session touches it, lights files by how much of them entered context, pulses on edits, flags applicable files that stayed dark, and replays a session with the scrubber. The evolution panel lists decisions and retirements over time. The status line says whether the stream is live and how long ago the last event arrived; the window control (all time, today, last hour) keeps a long history from burying what is happening now. Times are shown in your zone. A tab left open across a server restart reloads itself.

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
| 14 | The context loop: file cards with content-hash freshness, read before edit (the file, its imports, its importers on an export change), cards owed after an edit, per-agent observation and state | `src/cards/`, `src/enforce/`, `src/adapters/core.ts` |
| 15 | Tool adapters: facts from other tools that share the repository; code-kit (spec requirements, lane, layer rules) | `src/tool-adapters/` |
| 16 | Context through imports: the rules and decisions of what a file imports, in its slice; a card doesn't excuse an import that carries context | `src/walker/depends.ts` |
| 17 | Guidance: `ctx next` (the step to take, from the repository's state), `ctx cards`, and the `next`, `init`, `cards`, `curate` and `status` skills for both harnesses | `src/cli/guide.ts`, `adapters/*/skills/` |

Also: commit provenance resolved from git (`ctx provenance`), and a worked example under `examples/booking-service/`: a booking service built by an agent under the context loop, with its graph, decisions and cards.

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
F <path> <hash> <date> <who> <text> [req:<id>,<id>]     file card (cards.ctx); fresh while the file's hash matches
```

Rules a constraint can carry: `noimport:<A>:<B>` and `public-entry:<A>`, evaluated against the import graph. Test files are excluded unless the rule ends in `+tests`.

See `examples/booking-service/` for a complete example: the code, and the graph, decisions and cards an agent built around it (its README says how to try it). `packs/` holds the style packs.

## Changes

What changed in each release is in [CHANGELOG.md](https://github.com/warrendeanlangeveldt/context-graph/blob/main/CHANGELOG.md), and on [GitHub Releases](https://github.com/warrendeanlangeveldt/context-graph/releases).

## Licence

MIT. See [LICENSE](LICENSE). To report a security problem, see [SECURITY.md](SECURITY.md).
