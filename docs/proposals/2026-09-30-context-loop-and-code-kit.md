# The context loop, and working alongside code-kit

| | |
|---|---|
| Status | Implemented in 0.2.0 (see design spec §8.3, §9.1, §9.4, §9.5, §15.4, §17). Kept as the record of why. |
| Date | 2026-09-30 |
| Author | Warren Langeveldt, drafted with Claude |
| Touches | §8 Observation, §9 Recording decisions, §15 Harness adapters, §17 Configuration |

## 1. Why

Context Graph was built to do three things around every change: make the agent build real context before it acts, tell it the *why* behind what it's about to change, and keep what it learns for the next agent. Today it does the second well and the first and third only partly. It injects slices, histories and cards, but it never stops an edit made on the strength of a grep, and it only asks for a record when a file already carries rules.

This proposal closes that loop, and defines how ctx works next to **code-kit**, the plugin that enforces lanes, layers, specs and proof-before-finish in the same projects. The two stay separate plugins, each useful alone, each aware of the other.

## 2. The loop

For every edit of a file F:

```
1. does ctx hold current context for F?
     no  (no card, or F changed since its card) → read F in full, and its dependencies (or their cards)
     yes                                        → hydrate: card, decisions, and (with code-kit) spec and layer rules
                                                  + read the lines being changed
2. edit
3. record: a card for F on a miss; a decision for the change, pointing at what it serves
```

Understanding compounds: once a neighbourhood has cards, a miss on F costs F plus a few cards, not F plus ten files.

## 3. What ctx does today

Checked against the code on 2026-09-30.

| Behaviour | Today | Evidence |
|---|---|---|
| Blocks an edit made without reading the file | Never. PreToolUse only injects. | `src/adapters/core.ts` PreToolUse branch returns context, never a deny |
| Context for a file the graph doesn't know | Nothing: no history, no card | `renderHistory` is silent without decisions (`core.ts` ~216) |
| Record for an edited file with no rules | Not asked for | §9.1: "Edits to nodes with no active constraints do not require a decision" |
| Blocks at turn end | Yes, for a missing decision on a constrained file | `core.ts:304` |

## 4. Proposal

### 4.1 File cards

A **card** is a file-level record of what a file is for, what it relies on, who relies on it, and the invariants it keeps. Decisions keep the *why of each change*; a card holds the *why of the file*.

- A new record kind, `F`, in its own file, `cards.ctx`, carrying the file's content hash at the time it was written.
- Written only after the observer has seen a **full read** of the file in the same agent's context (§4.4). A card from a grep is rejected.
- **Fresh** when the file's current hash matches. **Stale** when it doesn't: the agent reads at least the diff since the card's hash and updates the card.

### 4.2 Read before edit

Before an edit of an existing file:

| Case | Required in this agent's context |
|---|---|
| Fresh card | The card and decisions (hydrated automatically), and the range being edited |
| No card, or stale | The file in full; its imports, or their fresh cards |
| The edit changes the file's exports | Also its importers, or their fresh cards |

When the requirement isn't met, the edit is refused with the exact list: "read `src/booking.ts` in full and `src/api/cancel.ts`, or run `ctx hydrate src/booking.ts`". New files are exempt from reading but owe a card.

Configured under a new `[enforce]` section, each rule `off | nudge | block`. As built, the defaults are `block`: the loop is the point of the tool, and `nudge` remains for a repository that wants to adopt it gradually.

```toml
[enforce]
read_before_edit = "block"   # the file, or its fresh card
dependencies     = "block"   # imports on a miss; importers when exports change
cards            = "block"   # a card is owed after every edit, until it matches the file
```

`nudge` asks on the next tool call, as decisions already do; `block` refuses the edit (PreToolUse deny with the reason).

### 4.3 Write-back for every file

§9.1 changes: an edit of a file with no active constraints owes a **card** when it has none, and a decision when the change alters behaviour. Otherwise the graph only ever grows around rules it already has, and ordinary files never gain a why.

### 4.4 Per-agent observation

Enforcement is only fair if each agent's reads count for that agent. Today they don't (§6.2). Observation and state become keyed by session **and** agent, so a lane agent's full read counts for that lane agent, and cards and histories are announced once per agent rather than once per session.

## 5. Working alongside code-kit

### 5.1 How each finds the other

- ctx detects code-kit by `.claude/code-kit.json` in the repository.
- code-kit detects ctx by `.ctx/`. Its side is built (code-kit 0.3.0, in review): a `context-graph` **adapter** (`hooks/lib/adapters/context-graph.mjs` in code-kit) that adds, while `.ctx/` exists:
  - `.ctx/**` to the lead's paths;
  - `.ctx/decisions.ctx` to what any actor may write, so lane agents can record decisions;
  - `graph.ctx` and `config.toml` as protected paths (approval `ctx`);
  - a block on any Claude actor writing a `Ctx-Ratified-By` trailer;
  - setup: ignore ctx's working files, and `merge=union` for `decisions.ctx`.
- ctx gets the same shape: a **tool adapter**, `src/tool-adapters/code-kit.ts`, kept apart from the harness adapters in `src/adapters/` (§15). The core never names code-kit; it calls whichever tool adapters are detected.

### 5.2 What ctx takes from code-kit

Through code-kit's command line only, never its internals:

