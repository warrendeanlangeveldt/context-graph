# 05. Curator

**Status:** draft
**Outcome:** The graph keeps up with how the team actually works: conventions the code follows get proposed as rules, and rules that keep getting overridden get flagged.
**Actors:** the mod (starts it); the curator agent (proposes, never ratifies); the person or delegated ratifier (decides)
**Depends on:** 09-panes, 02-ratify-and-drop

## In scope

- A background agent, off until turned on, that reviews the session's decisions and the graph's evidence after every 10 new decisions, and when the person asks (Curate now). (Not at the session's end: a mod can't start an agent once the session is ending.)
- It proposes rules with `ctx propose` and modules with `ctx module` (proposed edge), and flags rules overridden three or more times since they were ratified.

## Requirements

### CUR-1 Proposes from evidence

When three or more decisions on one module serve or describe the same convention that no rule states, the curator proposes it, citing the decisions.

**Acceptance**

- Given three decisions on `L:billing` saying money is stored in cents, then a proposal "Money is stored as integer cents" appears on `L:billing`, citing them.

### CUR-2 Flags overridden rules

A rule overridden three or more times since it was ratified is flagged in the band and the pane with its overriding decisions, suggesting reword or retire; the curator never retires it.

### CUR-3 Never decides

The curator may only propose; ratifying, dropping and retiring stay the person's or the delegated ratifier's.

### CUR-4 Paused near the plan's limit

As CARDW-5.

## Open questions

| Question                     | Owner  | Blocks   |
| ---------------------------- | ------ | -------- |
| The curator's default model. | Warren | 09-panes |
