# 06. Read-assist

**Status:** draft
**Outcome:** When an edit is refused because the file isn't understood yet, the agent gets on with reading what's missing instead of working out what to do, and the person sees its progress.
**Actors:** agents (refused, then guided); the mod; the person (watches)
**Depends on:** 01-current-file, 03-coverage

## In scope

- On a read-before-edit refusal, the mod tells the agent exactly what to read, in order, and shows its progress toward understanding in the pane and the transcript.
- The refusal itself is unchanged: the hooks still refuse the edit until the file is understood.

## Requirements

### ASSIST-1 A reading list, delivered

When an edit is refused for unread files, the refusal's result is drawn as a card listing the files still to read, and the agent receives the list as a message to read them in full, then retry.

**Acceptance**

- Given web's edit of `src/a.ts` refused for `src/b.ts` and `src/c.ts`, then the transcript shows a card with both, and web receives "Read src/b.ts and src/c.ts in full, then edit src/a.ts again."

### ASSIST-2 Progress

The card and the Context pane show the agent's progress ("1 of 2 read"), and turn to "understood" when the list is done.

### ASSIST-3 Within the rules

Read-assist never reads on the agent's behalf or marks a file understood: only the agent's own full reads count, as today.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
