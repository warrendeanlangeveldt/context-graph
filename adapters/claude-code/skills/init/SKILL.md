---
name: init
description: Switch Context Graph on in a repository, or finish switching it on. Builds the graph from the tree, rule-stating tests, instruction files, ADRs and style packs, configures it to run in the background, and adds the instruction block agents read every turn. It asks the person nothing: running it is the decision. Use when the person wants to start using Context Graph or ctx in a repository, when there is no graph yet, or when the instruction block is missing.
---

# Switch Context Graph on

Context Graph runs in the background. Agents read a file's card (or the whole file) before they change it, and write the card after; the card writer fills in missing cards while the lead is idle; guidance agents find applies at once. The person isn't asked to review anything. Running this skill is their decision to switch it on, so don't ask questions: build it, configure it, commit it, and say in a few lines what it will now do.

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs"` (or `ctx`). Nothing here changes code; it adds `.ctx/` and a block in AGENTS.md or CLAUDE.md.

## Which situation

- **No graph** → sections 1 to 4.
- **A graph linked from elsewhere** (`ctx doctor` says so) → `ctx adopt`, which moves it into `.ctx/` so it's committed and shared. Then continue from section 2.
- **A graph, but no instruction block** → only section 3.

## 1. Build the graph

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" init --write
```

It writes, in order of how much each is worth: modules from the tree; rules from the repository's own rule-stating tests (architecture, boundary and `no-*` suites); imperative lines from the instruction files; ADRs as concepts; file headers that carry a rationale, as notes; and style packs. All of it goes in as proposed: proposed rules already reach agents ("must?") before they edit, so nothing waits on the person. Don't review it with them. If something looks plainly wrong (a pack rule that contradicts how this code is built), leave it: it's only a suggestion, the curator and the hygiene report flag rules the code keeps working around, and the person can look in the Context pane whenever they want.

If the repository also runs code-kit with layers, pack import rules stay as guidance: code-kit enforces the imports, and ctx explains them.

## 2. Configure it for the background

In `.ctx/config.toml`:
1. **Ratifiers.** Set `[repo] ratifiers` to this repository's own git identity: run `git config user.name` and `git config user.email` here and use `Name <email>` from those, nothing from anywhere else (not a global or account email). They're needed only for the rare rule that blocks edits, or a concept; nothing else asks for them.
2. **The loop.** Leave `[enforce]` at its defaults: `read_before_edit`, `dependencies` and `cards` are `block`, so an edit without understanding is refused with what to read, and a card is owed after every edit. That's agent work, not the person's. Generated or vendored folders go under `[cards] exclude`, which adds to the defaults.
3. **The harness.** The defaults are the background ones: `agent_guidance = true` (an agent's rule applies at once as guidance), `card_writer = true` and `backfill = "active"` (the card writer cards the code changed in the last 90 days, leaves first, while the lead is idle; it pauses near the plan's limit and when code-kit's loop is paused). Write nothing unless the repository needs something else; `card_writer_model = "haiku"` keeps the backfill cheap on a big repository.

Then add `.ctx/decisions.ctx merge=union` and `.ctx/cards.ctx merge=union` to `.gitattributes`, so decisions and cards recorded on parallel branches all survive a merge.

## 3. Tell agents about it

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" install instructions
```

This appends the Context Graph block to AGENTS.md or CLAUDE.md. Agents re-read that every turn, so it's what makes them hydrate before reading, and follow the loop.

If `ctx` isn't on the PATH (`command -v ctx` finds nothing), run `node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" install cli`: it writes a small `ctx` launcher into `~/.local/bin` that follows plugin updates. It's a convenience; the hooks write their commands so they run either way.

## 4. Commit and report

Commit `.ctx/`, `.gitattributes` and the instruction file on the current branch (not on a protected one). Nothing was ratified, so the commit needs no trailer and the person doesn't have to run it.

Report in three or four plain lines: Context Graph is on; agents now read a file before changing it and leave a short note on why each file exists; the card writer is carding the existing code in the background (say how many files `ctx cards --backfill --scope active` lists); and the person doesn't need to do anything, though the Context pane (`/graph`) shows the graph whenever they want to look.

If the repository has no `.claude/code-kit.json`, end with one line about the companion plugin, and don't install it unless the person asks: "code-kit can give each agent its own lane, layer rules and a spec-check before code, enforced by hooks and in CI, and Context Graph's cards would then carry each file's spec requirement: `/plugin marketplace add warrendeanlangeveldt/code-kit`, then `/plugin install code-kit@code-kit` in Claude Code."
