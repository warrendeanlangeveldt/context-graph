# Claude Code Extension Surfaces: Authoritative Reference

**Document version:** 2026-09-07  
**Compiled from:** code.claude.com official documentation  
**Purpose:** Codebase-agnostic developer plugin spec foundation

---

## 1. HOOKS: Event Types, JSON Schema, and Capabilities

### 1.1 Complete Hook Event Lifecycle

**Source:** https://code.claude.com/docs/en/hooks.md

Claude Code fires hooks at these lifecycle points:

#### Once Per Session

- **`SessionStart`** – Session begins or resumes
  - Input: `start_reason` (startup|resume|clear|compact|fork)
  - Input: `model` (canonical model name, not always present)

- **`SessionEnd`** – Session terminates
  - Input: `end_reason` (clear|resume|logout|etc.)

- **`Setup`** – One-time preparation (fires with `--init-only`, `--init`, or `--maintenance`)
  - Input: `setup_reason` (init|maintenance)

#### Once Per Turn

- **`UserPromptSubmit`** – Before Claude processes user input
- **`UserPromptExpansion`** – When slash command expands
- **`Stop`** – When Claude finishes responding
- **`StopFailure`** – When turn ends due to API error

#### On Every Tool Call (Agentic Loop)

- **`PreToolUse`** – Before tool executes (blockable, can modify input)
- **`PostToolUse`** – After tool succeeds
- **`PostToolUseFailure`** – After tool fails
- **`PostToolBatch`** – After parallel batch resolves
- **`PermissionRequest`** – When tool needs permission
- **`PermissionDenied`** – When auto mode denies tool call

#### Async / Standalone Events

- **`Notification`** – User notifications (permission_prompt, idle_prompt, auth_success, elicitation_dialog, agent_needs_input, agent_completed, quota_auto_resume_*)
- **`ConfigChange`** – Configuration changed
- **`CwdChanged`** – Working directory changed
- **`FileChanged`** – File modified/created/deleted (input: file_path, change_type)
- **`DirectoryAdded`** – Directory created
- **`InstructionsLoaded`** – CLAUDE.md loaded (input: load_reason = session_start|nested_traversal|path_glob_match|include|compact)
- **`WorktreeCreate`** / **`WorktreeRemove`** – Git worktree operations

#### Subagent Events

- **`SubagentStart`** – Subagent spawned (input: agent_type)
- **`SubagentStop`** – Subagent finished
- **`TaskCreated`** / **`TaskCompleted`** – Workflow task lifecycle
- **`TeammateIdle`** – Agent teammate waiting

#### Model Switch Events

- **`PreModelSwitch`** – Before model switch (blockable)
- **`PostModelSwitch`** – After model changes

#### MCP & Display Events

- **`Elicitation`** – MCP server requests user input
- **`ElicitationResult`** – After user responds

---

### 1.2 Universal JSON Input Schema (All Events)

**Source:** https://code.claude.com/docs/en/hooks.md

Every hook receives (on stdin for command/HTTP hooks) or as callback parameters (SDK):

```json
{
  "session_id": "abc123",
  "prompt_id": "550e8400-e29b-41d4-a716-446655440000",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/directory",
  "permission_mode": "default|plan|acceptEdits|auto|dontAsk|bypassPermissions",
  "effort": { "level": "low|medium|high|xhigh|max" },
  "hook_event_name": "PreToolUse|PostToolUse|...",
  "agent_id": "subagent-uuid-if-present",
  "agent_type": "Explore|Plan|general-purpose|custom-name"
}
```

**Event-Specific Input Fields:**

| Event                                             | Additional Fields                                                                                                   | Notes                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure` | `tool_name`, `tool_input` (object), `tool_use_id`                                                                   | tool_input contains all params (command, file_path, timeout, etc.) |
| `PermissionRequest`                               | `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, `requires_permission: true`                            |                                                                    |
| `PermissionDenied`                                | `tool_name`, `tool_input`, `tool_use_id`, `permission_mode`, `denied_by: "classifier\|no_verdict"`                  |                                                                    |
| `UserPromptSubmit`                                | `prompt` (string), `prompt_id`                                                                                      | Plain text input                                                   |
| `UserPromptExpansion`                             | `command` (e.g., "command-name"), `expanded_prompt`, `command_name`                                                 | Slash command expansion                                            |
| `Stop` / `SubagentStop`                           | `stop_reason: "end_turn\|tool_use\|max_tokens"`, `last_assistant_message`, `turn_count`                             |                                                                    |
| `PostToolBatch`                                   | `tool_calls` (array), `batch_size`                                                                                  | Array of {tool_name, tool_use_id}                                  |
| `PreModelSwitch`                                  | `to_model`, `from_model`, `reason: "user_request\|resume\|auto_fallback"`                                           | Matcher on canonical model name                                    |
| `SessionStart`                                    | `start_reason: "startup\|resume\|clear\|compact\|fork"`                                                             | model field optional                                               |
| `Setup`                                           | `setup_reason: "init\|maintenance"`                                                                                 |                                                                    |
| `FileChanged`                                     | `file_path` (absolute), `change_type: "modified\|created\|deleted"`                                                 |                                                                    |
| `ConfigChange`                                    | `config_source: "user_settings\|project_settings\|local_settings\|policy_settings\|skills"`, `changed_keys` (array) |                                                                    |
| `Notification`                                    | `notification_type`, `message`                                                                                      |                                                                    |
| `Elicitation`                                     | `mcp_server`, `tool_name`, `prompt`                                                                                 | User prompt from MCP server                                        |
| `ElicitationResult`                               | `mcp_server`, `user_response`, `prompt`                                                                             | User's answer                                                      |
| `WorktreeCreate` / `WorktreeRemove`               | `worktree_path`, `reason: "worktree_flag\|isolation_mode\|background_session"`                                      |                                                                    |
| `CwdChanged`                                      | `new_cwd`, `previous_cwd`                                                                                           | No matcher support – fires on every change                         |
| `InstructionsLoaded`                              | `file_path`, `load_reason`, `file_size`                                                                             |                                                                    |

