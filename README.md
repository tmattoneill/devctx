# 🎮 devctx — Development Context Tracker for Claude Code

A project-aware development context MCP server. Part logger, part project manager, part git companion.

devctx runs as a **global MCP server** that's **project-scoped** — it detects which git repo you're in and maintains per-project state. It logs activity, tracks todos, keeps per-branch notes, and syncs everything to your `CLAUDE.md` so Claude Code always has context.

## Tools (17)

| Tool | Type | Description |
|------|------|-------------|
| `devctx_init` | meta | Initialize devctx for a project (safe on existing projects) |
| `devctx_start` | meta | Resume tracking after pause |
| `devctx_stop` | meta | Pause tracking (reads still work) |
| `devctx_status` | read | Full dashboard with branches, todos, vitals + AI narrative |
| `devctx_summary` | read | AI-generated narrative only (last session, state, next steps) |
| `devctx_whereami` | read | Full project context dump |
| `devctx_update_focus` | write | Set what you're working on → syncs to CLAUDE.md |
| `devctx_log` | write | Log commits, pushes, builds, deploys, milestones |
| `devctx_activity` | read | View the activity log, filter by type |
| `devctx_todo_add` | write | Add todo with priority, branch scope, tags |
| `devctx_todo_update` | write | Change todo status, priority, text |
| `devctx_todo_list` | read | List todos, filter by branch or status |
| `devctx_todo_remove` | write | Remove a todo by ID |
| `devctx_branch_notes` | read | Get per-branch markdown notes |
| `devctx_branch_notes_save` | write | Save per-branch documentation |
| `devctx_git_summary` | read | Git-focused view (branches, commits, push status) |
| `devctx_sync` | write | Force sync state → CLAUDE.md |

**Write tools** respect the active/paused state. **Read tools** always work.

## Installation

```bash
# Clone or copy this directory
cd devctx-mcp-server

# Install and build
npm install
npm run build

# Optional: install globally for easy path reference
npm link
```

### Claude Code MCP Config

