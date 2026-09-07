---
name: devctx-linear
description: "Sync devctx todos with Linear issues in either direction. Use when the user mentions Linear, or asks to pull issues in or push todos out to their tracker."
---

<!-- Generated from slash-commands/devctx-linear.md by scripts/gen-skills.mjs. Do not edit. -->

Sync Linear issues with devctx todos.

- To configure Linear for this project: call devctx_linear_sync with configure=true
- To sync both ways (default): call devctx_linear_sync
- To pull only from Linear: call devctx_linear_sync with direction="pull"
- To push todos to Linear: call devctx_linear_sync with direction="push"

After syncing, call devctx_todo_list to see todos with their Linear identifiers (e.g. [ENG-42]).

If LINEAR_API_KEY is not set, tell the user to add it to the devctx MCP server's environment:

- Claude Code: the `env` block for devctx in `~/.claude/settings.json`
- Codex: `codex mcp add devctx --env LINEAR_API_KEY=lin_api_... -- node /path/to/devctx/dist/index.js`

Note that Codex's `codex mcp login linear` authenticates Linear's own remote MCP server. devctx talks to the Linear GraphQL API directly and cannot reuse that session, so it needs its own key.
