# devctx — Persistent Memory for Claude Code

Claude Code forgets everything between sessions. Compact the conversation, restart, or come back next week — gone. You re-explain, re-orient, burn tokens rebuilding context that existed five minutes ago.

devctx fixes this. It's an MCP server that logs what you do, tracks what's outstanding, and feeds it all back to Claude automatically when you return. Think of it as a save game for your development session.

**Built with Claude Code. Built for Claude Code.**

## Three problems, one tool

### 1. Context that survives compaction and restarts

devctx writes project state to disk — `.devctx/` in your repo root. Activity logs, branch state, session records, your current focus. When Claude's context window resets, devctx doesn't. It reads fresh from disk on every session start.

### 2. Structured todo tracking

Not comments buried in code. Tracked, prioritised, branch-aware items that Claude can create, update, and complete through the MCP. Tag them, scope them to branches, filter by status. The `/devctx-goodbye` command even suggests new todos based on your session — tagged `[suggested]` so you can promote or dismiss them.

### 3. Stale project recovery

You haven't touched a project in three weeks. You've completely lost mental context. Run `/devctx-status` and Claude tells you what you were doing, what's outstanding, what state the branches are in. It reads your session history, git log, todos, and branch notes to reconstruct the picture. No re-explanation needed.

## Dashboard

devctx includes a web dashboard that visualises your project state in the browser. Activity logs, todos, git status, session history — all drawn from the same `.devctx` data the MCP reads.

```bash
node dist/dashboard/cli.js
# Opens localhost:3333
```

Flags: `--port`, `--no-open`, `--dev`. Ctrl+C to stop.

## How it works

devctx runs as a **global MCP server** that's **project-scoped**. One installation, per-repo state. It detects which git repo you're in and maintains a `.devctx/` directory there.

It syncs key state to your `CLAUDE.md` between markers — focus, branch, active todos — so Claude has context before any tool is called. Everything outside the markers is untouched.

### Git hooks (passive capture)

During init, devctx installs four hooks into `.git/hooks/`:

| Hook | What it logs |
|------|-------------|
| `post-commit` | Every commit (hash, subject, author) |
| `post-checkout` | Branch switches |
| `post-merge` | Merges |
| `pre-push` | Pushes |

These fire from any terminal, not just Claude Code. Ambient context capture. They append to `.devctx/activity.log` silently, fail silently, and never block a git operation.

### Auto-session-start

The first devctx tool call in any new conversation automatically resumes tracking, logs a `session_start` entry, and prepends a greeting with your current focus, branch, and outstanding todos.

### Goodbye (session wrap-up)

```
/devctx-goodbye picking this up Thursday, blocked on API key from Dave
```

The save button. Goodbye gathers your commits, activity, git status, and todos, then generates a session record with three sections: what happened, what's unfinished, and suggested next steps. It saves the record to `.devctx/sessions/`, auto-adds suggested todos, syncs CLAUDE.md, commits it, and pauses tracking.

Next time you open the project, `/devctx-status` reads this file to tell you where you left off.

### Source TODO scanning

devctx scans your codebase for `TODO`, `FIXME`, `HACK`, and `XXX` comments during init and goodbye. It diffs the results across sessions so you can see which code TODOs were added or resolved. Supports 26+ file extensions across all common languages.

### AI narrative

When you have an `ANTHROPIC_API_KEY` set, status and goodbye commands call `claude-sonnet-4-20250514` to generate a prose summary of your session — recent work, deploy status, prioritised next steps. Token limits are conservative (600 for status, 1200 for goodbye). Without the key, you get a deterministic fallback that's still useful.

## Tools (18)

