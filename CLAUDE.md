# devctx-mcp-server

MCP server that gives Claude Code persistent project context across sessions. Tracks focus, todos, branch notes, activity log, and generates AI narrative summaries.

## Architecture

- **Runtime:** Node.js, TypeScript, compiled to `dist/`
- **Protocol:** MCP (Model Context Protocol) via `@modelcontextprotocol/sdk`; `@anthropic-ai/sdk` for narratives
- **Entry point:** `src/index.ts` — registers all 21 tools with Zod schemas
- **State storage:** `.devctx/` directory in each tracked project (JSON files, gitignored)
- **Context sync:** Writes a `<!-- devctx -->` section to each project's `CLAUDE.md`

## Source layout

```
src/
  index.ts              # Tool registration, handlers, MCP server setup, auto-session-start
  services/
    scanner.ts          # Project auto-detection (language, framework, CI/CD, infra)
    git.ts              # Git operations (status, branches, commits, init, commit, push, pull, checkout, merge, stash)
    hooks.ts            # Git hook templates and installer (post-commit, post-checkout, post-merge, pre-push)
    dashboard.ts        # ASCII status dashboard renderer
    narrative.ts        # AI summary + goodbye session summary via Claude API (with deterministic fallback)
    version.ts          # Semver tag suggestions from commits since the last tag (AI, with fallback)
    ai-status.ts        # Classifies and records why the last Anthropic call failed
    format.ts           # Text formatters for whereami, todos, activity
    linear.ts           # Linear GraphQL API client + sync logic (pull/push)
scripts/
  gen-skills.mjs        # Generates skills/ (Codex) from slash-commands/ (Claude Code)
skills/                 # Generated Codex skills, one <name>/SKILL.md each
  shared/
    data.ts             # .devctx/ state management (todos, activity log, focus, sessions)
    types.ts            # Shared interfaces (ProjectState, Todo, LinearConfig, ActivityEntry)
    index.ts            # Re-exports
  dashboard/
    cli.ts              # `devctx-dash` entry point
    server.ts           # Fastify JSON API + static host for the client bundle (binds 127.0.0.1)
    client/             # React + Vite SPA, its own tsconfig, builds to client/dist
slash-commands/         # Source of truth: 14 commands, symlinked to ~/.claude/commands/
```

## Key patterns

- Every tool handler calls `resolveRepoRoot()` then `autoSessionStart(repoRoot)` — except `devctx_init` which uses `resolveCwd()`
- Auto-session-start fires exactly once per MCP process via module-level `sessionStarted` flag
- Write tools check `guardActive()` and `guardInitialized()` before proceeding
- `logActivity()` appends to `.devctx/activity.log` with `appendFileSync` — one JSON object per line, and the git hooks append to the same file from other terminals, so a read-modify-write would drop their entries
- Git hooks also append to `activity.log` from any terminal (POSIX shell, marker-based)
- The dashboard is pure text (no ANSI, no box-drawing) to render cleanly in any terminal
- Narrative service falls back to a deterministic summary when `ANTHROPIC_API_KEY` is not set, when the key is rejected, or when the API call fails for any other reason
- AI call sites must never write to stderr — that makes Claude Code flag the MCP server as failed. They record the reason via `recordAiFailure()` in `ai-status.ts`, and `aiStatusBanner()` / `aiFallbackNote()` report it in tool output
- `.devctx/` JSON and the agent context files are written through `writeFileAtomic()` (temp file plus rename) in `shared/data.ts` — the server takes a SIGHUP when Claude Code exits, and a truncated state file used to read as empty and then get saved over
- Unparseable state files are renamed to `<name>.corrupt-<timestamp>` rather than treated as empty
- `updateContextFiles()` (tool param `sync_context`) updates whichever context files the repo already keeps, and creates `CLAUDE.md` only when the repo has neither. A Codex-only project never acquires a `CLAUDE.md`
- `readContextFile()` and `existingContextFiles()` are how everything else finds them. Goodbye reads whichever exists for its narrative prompt and commits all of them
- The context section is located by the LAST marker pair in the file, so prose that names the markers is not mistaken for the generated block
- `devctx_goodbye` saves session records to `.devctx/sessions/` and auto-generates suggested todos
- Todos have `source?: "manual" | "suggested" | "linear"` — suggested todos shown with `[suggested]` tag; Linear-linked todos show `[PROJ-123]` identifier

## Hosts

devctx serves Claude Code and Codex from the same stdio MCP server. Neither needs a code path of its own; what differs is the packaging around it.

- Claude Code reads `slash-commands/*.md` from `~/.claude/commands/`, invoked as `/devctx-status`. It also gets the status line and the `mcp__devctx` permissions entry, neither of which Codex has.
- Codex reads `skills/<name>/SKILL.md` from `~/.agents/skills/`, invoked as `$devctx-status` or fired implicitly when the request matches the frontmatter description.
- `slash-commands/` is the single source of truth. `scripts/gen-skills.mjs` (`npm run build:skills`, also part of `build:all`) generates `skills/` from it, so the two cannot drift. `src/shared/skills.test.ts` fails if they do.
- `devctx-statusline` is deliberately excluded from skill generation; Codex has no status line.
- Skill descriptions must be quoted in the YAML frontmatter. Several contain `": "`, which is illegal in a plain scalar and makes the whole skill fail to load in Codex.
- `util/install.sh` detects `claude` and `codex` and wires up whichever are present, failing only when neither is.

