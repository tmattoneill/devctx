#!/usr/bin/env bash
set -euo pipefail

# ─── Resolve paths ───────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Colors (disabled when NO_COLOR is set or stdout is not a TTY) ───────────

if [[ -z "${NO_COLOR:-}" ]] && [[ -t 1 ]]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  RED='\033[0;31m'
  CYAN='\033[0;36m'
  RESET='\033[0m'
else
  BOLD='' DIM='' GREEN='' YELLOW='' RED='' CYAN='' RESET=''
fi

# ─── Utility functions ───────────────────────────────────────────────────────

info()    { printf "${CYAN}%s${RESET}\n" "$*"; }
success() { printf "${GREEN}%s${RESET}\n" "$*"; }
warn()    { printf "${YELLOW}warning:${RESET} %s\n" "$*"; }
error()   { printf "${RED}error:${RESET} %s\n" "$*" >&2; }
step()    { printf "\n${BOLD}[%s] %s${RESET}\n" "$1" "$2"; }

# ─── Parse CLI flags ────────────────────────────────────────────────────────

SCOPE=""
API_KEY=""
NO_API_KEY=false
SKIP_REGISTRATION=false
VERBOSE=false

usage() {
  cat <<EOF
Usage: bash util/install.sh [options]

Options:
  -s user|project|local   MCP registration scope (skip interactive prompt)
  --api-key KEY           Anthropic API key for AI narrative summaries
  --no-api-key            Skip API key prompt
  --skip-registration     Skip MCP server registration
  --verbose               Show full command output
  --help                  Show this help message

Examples:
  bash util/install.sh                       # Interactive mode
  bash util/install.sh -s user --no-api-key  # Non-interactive, system-wide
  bash util/install.sh -s project             # Project-scoped registration
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -s)
      shift
      case "${1:-}" in
        user|project|local) SCOPE="$1" ;;
        *) error "Invalid scope: '${1:-}'. Must be user, project, or local."; exit 1 ;;
      esac
      shift
      ;;
    --api-key)
      shift
      API_KEY="${1:-}"
      if [[ -z "$API_KEY" ]]; then
        error "--api-key requires a value"
        exit 1
      fi
      shift
      ;;
    --no-api-key)
      NO_API_KEY=true
      shift
      ;;
    --skip-registration)
      SKIP_REGISTRATION=true
      shift
      ;;
    --verbose)
      VERBOSE=true
      shift
      ;;
    --help|-h)
      usage
      ;;
    *)
      error "Unknown option: $1"
      echo "Run 'bash util/install.sh --help' for usage."
      exit 1
      ;;
  esac
done

# ─── Header ──────────────────────────────────────────────────────────────────

printf "\n${BOLD}devctx installer${RESET}\n"
printf "${DIM}Project-aware development context for Claude Code${RESET}\n"

# ─── Prerequisite checks ────────────────────────────────────────────────────

step "0" "Checking prerequisites..."

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux)
      if [[ -f /etc/os-release ]]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        case "${ID:-}" in
          ubuntu|debian|pop|linuxmint|elementary) echo "debian" ;;
          fedora|rhel|centos|rocky|alma)          echo "redhat" ;;
          arch|manjaro|endeavouros)                echo "arch" ;;
          *)                                       echo "linux-unknown" ;;
        esac
      else
        echo "linux-unknown"
      fi
      ;;
    *) echo "unknown" ;;
  esac
}

