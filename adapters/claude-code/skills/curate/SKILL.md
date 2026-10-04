---
name: curate
description: Keep a Context Graph honest with the person. Lays out rules and concepts waiting to be ratified, with their evidence; the hygiene report's proposals (rules nobody follows, decisions that keep overriding a rule, dormant concepts); and old records to archive. It then applies what the person decides. Use when ctx next says proposals or hygiene findings are waiting, when the person wants to review or tidy the graph, or asks what the graph holds that no one has agreed to.
---

# Curate the graph

The graph is only worth what people have agreed to. Agents propose; a person ratifies, rewords or drops. This skill prepares the decision, and applies it once the person decides.

The CLI is `node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs"` (or `ctx`).

## 1. Gather

```bash
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" doctor          # the graph's size, and how much is still proposed
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" hygiene         # proposals from evidence; it never changes anything
node "${CLAUDE_PLUGIN_ROOT}/ctx.mjs" check --conformance
```

Proposed rules are `K G?` records in `.ctx/graph.ctx` and `proposals.ctx`. Proposed concepts are `C … proposed`. For each one, `ctx why <id>` shows the decisions that serve or override it. That's the evidence: a proposal that decisions keep serving has earned ratification, and one they keep overriding should probably go.

## 2. Put it to the person

Group by module. For each item, give one line of what it says, and one line of evidence: served N times, overridden M times, broken in K places. Then recommend: ratify, reword, drop, or wait for more evidence. Ask the person to decide. Don't decide for them.

For hygiene findings, give the signal, the evidence and ctx's proposal, and ask the same way.

## 3. Apply

- **Ratify:** `ctx ratify <id>...`.
- **Reword:** edit the record's text in `.ctx/graph.ctx`, keeping its id, then ratify it.
- **Drop a proposal:** delete its line.
- **Retire a ratified rule or concept:** `ctx retire <id> --reason "<why>" [--succ <successor>]`. Decisions that served it stay in force through its successor, or show as orphaned when there is none.
- **Archive:** `ctx gc` moves inactive records older than the threshold into `.ctx/archive/`. Nothing is lost; `ctx history <node> --timeline` still shows them.

## 4. Commit

The person commits the graph changes themselves, adding `Ctx-Ratified-By: <name>` as a commit trailer for anything ratified or retired: `git commit --trailer "Ctx-Ratified-By: <name>"`. The merge gate checks that trailer against `[repo] ratifiers`. An agent never writes it, unless the repository delegates: with a `[delegate]` section in `.ctx/config.toml`, the lead may ratify the kinds it lists itself, with `ctx ratify <id>... --delegated --reason "<why>"`, and commit with the `Ctx-Ratified-By: <ratifier> (delegated)` trailer it prints. Anything outside those kinds still goes to the person.

Report what changed and what's still open.
