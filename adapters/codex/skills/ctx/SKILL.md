---
name: ctx
description: Ask the Context Graph why a file or module is the way it is, what constraints apply to it, its decision history, or the coverage of the current session. Use when asked "why is this like this", "what rules apply here", "what was decided about", or when recording a decision.
---

Use the `ctx` MCP tools rather than reading the graph files directly:

- `applies` with a repository-relative path gives the applicable set: module chain, concepts, constraints, active decisions.
- `why` with a path, `L:` module id, or `C:` concept id gives the active constraints and decisions with provenance.
- `history` gives every decision on a node, superseded ones included, oldest first.
- `coverage` summarises the current session's edits: whether a slice was injected, callers in context, applicable files that stayed dark.
- `check` validates the graph.
- `record` writes a decision: `node`, `serves` (the constraint or concept the change honours), `text` (the why); add `overrides` only when the change deliberately breaks a guided constraint.

Before editing a file through the shell, get its slice first with `slice`.
