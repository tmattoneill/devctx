# devctx — Persistent Memory for Coding Agents

Coding agents forget everything between sessions. Compact the conversation, restart, or come back next week and it's gone. You re-explain, re-orient, and burn tokens rebuilding context that existed five minutes ago.

devctx fixes this. It's an MCP server that logs what you do, tracks what's outstanding, and feeds it all back automatically when you return. Think of it as a save game for your development session.

**Works with Claude Code and Codex.** Both speak MCP over stdio, so the same server serves both. Claude Code gets slash commands and a status line; Codex gets skills. The tracked state in `.devctx/` is identical either way.

## Three problems, one tool

### 1. Context that survives compaction and restarts

devctx writes project state to disk — `.devctx/` in your repo root. Activity logs, branch state, session records, your current focus. When Claude's context window resets, devctx doesn't. It reads fresh from disk on every session start.

### 2. Structured todo tracking

Not comments buried in code. Tracked, prioritised, branch-aware items that Claude can create, update, and complete through the MCP. Tag them, scope them to branches, filter by status. The `devctx-goodbye` command even suggests new todos based on your session — tagged `[suggested]` so you can promote or dismiss them.

### 3. Stale project recovery

You haven't touched a project in three weeks. You've completely lost mental context. Run `devctx-status` and your agent tells you what you were doing, what's outstanding, what state the branches are in. It reads your session history, git log, todos, and branch notes to reconstruct the picture. No re-explanation needed.

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

Next time you open the project, `devctx-status` reads this file to tell you where you left off.

### Source TODO scanning

devctx scans your codebase for `TODO`, `FIXME`, `HACK`, and `XXX` comments during init and goodbye. It diffs the results across sessions so you can see which code TODOs were added or resolved. Supports 26+ file extensions across all common languages.

### AI narrative

When you have an `ANTHROPIC_API_KEY` set, status, goodbye and version call `claude-sonnet-5` to generate a prose summary of your session — recent work, deploy status, prioritised next steps. Effort is pinned low and token budgets cover the reasoning as well as the prose (2000 for status, 4000 for goodbye, 1500 for version). Without the key you get a deterministic fallback that's still useful, and devctx tells you which one you got: a missing key, a rejected key and a retired model read differently in the output rather than all looking the same.

## Tools (21)

| Tool | Type | Description |
|------|------|-------------|
| `devctx_init` | meta | Initialise for a project (scans language/framework, installs git hooks) |
| `devctx_start` | meta | Resume tracking after pause |
| `devctx_stop` | meta | Pause tracking (reads still work) |
| `devctx_goodbye` | meta | Session wrap-up — AI summary, auto-todos, pause |
| `devctx_status` | read | Full dashboard with branches, todos, vitals, AI narrative |
| `devctx_summary` | read | AI-generated narrative only |
| `devctx_whereami` | read | Full project context dump |
| `devctx_update_focus` | write | Set current focus → syncs to the project context files |
| `devctx_log` | write | Log commits, pushes, builds, deploys, milestones, merges |
| `devctx_activity` | read | View activity log, filter by type |
| `devctx_todo_add` | write | Add todo with priority, branch scope, tags |
| `devctx_todo_update` | write | Change todo status, priority, text |
| `devctx_todo_list` | read | List todos, filter by branch or status |
| `devctx_todo_remove` | write | Remove a todo by ID |
| `devctx_branch_notes` | read | Get per-branch markdown notes |
| `devctx_branch_notes_save` | write | Save per-branch documentation |
| `devctx_git` | read/write | Git operations with auto-logging |
| `devctx_sync` | write | Force sync state → CLAUDE.md and AGENTS.md |
| `devctx_linear_sync` | read/write | Two-way sync between todos and Linear issues |
| `devctx_version` | write | Suggest and create a semver tag from commits since the last |
| `devctx_help` | read | Command reference |

Write tools respect the active/paused state. Read tools always work.

## Commands

The same set of workflows ships in both hosts' native format. `util/install.sh` links them as symlinks, so updates propagate on `git pull`.

In Claude Code they are slash commands, invoked as `/devctx-status`:

```bash
ln -sf "$PWD/slash-commands"/*.md ~/.claude/commands/
```

In Codex they are skills, invoked as `$devctx-status` or fired automatically when your request matches. They are generated from the same source files by `npm run build:skills`, so the two cannot drift:

```bash
ln -sfn "$PWD/skills"/*/ ~/.agents/skills/
```

Each one is a thin wrapper around the matching `devctx_*` MCP tool, so you can always call the tools directly instead.

