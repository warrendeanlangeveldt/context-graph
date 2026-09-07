---
name: ctx
description: Ask the Context Graph why a file or module is the way it is, what constraints apply to it, its decision history, or the coverage of the current session. Use when the user asks "why is this like this", "what rules apply here", "what was decided about", or wants to record a decision.
argument-hint: "[hydrate|why|history|applies|coverage|check] [node or scope]"
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

Arguments: $ARGUMENTS
