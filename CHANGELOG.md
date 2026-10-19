# Changelog

What changed in each release of Context Graph, newest first. Versions follow the plugin manifests and the npm package `@warren-dean/context-graph`. Each release is also on [GitHub Releases](https://github.com/warrendeanlangeveldt/context-graph/releases).

## 0.9.3 (2026-10-19)

Context Graph notices when a plugin compacts the conversation.

- code-kit 0.19 compacts the lead's context between turns once it passes a threshold, through Claude Code's plugin API. Claude Code's classic compaction hooks only cover `/compact` and its own automatic compaction, so Context Graph might not hear of this one. It would then go on as if the lead still held files it no longer had: skipping their context before an edit, and letting it edit them without reading them again. When a plugin's compaction stands in the main session, Context Graph's mod now sends its hook the same notice a classic compaction does.

## 0.9.2 (2026-10-17)

An agent is given a file's context once while it stays the same.

- Before each edit, Context Graph injects the file's card and slice. An agent editing the same file several times got the same text each time: in one lane, one file's context arrived 6 times and another's 4. Each agent now keeps a record of what it was given for each file, and the same text isn't injected again. After the context is compacted, each file's context arrives again at its next edit.
- A shell command naming a path from a folder above the shell's current one, for a file that doesn't exist yet, was recorded with the folder doubled (`apps/web/src/components/blocks/apps/web/src/components/blocks/ItemSet.tsx`). It's now resolved from the folder the path was written from.

## 0.9.1 (2026-10-17)

Context Graph tells a session each thing once, even when several of its hooks run at the same time.

- A session's hooks often run at once: a call's completion hook beside the next call's, and the lead's beside its lane agents'. Each hook loaded the session's state and wrote all of it back, so one hook's write undid another's, and a hook that read the file mid-write fell back to the defaults. Whatever the session had already been told was forgotten. In one lead session, "Context Graph became active during this session" was added to the context 118 times, and file and module context was repeated in the same way. A hook now writes back only what it changed, onto the state as it is at that moment, and replaces the file in one step.

## 0.9.0 (2026-10-16)

Context Graph no longer asks your session to start the card writer or the curator, and it doesn't try to card files that aren't code.

- The card writer now runs inside the mod. It writes one card at a time with its own model request, built from the file in full, what it imports, what imports it, and the file's recent commits and diff, and saves it with `ctx card`. Before, it asked the lead to start a background agent, and that request showed up in your conversation as a prompt from the plugin. In auto mode Claude Code won't let a plugin start an agent itself, so the request had to go through the lead.
- The curator works the same way. After every 10 new decisions, or when you press Curate now, it reads each module's decisions in one request and adds the conventions that three or more of them show as guidance, citing them. It no longer proposes modules; Add them as modules on the Overview does that.
- Both default to Sonnet when `card_writer_model` or `curator_model` is empty. Before, empty meant the session's model, which a plugin's own request can't use.
- Files that aren't code don't reach the card writer. On top of the NUL check, a file whose bytes aren't UTF-8 text, or that is a Git LFS pointer, owes no card, and the default exclusions now cover more media, images and fonts, 3D models, colour lookup tables (`.cube`), compiled output, `.bin` and `.dat` files, and data stores. A file the model still finds isn't code is skipped for the session and counted on the Overview, with Offer them again.
- The Overview says which file is being explained, how many are queued, and when a request failed (it tries again a minute later). Turned-down batches and Ask again are gone, since the lead isn't asked any more.

## 0.8.0 (2026-10-13)

A clearer Overview, and cards are never offered for documents.

- **Documents, archives and media never owe a card.** A branch's untracked `.docx`, `.zip` or exports were offered to the card writer. Office documents, archives and media are now excluded by default, and any file that isn't text has no card: it's left out of every card list, and `ctx card` refuses it.
- **The Overview opens on one status.** How many files are explained ("38 of 595", with a bar), and one line saying the one thing the card writer is doing about the rest, with its button: Pause, Resume, Ask again or Settings. Lines that contradicted each other are gone.
- **Modules, plainly.** With only the whole repository as a module, one line says so, and the folders that could be modules are named with **Add them as modules**. A selected module counts its proposed rules for Rules to review instead of offering Accept a second time.
- **One turned-down batch no longer stops the card writer.** Its files are skipped for the session and the next batch is offered; two in a row stop it until **Ask again**.
- **A tidier header.** The name and the state share one line. What you just did is said in words ("Accepted: <the rule> … committed on this branch (abc1234)") for 15 seconds, then goes.

## 0.7.0 (2026-10-12)

The Context pane says what Context Graph is for, and shows what it knows about your code.

- **An Overview of the codebase.** The pane opens on a row per module: how many of its files are explained (have a current card), its rules, its decisions and when the last one was. Under it, what's being written now: the card writer and the backfill. The weather glyphs, `0r +1?` counts and the box-drawn graph are gone; everything is said in words.
- **This file, in plain sections.** Why it exists, the rules here (agreed or proposed, in words), the decisions about it, what an agent has to read before editing it, the module it's part of, and what it uses and what uses it.
- **Rules to review and Agents.** Proposals lead with the rule itself. The Agents tab answers one question: did each agent understand the code before changing it?
- **Code the graph doesn't map yet.** A graph made before there was code saw everything as one module. `ctx next` and the Overview now name the folders with code that aren't modules yet, with **Add them as modules**.
- **Files in a lane's worktree** show their own card and neighbours, instead of "No card yet".
- **The card writer isn't stopped by another prompt.** When code-kit's loop prompted the lead first, Context Graph took that turn for the lead turning the card writer down, and stopped asking for the session. Only the turn carrying its own prompt counts now.
- **Coverage follows a resumed session.** The pane reads the session's id on each refresh, so a resumed or cleared session's reads show up.

## 0.6.0 (2026-10-11)

Cards are written in the background, and the gate sees shell edits.

- **Agents don't write cards any more.** By default (`[enforce] cards = "background"`), after an edit the card writer writes the file's card once the edit settles, from the file, its recent commits and its diff, so the card still says why the file changed. Agents are told to put that why in their commit messages. `cards = "block"` brings back the old behaviour, where each agent writes its own.
- **Lane work gets its cards after it merges.** Lanes edit in their own worktrees, which the card writer can't see, so it also cards the files merged in the last 14 days without one. `ctx cards --recent` lists them.
- **Shell edits are gated like the edit tools.** A `python3` or `node` script, `sed -i`, a redirect or `tee` that writes a file nobody read is refused before it runs, with the list of what to read.
- **An older instruction block is brought up to date.** CLAUDE.md or AGENTS.md carrying the old block (which told agents to write their cards) is reported by `ctx next`, and `ctx install instructions` replaces it in place, keeping the rest of the file.

## 0.5.0 (2026-10-11)

Context Graph now runs in the background. Agents read a file's card before they change it and write it after; nothing waits on you.

**In the background by default**

- **An agent's rule applies at once.** When an agent spots a convention the code follows, it's added as guidance every agent sees from then on, with no review. Only a rule that would block edits, or a concept, still needs a person to sign it. `agent_guidance = false` in `[harness]` brings back the old behaviour, where an agent's rule waits as a suggestion.
- **Setup asks nothing.** `/context-graph:init` builds the graph, configures it for the background and commits it. The ratifier is the repository's own git identity.
- **The card writer and backfill are on by default.** Missing cards are written while the lead is idle, starting with code changed in the last 90 days, leaves first. The Map tab has Pause and Resume for it.
- **The band speaks only when it matters:** a line appears only when agents keep working around a rule.

**What you see**

- **The module graph** in the Map tab: modules as nodes with their rules and how many files have a card, a pulse when a decision is recorded, and rules that are overridden outlined in red.
- **Plain words.** A file's "why" instead of "carded".

**Fixes**

- Once you decline a batch, the card writer offers no other batch this session. It and the curator pause while code-kit's loop is paused.
- `ctx agents` no longer counts a card as owed once a matching card exists, so the card writer isn't offered files that are already done.

## 0.4.0 (2026-10-10)

The harness, in Context Graph's mod (Claude Code 2.1.287 or later): background agents that keep the graph current, and panes that show it.

**Settings**

- **`[harness]` in `.ctx/config.toml`** holds the background agents and side questions: `card_writer`, `backfill`, `curator`, `side_questions`, a model for each, and `pause_at_percent`, the plan's 5-hour use at which they pause (code-kit's setting wins when it's installed). A wrong value gives way to its default, and `ctx doctor` reports it.
- **`ctx settings`** lists them; `ctx settings set <key> <value>` changes one, as the person. **`/graph-settings`** opens them in the session.

**Background agents**

- **The card writer** writes the cards owed and missing, from full reads of each file, in batches while the lead is idle. The lead may decline a batch; a declined batch isn't offered again.
- **Backfill for existing code.** With `backfill = "active"` (modules changed in the last 90 days) or `"all"`, the card writer also cards a brownfield project's code, leaves first. `init` offers it, and the Map tab has "Write cards for this module".
- **The curator** reads the decisions recorded and proposes the rules they show, and flags rules overridden again and again. It only proposes; you decide.
- **Read-assist:** the files an edit needs understood are delivered as a reading list, with its progress shown, and edits are tagged in the transcript.

**What you see**

- **The Context pane, redone:** the graph's health, tabs, keys, and `/graph <path>` to open a file. A file's card shows as Markdown, its rules as chips, and its neighbourhood (what it imports and what imports it).
- **Proposals in plain words:** **Accept**, **Reject…** and **Later** on a, r and l, grouped by module with **Accept all**, and the evidence for each with a sparkline once there is some.
- **`/why <path, module, rule or question>`** answers beside the conversation, from the graph's cards, rules and decisions only, citing each, with its cost.
- **The Map tab:** the modules as a tree, with a coverage heat map.
- New commands: `ctx neighbours <path>`, `ctx map`, `ctx cards --module`, `ctx cards --backfill --scope`.

**Fixes**

- Data files (`.jsonl`, `.ndjson`, `.csv`, `.tsv`) and tool config files (`*.config.js` and the like) owe no card.
- A person's act (`ratify --commit`, `drop`, `settings set`) is recognised only where a command runs it, not in a heredoc or quoted text such as a commit message.
- `init` proposes the repository's own git identity as the ratifier, never an address from elsewhere.
- The health line goes amber only for cards owed or rules flagged, not for a brownfield project still being carded, and an empty coverage bar draws grey.
- The mod keeps working in a headless session where the agent list or registration fails.

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
