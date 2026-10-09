# OpenAI Codex extension surfaces, state as of 2026-09-07

Research report produced for the Context Graph design spec. Facts are from the Codex documentation at learn.chatgpt.com/docs (every former developers.openai.com/codex page redirects there), the GitHub releases feed, and the Rust source under `codex-rs/` where the docs were silent. Items not confirmable from official sources are marked UNCONFIRMED.

**Latest stable release:** Codex CLI 0.153.4 (2026-09-04). Hooks engine landed in 0.114.0 (2026-03-11), subagents in 0.115.0 (2026-03-16), plugins as a first-class workflow in 0.117.0 (2026-03-26), hooks GA on 2026-05-14, `Interrupt` hooks in 0.150.0 (2026-08-26).

**Documentation moved.** `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*` (for example `/codex/hooks` to `/docs/hooks`, `/codex/config-reference` to `/docs/config-file/config-reference`). The repo's `docs/*.md` files are stubs pointing there; `CHANGELOG.md` points at GitHub Releases. `learn.chatgpt.com` also serves `.md` variants of every page.

---

## 1. Configuration and instructions

### config.toml locations and precedence

Sources: config-basic, config-reference, config-advanced, enterprise/managed-configuration.

Highest to lowest:

1. CLI flags and `-c/--config key=value` overrides (`--enable`/`--disable` for features)
2. Project config `.codex/config.toml`, walks root to cwd, closest to cwd wins; loaded only for trusted projects
3. Profile `~/.codex/<profile-name>.config.toml` selected with `--profile <name>` (also `profile = "..."` key)
4. User config `~/.codex/config.toml` (`CODEX_HOME` overrides the `~/.codex` directory)
5. System config `/etc/codex/config.toml` (Unix)
6. Built-in defaults

Managed layers sit on top as constraints, not overrides: `/etc/codex/requirements.toml` (Windows: `%ProgramData%\OpenAI\Codex\requirements.toml`), `/etc/codex/managed_config.toml`, cloud-fetched enterprise requirements, and macOS MDM keys `com.openai.codex:config_toml_base64` / `com.openai.codex:requirements_toml_base64`. Requirements precedence: system `requirements.toml` > enterprise cloud requirements > legacy `managed_config.toml` > MDM.

Discrepancy: config-reference lists the profile layer after project config; config-basic lists project above profile. UNCONFIRMED which is authoritative.

Project-scoped config cannot set (ignored with warning): `openai_base_url`, `chatgpt_base_url`, `apps_mcp_product_sku`, `model_provider`, `model_providers`, `notify`, `profile`, `profiles`, `experimental_realtime_ws_base_url`, `otel`.

Trust: `[projects."/abs/path"] trust_level = "trusted" | "untrusted"`. Untrusted projects skip project-scoped `.codex/` layers, including project-local config, hooks, and rules. User and system layers always load. Design consequence: a plugin that ships project-level hooks only fires in trusted checkouts; user-level (`~/.codex/hooks.json`) hooks always fire.

### AGENTS.md discovery

Source: agent-configuration/agents-md.

- Chain is built once per run at startup, not lazily when the agent changes directory.
- Global: `~/.codex/AGENTS.override.md` if present, else `~/.codex/AGENTS.md`.
- Project: walk from project root (marked by `.git`, `.hg`, `.sl`, or `project_root_markers`) down to cwd; at each level try `AGENTS.override.md`, then `AGENTS.md`, then `project_doc_fallback_filenames`. Discovery stops at cwd; directories below cwd are not read.
- Concatenated root to cwd; later (closer) files override earlier guidance.
- `project_doc_max_bytes` default 32 KiB combined; Codex stops adding files once the cap is hit and skips empty files.
- `project_doc_fallback_filenames` (default `["AGENTS.md"]`).
- `model_instructions_file` replaces the built-in base instructions (not AGENTS.md). `developer_instructions` injects an extra developer-role string.

```toml
project_doc_fallback_filenames = ["TEAM_GUIDE.md", ".agents.md"]
project_doc_max_bytes = 65536
```

