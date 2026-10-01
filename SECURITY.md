# Security

Context Graph runs as hooks and an MCP server inside Claude Code or Codex. It reads your repository and its git history, and records what agents read and edit under `~/.ctx` on your machine. It sends nothing anywhere unless you configure it to:
- the optional hosted overlay (`[overlay] url`, `[observe] forward = true`);
- an embeddings provider other than the in-process default.

To report a vulnerability, use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability) rather than a public issue. You'll get a reply within a week.

Hooks are a guard rail for agents, not a sandbox: they refuse the edits they recognise as made without context, and don't constrain a person or a process deliberately working around them.
