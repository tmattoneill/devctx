Sync Linear issues with devctx todos.

- To configure Linear for this project: call devctx_linear_sync with configure=true
- To sync both ways (default): call devctx_linear_sync
- To pull only from Linear: call devctx_linear_sync with direction="pull"
- To push todos to Linear: call devctx_linear_sync with direction="push"

After syncing, call devctx_todo_list to see todos with their Linear identifiers (e.g. [ENG-42]).

If LINEAR_API_KEY is not set, inform the user to add it to their environment or Claude Code MCP env config.
