# 04. Card writer

**Status:** draft
**Outcome:** Owed cards get written in the background, from a full reading of each file, without interrupting the lead or the person.
**Actors:** the mod (writes the cards, with its own model requests); the lead (never asked for cards, nor to start anything)
**Depends on:** 09-panes (its harness settings)

## In scope

- The mod writes cards in the background, a file at a time, with its own model requests, for files owed this session or changed on the branch without a current card. It never prompts the lead or adds to the person's conversation: a mod can't start an agent in auto mode (Claude Code refuses a plugin's `$.agent.spawn` there, as the auto mode classifier has no request of the model's to judge it by), and asking the lead to start one put Context Graph's request in front of the person.
- Each card is written from the file in full, with what it imports and what imports it.
- It works whenever the plan leaves room, never on a file an agent is editing.
- A backfill for a project that already has code (`[harness] backfill`: `active`, the modules changed in the last 90 days, or `all`): the existing files without a current card, leaves first, after the cards owed and changed; offered by init, paused from the band.

## Data

| Entity   | Field  | Type   | Required | Rules                                   |
| -------- | ------ | ------ | -------- | --------------------------------------- |
| Card job | path   | string | yes      | One job per file at a time              |
| Card job | reason | enum   | yes      | `asked`, `owed`, `changed`, `recent`, `backfill` |
| Card job | state  | enum   | yes      | `waiting`, `writing`, `done`, `skipped` |

## Requirements

### CARDW-1 What it writes

When on, the card writer takes the files owed a card this session and those changed on the branch without a current card, in order, and writes each one's card, one at a time, whether or not the lead is mid-turn. Files an agent edited in the last 2 minutes wait; a card it just wrote isn't written again until its file changes. The model is `card_writer_model`, Sonnet when empty.

**Acceptance**

- Given `src/a.ts` owed a card and nobody editing it, then within seconds the mod writes its card (`ctx card src/a.ts --text … --agent card-writer`), the file stops being owed, and the lead receives no prompt.

### CARDW-2 From a full reading

Its request carries the file in full (up to 60,000 characters), each import by its current card or its source, what imports it, and the file's last commits and diff; the model answers with the card, or `SKIP: <why>` for a file that isn't code.

### CARDW-3 Within the owed demand

A card it writes satisfies the owed demand exactly as one the editing agent writes.

### CARDW-4 Asked for

Write card and Cards for this module in the pane queue jobs for the card writer when it's on; with it off, the person's press asks the lead to run the cards skill.

### CARDW-5 Paused near the plan's limit

It starts no new job while the plan's 5-hour use is past the harness's pause point (code-kit's, or Context Graph's own setting when code-kit isn't installed).

### CARDW-6 What isn't code, failures, and pauses

What isn't code never reaches a request: files matching `[cards] exclude` (by default documents, archives, media, images, fonts, 3D models, colour lookup tables, compiled output and data stores) and any file whose contents aren't text (a NUL in its first 8000 bytes, bytes that aren't UTF-8, or a Git LFS pointer) owe no card. A file the model answers `SKIP` for is skipped for the session, counted on the Overview with Offer them again. A failed request is said on the Overview, and the next is made a minute later. While the person has paused code-kit's lead loop (its band's Pause), the card writer and the curator start nothing; they carry on when it resumes.

**Acceptance**

- Given encoded video takes (`.bin`, no NUL early on) and a `.cube` lookup table changed on the branch, then none is listed as missing a card, and none is sent to the model.
- Given a file the model answers `SKIP: an encoded video take` for, then no card is written, the lead receives nothing, and the Overview reads "Skipped 1 file that isn't code this session." with Offer them again.
- Given a request that fails, then the Overview says why and that it tries again in a minute, and a minute later it does.
- Given code-kit's loop paused, then no card is written and the Overview reads "Paused while code-kit's loop is paused; it carries on when that resumes."

## Open questions

| Question                         | Owner  | Blocks   |
| -------------------------------- | ------ | -------- |
| The card writer's default model: Sonnet. | Warren | settled |

### CARDW-7 Cards in the background, not the agents' work

With `[enforce] cards = "background"` (the default), an edit owes no card: the agent isn't asked for one and its turn isn't held, and the session's instructions tell it the card writer writes them, from the file, its diff and its commit messages, so it says why in its commits. The card writer's jobs, in order: files asked for, files owed (with `block`), the branch's changed files without a current card, then files merged in the last 14 days without one (`ctx cards --recent`: the lanes' work, edited in worktrees this checkout never saw), then the backfill. For a file someone just changed it reads its last commits and diff before writing, so the card carries what the change was for. `cards = "block"` keeps the old behaviour, where the agent writes it. An instruction block that still tells agents to write their cards is out of date: `ctx next` says so, and `ctx install instructions` replaces it in place.

**Acceptance**

- Given the default config and an agent editing a file, then nothing asks it for a card on its next call, and its turn ends.
- Given a commit merged from a lane changing `src/b.ts` without a card, then `ctx cards --recent` lists it missing, and the card writer's batch has it after the branch's own changed files.
- Given a CLAUDE.md with the older block, then `ctx next` gives `ctx install instructions`, which replaces the block in place and keeps the sections after it.

### CARDW-8 One status on the Overview

The Overview opens on how much of the code is explained ("38 of 595", a bar and the share, counted from `ctx cards` like the header) and one line saying the one thing the card writer is doing about the rest, with its button: explaining a file now (Pause, with the backfill on), queued (Pause), paused by the person (Resume), paused with code-kit's loop or at the plan's pause point, waiting after a failed request, off (Settings), nothing queued with the backfill off or the rest outside its scope (Settings), or every file explained. Files it skipped as not code are counted beneath, with Offer them again. No two lines contradict each other.

**Acceptance**

- Given 38 of 595 files explained and 550 queued, then the Overview shows "38 of 595" and "550 files queued, written in the background one at a time.", and no other line about the card writer.

### GATE-5 Shell edits are checked like the edit tools

A shell command that writes a file (a redirect, `tee`, `sed -i`, or an interpreter script such as `python3 - <<'PY'` that opens it for writing) is refused before it runs when the file isn't understood, with the same list of what to read as an edit tool gets.

**Acceptance**

- Given a `python3` heredoc that reads and rewrites `api/src/core/orch/bb.ts`, unread, then it's refused naming the file; once it and what it imports are read, it runs.