---

### 1.3 Hook Output Schema and Capabilities

**Source:** https://code.claude.com/docs/en/hooks.md + Agent SDK docs

All hooks can return structured output via stdout (command/HTTP/MCP hooks) or callback return (SDK):

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse|PostToolUse|...",
    "permissionDecision": "allow|deny|skip",
    "permissionDecisionReason": "string",
    "decision": "allow|deny|skip",
    "decisionReason": "string",
    "additionalContext": "string shown to Claude",
    "updatedInput": {
      "command": "modified-command",
      "timeout": 30000
    },
    "updatedResponse": "string",
    "systemMessage": "user-visible message",
    "retry": true,
    "terminalSequence": "\x1b]0;Title\x07"
  }
}
```

#### Capability Matrix: Which Output Fields Work on Which Events

| Field                    | Events                                                                                                                                | Description                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `additionalContext`      | PreToolUse, PostToolUse, PostToolUseFailure, Stop, SubagentStop, PermissionRequest                                                    | Shown to Claude as system message                           |
| `updatedInput`           | **PreToolUse only**                                                                                                                   | Modifies tool input before execution (merges with original) |
| `updatedResponse`        | Elicitation, ElicitationResult                                                                                                        | Modify MCP response text                                    |
| `permissionDecision`     | PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, UserPromptExpansion, Stop, SubagentStop, PostToolBatch, PreModelSwitch | Allow/deny/skip decision                                    |
| `decision` (alternative) | PermissionRequest only                                                                                                                | Does NOT support exit code 2; use field only                |
| `retry`                  | PermissionDenied                                                                                                                      | Allow model to retry denied call                            |
| `systemMessage`          | Most events                                                                                                                           | User-visible output in UI                                   |
| `terminalSequence`       | Most events                                                                                                                           | Terminal escape codes (notifications, title)                |

---

### 1.4 Exit Code Semantics

**Source:** https://code.claude.com/docs/en/hooks.md

| Code      | Behavior                                                                                                                                                                                                   | Applies To                                                                                                                                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**     | ✅ Success – Action proceeds. Stdout parsed as JSON if `{...}`. Plain text stdout added as context only on: UserPromptSubmit, UserPromptExpansion, SessionStart, PostModelSwitch. Stderr → debug log only. | All events                                                                                                                                                                                                                                                                             |
| **2**     | ⛔ **Blocking error** – Blocks action on blockable events. JSON decisions AND exit 2 together. Blocking message from JSON reason or stderr.                                                                | **Blockable:** PreToolUse, UserPromptSubmit, UserPromptExpansion, Stop, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, ConfigChange, PostToolBatch, PreModelSwitch, WorktreeCreate/Remove. **Not blockable:** PermissionRequest, StopFailure, PostToolUse, PostToolUseFailure |
| **Other** | ⚠️ Non-blocking error. If valid JSON output, honors decision fields. If invalid JSON, reports parse error. Empty stdout = non-blocking error.                                                              | All events                                                                                                                                                                                                                                                                             |

---

### 1.5 Transcript Format (JSONL Stable Public API)

**Source:** https://code.claude.com/docs/en/hooks.md

Location from hook input: `transcript_path`

Each line is a complete JSON object:

```jsonl
{"role":"user","content":"Do something","id":"msg_001"}
{"role":"assistant","content":"I'll help","id":"msg_002"}
{"type":"tool_use","tool_name":"Bash","tool_use_id":"toolu_001","input":{"command":"ls"}}
{"type":"tool_result","tool_use_id":"toolu_001","content":"file1.txt\nfile2.txt"}
```

**Stability Note:** Transcript is written asynchronously and may lag behind in-memory state. For current turn's final assistant message, prefer `last_assistant_message` from `Stop`/`SubagentStop` input over reading the file.

---

### 1.6 Hook Types & Execution Models

**Source:** https://code.claude.com/docs/en/hooks-guide.md + hooks.md

#### Command Hook (Shell Script)

```json
{
  "type": "command",
  "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/check.sh",
  "args": [],
  "timeout": 30,
  "async": false
}
```

- Runs shell command with JSON on stdin
- Exit code + stdout determine result
- Timeout in seconds

#### HTTP Hook (Remote Service)

```json
{
  "type": "http",
  "url": "http://localhost:8080/hooks/check",
  "headers": {
    "Authorization": "Bearer $TOKEN"
  },
  "allowedEnvVars": ["TOKEN"],
  "timeout": 30
}
```

- POST JSON to remote endpoint
- Response body parsed as JSON
- Env vars interpolated (only allowedEnvVars)
- Timeout in seconds

#### MCP Tool Hook (Invoke MCP Tool)

```json
{
  "type": "mcp_tool",
  "server": "my_server",
  "tool": "validate",
  "input": {
    "file_path": "${tool_input.file_path}"
  }
}
```

- Calls registered MCP tool
- Input can reference event fields with `${path}` syntax

#### Prompt Hook (LLM-Based Decision)

```json
{
  "type": "prompt",
  "prompt": "Should this command run? $ARGUMENTS",
  "model": "claude-haiku",
  "timeout": 30
}
```

- Runs small model to evaluate condition
- Returns yes/no decision
- Timeout in seconds

---

### 1.7 Matcher Patterns

**Source:** https://code.claude.com/docs/en/hooks.md

| Pattern              | Type          | Example       | Matches                                 |
| -------------------- | ------------- | ------------- | --------------------------------------- |
| `"*"`, `""`, omitted | Match all     |               | All occurrences                         |
| `Bash\|PowerShell`   | Exact list    | `Edit\|Write` | Tool name alternatives (pipe-separated) |
| `^Notebook.*`        | Regex         |               | Regex patterns                          |
| `mcp__memory__.*`    | MCP tools     |               | All tools from server (prefix match)    |
| `.envrc\|.env`       | File matchers |               | FileChanged event literal filenames     |

**For tool events** (PreToolUse, PostToolUse, PostToolUseFailure): Matches against `tool_name`  
**For SessionStart:** Matches against `start_reason`  
**For SessionEnd:** Matches against `end_reason`  
**For Notification:** Matches against `notification_type`  
**For SubagentStart/Stop:** Matches against `agent_type`

---

### 1.8 Hook Configuration Locations and Precedence

**Source:** https://code.claude.com/docs/en/hooks-guide.md + hooks.md

| Location                      | Scope               | Shared?                | Precedence                        |
| ----------------------------- | ------------------- | ---------------------- | --------------------------------- |
| `~/.claude/settings.json`     | All projects (user) | No                     | **3rd** (plugin > project > user) |
| `.claude/settings.json`       | Single project      | Yes (committed)        | **2nd**                           |
| `.claude/settings.local.json` | Single project      | No (gitignored)        | **2nd**                           |
| Plugin `hooks/hooks.json`     | When plugin enabled | Yes (bundled)          | **1st** (highest)                 |
| Skill/Subagent frontmatter    | Skill/agent scope   | Yes (defined in file)  | Inline to skill                   |
| Managed policy settings       | Organization-wide   | Yes (admin-controlled) | Override all                      |

**Configuration format:** All use same JSON schema. Plugin format:

```
plugin-root/hooks/hooks.json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "command", "command": "..." }]
      }
    ]
  }
}
```

---

### 1.9 Environment Variables Available to Hooks

Hooks can reference these environment variables:

| Variable                      | Value                                     | Available To                  |
| ----------------------------- | ----------------------------------------- | ----------------------------- |
| `CLAUDE_PROJECT_DIR`          | Repository root (stable across worktrees) | All hooks                     |
| `CLAUDE_SESSION_ID`           | Current session ID                        | All hooks                     |
| `CLAUDE_SKILL_DIR`            | Skill directory path (if skill-invoked)   | Skill-triggered hooks         |
| `CLAUDE_CODE_MCP_SERVER_NAME` | MCP server name                           | HTTP hooks with headersHelper |
| `CLAUDE_CODE_MCP_SERVER_URL`  | MCP server URL                            | HTTP hooks with headersHelper |
| `CLAUDE_PLUGIN_ROOT`          | Plugin installation directory             | Plugin hooks                  |
| `CLAUDE_PLUGIN_DATA`          | Plugin persistent state directory         | Plugin hooks                  |

---

### 1.10 Blockable vs Non-Blockable Events (Summary)

**Blockable** (exit 2 or JSON `permissionDecision: deny` will block):

- PreToolUse, UserPromptSubmit, UserPromptExpansion, Stop, SubagentStop, TeammateIdle, TaskCreated, TaskCompleted, ConfigChange, PostToolBatch, PreModelSwitch, WorktreeCreate/Remove

**Non-blockable** (exit 2 ignored):

- PermissionRequest, StopFailure, PostToolUse, PostToolUseFailure, all async events

---

## 2. PLUGINS: Structure, Manifest, and Distribution

### 2.1 Plugin Directory Layout

**Source:** https://code.claude.com/docs/en/plugins.md

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json                 # Required manifest
├── skills/                          # Model-invoked skills
│   └── skill-name/
│       ├── SKILL.md                # Frontmatter + instructions
│       └── reference.md            # Optional supporting files
├── commands/                        # Legacy flat commands (use skills/)
│   └── command-name.md
├── agents/                          # Custom subagent definitions
│   └── agent-name/
│       └── agent.json
├── hooks/                           # Event handlers
│   └── hooks.json
├── .mcp.json                        # MCP server configurations
├── .lsp.json                        # LSP server configurations
├── monitors/                        # Background monitors
│   └── monitors.json
├── settings.json                    # Default settings when plugin enabled
├── bin/                             # Executables (if not org-distributed)
│   └── tool-name
├── README.md                        # Documentation
└── LICENSE
```