### Approval and sandbox modes

```toml
approval_policy = "untrusted"      # prompt for everything not on the trusted list
approval_policy = "on-request"     # default interactive
approval_policy = "never"          # non-interactive
approval_policy = { granular = { sandbox_approval = true, rules = true, mcp_elicitations = false, request_permissions = true, skill_approval = true } }

sandbox_mode = "read-only" | "workspace-write" | "danger-full-access"

[sandbox_workspace_write]
writable_roots = ["/path"]
network_access = false
exclude_slash_tmp = false
exclude_tmpdir_env_var = false
```

`requirements.toml` can pin `allowed_approval_policies`, `allowed_sandbox_modes`, `allowed_approvals_reviewers`. Hook payloads report a Claude-style `permission_mode` (`default | acceptEdits | plan | dontAsk | bypassPermissions`), not the TOML names. UNCONFIRMED whether hook commands themselves run inside the sandbox; the docs describe them as host commands and say nothing about sandboxing them.

---

## 2. Hooks and lifecycle events

Source: docs/hooks plus generated schemas at `codex-rs/hooks/schema/generated/*.schema.json` and `codex-rs/core/src/tools/hook_names.rs`.

Codex has a hooks engine with a Claude Code-compatible shape, including `Write`/`Edit`/`Agent` matcher aliases and `CLAUDE_PLUGIN_ROOT` env compatibility. Enabled by default (`[features] hooks = true`).

**Events (12):** `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`.

**Config locations (all load; a higher layer does not replace a lower one):**

1. `~/.codex/hooks.json` or `[hooks]` in `~/.codex/config.toml`
2. `<repo>/.codex/hooks.json` or `[hooks]` in `<repo>/.codex/config.toml` (trusted projects only)
3. `requirements.toml` managed hooks
4. Plugin-bundled `hooks/hooks.json`

Codex warns if a layer has both `hooks.json` and inline `[hooks]`.

**hooks.json shape:**

```json
{
  "description": "Optional lifecycle hooks for this workspace.",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py\"",
            "statusMessage": "Checking Bash command"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/usr/bin/python3 \"$(git rev-parse --show-toplevel)/.codex/hooks/stop_continue.py\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

Handler keys: `type` (`command` | `mcp_tool`; `prompt` and `agent` are parsed but skipped), `command`, `commandWindows`, `timeout` (default 600 s; `SessionEnd`/`Interrupt` default 1 s, max 3 s), `statusMessage`, `additionalContextLimit` (default about 2,500 tokens, larger output spilled to `<temp_dir>/hook_outputs/<session_id>/<uuid>.txt`), `async` (fire-and-forget; max 8 concurrent; cannot block). `mcp_tool` handler: `{ "type": "mcp_tool", "server": "...", "tool": "...", "input": { "field": "${tool_input.nested}" }, "timeout": 30 }`.

Inline TOML equivalent:

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"

[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 "$(git rev-parse --show-toplevel)/.codex/hooks/pre_tool_use_policy.py"'
timeout = 30
statusMessage = "Checking Bash command"
```

**Matcher** is a regex over: `tool_name` (PreToolUse/PostToolUse/PermissionRequest), `source` (SessionStart: `startup|resume|clear|compact`), `trigger` (compact: `manual|auto`), `agent_type` (Subagent events). Omit, `""`, or `"*"` matches all.

