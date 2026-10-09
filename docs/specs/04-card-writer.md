# 04. Card writer

**Status:** draft
**Outcome:** Owed cards get written in the background, from a full reading of each file, so the end-of-turn demand rarely has to interrupt the lead.
**Actors:** the mod (starts it); the card writer agent; the lead (no longer interrupted for cards it owes)
**Depends on:** 09-panes (its harness settings)

## In scope

- A background agent, off until the project turns it on, that writes cards for files owed this session or changed on the branch without a current card.
- It follows the cards skill: reads each file in full with what it imports, then writes the card.
- It works only while the lead and lanes leave room: between turns, and never on a file an agent is editing.

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

## Open questions

| Question                         | Owner  | Blocks   |
| -------------------------------- | ------ | -------- |
| The card writer's default model. | Warren | 09-panes |
