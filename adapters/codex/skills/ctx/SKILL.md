---
name: ctx
description: Ask the Context Graph why a file or module is the way it is, what constraints apply to it, its decision history, or the coverage of the current session; and write a file's card after editing it. Use when asked "why is this like this", "what rules apply here", "what was decided about", when recording a decision, or when an edit was refused or a card is owed.
---

Use the `ctx` MCP tools rather than reading the graph files directly:

- `hydrate` with a file path, `L:` module id, `C:` concept id, or a short task description gives one bounded briefing: the slice, the callers with the lines that use the file (and whether they are already in context), the decision history behind the rules, what this session already holds, hints, and teammates' open files. Call it before working on anything not yet read this session, instead of reading callers one by one.
- `applies` with a repository-relative path gives the applicable set: module chain, concepts, constraints, active decisions.
- `why` with a path, `L:` module id, or `C:` concept id gives the active constraints and decisions with provenance.
- `history` gives every decision on a node, superseded ones included, oldest first.
- `coverage` summarises the current session's edits: whether a slice was injected, callers in context, applicable files that stayed dark.
- `check` validates the graph.
- `record` writes a decision: `node`, `serves` (the constraint or concept the change honours), `text` (the why); add `overrides` only when the change deliberately breaks a guided constraint.
- `card` writes or updates a file's card: `path` and `text` (what the file is for, what it relies on, who relies on it, what it must keep true), or several with `cards`. Write it after editing a file, while the file is in context.

The loop: before editing a file, understand it. A fresh card counts; otherwise read the file in full (`cat`, not `head` or `sed -n`) with what it imports, and what imports it when an edit changes its exports. A patch without that is refused with the exact list. After the edit, the card is owed until it matches the file.

Before editing a file through the shell, get its slice first with `slice`.
