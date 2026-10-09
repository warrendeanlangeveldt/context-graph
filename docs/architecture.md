# Architecture: Context Graph in the session

This covers what the mod adds. The rest of Context Graph is in `docs/design-spec.md`.

## Components

| Component     | Where                                     | What it does                                                                                                                                                                                    |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks and CLI | `src/`, bundled into `adapters/*/ctx.mjs` | As today. New: a proposals listing with evidence, `ratify --commit`, `drop`, JSON for a file's context and per-agent coverage, and a hook refusal for agents running ratify-and-commit or drop. |
| The mod       | `adapters/claude-code/hooks/mod/` (new)   | Draws the Context pane and the band line, above any other plugin's band, which it keeps; registers `/graph`; follows the agents' tool calls; turns presses into the person's ratify and drop.   |

`adapters/claude-code/hooks/hooks.json` keeps its settings hooks and adds the module. Claude Code older than 2.1.287 skips the module.

## How the mod reaches Context Graph

A hooks module can't import the bundled CLI, so the mod runs `node <plugin root>/ctx.mjs … --json` with `$.process.run` and reads the JSON. It follows files from `tool.call` and `tool.result` events (Read, Edit, Write, Grep and Glob, with their `agentId` and `agentType`). It acts only from its own buttons' `ui.press` handlers, so only the person ratifies or drops.

## Contracts

The JSON outputs the mod reads, which change with the mod:

- **A file's context:** card and freshness, rules, chain, decisions, understood-or-not with what's unread, and code-kit facts when present.
- **Proposals:** each with its evidence.
- **Coverage per agent** for the session.
- **`ratify --commit` and `drop`:** their results.

## Tests

- **The CLI:** in vitest, as today.
- **The mod:** `.test.ts` files beside it, run with `claude plugin test`, which needs Claude Code 2.1.287 or later.

## The harness (specs 04–09)

Context Graph's half of the harness, beside code-kit's (code-kit `docs/architecture.md`). The hooks keep the loop's rules; the mod adds background agents, guidance and richer views.

| Component      | Where                                            | What it does                                                                                                               |
| -------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Card writer    | `adapters/claude-code/hooks/mod/card-writer.mjs` | Pure: which files need cards, in what order, and the agent's brief (the cards skill's procedure).                          |
| Curator        | `…/mod/curator.mjs`                              | Pure: when to run, the agent's brief, and turning its report into `ctx propose`/`ctx module` calls and flags.              |
| Read-assist    | `…/mod/assist.mjs`                               | Pure: a refusal's reading list and an agent's progress through it, from the session's observations.                        |
| Side questions | `…/mod/why.mjs`                                  | Pure: the question's slice from `ctx`, the side call's prompt, and the answer's sources.                                   |
| Views          | `…/mod/views/`                                   | Pure drawing: header and band line, file (rendered card, chips, neighbourhood graph), proposals queue, coverage, map.      |
| Settings       | `src/core/context.ts`, `ctx settings`            | The `[harness]` section, read and validated; `ctx settings set <key> <value> --reason …` writes it as the person's change. |
| Register       | `…/mod/register.mjs`                             | The only file calling the mods API; starts the agents with `$.agent.spawn`, the side calls with `$.model.fork`.            |

### New CLI JSON the mod reads

`ctx neighbours <path> --json` (what a file imports and what imports it, with card state), `ctx map --json` (modules with rule counts, decision activity and coverage per file), `ctx settings --json`. They change with the mod.

### Background agents

The card writer and curator run under Context Graph's own hooks like any agent: the card writer may only write cards and decisions (`.ctx/cards.ctx`, `.ctx/decisions.ctx`), the curator only propose. Neither ratifies, drops or retires. They pause at code-kit's pause point when code-kit is installed, otherwise at `[harness] pause_at_percent` (default 80).
