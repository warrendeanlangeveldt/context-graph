---
name: cards
description: Write or bring up to date Context Graph file cards, and record the decisions a session still owes. Finds the files that need them (owed by the last session, changed on this branch without a current card, or chosen by the person), reads each in full with what it imports, and writes a card that says what the file is for, what it relies on, who relies on it, and what it must keep true. Use when a card or decision is owed, when ctx next or the gate reports files without cards, or when the person wants cards for part of the codebase.
---

# Cards

A card is a file's why: the thing the next agent reads instead of rediscovering it. A card is only as good as the reading behind it, so never write one from a grep or a partial read.

The CLI is `ctx`.

## 1. Find what needs a card

Use whichever applies, and say which:

```bash
ctx pending              # decisions the last session still owes
ctx cards --changed      # files this branch changed without a current card
ctx cards --missing      # every file without one (a whole codebase: agree a scope first)
```

For a large set, agree a scope with the person first, such as one module or the files changed most, rather than carding everything.

## 2. For each file

1. **Read it in full**, along with the files it imports. Read the importers too, when it's something others depend on.
2. **Check what's recorded:** `ctx why <file>` shows its rules and decisions. A card must not contradict them, and should mention the ones that shape the file.
3. **Write the card:** MCP tool `card` (`path`, `text`; `cards` for several at once), or `ctx card <path> --text "..."`. In a worktree, pass absolute paths so the card lands on your branch.

A good card is 2 to 4 sentences:
- **What it's for,** in the project's terms, not a paraphrase of its code.
- **What it relies on:** other files, ports, external contracts.
- **Who relies on it,** and on what exactly: the exports, the event shapes.
- **What it must keep true:** the invariants an editor could break without noticing, including rules that live elsewhere but apply here. For example: "the refund must travel on the cancelled event; billing reads only the log".

A weak card restates names ("booking service for bookings"). If you can't say what the file must keep true, you haven't read enough yet.

## 3. Decisions owed

For each file `pending` lists, record why the change was made, with the MCP tool `record` or `ctx record --node <path> --serves <rule or concept> --text "<why>"`. `serves` is the rule or concept the change honours. Add `--overrides <rule>` only when the change deliberately broke a guided rule. If you don't know why a change was made, ask the person rather than guessing.

## 4. Check

Run `ctx cards --changed` again: nothing should be stale or missing. Report what you carded and anything you found that looked wrong while reading. A card is a good moment to notice a bug, but don't fix it here.
