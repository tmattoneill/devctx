Help me set up the devctx status line for Claude Code. The devctx MCP server writes a `.devctx/statusline.json` cache file that a status line script reads to show project context in the terminal.

**What to do:**

1. Find the path to `devctx-statusline.sh`. It ships with the devctx-mcp-server package. Check:
   - If installed globally via npm: `$(npm root -g)/devctx-mcp-server/statusline/devctx-statusline.sh`
   - If local (this repo): the `statusline/devctx-statusline.sh` file in the project root

2. Read the user's `~/.claude/settings.json` file.

3. Add (or update) the `statusLine` entry:
   ```json
   "statusLine": {
     "type": "command",
     "command": "/absolute/path/to/devctx-statusline.sh"
   }
   ```

4. Tell the user to restart Claude Code to pick up the change.

**Requirements:**
- The script requires `jq` to be installed (`brew install jq` on macOS)
- The status line shows: project name, branch, focus, todo count (with high-priority highlight), time since last commit, model, cost, and context %
- If the user already has a status line configured, ask before replacing it

**What the status line shows:**
```
devctx  ⌥main  🎯 Fixing duplicate todos  📋 3!/10  ⏱ 3m  ✱ Opus 4.6  $1.24  42%
```