**Layout rules:**

- `.claude-plugin/` contains ONLY `plugin.json` (not other components)
- Skills/commands/agents/hooks/MCP at plugin ROOT, not inside `.claude-plugin/`
- Single-skill plugins can place `SKILL.md` directly at root (no `skills/` dir)
- `.lsp.json` and `.mcp.json` at plugin root
- `bin/` directory NOT allowed in org-distributed plugins (use `scripts/` with `${CLAUDE_PLUGIN_ROOT}` reference)

---

### 2.2 plugin.json Manifest Schema

**Source:** https://code.claude.com/docs/en/plugins.md + plugins-reference

```json
{
  "name": "my-plugin",
  "displayName": "My Plugin (human-readable)",
  "version": "1.0.0",
  "description": "Brief description shown in plugin manager",
  "author": {
    "name": "Author Name",
    "email": "author@example.com",
    "url": "https://example.com"
  },
  "homepage": "https://github.com/...",
  "repository": {
    "type": "git",
    "url": "https://github.com/..."
  },
  "license": "MIT",
  "category": "development|productivity|integrations",
  "tags": ["tag1", "tag2"],
  "keywords": ["keyword1", "keyword2"],
  "mcpServers": {
    "server-name": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/server-bin",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"]
    }
  },
  "experimental": {
    "evals": "evals/",
    "allowCrossMarketplaceDependencies": ["other-marketplace-name"]
  }
}
```

