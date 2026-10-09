# 08. Graph explorer

**Status:** draft
**Outcome:** The person sees the whole graph as a map (modules, their rules, decision activity and card coverage) and moves around it to any module or file.
**Actors:** the person
**Depends on:** 09-panes

## In scope

- A Map tab in the Context pane: modules as a tree with, for each, its rules (agreed and proposed), decisions in the last 30 days, and card coverage.
- A coverage heat map: one cell per file within each module, coloured current, stale, missing or owed this session.
- Moving with keys or the pointer; Enter opens a module or file in the File tab.

## Requirements

### MAP-1 Module tree

Each module shows its name, its rule counts, its decision activity as a short sparkline, and its coverage as a bar; modules with proposals waiting are marked.

### MAP-2 Coverage heat map

Within a selected module, one cell per file, coloured current, stale, missing or owed; a glyph per state for no-colour terminals.

**Acceptance**

- Given `L:billing` with 10 files, 6 carded, 2 stale and 2 missing, then its cells show 6 current, 2 stale and 2 missing, and the legend counts them.

### MAP-3 Navigate

j/k and arrows move; Enter opens; Esc goes back; the pointer selects on Desktop and in terminals that report it.

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