| Command | Purpose |
|---------|---------|
| `devctx-init` | Initialise for current project |
| `devctx-status` | Full dashboard with AI recap |
| `devctx-summary` | AI narrative only |
| `devctx-whereami` | Complete context dump |
| `devctx-start` | Resume tracking |
| `devctx-stop` | Pause tracking |
| `devctx-goodbye` | Session wrap-up |
| `devctx-focus` | Set current focus |
| `devctx-todos` | Manage todos |
| `devctx-git` | Git operations with logging |
| `devctx-version` | Suggest and create a semver tag |
| `devctx-linear` | Sync todos with Linear issues |
| `devctx-help` | Show available commands |
| `devctx-statusline` | Set up the status line (Claude Code only) |

## Installation

### Quick install (recommended)

```bash
git clone https://github.com/tmattoneill/devctx.git
cd devctx
bash util/install.sh
```

The installer detects which agents you have and wires up whichever it finds. It fails only if you have neither.

1. Installs dependencies and builds the project (`npm install && npm run build:all`)
2. Prompts for MCP registration scope (system-wide or project-only)
3. Optionally configures your Anthropic API key for AI narrative summaries
4. Claude Code: registers with `claude mcp add`, symlinks the 14 slash commands to `~/.claude/commands/`, adds `mcp__devctx` to permissions, and optionally sets up the status line
5. Codex: registers with `codex mcp add` and symlinks the 13 skills to `~/.agents/skills/`

If Node.js isn't installed, the script detects your platform (macOS/Ubuntu/Fedora/Arch) and offers to install it.

**Non-interactive mode** for scripted installs:

```bash
bash util/install.sh -s user --no-api-key        # System-wide, no API key
bash util/install.sh -s project --api-key sk-ant-...  # Project-scoped with key
```

Run `bash util/install.sh --help` for all options. The script is idempotent — safe to re-run after `git pull`.

### Manual installation

```bash
git clone https://github.com/tmattoneill/devctx.git
cd devctx
npm install
npm run build:all
```

Register with Claude Code:

```bash
claude mcp add -s user devctx -e ANTHROPIC_API_KEY=sk-ant-... -- node /absolute/path/to/devctx/dist/index.js
ln -sf "$PWD/slash-commands"/*.md ~/.claude/commands/
claude mcp list        # verify
```

Add `mcp__devctx` to the `permissions.allow` array in `~/.claude/settings.json` to avoid per-call prompts.

Register with Codex:

```bash
codex mcp add devctx --env ANTHROPIC_API_KEY=sk-ant-... -- node /absolute/path/to/devctx/dist/index.js
ln -sfn "$PWD/skills"/*/ ~/.agents/skills/
codex mcp list         # verify
```

`codex mcp list` shows `Auth: Unsupported` against devctx. That refers to OAuth on the local stdio transport and applies to every stdio server; it does not mean devctx is unsupported.

The API key is optional. Without it everything works and the summaries fall back to a deterministic one built from git history, todos and the activity log; devctx tells you in its output which one you got. The AI path is Anthropic-only by design, so there is one set of prompts to keep working rather than two. devctx never modifies source code, runs arbitrary shell commands, or accesses the network beyond the optional narrative call and Linear sync.

### Linear under Codex

`devctx_linear_sync` needs its own `LINEAR_API_KEY` in the devctx server's environment. Codex's `codex mcp login linear` authenticates Linear's own remote MCP server; devctx calls the Linear GraphQL API directly and cannot reuse that session.

```bash
codex mcp remove devctx
codex mcp add devctx --env ANTHROPIC_API_KEY=sk-ant-... --env LINEAR_API_KEY=lin_api_... -- node /absolute/path/to/devctx/dist/index.js
```

## Getting started

Run `devctx-init` in any directory. devctx detects your situation:

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
│   ├── statusline.json       # Cache read by the status line script
│   ├── linear.json           # Linear team, user and workflow state IDs
│   ├── sessions/             # Session records from goodbye
│   └── branches/             # Per-branch notes
├── CLAUDE.md                 # Synced with devctx section between markers
├── AGENTS.md                 # Same, when the repo keeps one for Codex
└── ...
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sdk` | AI narrative generation |
| `@modelcontextprotocol/sdk` | MCP server implementation |
| `zod` | Input validation |
| `fastify` | Dashboard HTTP server |
| `react` | Dashboard frontend (dev dependency; bundled at build time) |
| `vite` | Dashboard build tooling (dev dependency) |

## Free and open source

devctx is MIT licensed. Clone it, use it, fork it.

https://github.com/tmattoneill/devctx
