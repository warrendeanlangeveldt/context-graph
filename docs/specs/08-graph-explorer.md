# 08. Graph explorer

**Status:** draft
**Outcome:** The person sees the whole graph as a map (modules, their rules, decision activity and card coverage) and moves around it to any module or file.
**Actors:** the person
**Depends on:** 09-panes

## In scope

- The Overview tab in the Context pane: a row per module (MAP-4) with, for each, its files explained, its rules (agreed and proposed), its decisions and the last one.
- A coverage heat map: one cell per file within each module, coloured current, stale, missing or owed this session.
- Moving with keys or the pointer; Enter opens a module's files, and a file in This file.

## Requirements

### MAP-1 Modules

Each module shows its name, its rule counts, its decision activity as a short sparkline, and its coverage; modules with proposals waiting are marked. The graph (MAP-4) draws them; the selected module's detail carries the sparkline.

### MAP-2 Coverage heat map

Within a selected module, one cell per file, coloured current, stale, missing or owed; a glyph per state for no-colour terminals.

**Acceptance**

- Given `L:billing` with 10 files, 6 carded, 2 stale and 2 missing, then its cells show 6 current, 2 stale and 2 missing, and the legend counts them.

### MAP-4 Overview

The Overview is where the pane opens: what the graph knows, a row per module, indented under its parent, with how many of its files are explained (a current card) and a bar, its rules (agreed, and how many proposed), its decisions and when the last one was. A module where a decision was just recorded is drawn blue for a few seconds; one with a rule hygiene flags as overridden, red. The selected module's detail shows its rules in words, its decisions as a sparkline, what it uses and what uses it, an overridden rule's text with what to reword, and the proposals on it with Accept, Reject… and Later. Under the table, Working now: the card writer and the backfill.

**Acceptance**

- Given `L:src` containing `L:billing`, then the graph draws a node for each with its counts (`2r 1/1`, `1r +1? 6/10`), and an edge from `L:src` to `L:billing`.
- Given hygiene flagging `billing.cents` as overridden three times, then `L:billing` is outlined red, and selecting it shows "billing.cents overridden 3×", the rule's text and the proposals on `L:billing` with Accept.
- Given a decision recorded on `L:billing`, then at the next read of the map its node pulses, and stops a few seconds later.

### MAP-3 Navigate

j/k and arrows move; Enter opens; Esc goes back; the pointer selects on Desktop and in terminals that report it.

### MAP-6 Code the graph doesn't map yet

A graph made before there was code, or before the code grew, maps whole folders to the repository's one module: rules and decisions can't be scoped to them, and the Map shows one box. `ctx next` and `ctx info` name the folders with code that look like modules and are mapped only to the whole repository; `ctx next` gives `init` with `ctx init --write`. The Map says which they are, with Add them as modules, which runs it: the modules are added and their edges proposed, nothing is ratified.

**Acceptance**

- Given a graph mapping only `**`, and five source files in `services/billing/src`, then `ctx next` gives `init` with `ctx init --write`, naming `services/billing`; once the graph maps it, it doesn't.
- Given folders not mapped yet, then the Map names them and offers Add them as modules; given none, it doesn't.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
