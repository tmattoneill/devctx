# Hooks Documentation for devctx Project

## Context

This document explains how hooks are implemented and used in the devctx project. Hooks are essential for automatically tracking development activities that occur outside of Claude Code, directly in the terminal. The system implements Git hooks to capture commits, branch switches, merges, and pushes, logging them to the activity log for comprehensive project tracking.

## Implementation Overview

The hooks implementation is located in `src/services/hooks.ts` and consists of:

1. Four Git hook templates:
   - `post-commit`: Logs commits to `.devctx/activity.log`
   - `post-checkout`: Logs branch switches
   - `post-merge`: Logs merge operations
   - `pre-push`: Logs push operations

2. An installation system that manages placing these hooks in a Git repository

## Hook Details

### Hook Script Structure

Each hook script follows a consistent pattern:
- Uses POSIX shell scripting for compatibility
- Includes error handling with `set +e` to prevent hook failures from blocking Git operations
- Checks for a `DEVCTX_SKIP_HOOKS` environment variable to allow bypassing
- Verifies the repository has devctx initialized before logging
- Captures relevant metadata and formats it as JSON
- Appends data to `.devctx/activity.log`

### Post-commit Hook
- Triggered after each Git commit
- Logs commit details including hash, subject, author, and timestamp
- Automatically escapes special characters in commit messages

### Post-checkout Hook
- Triggered when switching branches
- Only fires on branch checkout (not file checkout)
- Records the transition from one branch to another

### Post-merge Hook
- Triggered after merging branches
- Logs whether the merge was a squash merge or regular merge

### Pre-push Hook
- Triggered before pushing to a remote repository
- Records which branch is being pushed and to which remote

## Installation Process

The `installHooks()` function in `hooks.ts` handles installation:

1. Checks if `.git/hooks` directory exists
2. For each hook:
   - If a hook file already exists:
     - If it contains devctx markers, replaces the existing devctx section
     - Otherwise, appends the devctx hook to the existing hook
   - If no hook file exists, creates a new one with shebang and hook content
3. Sets appropriate execution permissions (0o755)

## Integration with the System

### Activity Logging
Hooks write directly to `.devctx/activity.log` in JSON format, which is then consumed by:
- `devctx_activity` tool for viewing logs
- `devctx_status` dashboard for recent activities
- Session summaries in `devctx_goodbye`

### Integration Points in index.ts
1. During `devctx_init` (lines 685-691): Hooks are installed when initializing a project
2. During `devctx_start` (lines 816-817): Hooks are verified/reinstalled when resuming tracking
3. In Git operations: The system sets `DEVCTX_SKIP_HOOKS=1` to prevent duplicate logging when using devctx tools

## Benefits

1. **Automatic Tracking**: Captures Git activities whether they occur through Claude Code or terminal
2. **Non-Intrusive**: Hooks won't break Git operations even if devctx fails
3. **Comprehensive**: Covers the full Git workflow (commit, branch, merge, push)
4. **Consistent**: All activities are logged in the same format regardless of source

## Verification

To check if hooks are properly installed:
1. Look for hook files in `.git/hooks/` directory
2. Verify that they contain the devctx markers (`# --- devctx hook start ---` and `# --- devctx hook end ---`)
3. Check `.devctx/activity.log` for recent entries with `source":"hook"` in metadata