#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { getRepoRoot, getCurrentBranch, getRecentCommits, getGitStatus, getBranches, getLastPush, getRemoteUrl, getAllBranches, getStashCount, getLastCommitAge, hasGitRepo, initGitRepo, createInitialCommit, commitFiles, gitCommit, gitPush, gitPull, gitCheckout, gitMerge, gitStash, getVersionTags, getCommitsSinceTag, gitTag, gitPushTag } from "./services/git.js";
import {
  getProjectState, saveProjectState, updateProjectFocus,
  logActivity, getRecentActivity, getLastActivityByType,
  getTodos, addTodo, updateTodo, removeTodo, cleanupTodos, normalizeForComparison, isSimilarToAny,
  getBranchNotes, saveBranchNotes, listBranchNotes,
  updateContextFiles, updateStatusLineCache,
  isDevctxActive, setDevctxActive, isDevctxInitialized,
  saveSourceTodos, getSourceTodos,
  saveSessionRecord,
  getLinearConfig, saveLinearConfig, markTodoSynced, markTodoSyncFailed,
  readContextFile, existingContextFiles,
} from "./shared/index.js";
import { fetchViewerAndTeams, syncWithLinear, pushLinkedTodo } from "./services/linear.js";
import { formatWhereAmI, formatTodoList, formatActivityLog } from "./services/format.js";
import { buildDashboard } from "./services/dashboard.js";
import { generateNarrative, generateGoodbyeSummary } from "./services/narrative.js";
import { aiStatusBanner } from "./services/ai-status.js";
import { getCurrentVersion, bumpVersion, generateVersionSuggestion, fallbackVersionSuggestion } from "./services/version.js";
import { scanProject, formatScanReport, generateAutoDescription, scanSourceTodos, formatSourceTodos } from "./services/scanner.js";
import { installHooks } from "./services/hooks.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

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

/** Sync both CLAUDE.md and status line cache in one call */
function syncSideEffects(repoRoot: string, branch: string, state: ReturnType<typeof getProjectState>, todos: ReturnType<typeof getTodos>): void {
  updateContextFiles(repoRoot, branch, state, todos);
  updateStatusLineCache(repoRoot, branch);
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

  // Write initial status line cache
  updateStatusLineCache(repoRoot, branch);

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

  lines.push(`Run \`devctx-goodbye\` when you're done to save session context.`);
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

// Read from package.json so the version reported over MCP cannot drift from
// the published one.
const pkg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf-8"),
) as { version: string };

