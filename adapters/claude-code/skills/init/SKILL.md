---
name: init
description: Set up Context Graph in a repository, or finish setting it up. Proposes a graph from the tree, rule-stating tests, instruction files, ADRs and style packs, reviews it with the person, writes it, sets the ratifiers and the loop's settings, and adds the instruction block agents read every turn. Use when the person wants to start using Context Graph or ctx in a repository, when there is no graph yet, or when the instruction block is missing.
---

# Set up Context Graph

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs"` (or `ctx`). Nothing here changes code; it adds `.ctx/` and a block in AGENTS.md or CLAUDE.md.

## Which situation

- **No graph** → sections 1 to 4.
- **A graph linked from elsewhere** (`ctx doctor` says so) → offer `ctx adopt`, which moves it into `.ctx/` so it's committed and shared. Then continue from section 3.
- **A graph, but no instruction block** → only section 4.

Say which one applies before you start.

## 1. Propose

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" init
```

This writes nothing. It proposes, in order of how much each is worth:
1. modules from the tree;
2. rules from the repository's own rule-stating tests (architecture, boundary and `no-*` suites);
3. imperative lines from the instruction files;
4. ADRs as concepts;
5. file headers that carry a rationale, as notes;
6. style packs.

For every checkable rule, it also counts how often the code already breaks it.

Show the person, briefly:
- the modules and how the tree maps to them;
- the rules, grouped by module, each with its evidence and its conformance count;
- anything suspicious: a rule broken in many places may be wrong, or legacy.

## 2. Decide with the person

Nothing is ratified by an agent: ratifying is a person's act. Ask which rules and concepts they accept as they are, which to reword, and which to drop. A rule nobody would enforce in review should be dropped, not ratified.

If the repository also runs code-kit with layers, say that pack import rules stay as guidance: code-kit enforces the imports, and ctx explains them.

## 3. Write and configure

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" init --write      # proposals into .ctx/
```

Then:
1. **Ratifiers.** Set `[repo] ratifiers` in `.ctx/config.toml` to the git identities allowed to ratify. Without them, nothing proposed can ever be ratified.
2. **The loop.** Explain `[enforce]`:
   - `read_before_edit`, `dependencies` and `cards` default to `block`: an edit without understanding is refused, and a card is owed after every edit;
   - a repository adopting ctx gradually can start at `nudge`;
   - generated or vendored folders go under `[cards] exclude`, which adds to the defaults.
3. **Ratification.** Run `node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" ratify <id>...` for what the person accepted. Ratifying a checkable rule records its current violations as legacy decisions, so the next agent sees a known exception, not a contradiction.
4. **Merges.** Add `.ctx/decisions.ctx merge=union` and `.ctx/cards.ctx merge=union` to `.gitattributes`, so decisions and cards recorded on parallel branches all survive a merge.

## 4. Tell agents about it

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" install instructions
```

This appends the Context Graph block to AGENTS.md or CLAUDE.md. Agents re-read that every turn, so it's what makes them hydrate before reading, and follow the loop.

Then the person commits `.ctx/`, `.gitattributes` and the instruction file, with `Ctx-Ratified-By: <name>` as a commit trailer when they ratified anything. They run that commit themselves; an agent never writes that trailer.

Report what was set up, what's enforced from now on, and what's still only proposed. Suggest `/context-graph:cards` to start writing cards for the files people work in most.
