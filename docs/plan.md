# Plan: Context Graph in the session

`code-kit status` reads this file. Keep each story's heading and its four `**…:**` lines in this form.

## Lanes

| Lane | Agent              | Owns                 | Proves its work with                                    |
| ---- | ------------------ | -------------------- | ------------------------------------------------------- |
| lead | (the main session) | the whole repository | `npm run typecheck && npm test && npm run bundle:check` |

## Milestone 1: the facts and acts the mod needs

### ST-1 JSON for a file's context and per-agent coverage

**Lane:** lead
**Requirements:** FILE-2, FILE-3, COV-1, COV-3
**Depends on:** none
**Status:** done

One command that gives a file's card and freshness, rules, chain, newest decisions, and whether a given agent understood it, with what's unread, plus code-kit's facts when present. Coverage per agent, as JSON, for a session.

### ST-2 Proposals with evidence, `ratify --commit` and `drop`

**Lane:** lead
**Requirements:** RAT-1, RAT-3, RAT-4, RAT-5
**Depends on:** none
**Status:** done

- **Proposals:** a listing with served, overridden and violation counts.
- **`ratify --commit`:** commits only the graph's files with the person's trailer, refusing on default or protected branches and for non-ratifiers.
- **`drop --reason`:** removes a proposal and records the reason.
- **The hook:** refuses agents running either.

## Milestone 2: the mod

Needs Claude Code 2.1.287 or later on the machine that builds it.

### ST-3 The mod's skeleton

**Lane:** lead
**Requirements:** FILE-1, FILE-5
**Depends on:** ST-1
**Status:** done

The module in the Claude Code adapter's `hooks.json`, `/graph`, the pane following the agents' reads and edits, and the no-graph message.

### ST-4 The file being worked on

**Lane:** lead
**Requirements:** FILE-2, FILE-3, FILE-4
**Depends on:** ST-3
**Status:** done

Card, rules, chain, decisions and understood-or-not for the followed file, and the code-kit section with its link when code-kit is installed.

### ST-5 Proposals, Ratify and Drop, and the band

**Lane:** lead
**Requirements:** RAT-1, RAT-2, RAT-3, RAT-4
**Depends on:** ST-2, ST-3
**Status:** done

The Proposals section with evidence, the band's count, and the Ratify and Drop confirmations running the person's acts.

### ST-6 Coverage per agent

**Lane:** lead
**Requirements:** COV-1, COV-2, COV-3
**Depends on:** ST-1, ST-3
**Status:** done

The Coverage section, live, with edits made without understanding marked.

## Milestone 3: Context Graph's harness

Built after code-kit's harness (its milestone 4), whose spikes it relies on.

### ST-7 Harness settings

**Lane:** lead
**Requirements:** VIEW-6
**Depends on:** none
**Status:** done

The `[harness]` section in `.ctx/config.toml`, validated; `ctx settings`; the Settings view.

### ST-8 Panes v2: header, band, tabs and keyboard

**Lane:** lead
**Requirements:** VIEW-1, VIEW-5
**Depends on:** ST-7
**Status:** done

The new frame, the band line with the graph's health, the keyboard model.

### ST-9 The file view

**Lane:** lead
**Requirements:** VIEW-2
**Depends on:** ST-8
**Status:** done

The card rendered, rules as chips, and the neighbourhood graph from `ctx neighbours`.

### ST-10 The proposals queue

**Lane:** lead
**Requirements:** VIEW-3
**Depends on:** ST-8
**Status:** done

Proposals with evidence and sparklines; ratify, drop and defer on keys.

### ST-11 Read-assist and transcript tags

**Lane:** lead
**Requirements:** ASSIST-1, ASSIST-2, ASSIST-3, VIEW-4
**Depends on:** ST-8
**Status:** done

The refusal's reading list delivered to the agent, its progress, and tags on tool rows.

### ST-12 The card writer

**Lane:** lead
**Requirements:** CARDW-1, CARDW-2, CARDW-3, CARDW-4, CARDW-5
**Depends on:** ST-7
**Status:** done

The background agent writing owed and missing cards from full reads.

### ST-13 The curator

**Lane:** lead
**Requirements:** CUR-1, CUR-2, CUR-3, CUR-4
**Depends on:** ST-7
**Status:** done

The background agent proposing rules from evidence and flagging overridden ones.

### ST-14 Side questions

**Lane:** lead
**Requirements:** ASKQ-1, ASKQ-2, ASKQ-3
**Depends on:** ST-8
**Status:** todo

`/why`, answered beside the conversation from the graph, with its cost.

### ST-15 The graph explorer

**Lane:** lead
**Requirements:** MAP-1, MAP-2, MAP-3
**Depends on:** ST-8
**Status:** todo

Modules with rules, activity and coverage; the coverage heat map; `ctx map`.