const server = new McpServer({
  name: "devctx-mcp-server",
  version: pkg.version,
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
    const versionTags = getVersionTags(repoRoot);
    const currentVersion = getCurrentVersion(versionTags);

    const output = formatWhereAmI(repoRoot, status, state, commits, activeTodos, activity, branchNotes, lastPush, currentVersion !== "none" ? currentVersion : undefined);

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
    description: `Update what you're currently working on. This sets the "current focus" shown in whereami and optionally updates the project description. Also syncs to CLAUDE.md (and AGENTS.md when present) so future sessions pick up the context.`,
    inputSchema: {
      focus: z.string().min(1).max(500).describe("What you're currently working on"),
      description: z.string().max(1000).optional().describe("Optional project description update"),
      sync_context: z.boolean().default(true).describe("Whether to update CLAUDE.md (and AGENTS.md when present) with the new focus"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ focus, description, sync_context }) => {
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

    if (sync_context) {
      const todos = getTodos(repoRoot);
      syncSideEffects(repoRoot, branch, state, todos);
    } else {
      updateStatusLineCache(repoRoot, branch);
    }

    return {
      content: [{ type: "text", text: `✅ Focus updated: **${focus}**\n\nThis will be shown in \`devctx_whereami\` and ${sync_context ? "has been synced to your project context files" : "was NOT synced to your project context files"}.` }],
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
      type: z.enum(["commit", "push", "build", "run", "test", "deploy", "note", "milestone", "custom", "branch_switch", "merge", "version"]).describe("Type of activity — use build/run/test for dev commands, commit/push/deploy for git operations"),
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
    updateStatusLineCache(repoRoot, branch);

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
      type: z.enum(["commit", "push", "build", "run", "test", "deploy", "note", "milestone", "custom", "branch_switch", "merge", "version"]).optional().describe("Filter by activity type"),
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
    description: `Add a new todo item. Todos can be scoped to a branch, prioritized, and tagged. They appear in whereami and can be synced to CLAUDE.md (and AGENTS.md when present).`,
    inputSchema: {
      text: z.string().min(1).max(500).describe("The todo item text"),
      priority: z.enum(["low", "medium", "high", "critical"]).default("medium").describe("Priority level"),
      branch: z.string().optional().describe("Scope todo to a specific branch (defaults to current)"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
      sync_context: z.boolean().default(true).describe("Whether to update CLAUDE.md (and AGENTS.md when present)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, priority, branch, tags, sync_context }) => {
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

    if (sync_context) {
      const state = getProjectState(repoRoot);
      const todos = getTodos(repoRoot);
      syncSideEffects(repoRoot, currentBranch, state, todos);
    } else {
      updateStatusLineCache(repoRoot, currentBranch);
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
      promote: z.boolean().optional().describe("Mark an AI-suggested todo as one you own. Suggested todos are never pushed to Linear until promoted."),
      sync_context: z.boolean().default(true).describe("Whether to update CLAUDE.md (and AGENTS.md when present)"),
      sync_linear: z.boolean().default(true).describe("Whether to push status/priority changes to Linear if the todo has a linearId and LINEAR_API_KEY is set"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ id, status, text, priority, tags, promote, sync_context, sync_linear }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;

    const updates: Record<string, unknown> = {};
    if (status) updates.status = status;
    if (text) updates.text = text;
    if (priority) updates.priority = priority;
    if (tags) updates.tags = tags;
    if (promote) updates.source = "manual";

    const todo = updateTodo(repoRoot, id, updates);
    if (!todo) {
      return { content: [{ type: "text", text: `❌ Todo \`${id}\` not found.` }], isError: true };
    }

    // Push to Linear before reporting back. This is awaited on purpose: marking
    // a todo done is supposed to close its Linear issue, and a fire-and-forget
    // push would report success here whether or not that actually happened.
    let linearNote = "";
    if (sync_linear && todo.linearId && process.env.LINEAR_API_KEY) {
      try {
        await pushLinkedTodo(repoRoot, process.env.LINEAR_API_KEY, todo);
        markTodoSynced(repoRoot, todo.id);
        const ref = todo.linearIdentifier ?? "the linked Linear issue";
        linearNote = todo.status === "done"
          ? `\n🔗 Closed ${ref} in Linear.`
          : `\n🔗 Synced ${ref} to Linear (${todo.status}).`;
      } catch (error) {
        // The local update stands; only the push failed. Record it so
        // devctx_todo_list keeps showing the todo as out of sync.
        const detail = error instanceof Error ? error.message : String(error);
        markTodoSyncFailed(repoRoot, todo.id, detail);
        linearNote = `\n⚠️ Linear sync failed: ${detail}`;
      }
    }

    if (sync_context) {
      const state = getProjectState(repoRoot);
      const todos = getTodos(repoRoot);
      const branch = getCurrentBranch(repoRoot);
      syncSideEffects(repoRoot, branch, state, todos);
    } else {
      updateStatusLineCache(repoRoot, getCurrentBranch(repoRoot));
    }

    return {
      content: [{ type: "text", text: `✅ Todo \`${id}\` updated: **${todo.text}** → ${todo.status}${linearNote}` }],
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
    updateStatusLineCache(repoRoot, getCurrentBranch(repoRoot));
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
    title: "Sync project context files",
    description: `Force a sync of the current devctx state (focus, todos, branch info) into CLAUDE.md, and into AGENTS.md when the repo keeps one. This updates the auto-managed section between the devctx markers.`,
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
    syncSideEffects(repoRoot, branch, state, todos);

    return {
      content: [{ type: "text", text: `✅ Project context synced.\nBranch: \`${branch}\` | Focus: ${state.currentFocus || "(not set)"} | Active todos: ${todos.filter((t) => t.status !== "done").length}` }],
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
- Existing git repo: scans project, creates .devctx, syncs to CLAUDE.md (and AGENTS.md when present)
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
      syncSideEffects(repoRoot, branch, state, todos);
      output.push("  ✅ Project context updated");
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

    // ── Step 9b: Scan source TODOs ──
    const sourceTodos = scanSourceTodos(repoRoot);
    if (sourceTodos.length > 0) {
      saveSourceTodos(repoRoot, sourceTodos);
      report.push("---");
      report.push("");
      report.push("**📝 Source Code TODOs:**");
      report.push(formatSourceTodos(sourceTodos));
      report.push("");
    }

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
    report.push("✅ Ready. Run `devctx-status` for the full dashboard or `devctx-whereami` for project context.");

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
    description: `Pause devctx for the current project. When paused, all write operations (logging, todos, focus updates, context file sync) are disabled. Read operations (whereami, git_summary, viewing todos/activity) still work. Existing data is preserved. Use devctx_start to resume.`,
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
    updateStatusLineCache(repoRoot, getCurrentBranch(repoRoot));

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
    description: `Resume devctx tracking after it was paused with devctx_stop. Re-enables all write operations (logging, todos, focus updates, context file sync).`,
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

    // Ensure git hooks are installed (idempotent)
    const hookResult = installHooks(repoRoot);

    const startBranch = getCurrentBranch(repoRoot);
    logActivity(repoRoot, {
      type: "session_start",
      message: "devctx tracking resumed",
      branch: startBranch,
    });
    updateStatusLineCache(repoRoot, startBranch);

    const hookNote = hookResult.installed.length > 0
      ? `\n✅ Git hooks verified: ${hookResult.installed.join(", ")}`
      : "";

    return {
      content: [{ type: "text", text: `▶️ devctx resumed for **${state.projectName}**.\n\nAll operations are active. Current focus: ${state.currentFocus || "(not set)"}\nUse \`devctx_whereami\` to see where you left off.${hookNote}` }],
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

    const versionTags = getVersionTags(repoRoot);
    const currentVersion = getCurrentVersion(versionTags);

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
      currentVersion: currentVersion !== "none" ? currentVersion : undefined,
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

    return withGreeting({
      content: [{
        type: "text",
        text: `# 📋 Project Summary — ${state.projectName}\n${aiStatusBanner()}\n${narrative}`,
      }],
    });
  }
);

// ============================================================
// TOOL: devctx_git
// ============================================================
server.registerTool(
  "devctx_git",
  {
    title: "Git Operations",
    description: `Execute git operations with automatic activity logging, or view a git summary. **Prefer this tool over running raw git commands in the shell** — it automatically logs activity to devctx so the dashboard, narrative, and session records stay accurate.

When called with no command (or command "status"), returns a read-only git summary (commits, branches, status). When called with a command, executes the operation and logs it.

Supported commands: commit, push, pull, checkout, merge, stash, status.`,
    inputSchema: {
      command: z.enum(["commit", "push", "pull", "checkout", "merge", "stash", "status"]).optional().describe("Git command to execute. Omit for read-only summary."),
      message: z.string().max(1000).optional().describe("Commit message (required for commit), or stash message"),
      files: z.array(z.string()).optional().describe("Files to stage before commit (stages all if omitted)"),
      branch: z.string().optional().describe("Branch name for checkout/merge, or branch to show commits for (in summary mode)"),
      remote: z.string().optional().describe("Remote name for push/pull (defaults to origin)"),
      force: z.boolean().optional().describe("Force push with --force-with-lease"),
      create: z.boolean().optional().describe("Create new branch on checkout (-b)"),
      no_ff: z.boolean().optional().describe("No fast-forward merge (--no-ff)"),
      squash: z.boolean().optional().describe("Squash merge (--squash)"),
      rebase: z.boolean().optional().describe("Pull with rebase (--rebase)"),
      action: z.enum(["push", "pop", "list", "drop"]).optional().describe("Stash action (default: push)"),
      commit_count: z.number().int().min(1).max(50).default(10).describe("Number of recent commits in summary mode"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ command, message, files, branch, remote, force, create, no_ff, squash, rebase, action, commit_count }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);

    // ── Read-only summary mode ──
    if (!command || command === "status") {
      const status = getGitStatus(repoRoot);
      const commits = getRecentCommits(repoRoot, commit_count, branch);
      const branches = getBranches(repoRoot);
      const lastPush = getLastPush(repoRoot, branch);
      const remoteUrl = getRemoteUrl(repoRoot);

      const lines: string[] = [
        `# 🔀 Git Summary`,
        `**Remote:** ${remoteUrl}`,
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

    // ── Write operations require active + initialized ──
    const paused = guardActive(repoRoot);
    if (paused) return paused;
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const currentBranch = getCurrentBranch(repoRoot);

    try {
      let output: string;
      let activityType: string;
      let activityMessage: string;
      let metadata: Record<string, string> = { source: "devctx_git" };

      switch (command) {
        case "commit": {
          if (!message) {
            return { content: [{ type: "text", text: "❌ `message` is required for commit." }], isError: true };
          }
          output = gitCommit(repoRoot, message, files);
          // Extract short hash from output
          const hashMatch = output.match(/\[[\w/.-]+ ([a-f0-9]+)\]/);
          const shortHash = hashMatch?.[1] || "";
          activityType = "commit";
          activityMessage = message;
          metadata.short_hash = shortHash;
          if (files) metadata.files = files.join(", ");
          break;
        }
        case "push": {
          output = gitPush(repoRoot, remote, force);
          activityType = "push";
          activityMessage = `Pushed ${currentBranch} to ${remote || "origin"}`;
          metadata.remote = remote || "origin";
          if (force) metadata.force = "true";
          break;
        }
        case "pull": {
          output = gitPull(repoRoot, remote, rebase);
          activityType = "merge";
          activityMessage = `Pulled from ${remote || "origin"}${rebase ? " (rebase)" : ""}`;
          metadata.remote = remote || "origin";
          if (rebase) metadata.rebase = "true";
          break;
        }
        case "checkout": {
          if (!branch) {
            return { content: [{ type: "text", text: "❌ `branch` is required for checkout." }], isError: true };
          }
          output = gitCheckout(repoRoot, branch, create);
          activityType = "branch_switch";
          activityMessage = `${create ? "Created and switched to" : "Switched to"} ${branch}`;
          metadata.from_branch = currentBranch;
          metadata.to_branch = branch;
          if (create) metadata.created = "true";
          break;
        }
        case "merge": {
          if (!branch) {
            return { content: [{ type: "text", text: "❌ `branch` is required for merge." }], isError: true };
          }
          output = gitMerge(repoRoot, branch, no_ff, squash);
          activityType = "merge";
          activityMessage = `Merged ${branch} into ${currentBranch}`;
          metadata.from_branch = branch;
          if (no_ff) metadata.no_ff = "true";
          if (squash) metadata.squash = "true";
          break;
        }
        case "stash": {
          output = gitStash(repoRoot, action, message);
          activityType = "note";
          activityMessage = `Stash ${action || "push"}${message ? `: ${message}` : ""}`;
          metadata.action = action || "push";
          break;
        }
        default:
          return { content: [{ type: "text", text: `❌ Unknown command: ${command}` }], isError: true };
      }

      const activityBranch = command === "checkout" ? (branch || currentBranch) : currentBranch;
      logActivity(repoRoot, {
        type: activityType as any,
        message: activityMessage,
        branch: activityBranch,
        metadata,
      });
      updateStatusLineCache(repoRoot, activityBranch);

      const typeIcon: Record<string, string> = {
        commit: "💾", push: "🚀", pull: "⬇️", checkout: "🔀", merge: "🔗", stash: "📦",
      };

      return {
        content: [{
          type: "text",
          text: `${typeIcon[command] || "📝"} **${command}** completed\n\n\`\`\`\n${output || "(no output)"}\n\`\`\`\n\n✅ Logged to activity.`,
        }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `❌ git ${command} failed:\n\n\`\`\`\n${errMsg}\n\`\`\`` }],
        isError: true,
      };
    }
  }
);

// ============================================================
// TOOL: devctx_version
// ============================================================
server.registerTool(
  "devctx_version",
  {
    title: "Semantic Versioning",
    description: `Create a semantic version tag for the project. Analyzes commits since the last version tag using AI (or deterministic fallback) to suggest major/minor/patch bump. Creates an annotated git tag and optionally pushes it.

Use this when you want to version a release. Use dry_run to preview without tagging. Use override_level to force a specific bump level.

- First version starts at v0.1.0
- PATCH: bug fixes, docs, refactoring
- MINOR: new features, enhancements
- MAJOR: breaking changes, API removals`,
    inputSchema: {
      override_level: z.enum(["major", "minor", "patch"]).optional().describe("Force a specific bump level instead of AI suggestion"),
      dry_run: z.boolean().default(false).describe("Preview the version suggestion without creating a tag"),
      remote: z.string().optional().describe("Remote to push tags to (defaults to origin)"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ override_level, dry_run, remote }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    try {
      const state = getProjectState(repoRoot);
      const branch = getCurrentBranch(repoRoot);
      const versionTags = getVersionTags(repoRoot);
      const currentVersion = getCurrentVersion(versionTags);

      // Get commits since last tag
      const commits = currentVersion !== "none"
        ? getCommitsSinceTag(repoRoot, currentVersion)
        : getRecentCommits(repoRoot, 50);

      if (commits.length === 0) {
        return {
          content: [{
            type: "text",
            text: `📦 **No commits to version.**\n\nCurrent version: \`${currentVersion}\`\nNo new commits since last tag. Make some changes first!`,
          }],
        };
      }

      // Get suggestion (AI or fallback)
      let suggestion;
      if (override_level) {
        const nextVersion = bumpVersion(currentVersion, override_level);
        suggestion = {
          level: override_level,
          reason: `Manual override: ${override_level} bump`,
          currentVersion,
          nextVersion,
        };
      } else {
        suggestion = await generateVersionSuggestion(commits, currentVersion, state.projectName);
      }

      // Dry run — just show the suggestion
      if (dry_run) {
        const commitList = commits.slice(0, 10).map(c => `  - \`${c.shortHash}\` ${c.subject}`).join("\n");
        const moreText = commits.length > 10 ? `\n  … +${commits.length - 10} more` : "";
        return {
          content: [{
            type: "text",
            text: [
              `📦 **Version Preview** (dry run)`,
              "",
              `Current: \`${currentVersion}\``,
              `Suggested: \`${suggestion.nextVersion}\` (${suggestion.level.toUpperCase()})`,
              `Reason: ${suggestion.reason}`,
              "",
              `**${commits.length} commit(s) since last tag:**`,
              commitList + moreText,
              "",
              `Run \`devctx_version\` without \`dry_run\` to apply.`,
            ].join("\n"),
          }],
        };
      }

      // Create annotated tag
      const tagMessage = `${suggestion.nextVersion}: ${suggestion.reason}`;
      gitTag(repoRoot, suggestion.nextVersion, tagMessage);

      // Push tags
      let pushResult = "";
      try {
        gitPushTag(repoRoot, suggestion.nextVersion, remote);
        pushResult = `Pushed to ${remote || "origin"}.`;
      } catch {
        pushResult = "Tag created locally (push failed or no remote).";
      }

      // Log activity
      logActivity(repoRoot, {
        type: "version",
        message: `Tagged ${suggestion.nextVersion} (${suggestion.level}): ${suggestion.reason}`,
        branch,
        metadata: {
          from_version: currentVersion,
          to_version: suggestion.nextVersion,
          level: suggestion.level,
          commits: String(commits.length),
        },
      });

      return {
        content: [{
          type: "text",
          text: [
            `🏷️ **${suggestion.nextVersion}** tagged!`,
            "",
            `${currentVersion === "none" ? "First version" : `${currentVersion} → ${suggestion.nextVersion}`} (${suggestion.level.toUpperCase()})`,
            `Reason: ${suggestion.reason}`,
            `Commits: ${commits.length}`,
            pushResult,
          ].join("\n"),
        }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `❌ Version failed: ${errMsg}` }],
        isError: true,
      };
    }
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

      // Read the project's agent context file, whichever it has
      const contextFile = readContextFile(repoRoot);

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

      // Scan source TODOs and diff against last scan
      const currentSourceTodos = scanSourceTodos(repoRoot);
      const previousSourceTodos = getSourceTodos(repoRoot);

      // Diff: find added and resolved TODOs
      const prevKeys = new Set(previousSourceTodos.map(t => `${t.file}:${t.line}:${t.tag}`));
      const currKeys = new Set(currentSourceTodos.map(t => `${t.file}:${t.line}:${t.tag}`));
      const addedSourceTodos = currentSourceTodos.filter(t => !prevKeys.has(`${t.file}:${t.line}:${t.tag}`));
      const resolvedSourceTodos = previousSourceTodos.filter(t => !currKeys.has(`${t.file}:${t.line}:${t.tag}`));

      // Save current scan for next diff
      saveSourceTodos(repoRoot, currentSourceTodos);

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
        projectInstructions: contextFile?.content ?? "",
        projectInstructionsFile: contextFile?.filename ?? "CLAUDE.md",
        userMessage,
        sessionDuration,
        commitCount,
        sourceTodos: currentSourceTodos,
        sourceTodoDiff: { added: addedSourceTodos, resolved: resolvedSourceTodos },
      });

      // Save session record
      const now = new Date();
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

      const sessionFile = saveSessionRecord(repoRoot, sessionRecord);

      // Add suggested todos — but only ones that don't overlap with existing todos
      const branch = getCurrentBranch(repoRoot);
      const existingTodos = getTodos(repoRoot).filter(t => t.status !== "done");
      const existingTexts = existingTodos.map(t => normalizeForComparison(t.text));
      let skippedDupes = 0;
      for (const t of suggestedTodos) {
        if (isSimilarToAny(t.text, existingTexts)) {
          skippedDupes++;
          continue;
        }
        addTodo(repoRoot, t.text, t.priority as "low" | "medium" | "high" | "critical", branch, undefined, "suggested");
        // Add to existing list so subsequent suggestions are checked against earlier ones too
        existingTexts.push(normalizeForComparison(t.text));
      }

      // Log session end
      logActivity(repoRoot, {
        type: "session_end",
        message: "Session ended — goodbye summary saved",
        branch,
      });

      // Pause tracking
      setDevctxActive(repoRoot, false);

      // Clean up todos: remove resolved, deduplicate
      const cleanup = cleanupTodos(repoRoot);

      // Sync CLAUDE.md + status line cache, auto-commit, and push so we leave clean
      const updatedState = getProjectState(repoRoot);
      const updatedTodos = getTodos(repoRoot);
      syncSideEffects(repoRoot, branch, updatedState, updatedTodos);
      // Commit every context file that exists, not just CLAUDE.md — syncSideEffects
      // has just rewritten AGENTS.md too where the repo keeps one.
      const committed = commitFiles(repoRoot, existingContextFiles(repoRoot), "devctx: session goodbye");
      if (committed) {
        try { gitPush(repoRoot); } catch { /* best effort — offline is fine */ }
      }

      // Count branches worked on
      const branchSet = new Set(recentActivity.map(a => a.branch));

      // Version suggestion (best-effort, never blocks goodbye)
      let versionHint = "";
      try {
        const versionTags = getVersionTags(repoRoot);
        const currentVer = getCurrentVersion(versionTags);
        const verCommits = currentVer !== "none"
          ? getCommitsSinceTag(repoRoot, currentVer)
          : recentCommits;
        if (verCommits.length > 0) {
          const suggestion = await fallbackVersionSuggestion(verCommits, currentVer);
          versionHint = `\n📦 Version suggestion: bump to \`${suggestion.nextVersion}\` (${suggestion.level.toUpperCase()}) — ${suggestion.reason}. Run \`devctx_version\` to apply.`;
        }
      } catch { /* best effort — never block goodbye */ }

      // Build source TODO diff summary
      const todoDiffLines: string[] = [];
      if (addedSourceTodos.length > 0 || resolvedSourceTodos.length > 0) {
        todoDiffLines.push("");
        todoDiffLines.push(`**Code TODOs:** ${currentSourceTodos.length} total`);
        if (addedSourceTodos.length > 0) todoDiffLines.push(`  + ${addedSourceTodos.length} new`);
        if (resolvedSourceTodos.length > 0) todoDiffLines.push(`  - ${resolvedSourceTodos.length} resolved`);
      }

      return {
        content: [{
          type: "text",
          text: [
            `👋 **Session saved.**`,
            `${commitCount} commit(s) across ${branchSet.size} branch(es). ${suggestedTodos.length - skippedDupes} suggested todo(s) added${skippedDupes > 0 ? ` (${skippedDupes} duplicate(s) skipped)` : ""}.`,
            ...(cleanup.removed > 0 || cleanup.deduped > 0
              ? [`🧹 Todo cleanup: ${cleanup.removed} resolved removed, ${cleanup.deduped} duplicate(s) merged.`]
              : []),
            ...(sessionDuration ? [`Duration: ${sessionDuration}.`] : []),
            ...todoDiffLines,
            ...(versionHint ? [versionHint] : []),
            "",
            `Session record: \`${sessionFile.substring(repoRoot.length + 1)}\``,
            "",
            "Tracking paused. See you next time!",
          ].join("\n"),
        }],
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      // Don't write to stderr — it causes Claude Code to flag the MCP server as failed
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
// TOOL: devctx_linear_sync
// ============================================================
server.registerTool(
  "devctx_linear_sync",
  {
    title: "Linear Issue Sync",
    description: `Sync Linear issues with devctx todos. Requires LINEAR_API_KEY environment variable.

- configure=true: Connect this project to Linear — fetches your teams and saves config to .devctx/linear.json
- direction="pull": Import assigned Linear issues as todos (default pulls open issues assigned to you)
- direction="push": Push unlinked todos to Linear as new issues, and push status updates for linked todos
- direction="both" (default): Pull then push

After syncing, todos linked to Linear issues show their identifier (e.g. [ENG-42]) in devctx_todo_list.

If LINEAR_API_KEY is not set, returns a helpful error explaining how to configure it.`,
    inputSchema: {
      direction: z.enum(["both", "pull", "push"]).default("both").describe("Sync direction"),
      configure: z.boolean().default(false).describe("Run configuration wizard — fetches teams, saves .devctx/linear.json"),
      team_key: z.string().optional().describe("Team key to use when you have multiple Linear teams (e.g. 'ENG')"),
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ direction, configure, team_key }) => {
    const repoRoot = resolveRepoRoot();
    autoSessionStart(repoRoot);
    const paused = guardActive(repoRoot);
    if (paused) return paused;
    const notInit = guardInitialized(repoRoot);
    if (notInit) return notInit;

    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      return {
        content: [{
          type: "text",
          text: [
            "❌ **LINEAR_API_KEY not set.**",
            "",
            "To use Linear sync, add your Linear API key to the devctx MCP server environment:",
            "",
            "1. Get your API key from Linear → Settings → API → Personal API keys",
            "",
            "2. Add it to the devctx server's environment.",
            "",
            "   **Claude Code** — `~/.claude/settings.json`:",
            "```json",
            `{`,
            `  "mcpServers": {`,
            `    "devctx": {`,
            `      "env": { "LINEAR_API_KEY": "lin_api_..." }`,
            `    }`,
            `  }`,
            `}`,
            "```",
            "",
            "   **Codex** — re-register the server with the key:",
            "```bash",
            "codex mcp remove devctx",
            `codex mcp add devctx --env LINEAR_API_KEY=lin_api_... -- node "${process.argv[1]}"`,
            "```",
            "",
            "3. Restart your agent, then run `devctx_linear_sync` with `configure=true`",
            "",
            "Note: Codex's `codex mcp login linear` authenticates Linear's own remote MCP server.",
            "devctx calls the Linear GraphQL API directly and cannot reuse that session, so it needs its own key.",
          ].join("\n"),
        }],
        isError: true,
      };
    }

    // --- Configure mode ---
    if (configure) {
      try {
        const { userId, teams } = await fetchViewerAndTeams(apiKey);

        if (teams.length === 0) {
          return {
            content: [{ type: "text", text: "❌ No Linear teams found for your account." }],
            isError: true,
          };
        }

        // Select team
        let selectedTeam = teams[0];
        if (teams.length > 1) {
          if (team_key) {
            const match = teams.find(t => t.key.toLowerCase() === team_key.toLowerCase());
            if (!match) {
              return {
                content: [{
                  type: "text",
                  text: [
                    `❌ Team key \`${team_key}\` not found. Available teams:`,
                    ...teams.map(t => `- **${t.key}**: ${t.name}`),
                    "",
                    "Re-run with `team_key` set to one of the above.",
                  ].join("\n"),
                }],
                isError: true,
              };
            }
            selectedTeam = match;
          } else {
            return {
              content: [{
                type: "text",
                text: [
                  "⚠️ You have multiple Linear teams. Re-run with `team_key` to select one:",
                  ...teams.map(t => `- **${t.key}**: ${t.name}`),
                ].join("\n"),
              }],
            };
          }
        }

        const config = {
          teamId: selectedTeam.id,
          teamKey: selectedTeam.key,
          userId,
          statusMap: {
            todo: "Todo",
            in_progress: "In Progress",
            done: "Done",
            blocked: "Blocked",
          },
          defaultPriority: 3,
        };

        saveLinearConfig(repoRoot, config);

        logActivity(repoRoot, {
          type: "note",
          message: `Linear configured: team ${selectedTeam.key} (${selectedTeam.name})`,
          branch: getCurrentBranch(repoRoot),
        });

        return {
          content: [{
            type: "text",
            text: [
              `✅ **Linear configured!**`,
              "",
              `**Team:** ${selectedTeam.name} (\`${selectedTeam.key}\`)`,
              `**Available states:** ${selectedTeam.states.map((s: { name: string; type: string }) => `${s.name} (${s.type})`).join(", ")}`,
              "",
              "Config saved to `.devctx/linear.json`. Run `devctx_linear_sync` to sync issues.",
            ].join("\n"),
          }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `❌ Linear configuration failed: ${errMsg}` }],
          isError: true,
        };
      }
    }

    // --- Sync mode ---
    const config = getLinearConfig(repoRoot);
    if (!config) {
      return {
        content: [{
          type: "text",
          text: "❌ Linear not configured for this project. Run `devctx_linear_sync` with `configure=true` first.",
        }],
        isError: true,
      };
    }

    try {
      const branch = getCurrentBranch(repoRoot);
      const result = await syncWithLinear(repoRoot, apiKey, config, direction, branch);

      logActivity(repoRoot, {
        type: "note",
        message: `Linear sync (${direction}): ${result.pulled} pulled, ${result.pushed} pushed, ${result.updated} updated`,
        branch,
      });

      // Sync CLAUDE.md and status line
      const state = getProjectState(repoRoot);
      const todos = getTodos(repoRoot);
      syncSideEffects(repoRoot, branch, state, todos);

      const lines: string[] = [
        `✅ **Linear sync complete** (${direction})`,
        "",
        `- Pulled from Linear: **${result.pulled}** new todo(s)`,
        `- Pushed to Linear: **${result.pushed}** new issue(s)`,
        `- Updated: **${result.updated}** issue(s)`,
      ];

      if (result.skipped > 0) {
        lines.push(`- Skipped: **${result.skipped}** AI-suggested todo(s) — promote one with \`devctx_todo_update promote=true\` before it will push`);
      }

      if (result.errors.length > 0) {
        lines.push("", `⚠️ **${result.errors.length} error(s):**`);
        for (const e of result.errors) {
          lines.push(`- ${e}`);
        }
      }

      lines.push("", "Run `devctx_todo_list` to see todos with their Linear identifiers.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `❌ Linear sync failed: ${errMsg}` }],
        isError: true,
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
      "# devctx — Commands",
      "",
      "| Command | What it does |",
      "|---------|-------------|",
      "| `devctx-init` | Initialize devctx for the current project. Detects language, framework, sets up tracking. |",
      "| `devctx-whereami` | Full overview — branch, focus, recent commits, todos, activity. |",
      "| `devctx-status` | Dashboard view — vitals, branches, todos, last actions, AI recap. |",
      "| `devctx-summary` | AI-generated narrative summary of the project state. |",
      "| `devctx-focus` | Update what you're currently working on. Text after the command becomes the focus. |",
      "| `devctx-todos` | List todos. Also handles adding, updating, or removing if you say so. |",
      "| `devctx-git` | Git operations with auto-logging, or read-only summary. Supports commit, push, pull, checkout, merge, stash. |",
      "| `devctx-goodbye` | End-of-session wrap-up. Saves an AI summary, suggests todos, pauses tracking. |",
      "| `devctx-version` | Semantic versioning — AI-suggested bump level, creates annotated git tags, pushes to remote. |",
      "| `devctx-linear` | Sync Linear issues with devctx todos (configure, pull, push). Requires LINEAR_API_KEY. |",
      "| `devctx-start` | Resume tracking (happens automatically on new sessions). |",
      "| `devctx-stop` | Pause tracking manually. Read-only tools still work. |",
      "| `devctx-help` | This help screen. |",
      "",
      "## Invoking these",
      "",
      "In Claude Code they are slash commands: `/devctx-status`.",
      "In Codex they are skills: type `$devctx-status`, or just describe what you want and the matching skill fires.",
      "Either way each one is a thin wrapper that calls the matching `devctx_*` MCP tool, so you can always call the tools directly instead.",
      "",
      "## How it works",
      "",
      "devctx tracks project context in a `.devctx/` directory (gitignored) and syncs key info to `CLAUDE.md`, and to `AGENTS.md` when your repo keeps one.",
      "Git hooks capture commits, branch switches, merges, and pushes from any terminal.",
      "On new sessions, tracking resumes automatically and your agent greets you with project context.",
      "Run `devctx-goodbye` when you're done to save a session record for next time.",
      "",
      "## Tips",
      "",
      "- `devctx-status` is the best single command for getting oriented.",
      "- After `devctx-goodbye`, suggested todos carry forward to the next session.",
      "- Use `devctx_git` for git operations — it auto-logs to the activity feed. Git hooks also capture activity from regular terminal use.",
      "- Branch notes (`devctx_branch_notes_save`) are great for documenting what a branch is for.",
    ].join("\n");

    return { content: [{ type: "text" as const, text: help }] };
  }
);

// ============================================================
// Start server
// ============================================================

// MCP servers communicate over stdio. Any write to stderr causes Claude Code
// to flag the server as "failed". Suppress all possible stderr output:
// 1. Silence console.warn/error (third-party libs like @anthropic-ai/sdk use console.warn)
// 2. Catch uncaught exceptions and unhandled rejections
// 3. Handle SIGTERM/SIGINT for clean shutdown (no non-zero exit code)
if (!process.argv.includes("--verbose")) {
  console.error = () => {};
  console.warn = () => {};
}
process.on("unhandledRejection", () => {});
process.on("uncaughtException", () => {});
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
process.on("SIGHUP", () => process.exit(0));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // When Claude Code exits, it closes our stdin pipe. The StdioServerTransport
  // doesn't handle stdin 'end'/'close', so we must detect this ourselves and
  // shut down cleanly — otherwise the process lingers or exits uncleanly,
  // causing Claude Code to report "1 MCP server failed".
  process.stdin.on("end", () => {
    server.close().catch(() => {});
    process.exit(0);
  });

  // Handle broken stdout pipe (Claude Code closed its end) gracefully.
  process.stdout.on("error", () => {});
}

main().catch(() => {
  process.exit(1);
});
