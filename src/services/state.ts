import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const CLAUDETTE_DIR = ".devctx";
const ACTIVITY_LOG = "activity.log";
const PROJECT_STATE = "state.json";
const TODOS_FILE = "todos.json";

export interface ProjectState {
  projectName: string;
  description: string;
  currentFocus: string;
  lastUpdated: string;
  active: boolean;
  workingSessions: WorkingSession[];
}

export interface WorkingSession {
  started: string;
  ended?: string;
  summary: string;
  branch: string;
}

export interface Todo {
  id: string;
  text: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  branch?: string;
  priority: "low" | "medium" | "high" | "critical";
  created: string;
  updated: string;
  tags?: string[];
}

export interface ActivityEntry {
  timestamp: string;
  type: "commit" | "push" | "build" | "run" | "test" | "deploy" | "note" | "session_start" | "session_end" | "milestone" | "custom";
  message: string;
  branch: string;
  metadata?: Record<string, string>;
}

// --- Directory management ---

function ensuredevctxDir(repoRoot: string): string {
  const dir = join(repoRoot, CLAUDETTE_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Ensure .devctx is gitignored
  ensureGitignore(repoRoot);
  return dir;
}

function ensureGitignore(repoRoot: string): void {
  const gitignorePath = join(repoRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, "utf-8");
    if (!content.includes(".devctx/")) {
      writeFileSync(gitignorePath, content.trimEnd() + "\n.devctx/\n");
    }
  } else {
    writeFileSync(gitignorePath, ".devctx/\n");
  }
}

function branchFileName(branch: string): string {
  return branch.replace(/\//g, "__") + ".md";
}

// --- Project state ---

export function getProjectState(repoRoot: string): ProjectState {
  const dir = ensuredevctxDir(repoRoot);
  const stateFile = join(dir, PROJECT_STATE);

  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, "utf-8"));
    } catch {
      // corrupted, return default
    }
  }

  const defaultState: ProjectState = {
    projectName: repoRoot.split("/").pop() || "unknown",
    description: "",
    currentFocus: "",
    lastUpdated: new Date().toISOString(),
    active: true,
    workingSessions: [],
  };
  saveProjectState(repoRoot, defaultState);
  return defaultState;
}

export function saveProjectState(repoRoot: string, state: ProjectState): void {
  const dir = ensuredevctxDir(repoRoot);
  state.lastUpdated = new Date().toISOString();
  writeFileSync(join(dir, PROJECT_STATE), JSON.stringify(state, null, 2));
}

export function isDevctxActive(repoRoot: string): boolean {
  const state = getProjectState(repoRoot);
  return state.active !== false; // default to true for backwards compat
}

export function setDevctxActive(repoRoot: string, active: boolean): ProjectState {
  const state = getProjectState(repoRoot);
  state.active = active;
  saveProjectState(repoRoot, state);
  return state;
}

export function isDevctxInitialized(repoRoot: string): boolean {
  const dir = join(repoRoot, CLAUDETTE_DIR);
  return existsSync(dir) && existsSync(join(dir, PROJECT_STATE));
}

export function updateProjectFocus(repoRoot: string, focus: string, description?: string): ProjectState {
  const state = getProjectState(repoRoot);
  state.currentFocus = focus;
  if (description) state.description = description;
  saveProjectState(repoRoot, state);
  return state;
}

// --- Activity log ---

export function logActivity(repoRoot: string, entry: Omit<ActivityEntry, "timestamp">): void {
  const dir = ensuredevctxDir(repoRoot);
  const logFile = join(dir, ACTIVITY_LOG);

  const fullEntry: ActivityEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
  };

  const line = JSON.stringify(fullEntry) + "\n";

  if (existsSync(logFile)) {
    const existing = readFileSync(logFile, "utf-8");
    writeFileSync(logFile, existing + line);
  } else {
    writeFileSync(logFile, line);
  }
}

export function getRecentActivity(repoRoot: string, count: number = 20, type?: string): ActivityEntry[] {
  const dir = ensuredevctxDir(repoRoot);
  const logFile = join(dir, ACTIVITY_LOG);

  if (!existsSync(logFile)) return [];

  const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
  let entries: ActivityEntry[] = lines.map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) as ActivityEntry[];

  if (type) {
    entries = entries.filter((e) => e.type === type);
  }

  return entries.slice(-count).reverse();
}

export function getLastActivityByType(repoRoot: string): Record<string, ActivityEntry | null> {
  const dir = join(repoRoot, CLAUDETTE_DIR);
  const logFile = join(dir, ACTIVITY_LOG);

  const types = ["commit", "push", "build", "run", "test", "deploy", "session_start", "session_end", "milestone", "note"];
  const result: Record<string, ActivityEntry | null> = {};
  for (const t of types) result[t] = null;

  if (!existsSync(logFile)) return result;

  const lines = readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean);
  // Walk backwards to find most recent of each type
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry: ActivityEntry = JSON.parse(lines[i]);
      if (result[entry.type] === null) {
        result[entry.type] = entry;
      }
      // Early exit if we've found all types
      if (Object.values(result).every((v) => v !== null)) break;
    } catch { /* skip bad lines */ }
  }

  return result;
}

