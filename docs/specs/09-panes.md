# 09. Panes v2 and harness settings

**Status:** draft
**Outcome:** The Context pane reads at a glance and works from the keyboard, its band line sums up the graph's health, and the person sets Context Graph's harness from it.
**Actors:** the person
**Depends on:** 01 to 08

## In scope

- Tabs: File, Proposals, Coverage, Map (08); a fixed header with the graph's health.
- The file's card as rendered Markdown, its rules as coloured chips, and a small graph of what it imports and what relies on it.
- Proposals as a queue with their evidence and a sparkline of how often each was served or overridden; ratify, drop and defer on keys.
- A band line: "☀ 92% have their why · 2 owed · 1 proposal" (a file's why is its card; the panes don't say "carded"), turning amber then red as cards owed or overrides pile up.
- Tags on transcript tool rows for edits the graph refused or that owe a card.
- A `[harness]` section in `.ctx/config.toml` (card writer, curator, side questions: on, model) edited from a Settings view, as the person's change.

## Requirements

### VIEW-1 Header and band

The header and the band line show the share of files with current cards, cards owed and proposals waiting, with a health glyph.

### VIEW-2 The file

The File tab shows the card rendered, the rules as chips by kind, and a neighbourhood graph: the files it imports and those that import it, with uncarded or rule-breaking ones marked.

### VIEW-3 Proposals queue

One card per proposal, grouped by module, with its evidence and, once decisions cite it, a sparkline of served and overridden decisions over time. The pane says Accept (ratify), Reject (drop) and Later (defer), on a, r and l, and each module has Accept all, one confirmation and one commit.

### VIEW-4 Transcript tags

An edit refused by read-before-edit, or one that owes a card, carries a small tag on its tool row ("card owed", "not understood").

### VIEW-5 Keyboard

1–4 switch tabs; j/k move; Enter opens; Esc goes back or closes.

### VIEW-6 Settings

The Settings view edits `[harness]`: each agent on or off and its model; a change asks for confirmation and a reason, then writes `.ctx/config.toml`. When code-kit protects that file, the change is logged as the person's.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