install_node() {
  local platform="$1"

  echo ""
  info "  Node.js is required but not installed (or below v18)."
  printf "  Install Node.js 22 LTS now? [Y/n]: "
  read -r confirm
  if [[ "${confirm:-y}" == [nN] ]]; then
    error "Node.js is required. Install it manually: https://nodejs.org"
    exit 1
  fi

  case "$platform" in
    macos)
      if command -v brew &>/dev/null; then
        info "  Installing via Homebrew..."
        brew install node@22
        # Homebrew may require linking for keg-only formula
        if ! command -v node &>/dev/null; then
          brew link --overwrite node@22 2>/dev/null || true
        fi
      else
        info "  Homebrew not found — installing via NodeSource..."
        curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
        warn "This will run the NodeSource install script with sudo."
        printf "  Continue? [Y/n]: "
        read -r confirm2
        if [[ "${confirm2:-y}" == [nN] ]]; then
          error "Aborted. Install Node.js manually: https://nodejs.org"
          exit 1
        fi
        sudo bash /tmp/nodesource_setup.sh
        sudo installer -pkg /tmp/nodesource_setup.sh -target / 2>/dev/null || true
        # Fallback: direct .pkg download
        if ! command -v node &>/dev/null; then
          error "Automatic install failed. Download from https://nodejs.org"
          exit 1
        fi
      fi
      ;;
    debian)
      info "  Installing via NodeSource APT repository..."
      if ! command -v curl &>/dev/null; then
        warn "curl not found, installing it first..."
        sudo apt-get update -qq && sudo apt-get install -y -qq curl
      fi
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y -qq nodejs
      ;;
    redhat)
      info "  Installing via NodeSource RPM repository..."
      if ! command -v curl &>/dev/null; then
        sudo dnf install -y -q curl 2>/dev/null || sudo yum install -y -q curl
      fi
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y -q nodejs 2>/dev/null || sudo yum install -y -q nodejs
      ;;
    arch)
      info "  Installing via pacman..."
      sudo pacman -Sy --noconfirm nodejs npm
      ;;
    *)
      error "Unsupported platform for automatic Node.js install."
      echo "  Install Node.js >= 18 manually: https://nodejs.org"
      exit 1
      ;;
  esac

  # Verify installation succeeded
  if ! command -v node &>/dev/null; then
    error "Node.js installation failed. Install manually: https://nodejs.org"
    exit 1
  fi

  local ver
  ver="$(node -e 'console.log(process.versions.node.split(".")[0])')"
  if [[ "$ver" -lt 18 ]]; then
    error "Installed Node.js is v$(node --version) — v18+ required"
    exit 1
  fi

  success "  Node.js $(node --version) installed"
}

PLATFORM="$(detect_platform)"

# Check Node.js — offer to install if missing or too old
NODE_OK=true
if ! command -v node &>/dev/null; then
  NODE_OK=false
elif [[ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]]; then
  NODE_OK=false
fi

if [[ "$NODE_OK" == false ]]; then
  install_node "$PLATFORM"
fi

# npm ships with node, but verify
if ! command -v npm &>/dev/null; then
  error "npm not found (should have been installed with Node.js)"
  exit 1
fi

# Claude CLI
if ! command -v claude &>/dev/null; then
  error "claude CLI is not installed or not in PATH."
  echo "  Install Claude Code: https://docs.anthropic.com/en/docs/claude-code"
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/package.json" ]]; then
  error "package.json not found at $PROJECT_ROOT"
  error "Run this script from the devctx project root: bash util/install.sh"
  exit 1
fi

success "  node $(node --version), npm $(npm --version), claude CLI found"

# ─── Step 1: Build ───────────────────────────────────────────────────────────

step "1" "Installing dependencies and building..."

run_cmd() {
  local label="$1"
  shift
  if [[ "$VERBOSE" == true ]]; then
    printf "  %s\n" "$label"
    "$@"
  else
    printf "  %s..." "$label"
    if output=$("$@" 2>&1); then
      printf " done\n"
    else
      printf " ${RED}failed${RESET}\n"
      echo "$output"
      exit 1
    fi
  fi
}

run_cmd "npm install" npm install --prefix "$PROJECT_ROOT"
run_cmd "npm run build:all" npm run build:all --prefix "$PROJECT_ROOT"

if [[ ! -f "$PROJECT_ROOT/dist/index.js" ]]; then
  error "Build succeeded but dist/index.js not found"
  exit 1
fi

success "  Build complete"