| From | ctx uses it for |
|---|---|
| `code-kit trace <path> --json` (planned in code-kit) | The requirements a file delivers, with their spec sections, found through commits naming `ST-n`; its lane; its layer and what that layer may import |
| `code-kit status --json` | Requirement IDs, so decisions can `--serves BOOK-4` |

A card then anchors its why in the spec ("delivers BOOK-4: a customer can cancel up to 24h before"), and the slice before an edit carries the layer rule ("layer domain: may import schemas only") so the agent plans within it. code-kit refuses a write that would break a layer, but the slice means the agent rarely hits that. ctx does not keep its own `rule:noimport:` copy of layers code-kit already enforces.

### 5.3 What code-kit takes from ctx

- `ctx hydrate`: code-kit's dispatch adds it to each lane's brief, and spec-check hydrates before comparing code with a requirement.
- `ctx coverage --json`: code-kit's review uses it as evidence ("edited `booking.ts`; never read its 4 importers").

## 6. Fixes needed regardless

These are bugs with or without code-kit. Each was confirmed in the code.

### 6.1 Agent worktrees map to the wrong module

A subagent with `isolation: "worktree"` works under `<repo>/.claude/worktrees/<id>/` while `CLAUDE_PROJECT_DIR` is the main checkout. The root comes from `CLAUDE_PROJECT_DIR` (`src/core/context.ts:85-86`), and paths are made relative to it (`src/util/paths.ts:42-47`). So `.claude/worktrees/abc/src/x.ts` matches only `M ** L:repo`, not `M src/** L:src`: the agent gets the root module's slice, rules and history. `findRepoRoot` checks only for a `.git` directory (`paths.ts:7-15`), and a worktree's `.git` is a file.

**Fix:** resolve each event's path against the worktree that contains it (`git rev-parse --show-toplevel` from the file's directory), and map it relative to that worktree. Observation stays keyed to the main repository (`git rev-parse --git-common-dir`), so all worktrees share one graph and one store.

### 6.2 Subagents' observation is pooled

`agent_id` is stored on each touch (`core.ts:122`) but never read. Coverage marks every subagent read `delegated` (`src/observe/coverage.ts:35`), and subagent edits are skipped after the tool runs (`core.ts:268`). `filesAnnounced` and `modulesAnnounced` are per session (`src/observe/store.ts:65-67`), so parallel agents miss histories and cards another agent was already shown. `SessionState.save()` rewrites the whole file (`store.ts:91-94`), so parallel hooks overwrite each other's state.

**Fix:** key state and announcements by session and agent (§4.4), and write state as appended events or per-agent files, not one rewritten file.

### 6.3 A refused edit still owes a decision

PreToolUse records the edit as pending before it runs (`core.ts:208`, `src/record/recorder.ts:36-52`). Pending is cleared only by `PostToolUseFailure` for that `tool_use_id` (`core.ts:259-262`) or by a decision. When another plugin's PreToolUse denies the edit (code-kit refusing a write outside the lane), neither fires. ctx nudges, blocks the turn, and eventually writes a spurious `no-decision` into `decisions.ctx` (`recorder.ts:181-200`).

**Fix:** record pending as *provisional* in PreToolUse and confirm it only on a successful PostToolUse for the same `tool_use_id`. Provisional entries left over when the turn ends are dropped.

### 6.4 Decision IDs collide across branches

`nextDecisionId()` is the local maximum plus one (`src/graph/graph.ts:190-197`). Two lanes on parallel branches both allocate `d-0042`; after the merge the loader reports a duplicate and one record overwrites the other (`graph.ts:85-86`).

**Fix:** IDs that can't collide, such as a short hash of the record's content and timestamp, still printed as `d-<hash>`. Existing `d-NNNN` IDs stay valid. `decisions.ctx` gets `merge=union` (code-kit's adapter already sets this up).

### 6.5 Provenance leaves the tree dirty after every commit

The post-commit hook runs `ctx provenance` (`src/install/install.ts:90-92`), which rewrites `-` SHAs in `decisions.ctx` and never stages or amends (`src/record/provenance.ts:40-51`). The tree is dirty after the commit. code-kit's finish check tells a lane to commit its work; the lane commits, provenance dirties the file again, and the lane loops.

**Fix:** never write after a commit. The commit that carries a decision is the one that added its line, so it is resolved when shown, from `git blame` on `decisions.ctx`.

## 7. Order of work

1. §6.3 refused edits, and §6.5 provenance. Small; they break any project that runs both plugins.
2. §6.1 worktrees, and §6.2 per-agent observation. They're prerequisites for enforcement being fair to parallel agents.
3. §6.4 decision IDs.
4. §4.1 file cards with freshness.
5. §4.2 read before edit, and §4.3 write-back, shipped as `nudge` first.
6. §5 the code-kit integration, once code-kit's `trace` command exists.

## 8. Open questions

- ~~Cards in `decisions.ctx`, or a separate `cards.ctx`?~~ Settled: `cards.ctx`, with `merge=union` like decisions.
- How big may a card be before it defeats its purpose? A budget like the slice's (around 150 tokens) seems right.
- Should `dependencies = "block"` cap the importers required, so a widely used file doesn't demand fifty reads? Probably: require importers' cards when they exist, and full reads of at most N without them.
