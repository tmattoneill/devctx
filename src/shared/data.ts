import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { createHash, randomBytes } from "crypto";
import type { ProjectState, Todo, ActivityEntry, SourceTodo, LinearConfig } from "./types.js";

const CLAUDETTE_DIR = ".devctx";
const ACTIVITY_LOG = "activity.log";
const PROJECT_STATE = "state.json";
const TODOS_FILE = "todos.json";

// --- Safe writes ---

/**
 * Write via a temp file and rename.
 *
 * A plain writeFileSync truncates the target first, so a process that dies
 * mid-write (the MCP server takes a SIGHUP when Claude Code exits) leaves
 * truncated JSON behind. rename(2) is atomic within a filesystem, so a reader
 * sees either the old file or the new one, never a half-written one.
 */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, file);
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* nothing more to do */ }
    throw error;
  }
}

function writeJsonAtomic(file: string, data: unknown): void {
  writeFileAtomic(file, JSON.stringify(data, null, 2));
}

/**
 * Move an unparseable file aside instead of letting the caller treat it as
 * empty. Callers here read-modify-write whole files, so returning [] for a
 * corrupt file would make the next save erase real data permanently.
 */
function quarantineCorruptFile(file: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    renameSync(file, `${file}.corrupt-${stamp}`);
  } catch {
    // If we cannot even rename it, leave it alone rather than destroying it.
  }
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
      // Corrupted. Keep a copy before the default state overwrites it.
      quarantineCorruptFile(stateFile);
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
  writeJsonAtomic(join(dir, PROJECT_STATE), state);
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

  // Append rather than rewrite: the git hooks append to this same file with
  // `>>` from any terminal, so a read-modify-write here would drop any entry
  // written between the read and the write.
  appendFileSync(logFile, line);
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

  const types = ["commit", "push", "build", "run", "test", "deploy", "session_start", "session_end", "milestone", "note", "branch_switch", "merge", "version"];
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
    const parsed = JSON.parse(readFileSync(todosFile, "utf-8"));
    if (!Array.isArray(parsed)) throw new Error("todos.json is not an array");
    let todos = parsed as Todo[];
    if (branch) todos = todos.filter((t) => !t.branch || t.branch === branch);
    if (status) todos = todos.filter((t) => t.status === status);
    return todos;
  } catch {
    // Move the bad file aside so the next saveTodos() writes a fresh list
    // instead of overwriting recoverable data with an empty array.
    quarantineCorruptFile(todosFile);
    return [];
  }
}

function saveTodos(repoRoot: string, todos: Todo[]): void {
  const dir = ensuredevctxDir(repoRoot);
  writeJsonAtomic(join(dir, TODOS_FILE), todos);
}

export function addTodo(repoRoot: string, text: string, priority: Todo["priority"] = "medium", branch?: string, tags?: string[], source?: Todo["source"]): Todo {
  const todos = getTodos(repoRoot);
  const id = `todo_${createHash("md5").update(`${Date.now()}:${randomBytes(4).toString("hex")}:${text}`).digest("hex").slice(0, 10)}`;
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
    source: source || "manual",
  };

  todos.push(todo);
  saveTodos(repoRoot, todos);
  return todo;
}

export function updateTodo(repoRoot: string, id: string, updates: Partial<Pick<Todo, "text" | "status" | "priority" | "branch" | "tags" | "linearId" | "linearUrl" | "linearIdentifier" | "linearSyncedAt" | "linearSyncError" | "source">>): Todo | null {
  const todos = getTodos(repoRoot);
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  todos[idx] = { ...todos[idx], ...updates, updated: new Date().toISOString() };
  saveTodos(repoRoot, todos);
  return todos[idx];
}

/**
 * Record that a todo now matches its Linear issue.
 *
 * Stamps `linearSyncedAt` with the same timestamp as `updated`. Writing them
 * from two separate `new Date()` calls leaves `updated` a millisecond ahead,
 * which the sync's "devctx is newer than Linear" test reads as dirty, so every
 * todo would re-push on every sync forever.
 */
export function markTodoSynced(
  repoRoot: string,
  id: string,
  fields: Partial<Pick<Todo, "status" | "linearId" | "linearUrl" | "linearIdentifier">> = {},
): Todo | null {
  const todos = getTodos(repoRoot);
  const idx = todos.findIndex((t) => t.id === id);
  if (idx === -1) return null;

  const stamp = new Date().toISOString();
  const next: Todo = { ...todos[idx], ...fields, updated: stamp, linearSyncedAt: stamp };
  delete next.linearSyncError;

  todos[idx] = next;
  saveTodos(repoRoot, todos);
  return next;
}