# ─── Step 2: Prompt for scope ────────────────────────────────────────────────

if [[ "$SKIP_REGISTRATION" == true ]]; then
  SCOPE="skip"
elif [[ -z "$SCOPE" ]]; then
  step "2" "MCP server registration scope"
  echo ""
  echo "  How should devctx be registered?"
  echo ""
  printf "  ${BOLD}1)${RESET} System-wide  — available in all projects ${DIM}(recommended)${RESET}\n"
  printf "  ${BOLD}2)${RESET} Project-only — available only in the current project\n"
  printf "  ${BOLD}3)${RESET} Skip         — don't register, I'll do it manually\n"
  echo ""
  printf "  Choice [1]: "
  read -r choice
  case "${choice:-1}" in
    1) SCOPE="user" ;;
    2) SCOPE="project" ;;
    3) SCOPE="skip" ;;
    *) warn "Invalid choice, defaulting to system-wide"; SCOPE="user" ;;
  esac
else
  step "2" "MCP server registration scope: $SCOPE"
fi

# ─── Step 3: Prompt for API key ──────────────────────────────────────────────

step "3" "Anthropic API key (optional)"

if [[ -n "$API_KEY" ]]; then
  echo "  API key provided via --api-key flag"
elif [[ "$NO_API_KEY" == true ]]; then
  echo "  Skipped (--no-api-key)"
elif [[ "$SCOPE" == "skip" ]]; then
  echo "  Skipped (no registration)"
else
  echo ""
  echo "  An Anthropic API key enables AI-powered narrative summaries."
  echo "  This is optional — devctx works without it (deterministic fallback)."
  echo ""
  printf "  API key (blank to skip): "
  read -r -s API_KEY
  echo ""
  if [[ -n "$API_KEY" ]]; then
    if [[ "$API_KEY" != sk-ant-* ]]; then
      warn "Key doesn't start with 'sk-ant-' — are you sure this is correct?"
      printf "  Continue anyway? [y/N]: "
      read -r confirm
      if [[ "${confirm:-n}" != [yY] ]]; then
        API_KEY=""
        echo "  API key cleared, continuing without it"
      fi
    else
      success "  API key accepted"
    fi
  else
    echo "  No key provided — narratives will use deterministic fallback"
  fi
fi

# ─── Step 4: Register MCP server ────────────────────────────────────────────

step "4" "Registering MCP server"

if [[ "$SCOPE" == "skip" ]]; then
  echo "  Skipped"
else
  # Check for existing registration
  if claude mcp list 2>/dev/null | grep -q "devctx"; then
    info "  Removing existing devctx registration..."
    claude mcp remove devctx 2>/dev/null || true
  fi

  # Build the registration command
  MCP_CMD=(claude mcp add -s "$SCOPE" devctx)

  if [[ -n "$API_KEY" ]]; then
    MCP_CMD+=(-e "ANTHROPIC_API_KEY=$API_KEY")
  fi

  MCP_CMD+=(-- node "$PROJECT_ROOT/dist/index.js")

  info "  Registering with scope: $SCOPE..."
  if "${MCP_CMD[@]}"; then
    success "  MCP server registered"
  else
    error "MCP registration failed"
    echo "  You can register manually:"
    echo "  claude mcp add -s $SCOPE devctx -- node $PROJECT_ROOT/dist/index.js"
    exit 1
  fi

  # Verify
  if claude mcp list 2>/dev/null | grep -q "devctx"; then
    success "  Verified: devctx appears in 'claude mcp list'"
  else
    warn "Registration succeeded but devctx not found in 'claude mcp list'"
  fi
fi

# ─── Step 5: Install slash commands (symlinks) ──────────────────────────────

step "5" "Installing slash commands"

COMMANDS_DIR="$HOME/.claude/commands"
SLASH_DIR="$PROJECT_ROOT/slash-commands"
LINKED=0
SKIPPED=0
BACKED_UP=0

mkdir -p "$COMMANDS_DIR"