## Linear integration

`devctx_linear_sync` syncs todos with Linear issues. Requires `LINEAR_API_KEY`; config lives in `.devctx/linear.json`.

- Status flows both ways. Marking a todo `done` closes its Linear issue, and an issue completed or canceled in Linear marks the local todo done on the next sync
- The assigned-issues query filters completed and canceled issues out, so closed issues vanish rather than arriving as done. `fetchIssuesByIds()` looks up linked todos that went missing and takes their real state
- `resolveStateIds()` maps each devctx status to a Linear workflow state ID and caches the result in `linear.json`, so a single todo update can close an issue without listing teams first. A full sync always refreshes it, since a renamed or deleted state would otherwise leave a stale ID
- Push never creates issues from `source: "suggested"` todos — those are AI output from `devctx_goodbye`, and pushing them would flood the team. Promote one with `devctx_todo_update promote=true` to make it pushable
- `markTodoSynced()` stamps `linearSyncedAt` and `updated` from one timestamp. Two separate `new Date()` calls leave `updated` a millisecond ahead, which the "devctx is newer than Linear" test reads as dirty, re-pushing every todo on every sync
- A todo whose push failed carries `linearSyncError` and shows `[linear sync failed]` in `devctx_todo_list`

## Build

```bash
npm run build      # tsc, outputs to dist/
npm run build:all  # tsc plus the dashboard client bundle
npm run typecheck  # type-checks the tests and the dashboard client, which `build` skips
npm test           # vitest
```

Vitest covers `scanner.ts`, `version.ts`, `shared/data.ts` and `ai-status.ts`, plus `durability.test.ts` (atomic writes, corrupt-file quarantine, activity-log appends, Linear sync markers, which context files get written) and `skills.test.ts` (the generated Codex skills match slash-commands and their frontmatter parses). 72 tests across 6 files. The root `tsconfig.json` excludes test files and the dashboard client, so `npm run build` type-checks neither — run `npm run typecheck` for those.

## Tools (21 total)

devctx_init, devctx_start, devctx_stop, devctx_goodbye, devctx_status, devctx_summary, devctx_whereami, devctx_update_focus, devctx_log, devctx_activity, devctx_todo_add, devctx_todo_update, devctx_todo_list, devctx_todo_remove, devctx_branch_notes, devctx_branch_notes_save, devctx_sync, devctx_git, devctx_linear_sync, devctx_version, devctx_help

## Important conventions

- Tool descriptions are intentionally verbose — they instruct the model when/how to call the tool
- `devctx_log` description explicitly tells the model to log after builds, runs, tests, commits, pushes, deploys
- Activity types: commit, push, build, run, test, deploy, note, milestone, session_start, session_end, custom, branch_switch, merge, version
- Dashboard uses plain-text column alignment (spaces + dashes), no Unicode box-drawing
- Scanner detects: JS/TS/Python/Rust/Go/Java/Kotlin/C++, 15+ frameworks, 10+ build tools, 6 CI/CD systems, 10+ infra platforms

<!-- DEVCTX:START -->
## Project Context (auto-updated by devctx)

> **IMPORTANT:** When starting a new conversation, greet the user with a brief summary of the project context below — current focus, branch, and any active todos. Keep it to 2-3 sentences. Do not skip this greeting.

**Current Focus:** Making devctx host-neutral for Claude Code and Codex: skills generation, context-file handling, installer, AI failure reporting

**Project:** Project-aware development context tracker for Claude Code. Logs git activity, tracks todos, maintains branch notes, and updates CLAUDE.md.

**Branch:** `main`
**Last Updated:** 07/09/2026, 15:50:45

### Active Todos
- [ ] [high] Fix the broken .claude gitlink: it is committed as mode 160000 with no .gitmodules, so a clone gets an empty dir and neither settings.local.json nor CLAUDE.md (`main`)
- [ ] [high] MCP error on logout/exit: the stdin end handler calls process.exit(0) immediately, killing in-flight requests (a goodbye mid-flight is lost). Track outstanding requests and drain before exiting. (`main`)
- [ ] [medium] Document the todo ID generation change in README or changelog (`main`)
- [ ] [medium] Exclude *.test.ts from scanSourceTodos: scanner.test.ts fixture strings are counted as 10 real source TODOs (`main`)
- [ ] [medium] Add integration tests that cover the MCP tool handlers and server startup (`main`)
- [ ] [medium] Add error handling tests for MCP server shutdown and cleanup scenarios (`main`)
- [ ] [medium] Add unit tests for linear.ts itself: resolveStateIds caching and refresh, findStateId type fallbacks, fetchIssuesByIds reconciliation of closed issues (`main`)

<!-- DEVCTX:END -->
