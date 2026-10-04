# Working on Context Graph

TypeScript (Node 22.5 or later), ESM. Context Graph ships as plugins for Claude Code (`adapters/claude-code/`) and Codex (`adapters/codex/`), each carrying a single-file bundle of the CLI (`ctx.mjs`), plus an npm package.

## Commands

```sh
npm install && npm run build   # generate packs, then tsc -> dist/
npm test                       # vitest; tests pin CTX_COMMAND=ctx, so results don't depend on the machine
npm run typecheck
npm run bundle                 # rebuild adapters/*/ctx.mjs; CI fails if the committed bundles are stale
```

After any change under `src/`, run `npm run bundle` and commit the rebuilt `adapters/*/ctx.mjs`.

## Layout

- `src/adapters/core.ts`: the hook flow for every harness. Profiles (`claude-code/hook.ts`, `codex/hook.ts`) supply only what differs. Every message an agent sees leaves through `runHook`.
- `src/graph/`: the `.ctx` grammar (parse, records, write, graph).
- `src/walker/`: slices, histories and module cards, and context through imports (`depends.ts`). The walker is pure: `src/walker/boundary.test.ts` enforces it.
- `src/cards/` and `src/enforce/`: file cards and read-before-edit.
- `src/record/`: decisions, owed cards and provenance.
- `src/observe/`: what agents touched, per agent and per session.
- `src/tool-adapters/`: other tools sharing a repository, such as code-kit. The core never names a tool.
- `src/cli/`: the `ctx` command. Rarely used commands load lazily through `commands.ts`, so hooks stay cheap.
- `adapters/*/skills/`: the skills, written once for each harness.
- `docs/design-spec.md`: the design. Change it with the behaviour.

## Rules

- Every behaviour change gets a test, end to end where it touches hooks (`src/enforce/loop.test.ts` and `src/adapters/*/hook.test.ts`).
- Refusals and asks say why, and what to do instead, in sentences an agent can act on.
- Keep the README's commands and the design spec in step with the code.
- Every release adds an entry at the top of `CHANGELOG.md`: the version, the date, and what changed for someone using Context Graph, in plain sentences. The GitHub Release notes use the same text.

## Context Graph

This repository runs its own loop: the graph is in `.ctx/`. Before working in a module you haven't read this session, call the `hydrate` MCP tool (shell: `ctx hydrate <scope>`). Before editing a file, understand it through its fresh card, or by reading it in full with what it imports. Afterwards, write its card with the `card` tool (shell: `ctx card <path> --text "..."`), and record the decisions a turn owes with `record`. When unsure what's needed next, run `ctx next`.