**Required fields:**

- `name` – Kebab-case, becomes skill namespace prefix

**Optional fields:**

- `version` – Pins plugin updates; omit to auto-use resolved version
- `author`, `homepage`, `repository`, `license` – Attribution and links
- `mcpServers` – MCP server configs (alternative: `.mcp.json`)
- `experimental.evals` – Plugin eval suite directory (default: `evals/`)

---

### 2.3 How Plugins Bundle Components

#### Skills

- Directory: `skills/<skill-name>/SKILL.md`
- Invocation: `/plugin-name:skill-name`
- Namespace prevents conflicts with other plugins

#### Agents (Custom Subagents)

- Directory: `agents/<agent-name>/` with agent definition files
- Enabled via `/context` or declared in `settings.json`

#### Hooks

- Directory: `hooks/hooks.json`
- Format same as project `.claude/settings.json` hooks
- Fires when plugin is enabled

#### MCP Servers

- Configuration: `.mcp.json` at plugin root OR inline in `plugin.json` as `mcpServers` key
- Tools named: `mcp__plugin_<plugin-name>_<server-name>__<tool>`

#### LSP Servers

- Configuration: `.lsp.json` at plugin root
- Provides code intelligence for specific languages

#### Monitors (Background Watchers)

- Configuration: `monitors/monitors.json`
- Runs commands in background, notifies Claude on stdout lines

#### Default Settings

- File: `settings.json` at plugin root
- Supported keys: `agent` (activate custom agent), `subagentStatusLine`
- Takes precedence over plugin.json settings

---

### 2.4 Plugin Marketplaces: Creation and Schema

**Source:** https://code.claude.com/docs/en/plugin-marketplaces.md

#### marketplace.json Structure

```json
{
  "name": "company-tools",
  "owner": {
    "name": "DevTools Team",
    "email": "devtools@example.com",
    "url": "https://example.com"
  },
  "description": "Internal tools and integrations",
  "version": "1.0",
  "metadata": {
    "pluginRoot": "./plugins"
  },
  "plugins": [
    {
      "name": "code-formatter",
      "displayName": "Code Formatter",
      "source": "./plugins/code-formatter",
      "description": "Auto-formatting on save",
      "version": "2.1.0",
      "author": { "name": "..." },
      "homepage": "...",
      "repository": { "type": "git", "url": "..." },
      "license": "MIT",
      "category": "development",
      "tags": ["formatter"],
      "strict": true
    }
  ],
  "renames": {
    "old-plugin-name": "new-plugin-name",
    "removed-plugin": null
  },
  "allowCrossMarketplaceDependenciesOn": ["other-marketplace-name"]
}
```

**Required fields:**

- `name` – Kebab-case marketplace ID
- `owner` (object with `name`, optional `email`, `url`)
- `plugins` (array)

**Plugin entry required fields:**

- `name` – Plugin name
- `source` – Path or source object (see 2.5)

---

### 2.5 Plugin Source Types in Marketplaces

**Source:** https://code.claude.com/docs/en/plugin-marketplaces.md

#### Relative Paths

```json
{
  "source": "./plugins/my-plugin"
}
```

Resolves relative to marketplace root.

#### GitHub

```json
{
  "source": {
    "source": "github",
    "repo": "owner/plugin-repo",
    "ref": "v2.0.0",
    "sha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
  }
}
```

#### Git URL

```json
{
  "source": {
    "source": "url",
    "url": "https://gitlab.com/team/plugin.git",
    "ref": "main",
    "sha": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0"
  }
}
```

#### Git Subdirectory (Sparse Checkout)

```json
{
  "source": {
    "source": "git-subdir",
    "url": "https://github.com/acme-corp/monorepo.git",
    "path": "tools/claude-plugin",
    "ref": "v2.0.0",
    "sha": "..."
  }
}
```

#### npm Package

```json
{
  "source": {
    "source": "npm",
    "package": "@acme/claude-plugin",
    "version": "2.1.0",
    "registry": "https://npm.example.com"
  }
}
```

#### Zip Archive (v2.1.224+)

```json
{
  "source": {
    "source": "archive",
    "url": "https://artifacts.example.com/my-plugin-2.1.0.zip",
    "sha256": "6bfa50e3d2e00c052b46abe51fff89346ac803e45771f76dcf6df1ab74cca5e1"
  }
}
```

#### Command Source (v2.1.229+)

```json
{
  "source": {
    "source": "command",
    "command": "my-tool claude-plugin-path",
    "timeout": 60,
    "mode": "copy|symlink"
  }
}
```

---

### 2.6 Marketplace Hosting and Installation

**User Installation:**

```bash
# GitHub
/plugin marketplace add owner/repo

# Private GitHub with URL
/plugin marketplace add https://github.com/company/plugins.git

# Remote marketplace
/plugin marketplace add https://example.com/marketplace.json

# Local testing
/plugin marketplace add ./path/to/marketplace

# Install plugin from marketplace
/plugin install plugin-name@marketplace-name
```

