# 10. What Context Graph costs to run

**Status:** draft
**Outcome:** Context Graph costs a session a few processes a minute while nobody is looking at it, never spends model tokens the person didn't switch on, and does background work once per checkout rather than once per session.
**Actors:** the mod (refreshes what it shows, runs the card writer); the hooks (observe tool calls); the person (switches the background work on)
**Depends on:** 04-card-writer, 09-panes

Measured on a Mac Studio running seven Claude Code sessions, Context Graph started a new `node ctx.mjs` process about once a second. Each one loads the bundle (about 0.25 s before it does anything), parses the graph and exits.

- **The mod refreshed every 2 seconds while an agent worked.** Its fingerprint counted every tool call as a change. Each refresh ran about eleven commands one after another: `info`, `proposals`, `cards`, `hygiene`, `settings`, `cards --changed`, `cards --recent`, `cards --backfill`, `agents`, `file` and `neighbours`.
- **Those commands reread everything.** `cards` and the backfill read and hashed every tracked file on every refresh. The backfill also walked 90 days of git history, and its ordering refiltered the remaining files on every pass.
- **The hooks ran for every tool call.** PostToolUse matched every tool, although only eight tools touch files.
- **The card writer and the backfill were on by default.** Every session ran them independently, so each one scanned the same checkout and spent Sonnet tokens on the same backlog.

On a repository of 269 files, a hook call took 0.5 to 1 s, `cards` 1 s and the backfill 2.4 s. A refresh cost several seconds of CPU and started again 2 seconds later, in every session.

## In scope

- When the mod refreshes, and how many processes a refresh starts.
- Caching what doesn't change between refreshes: file hashes, and which modules are active.
- One card writer per checkout, and the card writer and backfill off unless the person switches them on.
- Which tool calls start a hook.

## Out of scope

- Keeping the graph in memory in the MCP server. A snapshot command gets most of the saving without a long-lived cache to invalidate.
- The Codex adapter's hooks, whose tool names differ.

## Data

| Entity     | Where                                   | Fields                                                                                    |
| ---------- | --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Hash cache | `~/.ctx/hashes/<checkout>.json`         | path → size, mtime and content hash; a file whose size or mtime changed is hashed again    |
| Writer     | `~/.ctx/writers/<checkout>.json`        | session, since, last seen; the session running the card writer and backfill for a checkout |

## Requirements

### COST-1 Refresh on change

The mod refreshes when the graph's files (`graph.ctx`, `proposals.ctx`, `decisions.ctx`, `cards.ctx`, `config.toml`) change, when the followed file changes, or when an agent edits a file. Other tool calls count as a change only while the Context pane is open, where the coverage they change is shown. With nothing changed, it refreshes every minute while the pane is open and every five minutes otherwise.

**Acceptance**

- Given the pane closed and an agent reading files, then the mod doesn't refresh until an edit, a change to the graph's files or five minutes have passed.
- Given the pane open and an agent reading files, then the coverage refreshes within 2 seconds of each call, as before.

### COST-2 One process per refresh

`ctx snapshot --json` returns what a refresh shows from one process with the graph loaded once: `info`, `proposals`, `cards`, `hygiene` (the rules agents keep overriding, which the pane flags; the rest of hygiene runs git and isn't shown there), `settings` and `agents`, and with the card writer on, `changed`, `recent` and `backfill`. With `--file <path>` it adds the file and its neighbours. The mod reads it in place of the separate commands.

**Acceptance**

- Given a graph, then `ctx snapshot --json --session S` returns the same `info`, `proposals`, `cards`, `settings` and `agents` as the separate commands, and hygiene's overridden rules.
- Given the card writer off, then the snapshot has no `changed`, `recent` or `backfill`, and runs none of their git commands.

### COST-3 Hashes and active modules cached

A file's content hash is cached by its size and modification time, so `cards`, the backfill and the snapshot read only the files that changed since the last run. The modules the backfill's `active` scope keeps (those changed in the last 90 days) are cached for the commit HEAD is on. The backfill orders its files in one pass over the import graph.

**Acceptance**

- Given `ctx cards` run twice with no file changed, then the second run reads no tracked file's contents.
- Given a file edited between two runs, then the second run hashes that file again and reports its card stale.
- Given the backfill run twice on the same HEAD, then the second run doesn't walk the git history.

### COST-4 Background work, once per checkout, when switched on

The card writer and the backfill are off by default (`card_writer = false`, `backfill = "off"`); init and the settings pane offer them, and say each one spends model tokens. With them on, one session per checkout runs them: the first to claim the checkout's writer, until it ends or hasn't been seen for two minutes. Other sessions show the writer's progress and start nothing.

**Acceptance**

- Given a new graph, then `ctx settings --json` shows `card_writer` false and `backfill` off, and no session sends a card request.
- Given the card writer on and two sessions in one checkout, then only the first sends card requests; when it ends, the second takes over within two minutes.

### COST-5 Hooks only for the tools they observe

PostToolUse and PostToolUseFailure run the hook only for the tools whose calls touch files (Read, Grep, Glob, Edit, Write, MultiEdit, NotebookEdit and Bash), as PreToolUse does.

**Acceptance**

- Given an Agent, Task or MCP tool call, then no Context Graph hook process starts for it.

## Open questions

| Question                                                                                  | Owner  | Blocks |
| ----------------------------------------------------------------------------------------- | ------ | ------ |
| Should the MCP server hold the graph in memory and serve the snapshot, once COST-2 is measured | Warren | none   |
