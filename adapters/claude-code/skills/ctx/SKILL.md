---
name: ctx
description: Ask the Context Graph why a file or module is the way it is (for setup, cards, curation or what to do next, see the next, init, cards, curate and status skills), what constraints apply to it, its decision history, or the coverage of the current session; and write a file's card after editing it. Use when the user asks "why is this like this", "what rules apply here", "what was decided about", wants to record a decision, or when an edit was refused or a card is owed.
argument-hint: "[hydrate|why|history|applies|coverage|check|card] [node or scope]"
allowed-tools: "mcp__plugin_context-graph_ctx__*, Bash(ctx *)"
---

Use the `ctx` MCP tools rather than reading the graph files directly:

- `hydrate` with a file path, `L:` module id, `C:` concept id, or a short task description gives one bounded briefing: the slice, the callers with the lines that use the file (and whether they are already in context), the decision history behind the rules, what this session already holds, hints, and teammates' open files. Call it before working on anything you have not read this session, instead of reading callers one by one.
- `applies` with a repository-relative path gives the applicable set: the module chain, concepts, constraints, and active decisions.
- `why` with a path, `L:` module id, or `C:` concept id gives the active constraints and decisions with their provenance.
- `history` gives every decision on a node, superseded ones included, oldest first.
- `coverage` summarises the current session's edits: whether a slice was injected, how many callers were in context, and which applicable files stayed dark.
- `check` validates the graph and reports findings.
- `record` writes a decision. It needs `node`, `serves` (the constraint or concept the change honours), and `text` (the why). Add `overrides` only when the change deliberately breaks a guided constraint.
- `card` writes or updates a file's card: `path` and `text` (what the file is for, what it relies on, who relies on it, what it must keep true), or several at once with `cards`. Write it after editing a file, while the file is in your context. In a worktree, pass absolute paths so the card lands on your branch.
- `propose` proposes a rule for a path's module (or an `L:` module): `target` and `text`, with `test` (the path of a test that checks it) or `rule` when it can be checked. Use it for a convention you find the code following, or one your decisions keep serving, that no rule states yet. It applies as proposed until a person ratifies it; it never changes an agreed rule. From a shell: `ctx propose <path> "<rule>"`.

The loop: before editing a file, understand it. A fresh card counts (it is shown when you first read the file); otherwise read the file in full, no offset or limit, along with what it imports, and what imports it when you change its exports. An edit without that is refused with the exact list. After the edit, the card is owed until it matches the file.

Arguments: $ARGUMENTS
