# 09. Panes v2 and harness settings

**Status:** draft
**Outcome:** The Context pane reads at a glance and works from the keyboard, its band line sums up the graph's health, and the person sets Context Graph's harness from it.
**Actors:** the person
**Depends on:** 01 to 08

## In scope

- What Context Graph is for, at the top, then tabs: Overview (08), This file, Rules to review, Agents; a fixed header with the graph's state in words.
- The file's card as rendered Markdown, its rules as coloured chips, and a small graph of what it imports and what relies on it.
- Proposals as a queue with their evidence and a sparkline of how often each was served or overridden; ratify, drop and defer on keys.
- A header: "CONTEXT GRAPH keeps the why of your code: …", then "92% of files explained · 2 files to explain from this session · 1 rule to review" (a file is explained when it has a current card; the panes don't say "carded" or use symbols that need a legend). The band stays quiet unless rules are being worked around.
- Tags on transcript tool rows for edits the graph refused or that owe a card.
- A `[harness]` section in `.ctx/config.toml` (card writer, curator, side questions: on, model) edited from a Settings view, as the person's change.

## Requirements

### VIEW-1 Header and band

The pane's header says what Context Graph is for in one sentence, then, in words, the share of files explained (with a current card), files this session left to explain, rules to review and rules overridden, amber or red when something is owed or overridden. The band line is quiet by default: Context Graph runs in the background, cards owed are the agents' work and suggestions wait in the pane, so the band shows a line only when rules are being worked around again and again ("2 rules the agents keep working around"), amber, red from three.

**Acceptance**

- Given cards owed and proposals waiting, and no rule overridden, then the band shows nothing from Context Graph.
- Given one rule the agents keep overriding, then the band reads "1 rule the agents keep working around", with Context.

### VIEW-2 The file

This file shows why the file exists (its card, rendered), the rules here in words by kind (agreed and refused when broken, agreed as guidance, proposed), the decisions about it, what an agent has to read before editing it, and what it uses and what uses it, with unexplained or rule-breaking ones marked.

### VIEW-3 Proposals queue

One card per proposal, grouped by module, with its evidence and, once decisions cite it, a sparkline of served and overridden decisions over time. The pane says Accept (ratify), Reject (drop) and Later (defer), on a, r and l, and each module has Accept all, one confirmation and one commit.

### VIEW-4 Transcript tags

An edit refused by read-before-edit, or one that owes a card, carries a small tag on its tool row ("card owed", "not understood").

### VIEW-5 Keyboard

1–4 switch tabs (Overview, This file, Rules to review, Agents); the pane opens on the Overview; j/k move; Enter opens; Esc goes back or closes.

### VIEW-6 Settings

The Settings view edits `[harness]`: each agent on or off and its model; a change asks for confirmation and a reason, then writes `.ctx/config.toml`. When code-kit protects that file, the change is logged as the person's.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
