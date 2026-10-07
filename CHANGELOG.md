# Changelog

What changed in each release of Context Graph, newest first. Versions follow the plugin manifests and the npm package `@warren-dean/context-graph`. Each release is also on [GitHub Releases](https://github.com/warrendeanlangeveldt/context-graph/releases).

## 0.3.2 (2026-10-07)

Gaps found while an autonomous lead gives each engineering pattern its own rule:

- **`ctx module <L:id> --paths "<glob>…"`** gives paths their own module, so a rule can attach to them alone.
  - Its mappings go ahead of any broader one that would claim the same paths.
  - It sits in the module its paths belonged to, or `--in`.
  - Its containment edge is proposed. With `modules` in `[delegate] may_ratify`, the lead adds it agreed with `--delegated --reason`.
- **A module's proposed containment edge is walked** while it has no agreed one, so its files keep the parent's rules until the edge is ratified. The delegated ratifier may ratify containment edges under `modules`; other edges still go to the person.
- **`ctx retire --delegated --reason`** records a retirement as the delegated ratifier's, checked against `may_ratify`, instead of under the git user as `/human`.
- **`ctx init` on a curated graph** proposes modules for folders nothing maps yet, with their containment edges proposed, written ahead of the root mapping.

## 0.3.1 (2026-10-07)

- **`ctx propose <path> "<rule>"`, and the MCP tool `propose`:** propose a rule for a path's module, or for a module named as `L:…`.
  - Options: `--test` names a test that checks it, `--rule` gives a checkable rule, and `--id` sets the id (otherwise one is made from the module and the rule's first words).
  - It goes into `proposals.ctx` and applies as proposed until a person ratifies it.
  - It refuses a path outside any module, a rule the module already has, and an id already in use.
  - Agents may propose; only a person ratifies.

## 0.3.0 (2026-10-07)

Context Graph in the session: a mod for Claude Code 2.1.287 or later, in the terminal and the Desktop app. Older versions skip it, and the hooks work as before. See [In the session](README.md#in-the-session).

- **`/graph`** opens the Context pane:
  - the file an agent last read or edited, with its card, rules, chain, newest decisions, and whether that agent understood it;
  - with code-kit installed, the file's lane, layer and requirement;
  - proposals with their evidence, with **Ratify** and **Drop**;
  - coverage per agent, with edits made without understanding marked;
  - **Write card** and **Cards for this module**, which ask the lead to write the cards, or to hand them to the agent working on those files.
- **The band** reads "N proposals to ratify" while proposals wait. Both plugins' band lines show together.
- **Ratify** commits only the graph, with your trailer, after you confirm. **Drop** keeps your reason. Both run only on your press.
- The plugin's hook commands quote the plugin's path, so a path with a space no longer splits.

## 0.2.11 (2026-10-06)

The command-line groundwork for the coming Context Graph mod (`docs/brief.md`), useful on its own:

- **`ctx file <path> [--agent <id>]`:** a file's card and freshness, rules, chain and newest decisions, and whether an agent has understood it, with what it still has to read.
- **`ctx agents`:** each agent's coverage in the session: read, searched, edited (and whether each edit was understood first), and cards owed.
- **`ctx proposals`:** proposed rules and concepts, with served, overridden and violation counts.
- **The person's acts:** `ctx ratify … --commit` ratifies and commits only the graph with the person's trailer, and `ctx drop <id> --reason` turns a proposal down, keeping the reason.
  - Both refuse on protected branches and for non-ratifiers.
  - The hooks refuse both from every agent, matching only a real command, not text that mentions one.
- **Tool adapters** can now name protected branches. code-kit's adapter reports its `branches.protected`.

## 0.2.10 (2026-10-04)

- **Changelog:** `CHANGELOG.md` now ships in the npm package, covering every release, and the README links to it.

## 0.2.9 (2026-10-04)

- **Delegated ratification:** a repository's `.ctx/config.toml` can name a delegated ratifier, and the kinds it may ratify (`[delegate] ratifier`, `may_ratify`). This is for a lead that runs without a person watching.
  - **The command:** `ctx ratify <id>... --delegated --reason "…"` ratifies only those kinds, all or nothing, and never proposed edges.
  - **The record:** each ratification is recorded as a decision naming the ratifier, the kind and the reason.
  - **The gate:** it accepts the `Ctx-Ratified-By: <ratifier> (delegated)` trailer only for the delegated kinds, and never counts it as a person's.

## 0.2.8 (2026-10-02)

- **Companion plugin:** the README, `llms.txt` and the init skill now point to code-kit. Init mentions it once when it isn't installed, and never installs it unasked.

## 0.2.7 (2026-10-02)

- **Logo and diagram:** the npm package now includes them, and the README shows them on npmjs.com too.
- **Includes 0.2.6,** which wasn't published to npm on its own.

## 0.2.6 (2026-10-02)

- **MCP server version:** it now reports its real version (it said `0.1.0` before).
- **`ctx --version`** and **`ctx version`** print the installed version.
- **Tests:** the MCP server now has a test that drives it through a real MCP client.

## 0.2.5 (2026-10-01)

- **Descriptions:** they now open with what Context Graph does for AI coding agents.

## 0.2.4 (2026-10-01)

- **npm:** published as `@warren-dean/context-graph`. `npm i -g @warren-dean/context-graph` puts `ctx` on your PATH.
- **A smaller install:** the embedding model is now an optional dependency, so the install is about 29 MB instead of 405 MB.
- **`ctx doctor`** suggests the npm install when `ctx` isn't on the PATH.
- **For AI tools:** an `llms.txt` and an `AGENTS.md` describe the plugin.

## 0.2.3 (2026-10-01)

- **Ready to install from a public repository:** MIT licence, a security policy, and install instructions.
- **A new example:** the booking service from the benchmark replaces the old one.

## 0.2.2 (2026-09-30)

- **Finding your way:** `ctx next` names the one thing to do now, and `ctx cards` shows which files have a current card. Skills (`next`, `init`, `cards`, `curate`, `status`) are available for both Claude Code and Codex.

## 0.2.1 (2026-09-30)

- **Dependency context:** before an edit, an agent also sees the rules and decisions on the files the edited file imports. Module rules are grouped by module, and each import's decisions are shown newest first.

## 0.2.0 (2026-09-30)

- **The context loop:**
  - an edit is refused until the file is understood, through its current card or a full read with its imports;
  - after the edit, the card and the decision are owed;
  - each agent's reads are observed separately, and worktrees are handled.
- **Hydrate:** one briefing before you work, covering the callers, the history, and what the session already holds.
- **The view:** a meaning layer, a focus drawer, and readable defaults.
- **The code-kit tool adapter:** a file's spec requirement and layer rule appear in its card and its slice.

## 0.1.x (2026-09-07)

- **The first releases:**
  - the graph grammar, the walker, the observer and the recorder;
  - the Claude Code and Codex adapters;
  - the MCP server, the merge gate, bootstrap with packs, and the benchmark;
  - in-process MiniLM embeddings.