**Team Distribution (via .claude/settings.json):**

```json
{
  "extraKnownMarketplaces": {
    "company-tools": {
      "source": {
        "source": "github",
        "repo": "your-org/claude-plugins"
      }
    }
  },
  "enabledPlugins": {
    "code-formatter@company-tools": true
  }
}
```

**Organization Settings (Admin Portal):**

- Admin sets marketplace in `claude.ai/admin-settings/plugins`
- Restrictions: Private repo, only github/url/git-subdir/relative sources
- No top-level `bin/` (use `${CLAUDE_PLUGIN_ROOT}/scripts/<name>`)

---

### 2.7 Version Management

- **Explicit `version` field:** Users only receive updates when bumped
- **Omitted `version`:** Claude Code uses commit SHA (git) or archive digest
- **For archives:** SHA-256 digest serves as version if no `version` declared
- **Migration:** `renames` map old names to new names or `null` if removed

---

### 2.8 Plugin Enable/Disable and Scope

- **User scope:** `~/.claude/settings.json` – All projects
- **Project scope:** `.claude/settings.json` (committed) or `.claude/settings.local.json` (gitignored)
- **Managed scope:** Organization admin controls via policy settings (can force-enable/disable)
- **CLI override:** `--plugin-dir ./path` loads local copy for current session only (overrides installed, except forced by policy)

---

## 3. MCP: Server Registration, Naming, and Configuration

### 3.1 MCP Server Registration Methods

**Source:** https://code.claude.com/docs/en/mcp.md

#### Command Line

```bash
# HTTP transport
claude mcp add --transport http notion https://mcp.notion.com/mcp

# SSE transport (deprecated)
claude mcp add --transport sse asana https://mcp.asana.com/sse

# Stdio (local process)
claude mcp add --transport stdio airtable -- npx -y airtable-mcp-server

# WebSocket
claude mcp add-json events-server '{"type":"ws","url":"wss://mcp.example.com/socket"}'
```

#### JSON Direct

```bash
claude mcp add-json weather-api \
  '{"type":"http","url":"https://api.weather.com/mcp"}'
```

#### OAuth Pre-configured

```bash
claude mcp add-json my-server \
  '{"type":"http","url":"https://mcp.example.com/mcp","oauth":{"clientId":"...","callbackPort":8080}}' \
  --client-secret
```

---

### 3.2 .mcp.json Format (Project/Plugin Scope)

**Source:** https://code.claude.com/docs/en/mcp.md

Location: `.mcp.json` at project or plugin root

```json
{
  "mcpServers": {
    "server-name": {
      "type": "http|sse|ws|stdio",
      "url": "https://...",
      "command": "server-binary",
      "args": ["--config", "config.json"],
      "env": {
        "KEY": "value",
        "INHERITED": "${INHERITED_VAR}"
      },
      "headers": {
        "Authorization": "Bearer token",
        "Custom": "${HEADER_VAR}"
      },
      "timeout": 600000,
      "oauth": {
        "clientId": "...",
        "callbackPort": 8080,
        "authServerMetadataUrl": "...",
        "scopes": "..."
      },
      "headersHelper": "/path/to/script.sh"
    }
  }
}
```

**Field definitions:**

- `type` – Transport: http, sse (deprecated), ws, stdio
- `url` – Remote endpoint (http/sse/ws)
- `command` – Binary path (stdio)
- `args` – Command arguments
- `env` – Environment variables (supports `${VAR}` and `${VAR:-default}` expansion)
- `headers` – HTTP headers with env var support
- `timeout` – Milliseconds (default varies by transport)
- `oauth` – OAuth configuration
- `headersHelper` – Script that returns dynamic headers (receives env: `CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL`, `CLAUDE_PLUGIN_ROOT`)

**Path placeholders:**

```
${CLAUDE_PLUGIN_ROOT}    – Plugin installation directory
${CLAUDE_PLUGIN_DATA}    – Plugin persistent state directory
${CLAUDE_PROJECT_DIR}    – Repository root
```

**Environment variable expansion:**

```
${VAR}           – Expands to VAR
${VAR:-default}  – Expands to VAR or "default" if VAR not set
```

---

### 3.3 MCP Tool Naming Convention

**Source:** https://code.claude.com/docs/en/mcp.md

#### Standard Tool Names

```
mcp__<server-name>__<tool-name>
```

**Examples:**

- `mcp__stripe__create_charge`
- `mcp__github__create_pull_request`
- `mcp__notion__query_database`

#### Plugin-Bundled Tool Names

```
mcp__plugin_<plugin-name>_<server-name>__<tool-name>
```

**Characters outside A-Z, a-z, 0-9, \_, and - are replaced with \_:**

- Plugin: `my-plugin`, Server: `database-tools`, Tool: `query`
- Result: `mcp__plugin_my-plugin_database-tools__query`

#### For Permissions and Matchers

- Server registration name: `plugin:my-plugin:database-tools`
- Wildcard: `mcp__plugin_my-plugin_database-tools__.*`
- Tool matcher: Include in `allowed-tools` lists on skills/subagents

---

### 3.4 Installation Scopes

**Source:** https://code.claude.com/docs/en/mcp.md