**Stdin payload, common fields (required per schema):** `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped events add `turn_id`; optional `agent_id`, `agent_type`. PreToolUse adds `tool_name`, `tool_use_id`, `tool_input`. PostToolUse adds `tool_response`. Stop adds `stop_hook_active` (bool) and `last_assistant_message`. UserPromptSubmit adds `prompt`. SubagentStop adds `agent_transcript_path`.

`transcript_path` "points to a chat transcript for convenience, but the transcript format isn't a stable interface for hooks and may change over time." It is the rollout JSONL described in section 5.

**Tool names as seen by hooks:**

| Canonical `tool_name`                                                                       | Matcher aliases               | `tool_input` shape                             | What it covers                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Bash`                                                                                      | none                          | `{"command": <cmd string>}`                    | All shell execution via unified exec (`exec_command`). Codex has no dedicated read-file tool; `cat`, `sed`, `rg` reads show up here. |
| `apply_patch`                                                                               | `Edit`, `Write`               | `{"command": "<full *** Begin Patch text>"}`   | All file writes and edits. Paths are recoverable by parsing `*** Add File:` / `*** Update File:` / `*** Delete File:` lines.         |
| `spawn_agent`                                                                               | `Agent`                       | JSON args                                      | Subagent creation                                                                                                                    |
| any other local function tool (`update_plan`, `view_image`, `read_mcp_resource`, and so on) | none                          | parsed JSON args (or raw string if unparsable) | via `function_hook_tool_name`                                                                                                        |
| MCP tools                                                                                   | regex such as `mcp__fs__read` | tool arguments                                 | docs give the `mcp__server__tool` form                                                                                               |

Hosted tools (`WebSearch`) do not use the local function-tool hook path and are not observable.

**Stdout output (exit 0 plus JSON):** shared `continue` (default true), `stopReason`, `systemMessage`, `suppressOutput`, `hookSpecificOutput.hookEventName`, `hookSpecificOutput.additionalContext`.

- PreToolUse can block, modify input, and inject context: `hookSpecificOutput.permissionDecision` in `allow | deny | ask`, `permissionDecisionReason`, `updatedInput`, `additionalContext`. Legacy top-level `decision` in `approve | block`.

  ```json
  {
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "allow",
      "updatedInput": { "command": "echo rewritten" }
    }
  }
  ```

- PostToolUse: `decision: "block"` plus `reason`, `additionalContext`, and `updatedMCPToolOutput` (schema-confirmed; replaces an MCP result the model sees).
- Stop and SubagentStop: `decision: "block"` plus `reason` forces the agent to keep working. This is the primitive for a "record a decision with why before the turn ends" gate. `stop_hook_active: true` on re-entry lets a hook avoid infinite loops.

  ```json
  { "decision": "block", "reason": "Run one more pass over the failing tests." }
  ```

- UserPromptSubmit, PreCompact, PostCompact can block; UserPromptSubmit, SessionStart, and SubagentStart can inject `additionalContext`.
- Exit 2 means fail with reason on stderr; other non-zero is a hook error and the operation continues.

**Trust:** non-managed hooks must be reviewed and trusted via `/hooks` (inspect sources, trust by hash, disable individually); `--dangerously-bypass-hook-trust` for automation. Managed hooks (requirements, MDM, cloud-managed) bypass review. `requirements.toml` `allow_managed_hooks_only = true` ignores user, project, and plugin hooks. The app-server exposes `hooks/list` and emits `hook/started` / `hook/completed` notifications.

