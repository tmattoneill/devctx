# devctx-mcp-server

MCP server that gives Claude Code persistent project context across sessions. Tracks focus, todos, branch notes, activity log, and generates AI narrative summaries.

## Architecture

- **Runtime:** Node.js, TypeScript, compiled to `dist/`
- **Protocol:** MCP (Model Context Protocol) via `@anthropic-ai/sdk` and `@anthropic-ai/sdk` for narratives
- **Entry point:** `src/index.ts` — registers all 18 tools with Zod schemas
- **State storage:** `.devctx/` directory in each tracked project (JSON files, gitignored)
- **Context sync:** Writes a `<!-- devctx -->` section to each project's `CLAUDE.md`

## Source layout

```
src/
  index.ts              # Tool registration, handlers, MCP server setup, auto-session-start
  services/
    scanner.ts          # Project auto-detection (language, framework, CI/CD, infra)
    git.ts              # Git operations (status, branches, commits, init, commit, push, pull, checkout, merge, stash)
    state.ts            # .devctx/ state management (todos, activity log, focus)
    hooks.ts            # Git hook templates and installer (post-commit, post-checkout, post-merge, pre-push)
    dashboard.ts        # ASCII status dashboard renderer
    narrative.ts        # AI summary + goodbye session summary via Claude API (with deterministic fallback)
    format.ts           # Text formatters for whereami, todos, activity
slash-commands/         # .md files copied to ~/.claude/commands/ (10 commands)
```

## Key patterns

- Every tool handler calls `resolveRepoRoot()` then `autoSessionStart(repoRoot)` — except `devctx_init` which uses `resolveCwd()`
- Auto-session-start fires exactly once per MCP process via module-level `sessionStarted` flag
- Write tools check `guardActive()` and `guardInitialized()` before proceeding
- `logActivity()` appends to `.devctx/activity.log` — one JSON object per line
- Git hooks also append to `activity.log` from any terminal (POSIX shell, marker-based)
- The dashboard is pure text (no ANSI, no box-drawing) to render cleanly in any terminal
- Narrative service falls back to deterministic summary when `ANTHROPIC_API_KEY` is not set
- `devctx_goodbye` saves session records to `.devctx/sessions/` and auto-generates suggested todos
- Todos have `source?: "manual" | "suggested"` — suggested todos shown with `[suggested]` tag

## Build

```bash
npm run build    # runs tsc, outputs to dist/
```

No test framework yet. Manual testing via throwaway git repos in `/tmp/`.

## Tools (18 total)

devctx_init, devctx_start, devctx_stop, devctx_goodbye, devctx_status, devctx_summary, devctx_whereami, devctx_update_focus, devctx_log, devctx_activity, devctx_todo_add, devctx_todo_update, devctx_todo_list, devctx_todo_remove, devctx_branch_notes, devctx_branch_notes_save, devctx_sync, devctx_git

## Important conventions

- Tool descriptions are intentionally verbose — they instruct the model when/how to call the tool
- `devctx_log` description explicitly tells the model to log after builds, runs, tests, commits, pushes, deploys
- Activity types: commit, push, build, run, test, deploy, note, milestone, session_start, session_end, custom, branch_switch, merge
- Dashboard uses plain-text column alignment (spaces + dashes), no Unicode box-drawing
- Scanner detects: JS/TS/Python/Rust/Go/Java/Kotlin/C++, 15+ frameworks, 10+ build tools, 6 CI/CD systems, 10+ infra platforms

<!-- DEVCTX:START -->
## Project Context (auto-updated by devctx)

> **IMPORTANT:** When starting a new conversation, greet the user with a brief summary of the project context below — current focus, branch, and any active todos. Keep it to 2-3 sentences. Do not skip this greeting.

**Current Focus:** Completing the duplicate todo ID bug fix — validating MD5 hash approach and cleaning up

**Project:** Project-aware development context tracker for Claude Code. Logs git activity, tracks todos, maintains branch notes, and updates CLAUDE.md.

**Branch:** `main`
**Last Updated:** 20/02/2026, 18:13:09

### Active Todos
- [ ] [high] Add automated tests for the TODO scanner to prevent regression of trailing delimiter bug (`main`)
- [ ] [high] Add automated tests for the new semantic versioning tool and version service (`main`)
- [ ] [medium] Document the todo ID generation change in README or changelog (`main`)
- [ ] [medium] Add the untracked .claude/ directory to version control (`main`)
- [ ] [medium] Address the new TODO item in src/dashboard/client/src/style.css:277 (`main`)
- [ ] [medium] Add automated tests for the shared data layer in src/shared/ (`main`)
- [ ] [medium] Update CLAUDE.md to document the new versioning capabilities and tools (`main`)

<!-- DEVCTX:END -->