// --- Todos ---

export function getTodos(repoRoot: string, branch?: string, status?: string): Todo[] {
  const dir = ensuredevctxDir(repoRoot);
  const todosFile = join(dir, TODOS_FILE);

  if (!existsSync(todosFile)) return [];

  try {
    let todos: Todo[] = JSON.parse(readFileSync(todosFile, "utf-8"));
    if (branch) todos = todos.filter((t) => !t.branch || t.branch === branch);
    if (status) todos = todos.filter((t) => t.status === status);
    return todos;
  } catch {
    return [];
  }
}

function saveTodos(repoRoot: string, todos: Todo[]): void {
  const dir = ensuredevctxDir(repoRoot);
  writeFileSync(join(dir, TODOS_FILE), JSON.stringify(todos, null, 2));
}

export function addTodo(repoRoot: string, text: string, priority: Todo["priority"] = "medium", branch?: string, tags?: string[]): Todo {
  const todos = getTodos(repoRoot);
  const id = `todo_${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  const todo: Todo = {
    id,
    text,
    status: "todo",
    branch,
    priority,
    created: now,
    updated: now,
    tags,
  };

  todos.push(todo);
  saveTodos(repoRoot, todos);
  return todo;
}

export function updateTodo(repoRoot: string, id: string, updates: Partial<Pick<Todo, "text" | "status" | "priority" | "branch" | "tags">>): Todo | null {
  const todos = getTodos(repoRoot);
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  todos[idx] = { ...todos[idx], ...updates, updated: new Date().toISOString() };
  saveTodos(repoRoot, todos);
  return todos[idx];
}

export function removeTodo(repoRoot: string, id: string): boolean {
  const todos = getTodos(repoRoot);
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return false;
  saveTodos(repoRoot, filtered);
  return true;
}

// --- Branch notes ---

export function getBranchNotes(repoRoot: string, branch: string): string {
  const dir = ensuredevctxDir(repoRoot);
  const notesDir = join(dir, "branches");
  const notesFile = join(notesDir, branchFileName(branch));

  if (!existsSync(notesFile)) return "";
  return readFileSync(notesFile, "utf-8");
}

export function saveBranchNotes(repoRoot: string, branch: string, content: string): void {
  const dir = ensuredevctxDir(repoRoot);
  const notesDir = join(dir, "branches");
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, branchFileName(branch)), content);
}

export function listBranchNotes(repoRoot: string): string[] {
  const dir = ensuredevctxDir(repoRoot);
  const notesDir = join(dir, "branches");
  if (!existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/__/g, "/").replace(/\.md$/, ""));
}

// --- CLAUDE.md management ---

export function updateClaudeMd(repoRoot: string, branch: string, state: ProjectState, todos: Todo[]): void {
  const claudeMdPath = join(repoRoot, "CLAUDE.md");
  let content = "";

  // Read existing CLAUDE.md
  if (existsSync(claudeMdPath)) {
    content = readFileSync(claudeMdPath, "utf-8");
  }

  // Build the devctx section
  const activeTodos = todos.filter((t) => t.status !== "done");
  const devctxSection = builddevctxSection(branch, state, activeTodos);

  // Replace or append the devctx section
  const startMarker = "<!-- DEVCTX:START -->";
  const endMarker = "<!-- DEVCTX:END -->";

  if (content.includes(startMarker) && content.includes(endMarker)) {
    const before = content.substring(0, content.indexOf(startMarker));
    const after = content.substring(content.indexOf(endMarker) + endMarker.length);
    content = before + devctxSection + after;
  } else {
    content = content.trimEnd() + "\n\n" + devctxSection + "\n";
  }

  writeFileSync(claudeMdPath, content);
}

function builddevctxSection(branch: string, state: ProjectState, activeTodos: Todo[]): string {
  const lines: string[] = [
    "<!-- DEVCTX:START -->",
    "## 🔍 Project Context (auto-updated by devctx)",
    "",
  ];

  if (state.currentFocus) {
    lines.push(`**Current Focus:** ${state.currentFocus}`);
    lines.push("");
  }

  if (state.description) {
    lines.push(`**Project:** ${state.description}`);
    lines.push("");
  }

  lines.push(`**Branch:** \`${branch}\``);
  lines.push(`**Last Updated:** ${new Date(state.lastUpdated).toLocaleString()}`);
  lines.push("");

  if (activeTodos.length > 0) {
    lines.push("### Active Todos");
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...activeTodos].sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    for (const todo of sorted) {
      const statusIcon = todo.status === "in_progress" ? "🔄" : todo.status === "blocked" ? "🚫" : "⬜";
      const priorityIcon = todo.priority === "critical" ? "🔴" : todo.priority === "high" ? "🟠" : todo.priority === "medium" ? "🟡" : "🟢";
      lines.push(`- ${statusIcon} ${priorityIcon} ${todo.text}${todo.branch ? ` (\`${todo.branch}\`)` : ""}`);
    }
    lines.push("");
  }

  lines.push("<!-- DEVCTX:END -->");
  return lines.join("\n");
}
