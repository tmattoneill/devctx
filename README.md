# devctx — Development Context Tracker for Claude Code

A project-aware development context MCP server. Part logger, part project manager, part git companion.

devctx runs as a **global MCP server** that's **project-scoped** — it detects which git repo you're in and maintains per-project state. It logs activity, tracks todos, keeps per-branch notes, and syncs everything to your `CLAUDE.md` so Claude Code always has context.

## Tools (18)

| Tool | Type | Description |
|------|------|-------------|
| `devctx_init` | meta | Initialize devctx for a project (installs git hooks, safe on existing projects) |
| `devctx_start` | meta | Resume tracking after pause |
| `devctx_stop` | meta | Pause tracking (reads still work) |
| `devctx_goodbye` | meta | Session wrap-up — AI summary, auto-todos, pause tracking |
| `devctx_status` | read | Full dashboard with branches, todos, vitals + AI narrative |
| `devctx_summary` | read | AI-generated narrative only (last session, state, next steps) |
| `devctx_whereami` | read | Full project context dump |
| `devctx_update_focus` | write | Set what you're working on → syncs to CLAUDE.md |
| `devctx_log` | write | Log commits, pushes, builds, deploys, milestones, merges, branch switches |
| `devctx_activity` | read | View the activity log, filter by type |
| `devctx_todo_add` | write | Add todo with priority, branch scope, tags |
| `devctx_todo_update` | write | Change todo status, priority, text |
| `devctx_todo_list` | read | List todos, filter by branch or status |
| `devctx_todo_remove` | write | Remove a todo by ID |
| `devctx_branch_notes` | read | Get per-branch markdown notes |
| `devctx_branch_notes_save` | write | Save per-branch documentation |
| `devctx_git` | read/write | Git operations with auto-logging (commit, push, pull, checkout, merge, stash) or read-only summary |
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

> **ANTHROPIC_API_KEY** enables the AI narrative summary in `devctx_status`, `devctx_summary`, and `devctx_goodbye`. Without it, you get a deterministic fallback that's still useful — just less eloquent. The key is used to call `claude-sonnet-4-20250514` with conservative token limits (600 for status/summary, 1200 for goodbye) — typically fractions of a cent per call.

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

### Permissions

devctx tools read/write to `.devctx/` (gitignored) and `CLAUDE.md` in your project. Since these are local file operations and the MCP server is trusted, you'll want to allow its tools so Claude Code doesn't prompt you on every call.

**Recommended: allow all devctx tools at the system level** (since devctx is a global MCP server used across all projects):

```bash
# In Claude Code, run:
/permissions

# Then add:
# Allow: mcp__devctx  (allows all devctx_* tools)
```