Add to your **global** Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "devctx": {
      "command": "node",
      "args": ["/absolute/path/to/devctx-mcp-server/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

> **ANTHROPIC_API_KEY** enables the AI narrative summary in `devctx_status` and `devctx_summary`. Without it, you get a deterministic fallback that's still useful — just less eloquent. The key is used to call Claude Sonnet for ~150-word summaries (very low token cost).

Or if you used `npm link`:

```json
{
  "mcpServers": {
    "devctx": {
      "command": "devctx-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

### Slash Commands (optional but recommended)

Copy the included slash commands to your global Claude Code commands directory:

```bash
cp slash-commands/*.md ~/.claude/commands/
```

This gives you:

| Command | What it does |
|---------|-------------|
| `/devctx-init` | Initialize devctx for the current project |
| `/devctx-status` | Full dashboard with AI narrative |
| `/devctx-summary` | Just the AI narrative summary |
| `/devctx-whereami` | Full project context overview |
| `/devctx-start` | Resume tracking + show where you left off |
| `/devctx-stop` | Pause tracking |
| `/devctx-focus` | Update what you're working on |
| `/devctx-todos` | View/manage todos |
| `/devctx-git` | Git summary |

## Getting Started

Run `/devctx-init` in any directory. devctx auto-detects your situation:

### 📂 Empty directory (new project)

```
> /devctx-init
```

devctx will:
1. Initialize a git repo (`main` branch)
2. Create `.devctx/` structure (auto-gitignored)
3. Create an initial commit
4. Skip CLAUDE.md (nothing to document yet)

You're ready to start coding immediately.

### 📁 Existing files, no git

```
> /devctx-init
```

devctx will:
1. **Scan the project** — auto-detects language, frameworks, build tools, CI/CD, infra
2. Initialize a git repo
3. Create `.devctx/` with detected metadata (name, description from package.json/Cargo.toml/etc.)
4. Create an initial commit with all existing files
5. Write context to CLAUDE.md

### 🔀 Existing git repo

```
> /devctx-init
```

devctx will:
1. **Scan the project** — same detection as above
2. Create `.devctx/` (auto-gitignored)
3. Pick up existing branches, commits, remote info
4. Write context to CLAUDE.md

### ✅ Already initialized

```
> /devctx-init
```

Shows current state and exits. Use `force: true` to re-scan and update metadata (preserves todos, activity log, branch notes).

### What the scanner detects

| Category | Examples |
|----------|---------|
| **Languages** | JavaScript, TypeScript, Python, Rust, Go, Java, Kotlin, C/C++ |
| **Frameworks** | Next.js, React, Vue, Angular, Svelte, Express, FastAPI, Django, Flask |
| **Build tools** | npm, pnpm, Yarn, Bun, Vite, Webpack, Cargo, Make, Maven, Gradle, Poetry, uv |
| **CI/CD** | GitHub Actions, GitLab CI, Jenkins, CircleCI, Travis, Bitbucket Pipelines |
| **Infrastructure** | Docker, Vercel, Netlify, Fly.io, Serverless, Terraform, Kubernetes, Railway |
| **Metadata** | Name + description from package.json, Cargo.toml, pyproject.toml, go.mod |

### Returning to a project

```
> /devctx-status
```

Full dashboard with AI narrative recap, branches, todos, vitals. The go-to command when picking up where you left off.

### Pausing / resuming

```
> /devctx-stop
```
Pauses all write operations. You can still read your project state (whereami, todos, git summary). Nothing is deleted.

```
> /devctx-start
```
Resumes tracking and shows where you left off.

### Day-to-day usage

```
> I'm now working on the payment integration
```
→ Updates focus, syncs to CLAUDE.md

```
> Add a high priority todo: fix the race condition in the webhook handler
> Mark todo_abc123 as done
> Show me blocked todos
```

```
> Save notes for this branch: implementing OAuth2 PKCE, using passport.js, refresh tokens in httpOnly cookies
```

```
> Log a deployment: v2.3.1 pushed to production, all health checks passing
```

## AI Narrative Summary

When you run `/devctx-status` or `/devctx-summary`, devctx generates a narrative recap at the top of the dashboard:

```
╔══════════════════════════════════════════════════════════════════╗
║   devctx ▶ ACTIVE                                 my-awesome-app ║
╠══════════════════════════════════════════════════════════════════╣
║                                                                  ║
║ You worked on the OAuth2 PKCE implementation yesterday,          ║
║ committing the login page and flow handler on feature/auth.      ║
║ Changes were pushed and built clean, and v2.3.1 was deployed     ║
║ to production with all health checks passing.                    ║
║                                                                  ║
║ Next steps:                                                      ║
║   🔴 Fix race condition in webhook handler                       ║
║   🟠 Add Stripe webhook signature verification                   ║
║   🟡 Write API documentation for /payments                       ║
║                                                                  ║
╠══════════════════════════════════════════════════════════════════╣
║ ...rest of dashboard...                                          ║
```

The narrative is generated by calling **Claude Sonnet** via the Anthropic API. It reads your recent commits, activity log, todos, branch notes, and current focus to write a ~150 word summary. Costs fractions of a cent per call.

**Without an API key**, you get a deterministic fallback that still lists recent work, deploy status, and prioritized next steps — just without the prose.

To disable the narrative on a per-call basis, pass `narrative: false` to `devctx_status`.

## How CLAUDE.md Integration Works

devctx manages a section in your `CLAUDE.md` between markers:

```markdown
<!-- DEVCTX:START -->
## 🔍 Project Context (auto-updated by devctx)

**Current Focus:** Building the payment integration
**Branch:** `feature/payments`
**Last Updated:** 2/15/2026, 3:45:00 PM

### Active Todos
- 🔄 🔴 Fix race condition in webhook handler (`feature/payments`)
- ⬜ 🟠 Add Stripe webhook signature verification (`feature/payments`)
<!-- DEVCTX:END -->
```

Everything outside the markers is untouched. Your existing CLAUDE.md content is preserved.

## File Structure (per project)

```
your-project/
├── .devctx/              # Auto-created, gitignored
│   ├── state.json        # Project name, description, focus, active flag
│   ├── activity.log      # JSONL activity log (append-only)
│   ├── todos.json        # Todo items
│   └── branches/         # Per-branch notes
│       ├── main.md
│       ├── feature__auth.md
│       └── fix__bug-123.md
├── CLAUDE.md             # Updated with devctx section
└── ...
```

## Tips

- **Global install, project-scoped state** — one MCP server config, per-repo `.devctx/` directories
- **Start/stop is per-project** — pausing in one repo doesn't affect others
- **CLAUDE.md syncing** is on by default for focus and todo changes. Pass `sync_claude_md: false` to skip
- **Branch notes** use `__` for path separators (`feature/auth` → `feature__auth.md`)
- **Activity log** is append-only JSONL — easy to parse, never loses data
- **Todos persist across branches** unless you scope them to a specific branch
- **Re-initializing** is safe — it detects existing state and won't overwrite unless you pass `force: true`
