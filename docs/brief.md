# Context Graph in the session (a mod)

**Status:** planned
**Updated:** 2026-10-09

## Problem

Context Graph puts a file's card, rules and decisions in front of an agent before it edits. But the person sees none of it unless they run `ctx` commands. They can't see what context the file being worked on carries, whether the agent read enough before editing, or what waits for them to ratify. Ratifying takes `ctx ratify` plus a commit with a `Ctx-Ratified-By` trailer typed by hand.

## Users

| Actor          | Trying to get done                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| The person     | See the why behind the file being worked on, how well each agent built its context, and ratify or drop proposals |
| Agents         | Unchanged: the hooks enforce read-before-edit and owed cards as before                                           |
| Other surfaces | VS Code, `claude -p`, SDK and cloud sessions run the hooks but draw nothing                                      |

## Outcome

In the Claude Code terminal or Desktop app, a person running Context Graph:

- opens a Context pane (`/graph`, or the band) that follows the file the agent is reading or editing, with its card, rules, recent decisions, and whether it's understood enough to edit;
- sees per agent what it read in full, what it only searched, and what it edited;
- ratifies or drops a proposal with a press and a confirmation, the ratification committed with their own trailer.

## Constraints

- A Claude Code mod in the Context Graph plugin, beside its hooks. Claude Code older than 2.1.287 doesn't load it and runs the hooks as before.
- The mod reaches Context Graph only through the `ctx` command line, since a hooks module may import nothing outside its plugin but `claude-code`.
- With code-kit installed too, each pane links to the other; each works alone.

## Non-goals

- Enforcement in the mod.
- Model calls to display anything.
- Editing the graph's settings from the pane.
- Drawing where Claude Code can't (VS Code, `claude -p`, SDK, cloud).

## Scope

| Area                     | Spec                          | First release                                                                                                 | Later                            |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| The file being worked on | `specs/01-current-file.md`    | Card, rules, decisions, understood or not, following the agent's reads and edits; code-kit link               | Pinning a file                   |
| Ratify and drop          | `specs/02-ratify-and-drop.md` | Proposals with their evidence; Ratify and Drop as the person's acts; the band's count                         | Rewording a proposal in the pane |
| Card writer              | `specs/04-card-writer.md`     | A background agent, opt-in, writing owed and missing cards from full reads                                    |                                  |
| Curator                  | `specs/05-curator.md`         | A background agent, opt-in, proposing rules from evidence and flagging overridden ones                        |                                  |
| Read-assist              | `specs/06-read-assist.md`     | A refused edit's reading list, delivered to the agent, with progress                                          |                                  |
| Side questions           | `specs/07-side-questions.md`  | `/why` answered beside the conversation, from the graph                                                       |                                  |
| Graph explorer           | `specs/08-graph-explorer.md`  | Modules with rules, activity and coverage; a coverage heat map                                                |                                  |
| Panes v2 and settings    | `specs/09-panes.md`           | Tabs, rendered card, neighbourhood graph, proposals queue, band health, transcript tags, `[harness]` settings |                                  |
| Coverage per agent       | `specs/03-coverage.md`        | Per agent: read in full, only searched, edited, cards written                                                 | History across sessions          |

**Quality targets:** refreshes within 2 seconds of a read or edit; no model calls; keyboard-usable; readable in light and dark terminals.

## The harness (2026-10-09)

Specs 04–09 grow the mod into Context Graph's half of a continuous engineering harness, specified with code-kit's (code-kit `docs/brief.md`, which holds the shared framing and decisions: in-session, two cooperating mods, background agents opt-in and paused near the plan's limit, settings in the project config, the person's acts only on a press). They're built after code-kit's harness, then joined by code-kit's combined lane view (its spec 13). v1's non-goal "no model calls" no longer holds for the card writer, curator and side questions, which are opt-in.

## Decision log

| Date       | Decision                                                                                                                                                | Why                                                  | Rejected, and why                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| 2026-10-06 | Present Context Graph through a mod in its plugin; enforcement stays in the hooks.                                                                      | Hooks run where Claude Code can't draw.              | Enforcement in the mod.                                 |
| 2026-10-06 | First release: the file being worked on, proposals to ratify, and coverage per agent.                                                                   | The person's choice.                                 | What's owed, which the hooks already hold the turn for. |
| 2026-10-06 | Ratify runs the ratification and commits only the graph's files with the person's `Ctx-Ratified-By` trailer, refusing on a protected or default branch. | One press finishes the ratification the gate checks. | Leaving the commit to the person.                       |
| 2026-10-06 | Its own pane, linked to code-kit's Lanes pane when both are installed.                                                                                  | Each plugin works alone.                             | One shared pane.                                        |
| 2026-10-06 | A band line only when proposals wait; the pane opens on demand.                                                                                         | Quiet unless the person is needed.                   | A pane that opens itself.                               |

## Open questions

| Question                                                           | Owner  | Blocks      |
| ------------------------------------------------------------------ | ------ | ----------- |
| Update Claude Code on this Mac to 2.1.287 or later (it's 2.1.280). | Warren | Milestone 2 |
