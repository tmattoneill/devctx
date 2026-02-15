#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getRepoRoot, getCurrentBranch, getRecentCommits, getGitStatus, getBranches, getLastPush, getRemoteUrl, getAllBranches, getStashCount, getLastCommitAge, hasGitRepo, initGitRepo, createInitialCommit } from "./services/git.js";
import {
  getProjectState, saveProjectState, updateProjectFocus,
  logActivity, getRecentActivity, getLastActivityByType,
  getTodos, addTodo, updateTodo, removeTodo,
  getBranchNotes, saveBranchNotes, listBranchNotes,
  updateClaudeMd,
  isDevctxActive, setDevctxActive, isDevctxInitialized,
} from "./services/state.js";
import { formatWhereAmI, formatTodoList, formatActivityLog } from "./services/format.js";
import { buildDashboard } from "./services/dashboard.js";
import { generateNarrative, generateGoodbyeSummary } from "./services/narrative.js";
import { scanProject, formatScanReport, generateAutoDescription } from "./services/scanner.js";
import { installHooks } from "./services/hooks.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

// --- Resolve project root ---

/** For init: returns cwd without requiring git */
function resolveCwd(): string {
  return process.cwd();
}

/** For all other tools: requires git repo */
function resolveRepoRoot(): string {
  const cwd = process.cwd();
  const root = getRepoRoot(cwd);
  if (!root) {
    throw new Error(`Not inside a git repository (cwd: ${cwd}). Run \`devctx_init\` first to set up your project.`);
  }
  return root;
}

/** Returns an error response if devctx is paused, or null if active */
function guardActive(repoRoot: string): { content: Array<{ type: "text"; text: string }> } | null {
  if (!isDevctxActive(repoRoot)) {
    return {
      content: [{ type: "text" as const, text: "⏸️ devctx is paused for this project. Use `devctx_start` to resume tracking." }],
    };
  }
  return null;
}

/** Returns an error response if devctx is not initialized, or null if ready */
function guardInitialized(repoRoot: string): { content: Array<{ type: "text"; text: string }>; isError: boolean } | null {
  if (!isDevctxInitialized(repoRoot)) {
    return {
      content: [{ type: "text" as const, text: "⚠️ devctx is not initialized for this project. Use `devctx_init` first." }],
      isError: true,
    };
  }
  return null;
}

// --- Auto-session-start ---

let sessionStarted = false;
let pendingGreeting: string | null = null;

function autoSessionStart(repoRoot: string): void {
  if (sessionStarted || !isDevctxInitialized(repoRoot)) return;

  const wasResumed = !isDevctxActive(repoRoot);

  // Auto-resume if paused — a new MCP process means a new Claude session
  if (wasResumed) {
    setDevctxActive(repoRoot, true);
  }

  const branch = getCurrentBranch(repoRoot);
  logActivity(repoRoot, {
    type: "session_start",
    message: "Session started",
    branch,
  });
  sessionStarted = true;

  // Build greeting for the first tool response
  const state = getProjectState(repoRoot);
  const lines: string[] = [`**devctx is tracking this project.**`];
  if (state.currentFocus) lines.push(`Focus: ${state.currentFocus}`);
  lines.push(`Branch: \`${branch}\``);
  if (wasResumed) lines.push(`Tracking resumed from last session.`);

  // Check for suggested todos from last goodbye
  const todos = getTodos(repoRoot);
  const suggested = todos.filter(t => t.source === "suggested" && t.status === "todo");
  if (suggested.length > 0) {
    lines.push(`${suggested.length} suggested todo(s) from last session — run \`devctx_todo_list\` to review.`);
  }

  lines.push(`Use \`/devctx-goodbye\` when you're done to save session context.`);
  pendingGreeting = lines.join("\n");
}

/** Prepend the one-time session greeting to a tool response */
function withGreeting<T extends { content: Array<{ type: "text"; text: string }> }>(result: T): T {
  if (!pendingGreeting) return result;
  const greeting = pendingGreeting;
  pendingGreeting = null;
  return {
    ...result,
    content: [
      { type: "text" as const, text: greeting + "\n\n---\n" },
      ...result.content,
    ],
  };
}

// --- Server ---

const server = new McpServer({
  name: "devctx-mcp-server",
  version: "1.0.0",
});