| Scope                    | Loads In             | Shared?               | Storage            | Precedence    |
| ------------------------ | -------------------- | --------------------- | ------------------ | ------------- |
| **Local**                | Current project only | No                    | `~/.claude.json`   | 1st (highest) |
| **Project**              | Current project only | Yes (via `.mcp.json`) | `.mcp.json`        | 2nd           |
| **User**                 | All user's projects  | No                    | `~/.claude.json`   | 3rd           |
| **Plugin**               | When plugin enabled  | Yes (bundled)         | Plugin `.mcp.json` | 4th           |
| **claude.ai connectors** | All                  | Managed               | Cloud              | 5th (lowest)  |

**CLI to set scope:**

```bash
# Local scope (default)
claude mcp add --transport http stripe https://mcp.stripe.com

# Project scope (committed to .mcp.json)
claude mcp add --transport http shared-server --scope project https://example.com/mcp

# User scope (all projects)
claude mcp add --transport http hubspot --scope user https://mcp.hubspot.com
```

---

### 3.5 Resources and Prompts

**Source:** https://code.claude.com/docs/en/mcp.md

MCP servers can push dynamic capabilities:

- **Dynamic Tool Updates** – `list_changed` notifications for real-time tool/prompt/resource updates
- **Tool Search** – Default: waits for connecting servers inside ToolSearch call
- **Dynamic Loading** – Servers finishing mid-session have tools available on next request
- **Fallback** – Keeps previous tools on transient errors
- **v2 Runtime** – Receives notifications over persistent stream

**Server Status Indicators in `/mcp`:**

- `✔ Connected` – Active and available
- `! Needs authentication` – OAuth required
- `✘ Failed to connect` – Connection error (shows reason)
- `⏸ Pending approval` – Project `.mcp.json` server awaiting trust
- `cached <time> ago` – Loaded from discovery cache, connects on first tool use

---

### 3.6 Tool Constraints and Limits

**Source:** https://code.claude.com/docs/en/mcp.md

```bash
# Set max output tokens (default: 25,000)
MAX_MCP_OUTPUT_TOKENS=50000 claude

# Per-tool character limit in tools/list
{
  "name": "get_schema",
  "_meta": {
    "anthropic/maxResultSizeChars": 200000
  }
}

# User interaction requirement (approval on every call)
{
  "name": "grant_access",
  "_meta": {
    "anthropic/requiresUserInteraction": true
  }
}

# Timeouts
MCP_TIMEOUT=10000 claude                           # Global MCP timeout
MCP_IDLE_TIMEOUT=300000 claude                     # Idle timeout (default 5min HTTP, 30min stdio)
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=120000 claude  # Auto-background threshold (default 2min)
```

---

## 4. SKILLS: Frontmatter, Invocation, and Auto-Trigger

### 4.1 SKILL.md Frontmatter Fields (Complete Reference)

**Source:** https://code.claude.com/docs/en/skills.md

```yaml
---
# Identity
name: skill-display-name
description: "When Claude should use this skill. Use for pattern matching."
when_to_use: "Additional trigger context"

# Control
disable-model-invocation: false # true = only you invoke it, never Claude
user-invocable: true # false = only Claude invokes it
paths: "*.ts,*.js" # Glob patterns for activation trigger

# Execution context
context: fork|inherit # fork = isolated subagent, inherit = same context
agent: Explore|Plan|general-purpose|custom-agent-name
background: false # false = wait for result, true = async (with context: fork)
model: claude-3-7-sonnet # Override session model
effort: low|medium|high|xhigh|max # Override effort level

# Tools
allowed-tools: "Bash(git *),Read" # Pre-approve tools for this skill
disallowed-tools: "AskUserQuestion" # Remove tools while skill active

# Arguments
arguments: [issue, branch] # Named positional arguments
argument-hint: "[issue-number]" # Autocomplete hint

# Shell (for injected commands)
shell: bash|powershell|zsh # Default shell for !` commands

# Hooks & metadata
hooks: { ... } # Advanced: register hooks within skill
metadata:
  custom-key: custom-value


# Advanced
# scripts/ directory at skill root can be referenced by commands
---
# Skill instructions follow frontmatter
```

### 4.2 Auto-Trigger Conditions

**Source:** https://code.claude.com/docs/en/skills.md

Claude automatically invokes a skill when:

1. **Description matches** – Keywords in user prompt align with `description` and `when_to_use`
2. **Not disabled** – `disable-model-invocation: false` (default)
3. **Paths match (if set)** – Working files match skill's `paths` glob patterns
4. **Not hidden** – `user-invocable: false` prevents user invocation (Claude still auto-triggers)

Example trigger:

```yaml
---
name: summarize-changes
description: Summarizes uncommitted changes and flags risks. Use when user asks what changed.
---
```

Triggers on: "What did I change?" or "Review my diff"

---

### 4.3 Skill Directory Structure

**Source:** https://code.claude.com/docs/en/skills.md

```
~/.claude/skills/                    # User scope (all projects)
├── my-skill/
│   ├── SKILL.md
│   ├── reference.md
│   └── scripts/
│       └── helper.py

.claude/skills/                      # Project scope (this repo only)
├── deploy/
│   ├── SKILL.md
│   └── output-styles/