**Surfaces:** CLI confirmed. Desktop app confirmed indirectly (issue #21639, "Hooks no longer run after Codex Desktop update"). IDE extension and Codex cloud tasks: UNCONFIRMED. The `codex-rs/app-server/README.md` still says hooks are advisory and lists only SessionStart/SessionEnd; that README is stale relative to the docs and the schemas.

### `notify` (legacy, pre-hooks)

```toml
notify = ["python3", "/path/to/notify.py"]
```

Only event: `agent-turn-complete`. Payload (kebab-case, from source):

```json
{
  "type": "agent-turn-complete",
  "thread-id": "...",
  "turn-id": "...",
  "cwd": "...",
  "client": "...",
  "input-messages": ["..."],
  "last-assistant-message": "..."
}
```

Source shows the JSON is appended as the last argv argument with stdin set to null; the config-reference prose says "via stdin". Trust the source. `notify` cannot be set from project config. It is now implemented as a hook named `legacy_notify` on the `AfterAgent` event.

### Before-edit interception point

Exists: `PreToolUse` with `matcher: "apply_patch"` (or `Edit|Write`). The hook receives the full patch text in `tool_input.command`, can return `additionalContext`, rewrite the patch via `updatedInput`, or `deny`. There is no separate on-file-change filesystem event in the CLI; the app-server has `fs/watch` and `fs/changed` for clients. `PostToolUse` on `apply_patch` gives `tool_response` (apply result).

---

## 3. Plugins and extensions

### Plugins (marketplace)

Sources: docs/plugins, plugins/build, what's-new (launch 2026-03-25), `codex-rs/cli/src/plugin_cmd.rs`.

A plugin bundles skills, connectors (apps), MCP servers, browser extensions, hooks, and scheduled-task templates. Layout:

```
my-plugin/
  .codex-plugin/plugin.json   # required manifest
  skills/<name>/SKILL.md
  .mcp.json                   # bundled MCP servers
  .app.json                   # connector references
  hooks/hooks.json            # lifecycle hooks
  assets/
```

Manifest (minimal): `{ "name": "my-first-plugin", "version": "1.0.0", "description": "...", "skills": "./skills/" }`. Full manifest adds `author`, `homepage`, `repository`, `license`, `keywords`, `mcpServers: "./.mcp.json"`, `apps: "./.app.json"`, `hooks: "./hooks/hooks.json"` (or an array of files), and an `interface` block (displayName, category, capabilities, brandColor, composerIcon, screenshots). Hook commands get `PLUGIN_ROOT`, `PLUGIN_DATA` (plus `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`), for example `"command": "python3 ${PLUGIN_ROOT}/hooks/session_start.py"`.

Marketplace manifest `.agents/plugins/marketplace.json` (repo-level `$REPO_ROOT/.agents/plugins/marketplace.json` or personal `~/.agents/plugins/marketplace.json`; plugin bodies at `./plugins/<name>` or `~/.codex/plugins/<name>`). Sources: `local` (`path`), `git-subdir` (`url`, `path`, `ref`), `npm` (`package`, `version`, `registry`). Policy: `installation: "AVAILABLE"`, `authentication: "ON_INSTALL"`.

CLI (`codex plugin` subcommands from source: `add`, `list`, `marketplace`, `remove`):

```
codex plugin marketplace add owner/repo [--ref main]
codex plugin marketplace add https://github.com/example/plugins.git --sparse .agents/plugins
codex plugin marketplace add ./local-marketplace-root
codex plugin marketplace list | upgrade [name] | remove <name>
```

In-session: `/plugins`. Plugin-scoped MCP policy in config.toml:

```toml
[plugins."my-plugin".mcp_servers.docs]
enabled = true
default_tools_approval_mode = "prompt"
enabled_tools = ["search"]
```

Enterprise: `features.plugins = false`, `[marketplaces] restrict_to_allowed_sources = true` in `requirements.toml`. Surfaces: CLI and Codex-in-ChatGPT desktop app; plugins are not available in the IDE extension. Self-serve publishing to the public directory is described as coming soon; workspace admins can publish internally.

### Skills

Source: docs/build-skills (follows agentskills.io).

`SKILL.md` with frontmatter `name`, `description`; optional `scripts/`, `references/`, `agents/openai.yaml` (`interface.display_name`, `short_description`, `icon_small`, `brand_color`; `policy.allow_implicit_invocation` default true; `dependencies.tools: [{type: mcp, value: serverName}]`). Discovery precedence: `.agents/skills` in cwd and every parent up to repo root, then `$REPO_ROOT/.agents/skills`, then `$HOME/.agents/skills`, then `/etc/codex/skills`, then bundled system skills. Invocation: explicit `$skill-name` in the composer, or implicit match on description (name plus description preloaded, capped at 2 percent of context or 8,000 chars). Disable: `[[skills.config]] path = "/path/SKILL.md" enabled = false`; `[skills] max_context_tokens`. `$skill-installer <name>` pulls from OpenAI's curated catalog (github.com/openai/skills). `~/.codex/skills` is not in the current docs.

### Custom prompts (deprecated)

`~/.codex/prompts/<name>.md` with front matter `description`, `argument-hint`; placeholders `$1` to `$9`, `$ARGUMENTS`, `$KEY`, `$$`; invoked `/prompts:<name>`. The docs state custom prompts are deprecated in favour of skills.

### Subagents

Built-ins: `default`, `worker`, `explorer`. Custom agents: `~/.codex/agents/*.toml` or `.codex/agents/*.toml` with `name`, `description`, `developer_instructions` (required); optional `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`.

```toml
[agents]
enabled = true
max_concurrent_threads_per_session = 5
default_subagent_model = "gpt-5.5"
default_subagent_reasoning_effort = "medium"
interrupt_message = true
```

Tools: v1 `spawn_agent`, `send_input`, `wait_agent`, `close_agent`; v2 adds `followup_task`, `send_message`, `list_agents`, `interrupt_agent` with path addresses such as `/root/agent_a`. Feature flag `features.multi_agent` (stable, on by default). Hooks `SubagentStart` and `SubagentStop` fire; each subagent has its own rollout (`parent_thread_id`, `agent_role`, `agent_path` in `session_meta`).

### "Extensions" (0.151.0, "Extensions can now inspect or replace MCP tool results")

These are in-tree Rust crates under `codex-rs/ext/*` (memories, goal, guardian-v2, skills, mcp, git-attribution, and others) registered through `codex-extension-api` contributor traits (`ToolLifecycleContributor`, `McpToolResultInput`, `ContextContributor`, `TurnInputContributor`). No dynamic loading was found (no libloading, wasm, or dylib in the tree). Not a third-party extension surface; only relevant to a fork.

---

## 4. MCP

Sources: docs/extend/mcp, config-reference, docs/mcp-server, docs/app-server.

CLI: `codex mcp add <name> [--env K=V]... -- <command> [args]`, `codex mcp add <name> --url https://... [--bearer-token-env-var VAR]`, `codex mcp list`, `codex mcp login <name>`. Config:

```toml
[mcp_servers.context7]            # stdio
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
env_vars = ["LOCAL_TOKEN"]       # forwarded from parent env
cwd = "/working/dir"
[mcp_servers.context7.env]
MY_ENV_VAR = "MY_ENV_VALUE"

[mcp_servers.figma]               # streamable HTTP
url = "https://mcp.figma.com/mcp"
auth = "oauth"                    # or "chatgpt"
bearer_token_env_var = "FIGMA_OAUTH_TOKEN"
http_headers = { "X-Figma-Region" = "us-east-1" }
env_http_headers = { "X-Token" = "TOKEN_ENV" }

# common keys
startup_timeout_sec = 10          # default 10
tool_timeout_sec = 60             # default 60
enabled = true
required = false                  # fail startup if unavailable
enabled_tools = ["open"]
disabled_tools = ["screenshot"]
default_tools_approval_mode = "auto" | "prompt" | "writes" | "approve"
[mcp_servers.figma.tools.open]
approval_mode = "approve"
output_token_limit = 30000        # per-tool, added 0.152.0
[mcp_servers.figma.oauth]
callback_url = "http://localhost:8080/callback"
callback_port = 8080
client_id = "abc123"
scopes = ["read", "write"]
```

Global: `mcp_optional_startup_grace_ms`, `mcp_oauth_callback_url`, `mcp_oauth_callback_port`. OAuth 2.0 authorization-code plus PKCE for streamable-HTTP servers; `experimental_environment = "remote"` runs a stdio server in a remote environment. Server names may contain `: @ / .` since 0.152.0.

**Resources and prompts:** the MCP doc says resources and prompts are not surfaced, only tools. However the source ships `list_mcp_resources`, `list_mcp_resource_templates`, `read_mcp_resource` function tools (`codex-rs/core/src/tools/handlers/mcp_resource_spec.rs`) and the app-server has `mcpServer/resource/read` and `mcpServer/elicitation/request`. Treat resources as available to the model, prompts as not; docs and source disagree.

**Codex as an MCP server:** `codex mcp-server` (stdio) exposes `codex` and `codex-reply` tools. The page states it is deprecated in favour of the app server. The app-server (`codex app-server`, JSON-RPC 2.0 over stdio, experimental WebSocket, or Unix socket) is the supported integration seam: `thread/start|resume|fork|read|list`, `turn/start|steer|interrupt`, `thread/inject_items`, `dynamicTools` on `turn/start`, `fs/watch`, `hooks/list`, `skills/list`, `plugin/*`, `mcpServer/tool/call`, server-initiated `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `tool/requestUserInput`.

---

## 5. Session logs and transcripts

Sources: troubleshooting page, config-advanced, `codex-rs/rollout/src/{recorder,rollout_file_name,session_index}.rs`, `codex-rs/history/src/rollout_payload.rs`, `codex-rs/message-history/src/lib.rs`, `codex-rs/protocol/src/{protocol,models}.rs`.

| Path                                                                                                                                       | Contents                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDThh-mm-ss>-<thread_id>.jsonl` (reverted threads: `...-<thread_id>_<rollout_id>.jsonl`) | Full transcript (the "rollout"). Resume appends to the same file.                                         |
| `$CODEX_HOME/archived_sessions/`                                                                                                           | Archived rollouts (`codex archive`, `thread/archive`)                                                     |
| `$CODEX_HOME/session_index.jsonl`                                                                                                          | `{ "id", "thread_name", "updated_at" }`, names only                                                       |
| `$CODEX_HOME/history.jsonl`                                                                                                                | Prompt history only: `{ "session_id", "ts", "text" }` per user message. `history.persistence = "save-all" | "none"`, `history.max_bytes`. Not a transcript despite the docs' wording. |
| SQLite state DB via `codex_state::StateRuntime`                                                                                            | filename UNCONFIRMED                                                                                      |
| TUI log                                                                                                                                    | only when `-c log_dir=./.codex-log` (`codex-tui.log`); `RUST_LOG` honoured                                |
| `CODEX_ROLLOUT_TRACE_ROOT`                                                                                                                 | opt-in raw trace bundles with `codex debug trace-reduce`                                                  |

`--ephemeral` (exec) or `thread.ephemeral` skips rollout persistence entirely. UNCONFIRMED whether `history.persistence = "none"` also suppresses rollouts (source suggests it governs only `history.jsonl`).

**Rollout line format** (`RolloutItemWire`, `#[serde(tag="type", rename_all="snake_case")]`): each line is `{"timestamp": "...", "type": <t>, "payload": {...}}` with `type` in `session_meta`, `response_item`, `inter_agent_communication`, `inter_agent_communication_metadata`, `compacted`, `turn_context`, `token_usage_record`, `world_state`, `retained_context`, `security_risk_score`, `event_msg`, `realtime_item`.

- `session_meta` payload: `session_id`, `id`, `forked_from_id`, `parent_thread_id`, `timestamp`, `cwd`, `originator`, `cli_version`, `source`, `agent_nickname`, `agent_role`, `agent_path`, `model_provider`, `base_instructions`, `dynamic_tools`, `git`.
- `turn_context` payload: `turn_id`, `cwd`, `approval_policy`, `sandbox_policy`, `permission_profile`, `model`, `effort`, `network`, `collaboration_mode`.
- `response_item` payload is a Responses-API `ResponseItem`: `message`, `agent_message`, `reasoning`, `local_shell_call`, `function_call` (`name`, `arguments`, `call_id`), `function_call_output`, `custom_tool_call` (this is `apply_patch`; `input` holds the full patch text), `custom_tool_call_output`, `tool_search_call/output`, `web_search_call`, `image_generation_call`, `compaction`, `configuration_update`.
- `event_msg` payload: `EventMsg` variants (`exec_command_begin/end`, `patch_apply_begin/end`, `mcp_tool_call_begin/end`, `user_message`, `agent_message`, `turn_aborted`, hook lifecycle events).

**An observer can reconstruct reads and edits.** Shell reads are `function_call` items (`name: "exec_command"` or shell, `arguments` containing `cmd`) plus `exec_command_begin` events; edits are `custom_tool_call` items with the complete `*** Begin Patch` text plus `patch_apply_begin/end` events carrying the per-file change set; MCP calls are `function_call` with `mcp__server__tool`-style names plus `mcp_tool_call_begin/end`. The file is append-only and can be tailed live (the `context_window` field exists "for consumers that tail rollout JSONL"). GitHub discussion #3827 and the hooks doc both warn the format is not a stable interface; pin to `cli_version` in `session_meta`.

### `codex exec`

Flags: `--json` (alias `--experimental-json`), `-o/--output-last-message PATH`, `--output-schema PATH`, `-s/--sandbox`, `-a/--ask-for-approval`, `--full-auto` (deprecated, use `--sandbox workspace-write`), `--dangerously-bypass-approvals-and-sandbox`/`--yolo`, `--ephemeral`, `-m`, `-p/--profile`, `-c KEY=VALUE`, `-C/--cd`, `--add-dir`, `--skip-git-repo-check`, `-i/--image`, `--search`, `--color`, `--oss --local-provider {lmstudio|ollama}`, `--ignore-user-config`, `--ignore-rules`, `--dangerously-bypass-hook-trust`. Prompt from arg or `codex exec - < task.txt`. Resume: `codex exec resume [SESSION_ID] | --last | --all --last` with optional follow-up prompt.

JSONL schema (`ThreadEvent`, `tag="type"`): `thread.started {thread_id}`, `turn.started {}`, `turn.completed {usage}`, `turn.failed {error}`, `item.started|item.updated|item.completed {item}`, `error {message}`. Items: `agent_message {text}`, `reasoning {text}`, `command_execution {command, aggregated_output, exit_code, status}`, `file_change {changes:[{path, kind: add|delete|update}], status}`, `mcp_tool_call {server, tool, arguments, result, error, status}`, `collab_tool_call {...}`, `web_search {...}`, `todo_list {...}`, `error {message}`. `file_change` carries paths but not patch bodies; `command_execution` carries the command string.

Other commands (from `cli/src/main.rs`): `resume`, `fork`, `queue`, `archive|unarchive|delete`, `migrate-rollouts`, `apply`, `cloud` (experimental), `review`, `mcp`, `plugin`, `app-server` (plus `daemon`, `proxy`, `generate-ts`, `generate-json-schema`), `remote-control`, `app`, `doctor`, `sandbox`, `debug`, `execpolicy`, `features`, `exec-server`, `agents`. No `codex hooks` subcommand; hooks are managed via the in-session `/hooks` command.

---

## 6. SDK and cloud

### SDKs

- TypeScript `@openai/codex-sdk` (Node 18+) and Python `openai-codex` (`AsyncCodex` available). Both spawn the `codex` CLI and exchange the section 5 JSONL events over stdio; same event and item schema as `codex exec --json`.
- `new Codex({ env, baseUrl, apiKey, codexPathOverride, config, configOverrides })`; `config` is flattened to repeated `--config key=value`; `configOverrides` are raw TOML strings.
- `codex.startThread({ workingDirectory, skipGitRepoCheck, sandboxMode, approvalPolicy, model, modelReasoningEffort, networkAccessEnabled, webSearchEnabled, additionalDirectories })`; `codex.resumeThread(threadId)` reads from `~/.codex/sessions`.
- `thread.run(prompt, { outputSchema })` buffers; `thread.runStreamed(prompt)` returns an async generator of `ThreadEvent`.
- No programmatic hook or callback API. The SDK is observation-only. Hooks still fire because they are loaded by the CLI it spawns; injecting them via `configOverrides` raw TOML is plausible but UNCONFIRMED. For control (approvals, dynamic tools, `thread/inject_items`) use the app-server directly.
- Separate `@openai/codex-security` CLI/SDK (0.1.5, July 2026) for security scanning.

### Cloud, web, GitHub

- Runs in the `universal` container; steps: checkout, setup script (internet on), optional maintenance script on cached-container resume (cache up to 12 h), agent phase with internet off by default (configurable domain allowlist). Env vars persist; secrets are decrypted only for setup and removed before the agent phase.
- `AGENTS.md` is honoured. Whether `.codex/config.toml`, hooks, plugins, skills, or MCP servers from the repo run in cloud tasks: UNCONFIRMED, not mentioned anywhere in the cloud docs.
- GitHub: connect repo (push or admin permission); `@codex review`, `@codex security review`, `@codex <task>` in PR comments; automatic reviews toggle; review rules under a `## Code Review Rules` section of `AGENTS.md`. Separate Codex GitHub Action for CI. `codex cloud` CLI is experimental; `codex apply` pulls a cloud diff locally.
- IDE extension: VS Code (plus Cursor, Windsurf), Xcode, JetBrains; hands off to Codex web. Config, hooks, and MCP support in the IDE is not documented; plugins are explicitly unsupported there.

---

## 7. What happened to "GPT plugins"

ChatGPT plugins (OpenAPI manifests) were sunset in 2024: no new installs or plugin chats after 2024-03-19, existing chats ended 2024-04-09. They were succeeded by GPTs with GPT Actions (OpenAPI-based, scoped to one GPT), then in October 2025 by apps in ChatGPT and the Apps SDK, which is built on MCP and tells builders to start with the MCP Apps specification. The Agents SDK is an unrelated orchestration library. In 2026 OpenAI reused the word "plugins" for the Codex and ChatGPT bundles described in section 3, a different system with no lineage to 2023 plugins. For a coding-agent plugin the only carry-over is MCP: a Codex plugin's `.mcp.json` and an Apps SDK app both speak MCP; the OpenAPI manifest era is irrelevant.

---

## Implications for the three requirements

| Requirement                                      | Codex mechanism                                                                                                                         | Caveat                                                                                                                                                                                    |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observe every read, grep, and edit               | `PreToolUse`/`PostToolUse` on `Bash` (all shell, including reads) and `apply_patch` (all edits); offline or tail from the rollout JSONL | Reads are shell commands, so path extraction means parsing `cat`, `sed`, `rg`, `grep` argv; project-level hooks need a trusted project; hooks must be trusted via `/hooks` unless managed |
| Inject a context slice before an edit            | `PreToolUse` matcher `apply_patch` returning `hookSpecificOutput.additionalContext` (also `updatedInput` to rewrite the patch)          | About 2,500-token default cap (`additionalContextLimit`), overflow spilled to disk with a preview                                                                                         |
| Require a decision with why before the turn ends | `Stop` hook returning `{"decision":"block","reason":"..."}`; check `stop_hook_active` to bound retries                                  | `Stop` output must be JSON; SDK and `exec` runs also fire it (same engine); cloud tasks UNCONFIRMED                                                                                       |

Package as a Codex plugin (`.codex-plugin/plugin.json` with `hooks: "./hooks/hooks.json"` plus a skill) for CLI and desktop distribution, and additionally ship the same `hooks.json` for `~/.codex/` since plugins do not reach the IDE extension.

## Sources

- https://learn.chatgpt.com/docs/hooks
- https://learn.chatgpt.com/docs/config-file/config-basic
- https://learn.chatgpt.com/docs/config-file/config-reference
- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://learn.chatgpt.com/docs/enterprise/managed-configuration
- https://learn.chatgpt.com/docs/agent-configuration/agents-md
- https://learn.chatgpt.com/docs/agent-configuration/subagents
- https://learn.chatgpt.com/docs/plugins
- https://developers.openai.com/codex/plugins/build
- https://learn.chatgpt.com/docs/build-skills
- https://learn.chatgpt.com/docs/custom-prompts
- https://learn.chatgpt.com/docs/extend/mcp
- https://learn.chatgpt.com/docs/mcp-server
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/developer-commands
- https://learn.chatgpt.com/docs/codex-sdk
- https://learn.chatgpt.com/docs/environments/cloud-environment
- https://learn.chatgpt.com/docs/third-party/github
- https://learn.chatgpt.com/docs/github-action
- https://github.com/openai/codex (releases feed; `codex-rs/` source)
- https://github.com/openai/codex/issues/21639
- https://community.openai.com/t/plugin-store-and-new-chats-with-plugins-closed-march-19-2024/689877
- https://developers.openai.com/apps-sdk/reference
