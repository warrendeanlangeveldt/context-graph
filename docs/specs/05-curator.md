# 05. Curator

**Status:** draft
**Outcome:** The graph keeps up with how the team actually works: conventions the code follows get proposed as rules, and rules that keep getting overridden get flagged.
**Actors:** the mod (runs it, with its own model request); the person or delegated ratifier (decides)
**Depends on:** 09-panes, 02-ratify-and-drop

## In scope

- Off until turned on: after every 10 new decisions, and when the person asks (Curate now), the mod reads the decisions on each module with three or more, with the rules stated and proposed there, in one model request (`curator_model`, Sonnet when empty), and adds the conventions they show with `ctx propose`. It never prompts the lead: a mod can't start an agent in auto mode, and asking the lead to start one put Context Graph's request in front of the person.
- Rules overridden three or more times since they were ratified are flagged from the hygiene report. Folders that could be modules are offered by Add them as modules (MAP-6), not by the curator.

## Requirements

### CUR-1 Proposes from evidence

When three or more decisions on one module serve or describe the same convention that no rule states, the curator proposes it, citing the decisions.

**Acceptance**

- Given three decisions on `L:billing` saying money is stored in cents, then a proposal "Money is stored as integer cents" appears on `L:billing`, the notice cites them, and the lead receives no prompt.
- Given a reply naming a rule that cites fewer than three of the module's decisions, or a module it wasn't shown, then nothing is proposed for it.

### CUR-2 Flags overridden rules

A rule overridden three or more times since it was ratified is flagged in the band and the pane with its overriding decisions, suggesting reword or retire; the curator never retires it.

### CUR-3 Never decides

The curator adds only guidance, which applies at once (with `[harness] agent_guidance` on, the default; off, it waits as a proposal). It never adds a rule that blocks edits; ratifying, dropping and retiring stay the person's or the delegated ratifier's.

### CUR-4 Paused near the plan's limit

As CARDW-5.

## Open questions

| Question                     | Owner  | Blocks   |
| ---------------------------- | ------ | -------- |
| The curator's default model: Sonnet. | Warren | settled |
