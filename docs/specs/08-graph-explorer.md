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

The Overview is where the pane opens: first how much of the code is explained and what the card writer is doing about the rest (CARDW-8), then the modules. With more than one module, a row per module, indented under its parent, with how many of its files are explained (a current card) and a bar, its rules (agreed, and how many proposed), its decisions and when the last one was. A module where a decision was just recorded is drawn blue for a few seconds; one with a rule hygiene flags as overridden, red. The selected module's detail shows its rules in words, its decisions as a sparkline, what it uses and what uses it, an overridden rule's text with what to reword, and how many proposals wait on it in Rules to review (they're accepted there, not here as well). With only the whole repository as a module there's no table to read: one line says the graph treats the whole repository as one module, with its rules and decisions.

**Acceptance**

- Given `L:src` containing `L:billing`, then the graph draws a node for each with its counts (`2r 1/1`, `1r +1? 6/10`), and an edge from `L:src` to `L:billing`.
- Given hygiene flagging `billing.cents` as overridden three times, then `L:billing` is outlined red, and selecting it shows "billing.cents overridden 3×", the rule's text and "1 proposed rule on it, in Rules to review (3)".
- Given a graph with only `L:repo`, then the Overview has no module table, and says the graph treats the whole repository as one module.
- Given a decision recorded on `L:billing`, then at the next read of the map its node pulses, and stops a few seconds later.

### MAP-3 Navigate

j/k and arrows move; Enter opens; Esc goes back; the pointer selects on Desktop and in terminals that report it.

### MAP-6 Code the graph doesn't map yet

A graph made before there was code, or before the code grew, maps whole folders to the repository's one module: rules and decisions can't be scoped to them, and the Map shows one box. `ctx next` and `ctx info` name the folders with code that look like modules and are mapped only to the whole repository; `ctx next` gives `init` with `ctx init --write`. The Overview names them ("Folders with code that could be modules: services, packages."), with Add them as modules, which runs it: the modules are added and their edges proposed, nothing is ratified.

**Acceptance**

- Given a graph mapping only `**`, and five source files in `services/billing/src`, then `ctx next` gives `init` with `ctx init --write`, naming `services/billing`; once the graph maps it, it doesn't.
- Given folders not mapped yet, then the Map names them and offers Add them as modules; given none, it doesn't.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