.claude/commands/                    # Legacy (converted to skills)
└── deploy.md
```

**Location Priority (when names conflict):**

1. Enterprise settings
2. Project scope (`.claude/`)
3. User scope (`~/.claude/`)
4. Bundled skills (except aliases)

---

### 4.4 String Substitutions in Skills

**Source:** https://code.claude.com/docs/en/skills.md

Available throughout skill content:

| Variable                | Description                             | Example                                                 |
| ----------------------- | --------------------------------------- | ------------------------------------------------------- |
| `$ARGUMENTS`            | All arguments passed                    | `/fix-issue 123` → `$ARGUMENTS` = `123`                 |
| `$0`, `$1`, ...         | Indexed arguments                       | `/migrate Foo JS TS` → `$0`=`Foo`, `$1`=`JS`, `$2`=`TS` |
| `$name`                 | Named argument (from `arguments` field) | With `arguments: [issue]`: `$issue` is the value        |
| `${CLAUDE_SKILL_DIR}`   | Skill directory path                    | Absolute path to skill folder                           |
| `${CLAUDE_PROJECT_DIR}` | Repository root                         | Absolute path to project                                |
| `${CLAUDE_SESSION_ID}`  | Session ID                              | For logging/correlation                                 |
| `${CLAUDE_EFFORT}`      | Current effort level                    | `low`, `medium`, `high`, `xhigh`, `max`                 |

---

### 4.5 Dynamic Context Injection (Before Claude Sees Skill)

**Source:** https://code.claude.com/docs/en/skills.md

Commands prefixed with `!` run and inject their output:

**Inline form:**

```markdown
## Current changes

!`git diff HEAD`
```

**Multi-line form:**

````markdown
## Environment

```!
node --version
git status --short
```
````

**Rules:**

- Commands run once and replace placeholder
- Non-zero exit codes abort skill invocation
- Exit code 1 from grep/git-diff/etc. counts as success (append `|| true` to expect non-zero)
- Never prompts for permissions
- Not supported in synced skills

---

### 4.6 Bundled Skills (Auto-Loaded)

**Source:** https://code.claude.com/docs/en/skills.md

Available by default (can disable with `disableBundledSkills: true`):

- `/run` – Launch and drive app
- `/verify` – Confirm code changes work
- `/debug` – Debug issues
- `/code-review` – Review code changes
- `/batch` – Run batch operations
- `/doctor` – Setup checkup
- `/loop` – Continuous iteration
- `/skill-doctor` – Usage and context-cost report (early access)
- `/plugin eval` – Plugin evaluation harness (early access)

---

## 5. AGENT SDK and Headless Mode

### 5.1 Headless Mode (claude -p)

**Source:** https://code.claude.com/docs/en/headless.md

Run Claude Code non-interactively:

```bash
claude -p "Find and fix the bug in auth.py"
claude -p "Summarize README.md" --allowedTools "Read"
claude -p --bare "Print the schema" --allowedTools "Read,Bash"
```

#### Key Flags

- **`-p` / `--print`** – Non-interactive mode, output to stdout
- **`--bare`** – Skip auto-discovery of hooks, skills, plugins, MCP, subagents, CLAUDE.md
- **`--continue`** – Continue most recent conversation
- **`--resume <session-id>`** – Continue specific session
- **`--allowedTools <list>`** – Pre-approve tools (comma-separated)
- **`--permission-mode`** – Set mode: auto, acceptEdits, dontAsk
- **`--permission-prompts none`** – Deny anything that would prompt
- **`--output-format text|json|stream-json`** – Output format
- **`--json-schema <schema>`** – Enforce structured output
- **`--append-system-prompt <text>`** – Add instructions

#### Bare Mode Behavior

- Skips: hooks, skills, plugins, MCP servers, subagents, CLAUDE.md, auto-memory
- Still loads: skills from `--add-dir` (only from `.claude/skills/`)
- Requires: `ANTHROPIC_API_KEY` for API auth (keychain not used)
- OAuth: Skipped in bare mode; use API key or headersHelper

#### Output Modes

**Text** (default):

```bash
claude -p "Summarize this project"
```

**JSON** (with metadata):

```bash
claude -p "Summarize this project" --output-format json
# Output: {"result": "...", "session_id": "...", "cost": {...}}
```

**Stream JSON** (real-time tokens):

```bash
claude -p "Explain recursion" --output-format stream-json --verbose
# Each line: {"type": "stream_event", "event": {...}}
```

**Structured Output** (JSON Schema):

```bash
claude -p "Extract function names from auth.py" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"functions":{"type":"array","items":{"type":"string"}}}}'
```

#### Exit Codes

- **0** – Success
- **1** – Failure (load error, no cases, invalid options, gate closed)
- **2** – Partial (cost ceiling hit, credential rejected before first run)
- **130** – Interrupted (SIGINT)
- **143** – Terminated (SIGTERM)

---

### 5.2 Python Agent SDK: Programmatic Hooks API

**Source:** https://code.claude.com/docs/en/agent-sdk/python

#### Installation

```bash
pip install claude-agent-sdk
```

#### Query Signature

```python
async def query(
    *,
    prompt: str | AsyncIterable[dict[str, Any]],
    options: ClaudeAgentOptions | None = None,
    transport: Transport | None = None
) -> AsyncIterator[Message]
```

#### Hook Configuration

```python
from claude_agent_sdk import ClaudeAgentOptions, HookEvent, HookRequest, HookResponse

options = ClaudeAgentOptions(
    hooks={
        HookEvent.PreToolUse: [hook_matcher_callback],
        HookEvent.PostToolUse: [hook_matcher_callback],
    }
)

async def hook_matcher_callback(request: HookRequest) -> HookResponse:
    # request has fields from hook JSON input
    if request.tool_name == "Bash" and "rm -rf" in request.tool_input.get("command", ""):
        return HookResponse(
            behavior="deny",
            permissionDecisionReason="Destructive command blocked"
        )
    return HookResponse(behavior="allow")
