# 01. The file being worked on

**Status:** draft
**Outcome:** While an agent works, the person sees the why behind the file it's on, and whether it understood the file before editing.
**Actors:** the person
**Depends on:** `ctx` card, slice and coverage data

## Requirements

### FILE-1 Open and follow

`/graph` opens the Context pane, focused. (It isn't `/context`, Claude Code's own command, or `/graph`, the plugin's `ctx` skill: a mod can't register a name that's taken.) The band's Context button does the same, and Escape closes it. The pane follows the file most recently read, edited or written by any agent in this session, and names that agent.

**Acceptance**

- Given an agent reads `src/a.ts`, when the person opens `/graph`, then the pane shows `src/a.ts` and the agent's type.
- Given the pane is open, when an agent then edits `src/b.ts`, then the pane moves to `src/b.ts` within 2 seconds.

### FILE-2 What the file carries

For the followed file the pane shows:

- its card, and whether the card is current (its hash matches) or stale;
- the rules that apply, each with its id and whether it's guidance or enforced;
- the module chain;
- its newest 4 decisions, with date, who and why.

**Acceptance**

- Given a file with a current card, two rules and three decisions, when it's followed, then all of them appear, the card marked current.
- Given a file with no card, when it's followed, then the pane says "No card yet" and shows the rules and decisions it has.

### FILE-3 Understood before editing

The pane says whether the agent working on the file has understood it, in Context Graph's own terms: a current card, or a full read with its imports. If not, it lists what's still to read.

**Acceptance**

- Given an agent that read only `src/a.ts` but not `src/b.ts`, which it imports, when `src/a.ts` is followed, then the pane says it isn't understood yet and lists `src/b.ts`.

### FILE-4 With code-kit

When code-kit is also installed, the pane shows the file's lane, layer and spec requirement, as code-kit's trace reports them, with a link that opens code-kit's Lanes pane.

**Acceptance**

- Given both plugins, when a file in the web lane is followed, then the pane shows `web`, its layer, and its requirement, and the link opens the Lanes pane.
- Given only Context Graph, when a file is followed, then no code-kit section appears.

### FILE-5 Not a Context Graph repository

With no graph, the pane says so with `ctx init` as the next step, and the mod draws no band.

**Acceptance**

- Given a repository with no `.ctx/`, when the person types `/graph`, then it says "No graph here yet: run /context-graph:init".

## Open questions

| Question | Owner | Blocks |
| -------- | ----- | ------ |