/**
 * Record that a push to Linear failed. Leaves `linearSyncedAt` behind
 * `updated` so the next full sync retries this todo.
 */
export function markTodoSyncFailed(repoRoot: string, id: string, error: string): Todo | null {
  return updateTodo(repoRoot, id, { linearSyncError: error });
}

export function removeTodo(repoRoot: string, id: string): boolean {
  const todos = getTodos(repoRoot);
  const filtered = todos.filter((t) => t.id !== id);
  if (filtered.length === todos.length) return false;
  saveTodos(repoRoot, filtered);
  return true;
}

const PRIORITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };

// --- Fuzzy todo similarity ---

/** Stop words to strip when comparing todo texts */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "to", "for", "of", "in", "on", "is", "it",
  "add", "write", "create", "implement", "complete", "update", "new",
  "comprehensive", "automated", "prevent", "regression", "ensure",
  "cover", "covering", "address", "item",
]);

/** Common suffixes to strip for pseudo-stemming */
function pseudoStem(word: string): string {
  return word
    .replace(/ation$/, "")   // documentation → document
    .replace(/ting$/, "")    // testing → test (but keep 4+ char root)
    .replace(/ment$/, "")    // improvement → improve
    .replace(/ies$/, "y")    // capabilities → capabilit → keep as-is since root is long enough
    .replace(/ing$/, "")     // versioning → version
    .replace(/ed$/, "")      // tracked → track
    .replace(/ly$/, "")      // manually → manual
    .replace(/s$/, "");      // tests → test
}

/**
 * Normalize text for fuzzy comparison: lowercase, split on non-alpha boundaries
 * (including path separators), remove stop words, pseudo-stem, sort remaining words.
 */
export function normalizeForComparison(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")  // split on punctuation/paths into separate words
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w))
    .map(pseudoStem)
    .filter(w => w.length > 2);  // filter again after stemming
  return [...new Set(words)].sort().join(" ");
}

/**
 * Check if two normalized strings are similar enough to be duplicates.
 * Uses Jaccard similarity on word sets — threshold of 0.5 means
 * at least half the words overlap.
 */
function areSimilar(normA: string, normB: string, threshold = 0.5): boolean {
  if (normA === normB) return true;
  const setA = new Set(normA.split(" "));
  const setB = new Set(normB.split(" "));
  if (setA.size === 0 || setB.size === 0) return false;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return intersection / union >= threshold;
}

/**
 * Check if a todo text is similar to any in a list of normalized texts.
 */
export function isSimilarToAny(text: string, normalizedExisting: string[]): boolean {
  const norm = normalizeForComparison(text);
  return normalizedExisting.some(existing => areSimilar(norm, existing));
}

/**
 * Clean up todos: remove done/resolved items and deduplicate by text similarity.
 * When duplicates exist, keeps the one with highest priority (then most recently updated).
 * Returns { removed, deduped } counts.
 */
export function cleanupTodos(repoRoot: string): { removed: number; deduped: number } {
  const todos = getTodos(repoRoot);
  const before = todos.length;

  // 1. Remove done todos
  const active = todos.filter(t => t.status !== "done");
  const removed = before - active.length;

  // 2. Deduplicate by fuzzy text similarity — keep highest priority, then most recent
  const keptNorms: string[] = []; // normalized texts of kept todos
  const deduped: typeof active = [];
  let dupCount = 0;

  for (const todo of active) {
    const norm = normalizeForComparison(todo.text);
    // Find if this is similar to an already-kept todo
    const existingIdx = keptNorms.findIndex(kept => areSimilar(norm, kept));
    if (existingIdx !== -1) {
      const kept = deduped[existingIdx];
      const keptRank = PRIORITY_RANK[kept.priority] ?? 0;
      const newRank = PRIORITY_RANK[todo.priority] ?? 0;
      if (newRank > keptRank || (newRank === keptRank && todo.updated > kept.updated)) {
        deduped[existingIdx] = todo;
        keptNorms[existingIdx] = norm;
      }
      dupCount++;
    } else {
      keptNorms.push(norm);
      deduped.push(todo);
    }
  }

  if (removed > 0 || dupCount > 0) {
    saveTodos(repoRoot, deduped);
  }

  return { removed, deduped: dupCount };
}

