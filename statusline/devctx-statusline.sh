#!/usr/bin/env bash
# devctx-statusline.sh — Status line script for Claude Code
#
# Reads Claude Code session JSON from stdin and .devctx/statusline.json from disk.
# Outputs a single ANSI-colored line for the Claude Code status bar.
#
# Configure in ~/.claude/settings.json:
#   "statusLine": { "type": "command", "command": "/path/to/devctx-statusline.sh" }

set -euo pipefail

# --- Colors (ANSI) ---
RESET=$'\033[0m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
CYAN=$'\033[36m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
RED=$'\033[31m'
MAGENTA=$'\033[35m'

# --- Check for jq ---
if ! command -v jq &>/dev/null; then
  echo "${DIM}(jq required for devctx statusline)${RESET}"
  exit 0
fi

# --- Read session JSON from stdin ---
SESSION_JSON=""
if [ ! -t 0 ]; then
  SESSION_JSON=$(cat)
fi

# --- Parse session data ---
MODEL=""
COST=""
CONTEXT_PCT=""
PROJECT_DIR=""

if [ -n "$SESSION_JSON" ]; then
  MODEL=$(echo "$SESSION_JSON" | jq -r '.model // empty' 2>/dev/null || true)
  COST=$(echo "$SESSION_JSON" | jq -r '.total_cost // empty' 2>/dev/null || true)
  CONTEXT_PCT=$(echo "$SESSION_JSON" | jq -r '.context_percent // empty' 2>/dev/null || true)
  PROJECT_DIR=$(echo "$SESSION_JSON" | jq -r '.workspace.project_dir // empty' 2>/dev/null || true)
fi

# --- Format model name ---
format_model() {
  local m="$1"
  case "$m" in
    *opus*4*6*|*claude-opus-4-6*)   echo "Opus 4.6" ;;
    *sonnet*4*6*|*claude-sonnet-4-6*) echo "Sonnet 4.6" ;;
    *haiku*4*5*|*claude-haiku-4-5*) echo "Haiku 4.5" ;;
    *opus*)   echo "Opus" ;;
    *sonnet*) echo "Sonnet" ;;
    *haiku*)  echo "Haiku" ;;
    "")       echo "" ;;
    *)        echo "$m" ;;
  esac
}

# --- Time-ago calculation (macOS + GNU compatible) ---
time_ago() {
  local iso_ts="$1"
  if [ -z "$iso_ts" ] || [ "$iso_ts" = "null" ]; then
    echo ""
    return
  fi

  local ts_epoch
  # Try GNU date first, then macOS date
  if date --version &>/dev/null 2>&1; then
    ts_epoch=$(date -d "$iso_ts" +%s 2>/dev/null || echo "")
  else
    ts_epoch=$(date -jf "%Y-%m-%dT%H:%M:%S" "${iso_ts%%.*}" +%s 2>/dev/null || echo "")
  fi

  if [ -z "$ts_epoch" ]; then
    echo ""
    return
  fi

  local now_epoch
  now_epoch=$(date +%s)
  local diff=$((now_epoch - ts_epoch))

  if [ "$diff" -lt 0 ]; then
    echo "now"
  elif [ "$diff" -lt 60 ]; then
    echo "${diff}s"
  elif [ "$diff" -lt 3600 ]; then
    echo "$((diff / 60))m"
  elif [ "$diff" -lt 86400 ]; then
    echo "$((diff / 3600))h"
  else
    echo "$((diff / 86400))d"
  fi
}

# --- Locate cache file ---
CACHE_FILE=""
if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/.devctx/statusline.json" ]; then
  CACHE_FILE="$PROJECT_DIR/.devctx/statusline.json"
fi

# --- Build output segments ---
SEGMENTS=()

if [ -n "$CACHE_FILE" ]; then
  CACHE=$(cat "$CACHE_FILE" 2>/dev/null || echo "{}")

  PROJECT_NAME=$(echo "$CACHE" | jq -r '.projectName // empty')
  FOCUS=$(echo "$CACHE" | jq -r '.currentFocus // empty')
  ACTIVE=$(echo "$CACHE" | jq -r '.active // true')
  BRANCH=$(echo "$CACHE" | jq -r '.branch // empty')
  TODO_COUNT=$(echo "$CACHE" | jq -r '.todoCount // 0')
  HIGH_COUNT=$(echo "$CACHE" | jq -r '.highPriorityCount // 0')
  LAST_COMMIT=$(echo "$CACHE" | jq -r '.lastCommit // empty')

  # Project name
  if [ -n "$PROJECT_NAME" ]; then
    SEGMENTS+=("${BOLD}${CYAN}${PROJECT_NAME}${RESET}")
  fi

  # Branch
  if [ -n "$BRANCH" ]; then
    SEGMENTS+=("${DIM}⌥${RESET}${GREEN}${BRANCH}${RESET}")
  fi

  # Paused indicator
  if [ "$ACTIVE" = "false" ]; then
    SEGMENTS+=("${DIM}⏸${RESET}")
  fi

  # Focus (truncate to ~30 chars)
  if [ -n "$FOCUS" ]; then
    TRUNCATED_FOCUS="$FOCUS"
    if [ "${#FOCUS}" -gt 30 ]; then
      TRUNCATED_FOCUS="${FOCUS:0:28}.."
    fi
    SEGMENTS+=("🎯 ${TRUNCATED_FOCUS}")
  fi

  # Todos
  if [ "$TODO_COUNT" -gt 0 ]; then
    if [ "$HIGH_COUNT" -gt 0 ]; then
      SEGMENTS+=("📋 ${RED}${HIGH_COUNT}!${RESET}/${TODO_COUNT}")
    else
      SEGMENTS+=("📋 ${TODO_COUNT}")
    fi
  fi

  # Time since last commit
  COMMIT_AGO=$(time_ago "$LAST_COMMIT")
  if [ -n "$COMMIT_AGO" ]; then
    SEGMENTS+=("${DIM}⏱ ${COMMIT_AGO}${RESET}")
  fi
fi

# --- Session segments (always shown) ---
FORMATTED_MODEL=$(format_model "$MODEL")
if [ -n "$FORMATTED_MODEL" ]; then
  SEGMENTS+=("${MAGENTA}✱ ${FORMATTED_MODEL}${RESET}")
fi

if [ -n "$COST" ] && [ "$COST" != "0" ]; then
  SEGMENTS+=("${YELLOW}\$${COST}${RESET}")
fi

if [ -n "$CONTEXT_PCT" ] && [ "$CONTEXT_PCT" != "0" ]; then
  # Color context % based on usage
  ctx_color="$GREEN"
  ctx_int="${CONTEXT_PCT%%.*}"
  if [ -n "$ctx_int" ] && [ "$ctx_int" -ge 80 ] 2>/dev/null; then
    ctx_color="$RED"
  elif [ -n "$ctx_int" ] && [ "$ctx_int" -ge 60 ] 2>/dev/null; then
    ctx_color="$YELLOW"
  fi
  SEGMENTS+=("${ctx_color}${CONTEXT_PCT}%${RESET}")
fi

# --- Join and output ---
if [ ${#SEGMENTS[@]} -eq 0 ]; then
  exit 0
fi

OUTPUT=""
for i in "${!SEGMENTS[@]}"; do
  if [ "$i" -gt 0 ]; then
    OUTPUT+="  "
  fi
  OUTPUT+="${SEGMENTS[$i]}"
done

echo "$OUTPUT"
