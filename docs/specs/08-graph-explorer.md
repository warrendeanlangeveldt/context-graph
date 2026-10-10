# 08. Graph explorer

**Status:** draft
**Outcome:** The person sees the whole graph as a map (modules, their rules, decision activity and card coverage) and moves around it to any module or file.
**Actors:** the person
**Depends on:** 09-panes

## In scope

- A Map tab in the Context pane: modules as a graph (MAP-4) with, for each, its rules (agreed and proposed), decisions in the last 30 days, and card coverage.
- A coverage heat map: one cell per file within each module, coloured current, stale, missing or owed this session.
- Moving with keys or the pointer; Enter opens a module or file in the File tab.

## Requirements

### MAP-1 Modules

Each module shows its name, its rule counts, its decision activity as a short sparkline, and its coverage; modules with proposals waiting are marked. The graph (MAP-4) draws them; the selected module's detail carries the sparkline.

### MAP-2 Coverage heat map

Within a selected module, one cell per file, coloured current, stale, missing or owed; a glyph per state for no-colour terminals.

**Acceptance**

- Given `L:billing` with 10 files, 6 carded, 2 stale and 2 missing, then its cells show 6 current, 2 stale and 2 missing, and the legend counts them.

### MAP-4 Module graph

The Map tab opens on the modules as a graph, read left to right: each module a node with its rule counts (proposed ones marked `+n?`) and how many of its files have a current card, joined to the modules it contains. On Desktop, VS Code and mobile it's drawn as an image, with the coverage as a ring and the imports between modules as dashed lines; in the terminal, with box-drawing characters. A module where a decision was just recorded pulses for a few seconds. A module with a rule hygiene flags as overridden is outlined red with "<rule> overridden n×". The selected module's detail shows its rules, decisions, coverage and imports, an overridden rule's text with what to reword, and the proposals on it with Accept, Reject… and Later.

**Acceptance**

- Given `L:src` containing `L:billing`, then the graph draws a node for each with its counts (`2r 1/1`, `1r +1? 6/10`), and an edge from `L:src` to `L:billing`.
- Given hygiene flagging `billing.cents` as overridden three times, then `L:billing` is outlined red, and selecting it shows "billing.cents overridden 3×", the rule's text and the proposals on `L:billing` with Accept.
- Given a decision recorded on `L:billing`, then at the next read of the map its node pulses, and stops a few seconds later.

### MAP-3 Navigate

j/k and arrows move; Enter opens; Esc goes back; the pointer selects on Desktop and in terminals that report it.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