Or add to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__devctx__devctx_init",
      "mcp__devctx__devctx_start",
      "mcp__devctx__devctx_stop",
      "mcp__devctx__devctx_goodbye",
      "mcp__devctx__devctx_status",
      "mcp__devctx__devctx_summary",
      "mcp__devctx__devctx_whereami",
      "mcp__devctx__devctx_update_focus",
      "mcp__devctx__devctx_log",
      "mcp__devctx__devctx_activity",
      "mcp__devctx__devctx_todo_add",
      "mcp__devctx__devctx_todo_update",
      "mcp__devctx__devctx_todo_list",
      "mcp__devctx__devctx_todo_remove",
      "mcp__devctx__devctx_branch_notes",
      "mcp__devctx__devctx_branch_notes_save",
      "mcp__devctx__devctx_git",
      "mcp__devctx__devctx_sync"
    ]
  }
}
```

Alternatively, if you prefer per-project control, add the same permissions to your project's `.claude/settings.json` instead.

> **Why system-level?** devctx only touches `.devctx/` (gitignored) and the `<!-- DEVCTX -->` markers in `CLAUDE.md`. It never modifies source code, runs shell commands, or accesses the network (except the optional AI narrative via `ANTHROPIC_API_KEY`). Allowing it globally avoids repetitive permission prompts across projects.

### Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | AI narrative generation (status, summary, goodbye) |
| `@modelcontextprotocol/sdk` | MCP protocol server implementation |
| `zod` | Input schema validation for all 18 tools |

### Slash Commands (optional but recommended)

Copy the included slash commands to your global Claude Code commands directory:

```bash
cp slash-commands/*.md ~/.claude/commands/
```

This gives you 11 slash commands:

| Command | What it does |
|---------|-------------|
| `/devctx-init` | Initialize devctx for the current project — scans language/framework, creates `.devctx/`, installs git hooks, syncs CLAUDE.md |
| `/devctx-status` | Full dashboard: branches, todos, vitals, working tree + AI narrative recap of your last session |
| `/devctx-summary` | Standalone AI narrative — recaps last session, current state, prioritized next steps |
| `/devctx-whereami` | Complete project context dump — branch, status, recent commits, todos, activity log, branch notes |
| `/devctx-start` | Resume tracking after a pause — re-enables logging and shows where you left off |
| `/devctx-stop` | Pause all write operations — reads still work, nothing is deleted |
| `/devctx-goodbye` | End-of-session wrap-up — generates AI summary, saves session record, auto-adds suggested todos, pauses tracking |
| `/devctx-focus` | Set your current working focus (e.g., "building payment integration") — updates CLAUDE.md |
| `/devctx-todos` | View, add, update, or filter todos by branch/status/priority |
| `/devctx-git` | Git operations with auto-logging, or read-only summary. Supports commit, push, pull, checkout, merge, stash |
| `/devctx-help` | Show available slash commands and how devctx works |

## Getting Started

Run `/devctx-init` in any directory. devctx auto-detects your situation:

### Empty directory (new project)

```
> /devctx-init
```

devctx will:
1. Initialize a git repo (`main` branch)
2. Create `.devctx/` structure (auto-gitignored)
3. Install git hooks for passive activity capture
4. Create an initial commit
5. Skip CLAUDE.md (nothing to document yet)

You're ready to start coding immediately.

### Existing files, no git

```
> /devctx-init
```

devctx will:
1. **Scan the project** — auto-detects language, frameworks, build tools, CI/CD, infra
2. Initialize a git repo
3. Create `.devctx/` with detected metadata (name, description from package.json/Cargo.toml/etc.)
4. Install git hooks
5. Create an initial commit with all existing files
6. Write context to CLAUDE.md

### Existing git repo

```
> /devctx-init
```

devctx will:
1. **Scan the project** — same detection as above
2. Create `.devctx/` (auto-gitignored)
3. Install git hooks into `.git/hooks/`
4. Pick up existing branches, commits, remote info
5. Write context to CLAUDE.md

### Already initialized

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

### Source Code TODO Scanning

During `devctx_init` (and again during `devctx_goodbye`), devctx scans your source files for inline TODO comments.

**Tags detected:** `TODO`, `FIXME`, `HACK`, `XXX`

**Supported file extensions (26+):** `.ts`, `.tsx`, `.js`, `.jsx`, `.py`, `.rs`, `.go`, `.java`, `.kt`, `.c`, `.cpp`, `.h`, `.hpp`, `.cs`, `.rb`, `.sh`, `.yaml`, `.yml`, `.toml`, `.md`, `.html`, `.css`, `.scss`, `.svelte`, `.vue`, `.swift`, `.zig`

**Scan limits:**
- Max directory depth: 5
- Max files scanned: 500
- Max lines per file: 10,000

**Skipped directories:** `node_modules`, `__pycache__`, `dist`, `build`, `target`, `.devctx`, `.git`, `vendor`, `.next`, `.nuxt`, `coverage`, `.turbo`

Results are saved to `.devctx/source-todos.json`. During goodbye, the current scan is diffed against the previous one to show which TODOs were added or resolved during the session.

## Session Intelligence

### Git Hooks (passive capture)

During `devctx_init`, devctx installs four git hooks into `.git/hooks/`:

| Hook | Activity logged |
|------|----------------|
| `post-commit` | Every commit (hash, subject, author) |
| `post-checkout` | Branch switches (from/to branch) |
| `post-merge` | Merges (squash flag) |
| `pre-push` | Pushes (remote name) |

Hooks fire from **any terminal**, not just Claude Code — giving ambient context capture. They append JSON entries to `.devctx/activity.log` silently.

- POSIX-compatible (`/bin/sh`) — works on macOS and Linux
- Fail silently — never block a git operation
- Marker-based — existing user hooks are preserved, devctx sections are replaceable
- Idempotent — re-running `devctx_init` updates hooks without duplication
- Skip-aware — hooks check `DEVCTX_SKIP_HOOKS` and exit early when `devctx_git` is the caller, preventing duplicate log entries

### Git Operations (`devctx_git`)

Beyond passive hook capture, `devctx_git` lets Claude Code execute git operations directly — with automatic activity logging so the dashboard and session records stay accurate.

```
> Commit these changes with message "Add payment handler"
> Push to origin
> Create and switch to feature/webhooks
> Merge feature/webhooks into main with --no-ff
> Stash my current changes
```

| Command | Parameters | Notes |
|---------|-----------|-------|
| `commit` | `message` (required), `files` (optional) | Stages specific files or commits what's staged |
| `push` | `remote`, `force` | Uses `--force-with-lease` (never raw `--force`) |
| `pull` | `remote`, `rebase` | Supports `--rebase` |
| `checkout` | `branch` (required), `create` | `-b` for new branches |
| `merge` | `branch` (required), `no_ff`, `squash` | `--no-ff` and `--squash` flags |
| `stash` | `action` (push/pop/list/drop), `message` | Default action is push |
| `status` | `branch`, `commit_count` | Read-only summary (same as omitting command) |

Called with no command (or `"status"`), `devctx_git` returns a read-only summary (branches, commits, status) — same as the old `devctx_git_summary`.

Operations set `DEVCTX_SKIP_HOOKS=1` in the environment so git hooks don't double-log activity that `devctx_git` already logs itself. Branch names are validated against a strict pattern to prevent shell injection.

### Auto-Session-Start

When Claude Code first calls any devctx tool in a new conversation, devctx automatically:

1. **Resumes tracking** if it was paused (a new MCP process means a new Claude Code session)
2. **Logs a `session_start` entry** — fires exactly once per MCP server process, giving goodbye a reliable start timestamp
3. **Builds a session greeting** prepended to the first tool response, showing:
   - Current focus
   - Current branch
   - Whether tracking was resumed from a paused state
   - Count of suggested todos from the last goodbye session
   - Reminder to use `/devctx-goodbye` when done

Additionally, the `CLAUDE.md` sync includes an instruction telling Claude to greet the user with a brief summary of the project context (focus, branch, active todos) when starting a new conversation. This ensures context continuity even before any devctx tool is called.

### Goodbye (Session Wrap-Up)

```
> /devctx-goodbye
```

or with a parting note:

```
> /devctx-goodbye picking this up Thursday, blocked on API key from Dave
```

The "save game" button. When you're done for the day, goodbye:

1. **Gathers context** — commits, activity log, git status, branches, todos, CLAUDE.md
2. **Generates an AI session record** with three sections:
   - **What happened** — detailed narrative referencing specific commits and files
   - **Unfinished work** — uncommitted changes, WIP branches, ahead/behind status
   - **Suggested next steps** — 3-7 actionable items inferred from the session
3. **Saves to** `.devctx/sessions/{datetime}.md` — persistent session records
4. **Auto-adds suggested todos** — tagged as `[suggested]` so you can promote or dismiss them
5. **Logs** `session_end` and **pauses tracking**
6. **Syncs** CLAUDE.md with latest state
7. **Auto-commits** `CLAUDE.md` with message `"devctx: session goodbye"` and **attempts a push** (fails silently if offline or no remote)

Next time you open the project, `/devctx-status` reads the most recent session file to generate a richer "Previously on..." narrative.

### Source TODO Tracking in Goodbye

During goodbye, devctx re-scans your source code for TODO/FIXME/HACK/XXX comments and diffs the results against the previous scan (saved during init or the last goodbye). The session record includes:

- **New code TODOs added** this session (with file, line, and tag)
- **Code TODOs resolved** this session (present in the previous scan but no longer found)

This gives you a clear picture of technical debt movement per session without any manual tracking.

### Todo Source Tagging

Todos created by `devctx_goodbye` are tagged as `[suggested]` in the dashboard and todo list, visually distinguishing them from manually-created todos. This lets you quickly identify AI-generated items and decide whether to keep or dismiss them.

## Returning to a project

```
> /devctx-status
```

Full dashboard with AI narrative recap, branches, todos, vitals. If a goodbye session record exists, the narrative incorporates it for a richer cold open.

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
Updates focus, syncs to CLAUDE.md

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
devctx ▶ ACTIVE ── my-awesome-app
══════════════════════════════════════════════════════════════

You worked on the OAuth2 PKCE implementation yesterday,
committing the login page and flow handler on feature/auth.
Changes were pushed and built clean, and v2.3.1 was deployed
to production with all health checks passing.

Next steps:
  🔴 Fix race condition in webhook handler
  🟠 Add Stripe webhook signature verification
  🟡 Write API documentation for /payments

──────────────────────────────────────────────────────────────
...rest of dashboard...
```

The narrative is generated by calling **`claude-sonnet-4-20250514`** via the Anthropic API (`@anthropic-ai/sdk`). It reads your recent commits, activity log, todos, branch notes, and current focus to write a ~150 word summary. Token limits are conservative: **600 max tokens** for status/summary, **1200** for goodbye session records. Typical cost is fractions of a cent per call.

**Without an API key**, you get a deterministic fallback that still lists recent work, deploy status, and prioritized next steps — just without the prose.

To disable the narrative on a per-call basis, pass `narrative: false` to `devctx_status`.

## How CLAUDE.md Integration Works

devctx manages a section in your `CLAUDE.md` between markers:

```markdown
<!-- DEVCTX:START -->
## Project Context (auto-updated by devctx)

**Current Focus:** Building the payment integration
**Branch:** `feature/payments`
**Last Updated:** 2/15/2026, 3:45:00 PM

### Active Todos
- 🔄 🔴 Fix race condition in webhook handler (`feature/payments`)
- ⬜ 🟠 Add Stripe webhook signature verification (`feature/payments`)
<!-- DEVCTX:END -->
```

Everything outside the markers is untouched. Your existing CLAUDE.md content is preserved.

### Project Context Greeting

The synced CLAUDE.md section includes an embedded instruction:

> **IMPORTANT:** When starting a new conversation, greet the user with a brief summary of the project context below — current focus, branch, and any active todos. Keep it to 2-3 sentences. Do not skip this greeting.

This ensures Claude Code greets you with project context at the start of every conversation, even before any devctx tool is called. The greeting is driven entirely by the CLAUDE.md content — no tool call required.

## File Structure (per project)

```
your-project/
├── .devctx/              # Auto-created, gitignored
│   ├── state.json        # Project name, description, focus, active flag
│   ├── activity.log      # JSONL activity log (append-only, also written by git hooks)
│   ├── todos.json        # Todo items (with source tagging: manual/suggested)
│   ├── source-todos.json # Last source code TODO scan (for diffing across sessions)
│   ├── sessions/         # Session records from devctx_goodbye
│   │   ├── 2026-02-14T18-30-00.md
│   │   └── 2026-02-15T17-00-00.md
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
- **Activity log** is append-only JSONL — easy to parse, never loses data. Git hooks also write to it
- **Todos persist across branches** unless you scope them to a specific branch
- **Re-initializing** is safe — it detects existing state and won't overwrite unless you pass `force: true`
- **Git hooks are non-destructive** — they append to existing hooks using marker comments, never clobber
- **Session records accumulate** in `.devctx/sessions/` and are never auto-deleted