for source in "$SLASH_DIR"/*.md; do
  filename="$(basename "$source")"
  target="$COMMANDS_DIR/$filename"

  # Already a correct symlink
  if [[ -L "$target" ]] && [[ "$(readlink "$target")" == "$source" ]]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Existing regular file — back up
  if [[ -f "$target" ]] && [[ ! -L "$target" ]]; then
    mv "$target" "$target.bak"
    warn "Backed up existing $filename to $filename.bak"
    BACKED_UP=$((BACKED_UP + 1))
  fi

  # Existing symlink pointing elsewhere — replace
  if [[ -L "$target" ]]; then
    rm "$target"
  fi

  ln -sf "$source" "$target"
  LINKED=$((LINKED + 1))
done

TOTAL=$((LINKED + SKIPPED))
if [[ $LINKED -gt 0 ]]; then
  success "  $LINKED commands linked ($SKIPPED already current, $TOTAL total)"
else
  success "  All $TOTAL commands already up to date"
fi
if [[ $BACKED_UP -gt 0 ]]; then
  warn "  $BACKED_UP existing files backed up to .bak"
fi

# ─── Step 6: Configure permissions ──────────────────────────────────────────

step "6" "Configuring permissions"

SETTINGS_FILE="$HOME/.claude/settings.json"

configure_permissions() {
  node -e "
    const fs = require('fs');
    const path = '$SETTINGS_FILE';
    const PERM = 'mcp__devctx';

    let settings;

    if (fs.existsSync(path)) {
      const raw = fs.readFileSync(path, 'utf8').trim();
      if (!raw) {
        console.log('WARN:settings file is empty, creating fresh');
        settings = {};
      } else {
        try {
          settings = JSON.parse(raw);
        } catch (e) {
          console.log('WARN:settings file is malformed JSON, skipping');
          process.exit(0);
        }
      }
    } else {
      settings = {};
    }

    if (typeof settings !== 'object' || Array.isArray(settings)) {
      console.log('WARN:settings file has unexpected structure, skipping');
      process.exit(0);
    }

    if (!settings.permissions) settings.permissions = {};
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

    const allow = settings.permissions.allow;
    if (allow.includes(PERM)) {
      console.log('SKIP:mcp__devctx already in permissions');
      process.exit(0);
    }

    allow.push(PERM);
    fs.writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
    console.log('OK:added mcp__devctx to permissions');
  "
}

PERM_RESULT="$(configure_permissions)"

case "$PERM_RESULT" in
  OK:*)    success "  ${PERM_RESULT#OK:}" ;;
  SKIP:*)  echo "  ${PERM_RESULT#SKIP:}" ;;
  WARN:*)  warn "${PERM_RESULT#WARN:}" ;;
esac

# ─── Summary ─────────────────────────────────────────────────────────────────

echo ""
printf "${BOLD}${GREEN}  devctx installed successfully!${RESET}\n"
echo ""

# MCP server status
if [[ "$SCOPE" == "skip" ]]; then
  printf "  MCP server:      ${DIM}skipped${RESET}\n"
else
  printf "  MCP server:      registered (${SCOPE} scope)\n"
fi

# Slash commands
printf "  Slash commands:  %s commands linked\n" "$TOTAL"

# AI narratives
if [[ -n "$API_KEY" ]]; then
  printf "  AI narratives:   enabled\n"
else
  printf "  AI narratives:   ${DIM}disabled (no API key)${RESET}\n"
fi

# Permissions
case "$PERM_RESULT" in
  OK:*|SKIP:*) printf "  Permissions:     mcp__devctx allowed\n" ;;
  *)           printf "  Permissions:     ${YELLOW}manual config needed${RESET}\n" ;;
esac

echo ""
printf "  Get started:  ${CYAN}claude${RESET} → ${CYAN}/devctx-init${RESET}\n"
printf "  Update later: ${DIM}git pull && bash util/install.sh${RESET}\n"
echo ""
