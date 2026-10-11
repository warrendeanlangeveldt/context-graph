# 04. Card writer

**Status:** draft
**Outcome:** Owed cards get written in the background, from a full reading of each file, so the end-of-turn demand rarely has to interrupt the lead.
**Actors:** the mod (starts it); the card writer agent; the lead (no longer interrupted for cards it owes)
**Depends on:** 09-panes (its harness settings)

## In scope

- A background agent, off until the project turns it on, that writes cards for files owed this session or changed on the branch without a current card.
- It follows the cards skill: reads each file in full with what it imports, then writes the card.
- It works only while the lead and lanes leave room: between turns, and never on a file an agent is editing.
- A backfill for a project that already has code (`[harness] backfill`: `active`, the modules changed in the last 90 days, or `all`): the existing files without a current card, leaves first, after the cards owed and changed; offered by init, paused from the band.

## Data

| Entity   | Field  | Type   | Required | Rules                                   |
| -------- | ------ | ------ | -------- | --------------------------------------- |
| Card job | path   | string | yes      | One job per file at a time              |
| Card job | reason | enum   | yes      | `owed`, `changed`, `asked`              |
| Card job | state  | enum   | yes      | `waiting`, `writing`, `done`, `skipped` |

## Requirements

### CARDW-1 What it writes

When on, the card writer takes the files owed a card this session and those changed on the branch without a current card, oldest first, and writes each one's card. Files an agent edited in the last 2 minutes wait.

**Acceptance**

- Given `src/a.ts` owed a card and nobody editing it, when the lead goes idle, then the card writer writes its card and the file stops being owed.

### CARDW-2 From a full reading

It reads each file in full, with what it imports and, for changed exports, what imports it, before writing; a card from a partial read is never written.

### CARDW-3 Within the owed demand

A card it writes satisfies the owed demand exactly as one the editing agent writes, so the lead's turn end no longer asks for it.

### CARDW-4 Asked for

Write card and Cards for this module in the pane queue jobs for the card writer when it's on, instead of prompting the lead.

### CARDW-5 Paused near the plan's limit

It starts no new job while the plan's 5-hour use is past the harness's pause point (code-kit's, or Context Graph's own setting when code-kit isn't installed).

### CARDW-6 Declined, and paused with the person

The lead may decline a batch: the turn the mod's prompt runs in ends with no card writer started. Only that turn counts; another prompt the lead takes first (code-kit's loop) isn't a decline. Once it does, no other batch is offered this session (not the next ten files either), until the person offers it again from the Coverage tab or asks for cards. And while the person has paused code-kit's lead loop (its band's Pause), the card writer and the curator start nothing; they carry on when it resumes.

**Acceptance**

- Given 25 files owed and the lead declining the first batch, then no further batch is offered until the person presses Offer it again.
- Given code-kit's loop prompt running before the card writer's, and it starting no card writer, then that isn't a decline.
- Given code-kit's loop paused, when the lead goes idle, then the card writer isn't started and the Coverage tab reads "Card writer: paused with code-kit's loop".

## Open questions

| Question                         | Owner  | Blocks   |
| -------------------------------- | ------ | -------- |
| The card writer's default model. | Warren | 09-panes |

### CARDW-7 Cards in the background, not the agents' work

With `[enforce] cards = "background"` (the default), an edit owes no card: the agent isn't asked for one and its turn isn't held, and the session's instructions tell it the card writer writes them, from the file, its diff and its commit messages, so it says why in its commits. The card writer's jobs, in order: files asked for, files owed (with `block`), the branch's changed files without a current card, then files merged in the last 14 days without one (`ctx cards --recent`: the lanes' work, edited in worktrees this checkout never saw), then the backfill. For a file someone just changed it reads its last commits and diff before writing, so the card carries what the change was for. `cards = "block"` keeps the old behaviour, where the agent writes it. An instruction block that still tells agents to write their cards is out of date: `ctx next` says so, and `ctx install instructions` replaces it in place.

**Acceptance**

- Given the default config and an agent editing a file, then nothing asks it for a card on its next call, and its turn ends.
- Given a commit merged from a lane changing `src/b.ts` without a card, then `ctx cards --recent` lists it missing, and the card writer's batch has it after the branch's own changed files.
- Given a CLAUDE.md with the older block, then `ctx next` gives `ctx install instructions`, which replaces the block in place and keeps the sections after it.

### GATE-5 Shell edits are checked like the edit tools

A shell command that writes a file (a redirect, `tee`, `sed -i`, or an interpreter script such as `python3 - <<'PY'` that opens it for writing) is refused before it runs when the file isn't understood, with the same list of what to read as an edit tool gets.

**Acceptance**

- Given a `python3` heredoc that reads and rewrites `api/src/core/orch/bb.ts`, unread, then it's refused naming the file; once it and what it imports are read, it runs.