```

#### Hook Return Type

```python
class HookResponse(TypedDict):
    behavior: Literal["allow", "ask", "deny"]
    permissionDecisionReason: NotRequired[str]
    updated_input: NotRequired[dict[str, Any]]
```

#### Environment Configuration

```python
options = ClaudeAgentOptions(
    env={
        "API_TIMEOUT_MS": "120000",
        "CLAUDE_CODE_MAX_RETRIES": "2",
        "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS": "120000",
        "CLAUDE_ENABLE_STREAM_WATCHDOG": "1",
        "CLAUDE_STREAM_IDLE_TIMEOUT_MS": "300000",
    }
)
```

#### Permission Callback

```python
from claude_agent_sdk import ToolPermissionContext, PermissionResult, PermissionResultAllow, PermissionResultDeny

async def can_use_tool(
    tool_name: str,
    input_data: dict,
    context: ToolPermissionContext
) -> PermissionResult:
    if tool_name == "Write" and input_data.get("file_path", "").startswith("/system/"):
        return PermissionResultDeny(message="System write denied")
    return PermissionResultAllow(updated_input=input_data)

options = ClaudeAgentOptions(can_use_tool=can_use_tool)
```

---

### 5.3 TypeScript Agent SDK: Programmatic Hooks API

**Source:** https://code.claude.com/docs/en/agent-sdk/typescript

#### Installation

```bash
npm install @anthropic-ai/claude-agent-sdk
```

#### Query Signature

```typescript
function query({
  prompt,
  options,
}: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Options;
}): Query; // extends AsyncGenerator<SDKMessage, void>
```

#### Hook Configuration

```typescript
import { query, HookEvent } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Hello",
  options: {
    hooks: {
      [HookEvent.PreToolUse]: [
        async (request, { signal }) => {
          if (
            request.tool_name === "Bash" &&
            request.tool_input.command.includes("rm -rf")
          ) {
            return {
              behavior: "deny",
              permissionDecisionReason: "Destructive command blocked",
            };
          }
          return { behavior: "allow" };
        },
      ],
    },
    includeHookEvents: true, // Include hook lifecycle in stream
  },
})) {
  console.log(message);
}
```

#### Hook Event Types in Stream

When `includeHookEvents: true`:

- **`SDKHookStartedMessage`** – Hook started
- **`SDKHookProgressMessage`** – Progress (for commands >1s)
- **`SDKHookResponseMessage`** – Hook response

**Note:** SessionStart, Setup, Notification, SessionEnd always emit lifecycle events.

#### Environment Setup

```typescript
const options = {
  env: {
    ...process.env,
    YOUR_VAR: "value",
    CLAUDE_AGENT_SDK_CLIENT_APP: "my-app",
  },
  pathToClaudeCodeExecutable: "/custom/path/to/claude",
  cwd: "/project/root",
};
```

#### Custom Process Spawning

```typescript
import { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

const options = {
  spawnClaudeCodeProcess: (opts: SpawnOptions): SpawnedProcess => {
    // Return custom process for VM/container/remote execution
  },
};
```

---

### 5.4 Agent Loop and Message Types

**Source:** https://code.claude.com/docs/en/agent-sdk/agent-loop + streaming-output

#### Common Message Types in SDK Stream

```typescript
interface SDKMessage {
  type: "user" | "assistant" | "tool_use" | "tool_result" | "system" | "hook_*" | ...
}

// Tool events
interface SDKToolUseMessage {
  type: "tool_use";
  tool_name: string;
  tool_use_id: string;
  input: Record<string, any>;
}

interface SDKToolResultMessage {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// System events
interface SDKSystemMessage {
  type: "system";
  subtype: "init" | "api_retry" | "plugin_install" | ...
}

// Hook events (when includeHookEvents: true)
interface SDKHookStartedMessage {
  type: "hook_started";
  name: string;
}

interface SDKHookProgressMessage {
  type: "hook_progress";
  data: string;
}

interface SDKHookResponseMessage {
  type: "hook_response";
  response: HookResponse;
}
```

---

## Summary: Adapter Design Implications

For your standalone developer plugin spec:

1. **Hook Events** – Use complete event list (1.1); your adapter should map PreToolUse/PostToolUse for file tracking and PreToolUse for context injection
2. **JSON I/O** – Transcript (1.5) is stable JSONL; hook JSON fields (1.2–1.3) are authoritative for decision flow
3. **Plugin Bundling** – Hooks at `plugins/hooks/hooks.json`; MCP tools in `.mcp.json` at plugin root (2.3, 3.2)
4. **Skill Integration** – If injecting context into model via skill, use `allowed-tools` (4.1) and dynamic context injection (4.5)
5. **SDK Portability** – Python/TypeScript SDKs expose same hook callbacks programmatically; headless mode with `-p --bare` skips filesystem hooks (5.1)
6. **Recording Decision** – Use PostToolUse to intercept tool result + additionalContext to inject decision prompt before Stop event

---

## Unconfirmed / Out of Scope

- **PreCompact hook:** Mentioned in TypeScript docs but not detailed in full hooks reference; timing and use case TBD
- **Resource/Prompt pushing by MCP:** Mentioned as supported but no detailed schema provided in fetched docs
- **LSP server detailed schema:** `.lsp.json` format not fully documented in fetched pages
- **Monitor schema (monitors.json):** Basic structure mentioned; full spec not in fetched documentation

---

**Document compiled:** 2026-09-07  
**Last updated:** https://code.claude.com/docs/en/ (docs dated 2026-09-05)