// --- Source TODOs ---

const SOURCE_TODOS_FILE = "source-todos.json";

export function saveSourceTodos(repoRoot: string, todos: SourceTodo[]): void {
  const dir = ensuredevctxDir(repoRoot);
  writeJsonAtomic(join(dir, SOURCE_TODOS_FILE), todos);
}

export function getSourceTodos(repoRoot: string): SourceTodo[] {
  const dir = join(repoRoot, CLAUDETTE_DIR);
  const file = join(dir, SOURCE_TODOS_FILE);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
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
  writeFileAtomic(join(notesDir, branchFileName(branch)), content);
}

export function listBranchNotes(repoRoot: string): string[] {
  const dir = ensuredevctxDir(repoRoot);
  const notesDir = join(dir, "branches");
  if (!existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/__/g, "/").replace(/\.md$/, ""));
}

// --- Linear config ---

const LINEAR_CONFIG_FILE = "linear.json";

export function getLinearConfig(repoRoot: string): LinearConfig | null {
  const dir = join(repoRoot, CLAUDETTE_DIR);
  const configFile = join(dir, LINEAR_CONFIG_FILE);
  if (!existsSync(configFile)) return null;
  try {
    return JSON.parse(readFileSync(configFile, "utf-8")) as LinearConfig;
  } catch {
    return null;
  }
}

export function saveLinearConfig(repoRoot: string, config: LinearConfig): void {
  const dir = ensuredevctxDir(repoRoot);
  writeJsonAtomic(join(dir, LINEAR_CONFIG_FILE), config);
}

// --- Status line cache ---

export interface StatusLineCache {
  projectName: string;
  currentFocus: string;
  active: boolean;
  branch: string;
  todoCount: number;
  highPriorityCount: number;
  lastCommit: string | null;
  lastPush: string | null;
  updatedAt: string;
}

