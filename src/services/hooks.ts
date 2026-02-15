import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { join } from "path";

const START_MARKER = "# --- devctx hook start ---";
const END_MARKER = "# --- devctx hook end ---";

// ── Hook script templates ────────────────────────────────────

function generatePostCommitHook(): string {
  return `
${START_MARKER}
# Log commits to .devctx/activity.log
(
  set +e
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  DEVCTX_DIR="$REPO_ROOT/.devctx"
  [ -d "$DEVCTX_DIR" ] || exit 0

  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || BRANCH="unknown"
  HASH="$(git rev-parse HEAD 2>/dev/null)" || HASH=""
  SHORT_HASH="$(git rev-parse --short HEAD 2>/dev/null)" || SHORT_HASH=""
  SUBJECT="$(git log -1 --format=%s 2>/dev/null)" || SUBJECT=""
  AUTHOR="$(git log -1 --format=%an 2>/dev/null)" || AUTHOR=""
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" || TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Escape double quotes in subject
  SUBJECT="$(printf '%s' "$SUBJECT" | sed 's/"/\\\\"/g')"
  AUTHOR="$(printf '%s' "$AUTHOR" | sed 's/"/\\\\"/g')"

  printf '{"timestamp":"%s","type":"commit","message":"%s","branch":"%s","metadata":{"hash":"%s","short_hash":"%s","author":"%s","source":"hook"}}\\n' \\
    "$TIMESTAMP" "$SUBJECT" "$BRANCH" "$HASH" "$SHORT_HASH" "$AUTHOR" \\
    >> "$DEVCTX_DIR/activity.log" 2>/dev/null
) || true
${END_MARKER}`;
}

function generatePostCheckoutHook(): string {
  return `
${START_MARKER}
# Log branch switches to .devctx/activity.log
(
  set +e
  # Only fire on branch checkout (3rd arg = 1), not file checkout (0)
  [ "$3" = "1" ] || exit 0

  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  DEVCTX_DIR="$REPO_ROOT/.devctx"
  [ -d "$DEVCTX_DIR" ] || exit 0

  NEW_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || NEW_BRANCH="unknown"
  # Resolve old branch from the previous HEAD ref
  OLD_BRANCH="$(git name-rev --name-only "$1" 2>/dev/null)" || OLD_BRANCH="unknown"
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" || TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  printf '{"timestamp":"%s","type":"branch_switch","message":"Switched from %s to %s","branch":"%s","metadata":{"from_branch":"%s","to_branch":"%s","source":"hook"}}\\n' \\
    "$TIMESTAMP" "$OLD_BRANCH" "$NEW_BRANCH" "$NEW_BRANCH" "$OLD_BRANCH" "$NEW_BRANCH" \\
    >> "$DEVCTX_DIR/activity.log" 2>/dev/null
) || true
${END_MARKER}`;
}

function generatePostMergeHook(): string {
  return `
${START_MARKER}
# Log merges to .devctx/activity.log
(
  set +e
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  DEVCTX_DIR="$REPO_ROOT/.devctx"
  [ -d "$DEVCTX_DIR" ] || exit 0

  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || BRANCH="unknown"
  SQUASH="false"
  [ "$1" = "1" ] && SQUASH="true"
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" || TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  printf '{"timestamp":"%s","type":"merge","message":"Merged into %s","branch":"%s","metadata":{"squash":"%s","source":"hook"}}\\n' \\
    "$TIMESTAMP" "$BRANCH" "$BRANCH" "$SQUASH" \\
    >> "$DEVCTX_DIR/activity.log" 2>/dev/null
) || true
${END_MARKER}`;
}

function generatePrePushHook(): string {
  return `
${START_MARKER}
# Log pushes to .devctx/activity.log
(
  set +e
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  DEVCTX_DIR="$REPO_ROOT/.devctx"
  [ -d "$DEVCTX_DIR" ] || exit 0

  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" || BRANCH="unknown"
  REMOTE="$1"
  TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" || TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  printf '{"timestamp":"%s","type":"push","message":"Pushing %s to %s","branch":"%s","metadata":{"remote":"%s","source":"hook"}}\\n' \\
    "$TIMESTAMP" "$BRANCH" "$REMOTE" "$BRANCH" "$REMOTE" \\
    >> "$DEVCTX_DIR/activity.log" 2>/dev/null
) || true
${END_MARKER}`;
}

// ── Hook installer ───────────────────────────────────────────

const HOOK_GENERATORS: Record<string, () => string> = {
  "post-commit": generatePostCommitHook,
  "post-checkout": generatePostCheckoutHook,
  "post-merge": generatePostMergeHook,
  "pre-push": generatePrePushHook,
};

export function installHooks(repoRoot: string): { installed: string[]; skipped: string[] } {
  const hooksDir = join(repoRoot, ".git", "hooks");
  const installed: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(hooksDir)) {
    return { installed, skipped: Object.keys(HOOK_GENERATORS) };
  }

  for (const [hookName, generator] of Object.entries(HOOK_GENERATORS)) {
    const hookPath = join(hooksDir, hookName);
    const hookContent = generator();

    try {
      if (existsSync(hookPath)) {
        const existing = readFileSync(hookPath, "utf-8");

        if (existing.includes(START_MARKER) && existing.includes(END_MARKER)) {
          // Replace existing devctx section
          const before = existing.substring(0, existing.indexOf(START_MARKER));
          const after = existing.substring(existing.indexOf(END_MARKER) + END_MARKER.length);
          writeFileSync(hookPath, before + hookContent + after);
        } else {
          // Append to existing hook
          writeFileSync(hookPath, existing.trimEnd() + "\n" + hookContent + "\n");
        }
      } else {
        // Create new hook file
        writeFileSync(hookPath, "#!/bin/sh\n" + hookContent + "\n");
      }

      chmodSync(hookPath, 0o755);
      installed.push(hookName);
    } catch {
      skipped.push(hookName);
    }
  }

  return { installed, skipped };
}
