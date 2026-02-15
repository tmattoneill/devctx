# devctx-mcp-server

MCP server that gives Claude Code persistent project context across sessions. Tracks focus, todos, branch notes, activity log, and generates AI narrative summaries.

## Architecture

- **Runtime:** Node.js, TypeScript, compiled to `dist/`
- **Protocol:** MCP (Model Context Protocol) via `@anthropic-ai/sdk` and `@anthropic-ai/sdk` for narratives
- **Entry point:** `src/index.ts` — registers all 17 tools with Zod schemas
- **State storage:** `.devctx/` directory in each tracked project (JSON files, gitignored)
- **Context sync:** Writes a `<!-- devctx -->` section to each project's `CLAUDE.md`

## Source layout

```
src/
  index.ts              # Tool registration, handlers, MCP server setup
  services/
    scanner.ts          # Project auto-detection (language, framework, CI/CD, infra)
    git.ts              # Git operations (status, branches, commits, init)
    state.ts            # .devctx/ state management (todos, activity log, focus)
    dashboard.ts        # ASCII status dashboard renderer
    narrative.ts        # AI summary via Claude API (with deterministic fallback)
    format.ts           # Text formatters for whereami, todos, activity
slash-commands/         # .md files copied to ~/.claude/commands/
```

## Key patterns

- Every tool handler calls `resolveRepoRoot()` which requires git — except `devctx_init` which uses `resolveCwd()` and can bootstrap git from scratch
- Write tools check `guardActive()` and `guardInitialized()` before proceeding
- `logActivity()` appends to `.devctx/activity.jsonl` — one JSON object per line
- The dashboard is pure text (no ANSI, no box-drawing) to render cleanly in any terminal
- Narrative service falls back to deterministic summary when `ANTHROPIC_API_KEY` is not set

## Build

```bash
npm run build    # runs tsc, outputs to dist/
```

No test framework yet. Manual testing via throwaway git repos in `/tmp/`.

## Tools (17 total)

devctx_init, devctx_start, devctx_stop, devctx_status, devctx_summary, devctx_whereami, devctx_update_focus, devctx_log, devctx_activity, devctx_todo_add, devctx_todo_update, devctx_todo_list, devctx_todo_remove, devctx_branch_notes, devctx_branch_notes_save, devctx_sync, devctx_git_summary

## Important conventions

- Tool descriptions are intentionally verbose — they instruct the model when/how to call the tool
- `devctx_log` description explicitly tells the model to log after builds, runs, tests, commits, pushes, deploys
- Activity types: commit, push, build, run, test, deploy, note, milestone, session_start, session_end, custom
- Dashboard uses plain-text column alignment (spaces + dashes), no Unicode box-drawing
- Scanner detects: JS/TS/Python/Rust/Go/Java/Kotlin/C++, 15+ frameworks, 10+ build tools, 6 CI/CD systems, 10+ infra platforms

<!-- DEVCTX:START -->
## 🔍 Project Context (auto-updated by devctx)

**Project:** Project-aware development context tracker for Claude Code. Logs git activity, tracks todos, maintains branch notes, and updates CLAUDE.md.

**Branch:** `unknown`
**Last Updated:** 15/02/2026, 12:23:22

<!-- DEVCTX:END -->