export function updateStatusLineCache(repoRoot: string, branch: string): void {
  const dir = ensuredevctxDir(repoRoot);
  const state = getProjectState(repoRoot);
  const todos = getTodos(repoRoot);
  const vitals = getLastActivityByType(repoRoot);

  const activeTodos = todos.filter(t => t.status !== "done");
  const highPriority = activeTodos.filter(t => t.priority === "high" || t.priority === "critical");

  const cache: StatusLineCache = {
    projectName: state.projectName,
    currentFocus: state.currentFocus ? state.currentFocus.slice(0, 60) : "",
    active: state.active !== false,
    branch,
    todoCount: activeTodos.length,
    highPriorityCount: highPriority.length,
    lastCommit: vitals.commit?.timestamp ?? null,
    lastPush: vitals.push?.timestamp ?? null,
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(join(dir, "statusline.json"), cache);
}

// --- Agent context file management ---

/**
 * Files that carry the devctx context section, in preference order.
 *
 * devctx updates whichever of these the repo already has and creates none of
 * them beyond the default. A Claude project keeps CLAUDE.md, a Codex project
 * keeps AGENTS.md, a project that wants both gets both, and a project with
 * neither gets CLAUDE.md.
 */
const CLAUDE_MD = "CLAUDE.md";
export const AGENT_CONTEXT_FILES = [CLAUDE_MD, "AGENTS.md"];

/** The context files this repo actually has, in preference order. */
export function existingContextFiles(repoRoot: string): string[] {
  return AGENT_CONTEXT_FILES.filter((f) => existsSync(join(repoRoot, f)));
}

/**
 * The project instructions to feed the narrative model, preferring CLAUDE.md.
 * A Codex-only repo has just AGENTS.md, and reading only CLAUDE.md there hands
 * the model nothing.
 */
export function readContextFile(repoRoot: string): { filename: string; content: string } | null {
  for (const filename of AGENT_CONTEXT_FILES) {
    const path = join(repoRoot, filename);
    if (!existsSync(path)) continue;
    try {
      return { filename, content: readFileSync(path, "utf-8") };
    } catch {
      // Unreadable, try the next one
    }
  }
  return null;
}

export function updateContextFiles(repoRoot: string, branch: string, state: ProjectState, todos: Todo[]): void {
  const activeTodos = todos.filter((t) => t.status !== "done");
  const devctxSection = builddevctxSection(branch, state, activeTodos);

  // Update the context files the repo already keeps. A Codex-only project with
  // just AGENTS.md should not acquire a CLAUDE.md it never asked for, and a
  // Claude project should not acquire an AGENTS.md. When a repo has neither,
  // CLAUDE.md is the default.
  const existing = existingContextFiles(repoRoot);
  const targets = existing.length > 0 ? existing : [CLAUDE_MD];

  for (const filename of targets) {
    const path = join(repoRoot, filename);
    let content = existsSync(path) ? readFileSync(path, "utf-8") : "";

    // Replace or append the devctx section
    const startMarker = "<!-- DEVCTX:START -->";
    const endMarker = "<!-- DEVCTX:END -->";

    // Anchor on the LAST marker pair, not the first. Documentation that
    // mentions the marker in prose would otherwise be read as the start of the
    // generated block, and everything from that sentence onward would be
    // replaced — the file documenting this feature is the likeliest casualty.
    const endIndex = content.lastIndexOf(endMarker);
    const startIndex = endIndex === -1 ? -1 : content.lastIndexOf(startMarker, endIndex);

    if (startIndex !== -1 && endIndex !== -1) {
      const before = content.substring(0, startIndex);
      const after = content.substring(endIndex + endMarker.length);
      content = before + devctxSection + after;
    } else {
      content = content.trimEnd() + "\n\n" + devctxSection + "\n";
    }

    writeFileAtomic(path, content);
  }
}

function builddevctxSection(branch: string, state: ProjectState, activeTodos: Todo[]): string {
  const lines: string[] = [
    "<!-- DEVCTX:START -->",
    "## Project Context (auto-updated by devctx)",
    "",
    "> **IMPORTANT:** When starting a new conversation, greet the user with a brief summary of the project context below — current focus, branch, and any active todos. Keep it to 2-3 sentences. Do not skip this greeting.",
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
      const statusMarker = todo.status === "in_progress" ? "[IN PROGRESS]" : todo.status === "blocked" ? "[BLOCKED]" : "[ ]";
      const priorityMarker = `[${todo.priority}]`;
      lines.push(`- ${statusMarker} ${priorityMarker} ${todo.text}${todo.branch ? ` (\`${todo.branch}\`)` : ""}`);
    }
    lines.push("");
  }

  lines.push("<!-- DEVCTX:END -->");
  return lines.join("\n");
}

// --- Session records ---

export function getLatestSessionContent(repoRoot: string): string | null {
  const sessionsDir = join(repoRoot, ".devctx", "sessions");
  if (!existsSync(sessionsDir)) return null;

  const files = readdirSync(sessionsDir)
    .filter(f => f.endsWith(".md"))
    .sort()
    .reverse();

  if (files.length === 0) return null;

  try {
    return readFileSync(join(sessionsDir, files[0]), "utf-8");
  } catch {
    return null;
  }
}

export function saveSessionRecord(repoRoot: string, content: string): string {
  const sessionsDir = join(repoRoot, ".devctx", "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const now = new Date();
  const dateStr = now.toISOString().replace(/:/g, "-").replace(/\.\d{3}Z$/, "");
  const sessionFile = join(sessionsDir, `${dateStr}.md`);

  writeFileAtomic(sessionFile, content);
  return sessionFile;
}

export interface SessionInfo {
  filename: string;
  timestamp: string; // ISO string derived from filename
}

export function listSessions(repoRoot: string): SessionInfo[] {
  const sessionsDir = join(repoRoot, ".devctx", "sessions");
  if (!existsSync(sessionsDir)) return [];

  return readdirSync(sessionsDir)
    .filter(f => f.endsWith(".md"))
    .sort()
    .reverse()
    .map(filename => {
      // filename format: 2026-02-18T17-09-45.md — restore colons for ISO
      const stem = filename.replace(/\.md$/, "");
      const iso = stem.replace(/-(\d{2})-(\d{2})$/, ":$1:$2")
        .replace(/T(\d{2})-/, "T$1:");
      return { filename, timestamp: iso };
    });
}

export function getSessionContent(repoRoot: string, filename: string): string | null {
  // Sanitize: only allow .md files, no path traversal
  if (!filename.endsWith(".md") || filename.includes("/") || filename.includes("..")) {
    return null;
  }
  const filePath = join(repoRoot, ".devctx", "sessions", filename);
  if (!existsSync(filePath)) return null;
  try {
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
