# Architecture: Context Graph in the session

This covers what the mod adds. The rest of Context Graph is in `docs/design-spec.md`.

## Components

| Component     | Where                                     | What it does                                                                                                                                                                                    |
| ------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hooks and CLI | `src/`, bundled into `adapters/*/ctx.mjs` | As today. New: a proposals listing with evidence, `ratify --commit`, `drop`, JSON for a file's context and per-agent coverage, and a hook refusal for agents running ratify-and-commit or drop. |
| The mod       | `adapters/claude-code/hooks/mod/` (new)   | Draws the Context pane and the band line, above any other plugin's band, which it keeps; registers `/graph`; follows the agents' tool calls; turns presses into the person's ratify and drop.                                                |

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