| Tool | Type | Description |
|------|------|-------------|
| `devctx_init` | meta | Initialise for a project (scans language/framework, installs git hooks) |
| `devctx_start` | meta | Resume tracking after pause |
| `devctx_stop` | meta | Pause tracking (reads still work) |
| `devctx_goodbye` | meta | Session wrap-up — AI summary, auto-todos, pause |
| `devctx_status` | read | Full dashboard with branches, todos, vitals, AI narrative |
| `devctx_summary` | read | AI-generated narrative only |
| `devctx_whereami` | read | Full project context dump |
| `devctx_update_focus` | write | Set current focus → syncs to CLAUDE.md |
| `devctx_log` | write | Log commits, pushes, builds, deploys, milestones, merges |
| `devctx_activity` | read | View activity log, filter by type |
| `devctx_todo_add` | write | Add todo with priority, branch scope, tags |
| `devctx_todo_update` | write | Change todo status, priority, text |
| `devctx_todo_list` | read | List todos, filter by branch or status |
| `devctx_todo_remove` | write | Remove a todo by ID |
| `devctx_branch_notes` | read | Get per-branch markdown notes |
| `devctx_branch_notes_save` | write | Save per-branch documentation |
| `devctx_git` | read/write | Git operations with auto-logging |
| `devctx_sync` | write | Force sync state → CLAUDE.md |

Write tools respect the active/paused state. Read tools always work.

## Slash commands

Copy to your global commands directory:

```bash
cp slash-commands/*.md ~/.claude/commands/
```

| Command | Purpose |
|---------|---------|
| `/devctx-init` | Initialise for current project |
| `/devctx-status` | Full dashboard with AI recap |
| `/devctx-summary` | AI narrative only |
| `/devctx-whereami` | Complete context dump |
| `/devctx-start` | Resume tracking |
| `/devctx-stop` | Pause tracking |
| `/devctx-goodbye` | Session wrap-up |
| `/devctx-focus` | Set current focus |
| `/devctx-todos` | Manage todos |
| `/devctx-git` | Git operations with logging |
| `/devctx-help` | Show available commands |

## Installation

```bash
git clone https://github.com/tmattoneill/devctx.git
cd devctx
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add devctx node /absolute/path/to/devctx/dist/index.js
```

To enable AI narrative summaries, add your API key:

```bash
claude mcp add devctx node /absolute/path/to/devctx/dist/index.js -e ANTHROPIC_API_KEY=sk-ant-...
```

Verify it's connected:

```bash
claude mcp list
```

Without the API key everything works — the summaries just use a deterministic fallback.

### Permissions

Allow all devctx tools at the system level to avoid per-call prompts:

```bash
/permissions
# Add: mcp__devctx
```

devctx never modifies source code, runs arbitrary shell commands, or accesses the network (except the optional AI narrative).

## Getting started

Run `/devctx-init` in any directory. devctx detects your situation:

**New directory** — initialises git, creates `.devctx/`, installs hooks, makes first commit.

**Existing files, no git** — scans your project (language, frameworks, build tools, CI/CD, infra), initialises git, creates `.devctx/` with detected metadata.

**Existing git repo** — scans the project, creates `.devctx/`, installs hooks, picks up existing branches and remote info.

**Already initialised** — shows current state. Pass `force: true` to re-scan (preserves todos, logs, notes).

The scanner detects languages (JS, TS, Python, Rust, Go, Java, and more), frameworks (Next.js, React, Vue, Express, FastAPI, Django, and others), build tools, CI/CD pipelines, and infrastructure config. It pulls project metadata from package.json, Cargo.toml, pyproject.toml, or go.mod.

## Day-to-day

```
> I'm working on the payment integration
```
Updates focus, syncs to CLAUDE.md.

```
> Add a high priority todo: fix the race condition in the webhook handler
> Mark todo_abc123 as done
> Show me blocked todos
```

```
> Save notes for this branch: implementing OAuth2 PKCE, refresh tokens in httpOnly cookies
```

```
> Log a deployment: v2.3.1 pushed to production
```

```
> /devctx-goodbye done for the day, picking up auth flow tomorrow
```

## File structure

```
your-project/
├── .devctx/                  # Auto-created, gitignored
│   ├── state.json            # Project metadata, focus, active flag
│   ├── activity.log          # JSONL, append-only (also written by git hooks)
│   ├── todos.json            # Tracked todos with source tagging
│   ├── source-todos.json     # Last source code TODO scan
│   ├── sessions/             # Session records from goodbye
│   └── branches/             # Per-branch notes
├── CLAUDE.md                 # Synced with devctx section between markers
└── ...
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | AI narrative generation |
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `zod` | Input validation |
| `fastify` | Dashboard HTTP server |
| `react` | Dashboard frontend |
| `vite` | Dashboard build tooling |

## Free and open source

devctx is MIT licensed. Clone it, use it, fork it.

https://github.com/tmattoneill/devctx