// ============================================================
// TOOL: devctx_whereami
// ============================================================
server.registerTool(
  "devctx_whereami",
  {
    title: "Where Am I",
    description: `Get a comprehensive overview of the current project state. Shows: current branch, git status, recent commits, active todos, branch notes, recent activity log, and current focus. Use this when starting a session, returning to a project after time away, or needing context on what's happening.`,
    inputSchema: {
      include_done_todos: z.boolean().default(false).describe("Include completed todos in the overview"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ include_done_todos }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const status = getGitStatus(repoRoot);
    const state = getProjectState(repoRoot);
    const commits = getRecentCommits(repoRoot, 5);
    const todos = getTodos(repoRoot, undefined, include_done_todos ? undefined : undefined);
    const activeTodos = include_done_todos ? todos : todos.filter((t) => t.status !== "done");
    const activity = getRecentActivity(repoRoot, 8);
    const branchNotes = getBranchNotes(repoRoot, status.branch);
    const lastPush = getLastPush(repoRoot);

    const output = formatWhereAmI(repoRoot, status, state, commits, activeTodos, activity, branchNotes, lastPush);

    return withGreeting({ content: [{ type: "text", text: output }] });
  }
);

// ============================================================
// TOOL: devctx_update_focus
// ============================================================
server.registerTool(
  "devctx_update_focus",
  {
    title: "Update Project Focus",
    description: `Update what you're currently working on. This sets the "current focus" shown in whereami and optionally updates the project description. Also syncs to CLAUDE.md so future Claude Code sessions pick up the context.`,
    inputSchema: {
      focus: z.string().min(1).max(500).describe("What you're currently working on"),
      description: z.string().max(1000).optional().describe("Optional project description update"),
      sync_claude_md: z.boolean().default(true).describe("Whether to update CLAUDE.md with the new focus"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ focus, description, sync_claude_md }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const branch = getCurrentBranch(repoRoot);
    const state = updateProjectFocus(repoRoot, focus, description);

    logActivity(repoRoot, {
      type: "note",
      message: `Focus updated: ${focus}`,
      branch,
    });

    if (sync_claude_md) {
      const todos = getTodos(repoRoot);
      updateClaudeMd(repoRoot, branch, state, todos);
    }

    return {
      content: [{ type: "text", text: `✅ Focus updated: **${focus}**\n\nThis will be shown in \`devctx_whereami\` and ${sync_claude_md ? "has been synced to CLAUDE.md" : "was NOT synced to CLAUDE.md"}.` }],
    };
  }
);

// ============================================================
// TOOL: devctx_log
// ============================================================
server.registerTool(
  "devctx_log",
  {
    title: "Log Activity",
    description: `Log a development activity. Creates a timestamped entry in the activity log. **You MUST call this whenever you perform any of these actions:**
- "build": After running any build command (npm run build, tsc, cargo build, make, etc.)
- "run": After starting a dev server, running the app, or executing start scripts (npm run dev, ./start.sh, python manage.py runserver, etc.)
- "test": After running tests (npm test, pytest, vitest, cargo test, etc.)
- "commit": After making a git commit
- "push": After pushing to remote
- "deploy": After deploying to any environment (production, staging, preview)
- "milestone": For significant project events (feature complete, release, etc.)
- "note": For any other notable event

Always log immediately after the action completes. This data powers the VITALS dashboard.`,
    inputSchema: {
      type: z.enum(["commit", "push", "build", "run", "test", "deploy", "note", "milestone", "custom", "branch_switch", "merge"]).describe("Type of activity — use build/run/test for dev commands, commit/push/deploy for git operations"),
      message: z.string().min(1).max(1000).describe("Description of the activity"),
      metadata: z.record(z.string()).optional().describe("Optional key-value metadata"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ type, message, metadata }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const branch = getCurrentBranch(repoRoot);

    logActivity(repoRoot, { type, message, branch, metadata });

    const typeIcon: Record<string, string> = {
      commit: "💾", push: "🚀", build: "🔨", run: "▶️", test: "🧪",
      deploy: "🌐", milestone: "🏆", note: "📝", custom: "📌",
      branch_switch: "🔀", merge: "🔗",
    };
    return {
      content: [{ type: "text", text: `${typeIcon[type] || "📝"} Logged: **${type}** on \`${branch}\`\n${message}` }],
    };
  }
);

// ============================================================
// TOOL: devctx_activity
// ============================================================
server.registerTool(
  "devctx_activity",
  {
    title: "View Activity Log",
    description: `View the activity log. Shows timestamped entries of commits, pushes, builds, deploys, notes, and milestones. Optionally filter by activity type.`,
    inputSchema: {
      count: z.number().int().min(1).max(100).default(20).describe("Number of entries to show"),
      type: z.enum(["commit", "push", "build", "run", "test", "deploy", "note", "milestone", "custom", "branch_switch", "merge"]).optional().describe("Filter by activity type"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ count, type }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const entries = getRecentActivity(repoRoot, count, type);
    const output = formatActivityLog(entries);
    return withGreeting({ content: [{ type: "text", text: output }] });
  }
);

// ============================================================
// TOOL: devctx_todo_add
// ============================================================
server.registerTool(
  "devctx_todo_add",
  {
    title: "Add Todo",
    description: `Add a new todo item. Todos can be scoped to a branch, prioritized, and tagged. They appear in whereami and can be synced to CLAUDE.md.`,
    inputSchema: {
      text: z.string().min(1).max(500).describe("The todo item text"),
      priority: z.enum(["low", "medium", "high", "critical"]).default("medium").describe("Priority level"),
      branch: z.string().optional().describe("Scope todo to a specific branch (defaults to current)"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
      sync_claude_md: z.boolean().default(true).describe("Whether to update CLAUDE.md"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, priority, branch, tags, sync_claude_md }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const currentBranch = getCurrentBranch(repoRoot);
    const todo = addTodo(repoRoot, text, priority, branch || currentBranch, tags);

    logActivity(repoRoot, {
      type: "note",
      message: `Todo added: ${text} [${priority}]`,
      branch: currentBranch,
    });

    if (sync_claude_md) {
      const state = getProjectState(repoRoot);
      const todos = getTodos(repoRoot);
      updateClaudeMd(repoRoot, currentBranch, state, todos);
    }

    return {
      content: [{ type: "text", text: `✅ Todo added: **${text}**\nID: \`${todo.id}\` | Priority: ${priority} | Branch: \`${todo.branch || "all"}\`` }],
    };
  }
);

// ============================================================
// TOOL: devctx_todo_update
// ============================================================
server.registerTool(
  "devctx_todo_update",
  {
    title: "Update Todo",
    description: `Update an existing todo item. Change its status (todo, in_progress, done, blocked), priority, text, or tags. Use the todo ID from devctx_todo_list.`,
    inputSchema: {
      id: z.string().describe("The todo ID (e.g., todo_abc123)"),
      status: z.enum(["todo", "in_progress", "done", "blocked"]).optional().describe("New status"),
      text: z.string().max(500).optional().describe("Updated text"),
      priority: z.enum(["low", "medium", "high", "critical"]).optional().describe("Updated priority"),
      tags: z.array(z.string()).optional().describe("Updated tags"),
      sync_claude_md: z.boolean().default(true).describe("Whether to update CLAUDE.md"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id, status, text, priority, tags, sync_claude_md }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const updates: Record<string, unknown> = {};
    if (status) updates.status = status;
    if (text) updates.text = text;
    if (priority) updates.priority = priority;
    if (tags) updates.tags = tags;

    const todo = updateTodo(repoRoot, id, updates);
    if (!todo) {
      return { content: [{ type: "text", text: `❌ Todo \`${id}\` not found.` }], isError: true };
    }

    if (sync_claude_md) {
      const state = getProjectState(repoRoot);
      const todos = getTodos(repoRoot);
      const branch = getCurrentBranch(repoRoot);
      updateClaudeMd(repoRoot, branch, state, todos);
    }

    return {
      content: [{ type: "text", text: `✅ Todo \`${id}\` updated: **${todo.text}** → ${todo.status}` }],
    };
  }
);

// ============================================================
// TOOL: devctx_todo_list
// ============================================================
server.registerTool(
  "devctx_todo_list",
  {
    title: "List Todos",
    description: `List all todos, optionally filtered by branch or status. Shows priority, status, tags, and IDs.`,
    inputSchema: {
      branch: z.string().optional().describe("Filter todos by branch"),
      status: z.enum(["todo", "in_progress", "done", "blocked"]).optional().describe("Filter by status"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ branch, status }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const todos = getTodos(repoRoot, branch, status);
    const output = formatTodoList(todos, branch);
    return withGreeting({ content: [{ type: "text", text: output }] });
  }
);

// ============================================================
// TOOL: devctx_todo_remove
// ============================================================
server.registerTool(
  "devctx_todo_remove",
  {
    title: "Remove Todo",
    description: `Remove a todo item by ID. Use devctx_todo_list to find IDs.`,
    inputSchema: {
      id: z.string().describe("The todo ID to remove"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const removed = removeTodo(repoRoot, id);
    if (!removed) {
      return { content: [{ type: "text", text: `❌ Todo \`${id}\` not found.` }], isError: true };
    }
    return { content: [{ type: "text", text: `🗑️ Todo \`${id}\` removed.` }] };
  }
);

// ============================================================
// TOOL: devctx_branch_notes
// ============================================================
server.registerTool(
  "devctx_branch_notes",
  {
    title: "Get Branch Notes",
    description: `Get the notes/documentation for a specific branch. Each branch can have its own .md file with context, decisions, and notes.`,
    inputSchema: {
      branch: z.string().optional().describe("Branch name (defaults to current branch)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ branch }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const b = branch || getCurrentBranch(repoRoot);
    const notes = getBranchNotes(repoRoot, b);

    if (!notes) {
      return { content: [{ type: "text", text: `No notes found for branch \`${b}\`. Use \`devctx_branch_notes_save\` to create them.` }] };
    }
    return { content: [{ type: "text", text: `# 📋 Branch Notes: \`${b}\`\n\n${notes}` }] };
  }
);

// ============================================================
// TOOL: devctx_branch_notes_save
// ============================================================
server.registerTool(
  "devctx_branch_notes_save",
  {
    title: "Save Branch Notes",
    description: `Save or update the notes for a branch. This creates/overwrites the branch-specific .md file in .devctx/branches/. Use for documenting what a branch is for, key decisions, implementation notes, etc.`,
    inputSchema: {
      branch: z.string().optional().describe("Branch name (defaults to current branch)"),
      content: z.string().min(1).max(10000).describe("Markdown content for the branch notes"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ branch, content }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const b = branch || getCurrentBranch(repoRoot);
    saveBranchNotes(repoRoot, b, content);

    logActivity(repoRoot, {
      type: "note",
      message: `Branch notes updated for \`${b}\``,
      branch: b,
    });

    return { content: [{ type: "text", text: `✅ Branch notes saved for \`${b}\` (${content.length} chars)` }] };
  }
);

// ============================================================
// TOOL: devctx_sync
// ============================================================
server.registerTool(
  "devctx_sync",
  {
    title: "Sync to CLAUDE.md",
    description: `Force a sync of the current devctx state (focus, todos, branch info) into CLAUDE.md. This updates the auto-managed section between the CLAUDETTE markers.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const branch = getCurrentBranch(repoRoot);
    const state = getProjectState(repoRoot);
    const todos = getTodos(repoRoot);
    updateClaudeMd(repoRoot, branch, state, todos);

    return {
      content: [{ type: "text", text: `✅ CLAUDE.md synced with current devctx state.\nBranch: \`${branch}\` | Focus: ${state.currentFocus || "(not set)"} | Active todos: ${todos.filter((t) => t.status !== "done").length}` }],
    };
  }
);

// ============================================================
// TOOL: devctx_init
// ============================================================
server.registerTool(
  "devctx_init",
  {
    title: "Initialize devctx",
    description: `Initialize devctx for the current directory. Handles all scenarios:
- Empty directory: creates git repo, .devctx structure, initial commit
- Files but no git: initializes git, scans project, creates .devctx, initial commit
- Existing git repo: scans project, creates .devctx, syncs to CLAUDE.md
- Already initialized: shows current state (use force to re-scan and update)

Auto-detects: language, frameworks, build tools, CI/CD, infra, package metadata.
Safe to run multiple times — won't overwrite existing data without force flag.`,
    inputSchema: {
      project_name: z.string().optional().describe("Project name (defaults to detected name or directory name)"),
      description: z.string().max(1000).optional().describe("Project description (auto-detected from package.json etc. if not provided)"),
      focus: z.string().max(500).optional().describe("Initial focus/what you're working on"),
      force: z.boolean().default(false).describe("Re-initialize: re-scan project and update metadata (preserves todos, activity log)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ project_name, description, focus, force }) => {
    const cwd = resolveCwd();

    // ── Step 1: Scan the project ──
    const scan = scanProject(cwd);
    const output: string[] = [];

    // ── Step 2: Handle already-initialized ──
    if (scan.environment === "git_with_devctx" && !force) {
      const existingState = getProjectState(cwd);
      return {
        content: [{
          type: "text",
          text: [
            `ℹ️ devctx is already initialized for **${existingState.projectName}**.`,
            "",
            `**Status:** ${existingState.active !== false ? "▶️ Active" : "⏸️ Paused"}`,
            `**Focus:** ${existingState.currentFocus || "(not set)"}`,
            `**Last updated:** ${new Date(existingState.lastUpdated).toLocaleString()}`,
            "",
            "Use `devctx_whereami` for full context, or re-run with `force: true` to re-scan and update metadata.",
          ].join("\n"),
        }],
      };
    }

    // ── Step 3: Create git if needed ──
    let gitCreated = false;
    let initialCommitMade = false;

    if (scan.environment === "empty" || scan.environment === "files_no_git") {
      output.push("**🔧 Setting up git...**");

      const success = initGitRepo(cwd);
      if (!success) {
        return {
          content: [{ type: "text", text: "❌ Failed to initialize git repository. Check directory permissions." }],
          isError: true,
        };
      }
      gitCreated = true;
      output.push("  ✅ Git repository initialized (`main` branch)");
    }

    // From this point, we have a git repo. Resolve root.
    const repoRoot = getRepoRoot(cwd) || cwd;

    // ── Step 4: Create .devctx structure ──
    const alreadyInitialized = isDevctxInitialized(repoRoot);
    const state = getProjectState(repoRoot); // Creates .devctx/ if needed

    // Apply user overrides or auto-detected values
    state.projectName = project_name || scan.detectedName || state.projectName || scan.dirName;
    state.description = description || scan.detectedDescription || generateAutoDescription(scan) || state.description;
    if (focus) state.currentFocus = focus;
    state.active = true;
    saveProjectState(repoRoot, state);

    if (!alreadyInitialized) {
      output.push("");
      output.push("**📁 Created .devctx/ structure:**");
      output.push("  ✅ `.devctx/` directory (added to .gitignore)");
      output.push("  ✅ Project state file");
      output.push("  ✅ Activity log");
    } else {
      output.push("");
      output.push("**🔄 Re-scanned project (force mode)**");
    }

    // ── Step 5: Initial commit if we created git ──
    if (gitCreated) {
      const commitMsg = scan.environment === "empty"
        ? "Initial commit (devctx)"
        : "Initial commit — devctx initialized";
      const committed = createInitialCommit(repoRoot, commitMsg);
      if (committed) {
        initialCommitMade = true;
        output.push("  ✅ Initial commit created");
      }
    }

    // ── Step 6: Gather git info (now that git definitely exists) ──
    const branch = getCurrentBranch(repoRoot);
    const branches = getBranches(repoRoot);
    const commits = getRecentCommits(repoRoot, 3);
    const remote = getRemoteUrl(repoRoot);

    // ── Step 7: Log the init event ──
    logActivity(repoRoot, {
      type: "milestone",
      message: alreadyInitialized
        ? `devctx re-initialized (force) — scanned: ${scan.languages.join(", ") || "unknown"}`
        : `devctx initialized — ${scan.languages.join(", ") || "new project"}`,
      branch,
      metadata: {
        environment: scan.environment,
        languages: scan.languages.join(", "),
        frameworks: scan.frameworks.join(", "),
        ...(gitCreated ? { git_created: "true" } : {}),
        ...(initialCommitMade ? { initial_commit: "true" } : {}),
      },
    });

    // ── Step 6b: Install git hooks ──
    const hookResult = installHooks(repoRoot);
    if (hookResult.installed.length > 0) {
      output.push(`  ✅ Git hooks installed: ${hookResult.installed.join(", ")}`);
    }
    if (hookResult.skipped.length > 0) {
      output.push(`  ⚠️ Hooks skipped: ${hookResult.skipped.join(", ")}`);
    }

    // ── Step 8: Sync to CLAUDE.md (skip for truly empty projects) ──
    if (scan.environment !== "empty" || focus) {
      const todos = getTodos(repoRoot);
      updateClaudeMd(repoRoot, branch, state, todos);
      output.push("  ✅ CLAUDE.md updated");
    }

    // ── Step 9: Build the report ──
    const header = gitCreated
      ? (scan.environment === "empty"
        ? "🎉 New project created from scratch!"
        : "🎉 Existing files detected — git initialized and project scanned!")
      : (alreadyInitialized
        ? "🔄 devctx re-initialized with fresh scan!"
        : "🎉 devctx initialized for existing project!");

    const report: string[] = [
      header,
      "",
      `**Project:** ${state.projectName}`,
      `**Description:** ${state.description || "(not set)"}`,
      ...(state.currentFocus ? [`**Focus:** ${state.currentFocus}`] : []),
      "",
      "---",
      "",
      "**🔍 Project Scan Results:**",
      formatScanReport(scan),
      "",
      "---",
      "",
      ...output,
    ];

    // Git state section
    if (commits.length > 0 || branches.length > 0) {
      report.push("");
      report.push("**🔀 Git State:**");
      report.push(`- Branch: \`${branch}\``);
      if (branches.length > 1) {
        report.push(`- Branches: ${branches.length} (${branches.slice(0, 5).map(b => `\`${b}\``).join(", ")}${branches.length > 5 ? "..." : ""})`);
      }
      report.push(`- Remote: ${remote}`);
      if (commits.length > 0) {
        report.push(`- Recent: ${commits.slice(0, 3).map(c => `\`${c.shortHash}\` ${c.subject}`).join(", ")}`);
      }
    }

    report.push("");
    report.push("---");
    report.push("");
    report.push("✅ Ready. Use `/devctx-status` for the full dashboard or `/devctx-whereami` for project context.");

    return {
      content: [{ type: "text", text: report.join("\n") }],
    };
  }
);

// ============================================================
// TOOL: devctx_stop
// ============================================================
server.registerTool(
  "devctx_stop",
  {
    title: "Pause devctx Tracking",
    description: `Pause devctx for the current project. When paused, all write operations (logging, todos, focus updates, CLAUDE.md sync) are disabled. Read operations (whereami, git_summary, viewing todos/activity) still work. Existing data is preserved. Use devctx_start to resume.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const state = setDevctxActive(repoRoot, false);

    return {
      content: [{ type: "text", text: `⏸️ devctx paused for **${state.projectName}**.\n\nRead operations still work — you can still use \`devctx_whereami\`, view todos, and check git status.\nWrite operations (logging, todo changes, focus updates) are disabled until you run \`devctx_start\`.` }],
    };
  }
);

// ============================================================
// TOOL: devctx_start
// ============================================================
server.registerTool(
  "devctx_start",
  {
    title: "Resume devctx Tracking",
    description: `Resume devctx tracking after it was paused with devctx_stop. Re-enables all write operations (logging, todos, focus updates, CLAUDE.md sync).`,
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const state = setDevctxActive(repoRoot, true);

    logActivity(repoRoot, {
      type: "session_start",
      message: "devctx tracking resumed",
      branch: getCurrentBranch(repoRoot),
    });

    return {
      content: [{ type: "text", text: `▶️ devctx resumed for **${state.projectName}**.\n\nAll operations are active. Current focus: ${state.currentFocus || "(not set)"}\nUse \`devctx_whereami\` to see where you left off.` }],
    };
  }
);

// ============================================================
// TOOL: devctx_status
// ============================================================
server.registerTool(
  "devctx_status",
  {
    title: "devctx Status Dashboard",
    description: `Full project status dashboard. Shows current branch, all unmerged branches with last commit, active todos, last push/build/deploy/commit times, and key vitals — all in a formatted overview. Optionally includes an AI-generated narrative summary at the top that recaps the last session and suggests next steps. The go-to command for getting back up to speed.`,
    inputSchema: {
      narrative: z.boolean().default(true).describe("Include AI-generated narrative summary at the top (requires ANTHROPIC_API_KEY env var, falls back to deterministic summary)"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ narrative: includeNarrative }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);

    if (!isDevctxInitialized(repoRoot)) {
      return {
        content: [{ type: "text", text: `⚪ devctx is **not initialized** for this project (\`${repoRoot}\`).\nRun \`devctx_init\` to set it up.` }],
      };
    }

    const state = getProjectState(repoRoot);
    const status = getGitStatus(repoRoot);
    const branches = getAllBranches(repoRoot);
    const todos = getTodos(repoRoot);
    const vitals = getLastActivityByType(repoRoot);
    const lastPush = getLastPush(repoRoot);
    const remote = getRemoteUrl(repoRoot);
    const stashCount = getStashCount(repoRoot);
    const lastCommitAge = getLastCommitAge(repoRoot);
    const recentCommits = getRecentCommits(repoRoot, 10);
    const recentActivity = getRecentActivity(repoRoot, 15);
    const branchNotes = getBranchNotes(repoRoot, status.branch);

    let narrativeText: string | undefined;
    if (includeNarrative) {
      narrativeText = await generateNarrative({
        state,
        status,
        branches,
        recentCommits,
        recentActivity,
        todos,
        branchNotes,
        lastPush,
        repoRoot,
      });
    }

    const dashboard = buildDashboard({
      state,
      status,
      branches,
      todos,
      vitals,
      lastPush,
      remote,
      stashCount,
      lastCommitAge,
      narrative: narrativeText,
    });

    return withGreeting({
      content: [{ type: "text", text: dashboard }],
    });
  }
);

// ============================================================
// TOOL: devctx_summary
// ============================================================
server.registerTool(
  "devctx_summary",
  {
    title: "AI Project Summary",
    description: `Generate an AI-written narrative summary of the project state. Recaps the last session (what was done, committed, pushed, deployed), describes current state, and lists prioritized next steps — all drawn from git history, activity log, and todos. Requires ANTHROPIC_API_KEY; falls back to a deterministic summary without it.`,
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false, // AI output varies
      openWorldHint: true,
    },
  },
  async () => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const state = getProjectState(repoRoot);
    const status = getGitStatus(repoRoot);
    const branches = getAllBranches(repoRoot);
    const recentCommits = getRecentCommits(repoRoot, 10);
    const recentActivity = getRecentActivity(repoRoot, 15);
    const todos = getTodos(repoRoot);
    const branchNotes = getBranchNotes(repoRoot, status.branch);
    const lastPush = getLastPush(repoRoot);

    const narrative = await generateNarrative({
      state,
      status,
      branches,
      recentCommits,
      recentActivity,
      todos,
      branchNotes,
      lastPush,
      repoRoot,
    });

    const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

    return withGreeting({
      content: [{
        type: "text",
        text: `# 📋 Project Summary — ${state.projectName}\n${hasApiKey ? "" : "*(deterministic fallback — set ANTHROPIC_API_KEY for AI narrative)*\n"}\n${narrative}`,
      }],
    });
  }
);

// ============================================================
// TOOL: devctx_git_summary
// ============================================================
server.registerTool(
  "devctx_git_summary",
  {
    title: "Git Summary",
    description: `Get a focused git summary: recent commits across branches, status, last push info, and available branches. More git-focused than whereami.`,
    inputSchema: {
      commit_count: z.number().int().min(1).max(50).default(10).describe("Number of recent commits to show"),
      branch: z.string().optional().describe("Show commits for a specific branch"),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ commit_count, branch }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const status = getGitStatus(repoRoot);
    const commits = getRecentCommits(repoRoot, commit_count, branch);
    const branches = getBranches(repoRoot);
    const lastPush = getLastPush(repoRoot, branch);
    const remote = getRemoteUrl(repoRoot);

    const lines: string[] = [
      `# 🔀 Git Summary`,
      `**Remote:** ${remote}`,
      `**Current Branch:** \`${status.branch}\``,
      `**Last Push:** ${lastPush}`,
      "",
      `## Branches (${branches.length})`,
      branches.map((b) => `- ${b === status.branch ? "→ " : "  "}\`${b}\``).join("\n"),
      "",
      `## Status`,
    ];

    if (status.isClean) {
      lines.push("Working tree clean ✨");
    } else {
      if (status.staged.length) lines.push(`Staged: ${status.staged.join(", ")}`);
      if (status.modified.length) lines.push(`Modified: ${status.modified.join(", ")}`);
      if (status.untracked.length) lines.push(`Untracked: ${status.untracked.join(", ")}`);
    }
    if (status.ahead) lines.push(`⬆️ ${status.ahead} ahead`);
    if (status.behind) lines.push(`⬇️ ${status.behind} behind`);

    lines.push("", `## Recent Commits${branch ? ` (${branch})` : ""}`);
    for (const c of commits) {
      lines.push(`- \`${c.shortHash}\` ${c.subject} — *${c.author}* (${new Date(c.date).toLocaleDateString()})`);
    }

    return withGreeting({ content: [{ type: "text", text: lines.join("\n") }] });
  }
);

// ============================================================
// TOOL: devctx_goodbye
// ============================================================
server.registerTool(
  "devctx_goodbye",
  {
    title: "Session Wrap-Up (Goodbye)",
    description: `Save a comprehensive session summary and wrap up for the day. This is the "save game" button — generates an AI-written session record with what happened, unfinished work, and suggested next steps. Auto-adds smart todos and pauses tracking. Run this when you're done working.`,
    inputSchema: {
      message: z.string().max(1000).optional().describe("Optional parting note (e.g., 'picking this up Thursday', 'blocked on API key from Dave')"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ message: userMessage }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    try {
      const state = getProjectState(repoRoot);
      const status = getGitStatus(repoRoot);
      const branches = getAllBranches(repoRoot);
      const recentCommits = getRecentCommits(repoRoot, 15);
      const recentActivity = getRecentActivity(repoRoot, 30);
      const todos = getTodos(repoRoot);
      const branchNotes = getBranchNotes(repoRoot, status.branch);
      const lastPush = getLastPush(repoRoot);

      // Read CLAUDE.md
      let claudeMdContent = "";
      const claudeMdPath = join(repoRoot, "CLAUDE.md");
      if (existsSync(claudeMdPath)) {
        try { claudeMdContent = readFileSync(claudeMdPath, "utf-8"); } catch { /* skip */ }
      }

      // Calculate session duration
      const sessionStarts = recentActivity.filter(a => a.type === "session_start");
      let sessionDuration: string | undefined;
      if (sessionStarts.length > 0) {
        const startTime = new Date(sessionStarts[0].timestamp).getTime();
        const now = Date.now();
        const diffMs = now - startTime;
        const mins = Math.floor(diffMs / 60000);
        if (mins < 60) sessionDuration = `${mins} minutes`;
        else {
          const hrs = Math.floor(mins / 60);
          const remainMins = mins % 60;
          sessionDuration = `${hrs}h ${remainMins}m`;
        }
      }

      // Count commits this session
      const commitCount = recentCommits.length;

      // Generate goodbye summary
      const { narrative, todos: suggestedTodos } = await generateGoodbyeSummary({
        state,
        status,
        branches,
        recentCommits,
        recentActivity,
        todos,
        branchNotes,
        lastPush,
        repoRoot,
        claudeMdContent,
        userMessage,
        sessionDuration,
        commitCount,
      });

      // Save session record
      const sessionsDir = join(repoRoot, ".devctx", "sessions");
      mkdirSync(sessionsDir, { recursive: true });

      const now = new Date();
      const dateStr = now.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
      const sessionFile = join(sessionsDir, `${dateStr}.md`);

      const sessionRecord = [
        `# Session: ${now.toLocaleDateString()} ${now.toLocaleTimeString()}`,
        `**Branch:** ${status.branch}`,
        ...(sessionDuration ? [`**Duration:** ${sessionDuration}`] : []),
        `**Commits:** ${commitCount}`,
        ...(userMessage ? [`\n> ${userMessage}`] : []),
        "",
        "---",
        "",
        narrative,
        "",
        "---",
        "",
        "## Auto-generated todos",
        ...(suggestedTodos.length > 0
          ? suggestedTodos.map(t => `- [${t.priority}] ${t.text}`)
          : ["(none)"]),
        "",
      ].join("\n");

      writeFileSync(sessionFile, sessionRecord);

      // Add suggested todos
      const branch = getCurrentBranch(repoRoot);
      for (const t of suggestedTodos) {
        addTodo(repoRoot, t.text, t.priority as "low" | "medium" | "high" | "critical", branch, undefined, "suggested");
      }

      // Log session end
      logActivity(repoRoot, {
        type: "session_end",
        message: "Session ended — goodbye summary saved",
        branch,
      });

      // Pause tracking
      setDevctxActive(repoRoot, false);

      // Sync CLAUDE.md
      const updatedState = getProjectState(repoRoot);
      const updatedTodos = getTodos(repoRoot);
      updateClaudeMd(repoRoot, branch, updatedState, updatedTodos);

      // Count branches worked on
      const branchSet = new Set(recentActivity.map(a => a.branch));

      return {
        content: [{
          type: "text",
          text: [
            `👋 **Session saved.**`,
            `${commitCount} commit(s) across ${branchSet.size} branch(es). ${suggestedTodos.length} suggested todo(s) added.`,
            ...(sessionDuration ? [`Duration: ${sessionDuration}.`] : []),
            "",
            `Session record: \`.devctx/sessions/${dateStr}.md\``,
            "",
            "Tracking paused. See you next time!",
          ].join("\n"),
        }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`devctx_goodbye error: ${errMsg}`);
      // Still try to log and pause even on error
      try {
        const branch = getCurrentBranch(repoRoot);
        logActivity(repoRoot, { type: "session_end", message: `Session ended (with errors: ${errMsg})`, branch });
        setDevctxActive(repoRoot, false);
      } catch { /* best effort */ }
      return {
        content: [{
          type: "text",
          text: `⚠️ Goodbye completed with errors: ${errMsg}\n\nTracking has been paused. Session record may be incomplete.`,
        }],
      };
    }
  }
);

// ============================================================
// TOOL: devctx_help
// ============================================================
server.registerTool(
  "devctx_help",
  {
    title: "Help — Slash Commands & Tools",
    description: "Show available devctx slash commands and what they do. Run this when the user asks for help with devctx.",
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const help = [
      "# devctx — Slash Commands",
      "",
      "| Command | What it does |",
      "|---------|-------------|",
      "| `/devctx-init` | Initialize devctx for the current project. Detects language, framework, sets up tracking. |",
      "| `/devctx-whereami` | Full overview — branch, focus, recent commits, todos, activity. |",
      "| `/devctx-status` | Dashboard view — vitals, branches, todos, last actions, AI recap. |",
      "| `/devctx-summary` | AI-generated narrative summary of the project state. |",
      "| `/devctx-focus` | Update what you're currently working on. Text after the command becomes the focus. |",
      "| `/devctx-todos` | List todos. Also handles adding, updating, or removing if you say so. |",
      "| `/devctx-git` | Git summary — recent commits, branches, remote info. |",
      "| `/devctx-goodbye` | End-of-session wrap-up. Saves an AI summary, suggests todos, pauses tracking. |",
      "| `/devctx-start` | Resume tracking (happens automatically on new sessions). |",
      "| `/devctx-stop` | Pause tracking manually. Read-only tools still work. |",
      "| `/devctx-help` | This help screen. |",
      "",
      "## How it works",
      "",
      "devctx tracks project context in a `.devctx/` directory (gitignored) and syncs key info to `CLAUDE.md`.",
      "Git hooks capture commits, branch switches, merges, and pushes from any terminal.",
      "On new sessions, tracking resumes automatically and Claude greets you with project context.",
      "Use `/devctx-goodbye` when you're done to save a session record for next time.",
      "",
      "## Tips",
      "",
      "- `/devctx-status` is the best single command for getting oriented.",
      "- After `/devctx-goodbye`, suggested todos carry forward to the next session.",
      "- You don't need to manually log commits or pushes — git hooks handle that.",
      "- Branch notes (`devctx_branch_notes_save`) are great for documenting what a branch is for.",
    ].join("\n");

    return { content: [{ type: "text" as const, text: help }] };
  }
);

// ============================================================
// Start server
// ============================================================

// Prevent unhandled rejections from crashing the server process
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection in devctx MCP server:", reason);
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("devctx MCP server running (stdio)");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
