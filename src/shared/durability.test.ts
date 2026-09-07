import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, appendFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  addTodo, getTodos, updateTodo, logActivity, getRecentActivity,
  markTodoSynced, markTodoSyncFailed, updateContextFiles,
  readContextFile, existingContextFiles,
} from "./data.js";

/**
 * Covers the two ways .devctx state could be destroyed: a truncated JSON file
 * being read as "empty" and then saved over, and the activity log's
 * read-modify-write dropping entries the git hooks appended concurrently.
 */

let tmpDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "durability-test-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, ".devctx"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".devctx/\n");
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("corrupt todos.json", () => {
  it("quarantines a truncated file instead of silently returning an empty list", () => {
    const dir = makeTempRepo();
    const todosFile = join(dir, ".devctx", "todos.json");

    addTodo(dir, "real work that must survive", "high");
    const good = readFileSync(todosFile, "utf-8");

    // Simulate a write cut short by SIGHUP
    writeFileSync(todosFile, good.slice(0, good.length / 2));

    expect(getTodos(dir)).toEqual([]);

    const quarantined = readdirSync(join(dir, ".devctx")).filter(f => f.includes("corrupt"));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(dir, ".devctx", quarantined[0]), "utf-8")).toContain("must survive");
  });

  it("does not overwrite the corrupt file when the next todo is added", () => {
    const dir = makeTempRepo();
    const todosFile = join(dir, ".devctx", "todos.json");

    addTodo(dir, "original todo", "high");
    writeFileSync(todosFile, "{ this is not json");

    addTodo(dir, "todo added after corruption", "low");

    const todos = getTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("todo added after corruption");

    const quarantined = readdirSync(join(dir, ".devctx")).filter(f => f.includes("corrupt"));
    expect(quarantined).toHaveLength(1);
  });

  it("treats a valid JSON document of the wrong shape as corrupt", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, ".devctx", "todos.json"), '{"todos": []}');

    expect(getTodos(dir)).toEqual([]);
    expect(readdirSync(join(dir, ".devctx")).filter(f => f.includes("corrupt"))).toHaveLength(1);
  });
});

describe("activity log", () => {
  it("keeps entries appended by a git hook while the process was working", () => {
    const dir = makeTempRepo();
    const logFile = join(dir, ".devctx", "activity.log");

    logActivity(dir, { type: "note", message: "first", branch: "main" });

    // A post-commit hook appends from another terminal with `>>`
    appendFileSync(
      logFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "commit",
        message: "from the git hook",
        branch: "main",
      }) + "\n",
    );

    logActivity(dir, { type: "note", message: "second", branch: "main" });

    const messages = getRecentActivity(dir, 20).map(e => e.message);
    expect(messages).toContain("first");
    expect(messages).toContain("from the git hook");
    expect(messages).toContain("second");
  });

  it("writes one line per entry", () => {
    const dir = makeTempRepo();
    for (let i = 0; i < 5; i++) {
      logActivity(dir, { type: "note", message: `entry ${i}`, branch: "main" });
    }
    const lines = readFileSync(join(dir, ".devctx", "activity.log"), "utf-8").trim().split("\n");
    expect(lines).toHaveLength(5);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });
});

describe("Linear sync markers", () => {
  it("leaves a synced todo looking clean, not dirty", () => {
    const dir = makeTempRepo();
    const todo = addTodo(dir, "linked work", "high");
    updateTodo(dir, todo.id, { linearId: "issue-1", linearIdentifier: "ENG-1" });

    const synced = markTodoSynced(dir, todo.id);

    // syncWithLinear treats `updated > linearSyncedAt` as "devctx is newer".
    // Two separate timestamps would leave it permanently newer and re-push
    // the same todo on every single sync.
    expect(synced?.linearSyncedAt).toBe(synced?.updated);
    expect(synced!.updated > synced!.linearSyncedAt!).toBe(false);
  });

  it("clears a previous failure when the push succeeds", () => {
    const dir = makeTempRepo();
    const todo = addTodo(dir, "linked work", "high");
    markTodoSyncFailed(dir, todo.id, "Linear API HTTP 500");
    expect(getTodos(dir)[0].linearSyncError).toBe("Linear API HTTP 500");

    markTodoSynced(dir, todo.id);
    expect(getTodos(dir)[0].linearSyncError).toBeUndefined();
  });

  it("leaves a failed todo dirty so the next sync retries it", () => {
    const dir = makeTempRepo();
    const todo = addTodo(dir, "linked work", "high");
    markTodoSynced(dir, todo.id);

    const failed = markTodoSyncFailed(dir, todo.id, "Linear API HTTP 500");

    expect(failed!.updated > failed!.linearSyncedAt!).toBe(true);
    expect(failed!.linearSyncError).toBe("Linear API HTTP 500");
  });

  it("records the status it synced", () => {
    const dir = makeTempRepo();
    const todo = addTodo(dir, "finish the thing", "high");
    markTodoSynced(dir, todo.id, { status: "done", linearIdentifier: "ENG-7" });

    const saved = getTodos(dir)[0];
    expect(saved.status).toBe("done");
    expect(saved.linearIdentifier).toBe("ENG-7");
  });
});

describe("agent context files", () => {
  const state = {
    projectName: "demo",
    description: "a demo project",
    currentFocus: "wiring the sync",
    lastUpdated: new Date().toISOString(),
    active: true,
    workingSessions: [],
  };

  it("writes the devctx section into AGENTS.md when that file exists", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Project\n");

    const todo = addTodo(dir, "wire up the sync", "high");
    updateContextFiles(dir, "main", state, [todo]);

    for (const file of ["CLAUDE.md", "AGENTS.md"]) {
      const content = readFileSync(join(dir, file), "utf-8");
      expect(content).toContain("<!-- DEVCTX:START -->");
      expect(content).toContain("wiring the sync");
      expect(content).toContain("wire up the sync");
    }
  });

  it("refreshes a stale AGENTS.md section rather than appending a second one", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# Project\n");
    writeFileSync(
      join(dir, "AGENTS.md"),
      "# Project\n\n<!-- DEVCTX:START -->\nstale content from months ago\n<!-- DEVCTX:END -->\n",
    );

    updateContextFiles(dir, "main", state, [addTodo(dir, "current work", "high")]);

    const content = readFileSync(join(dir, "AGENTS.md"), "utf-8");
    expect(content).not.toContain("stale content from months ago");
    expect(content.match(/<!-- DEVCTX:START -->/g)).toHaveLength(1);
    expect(content).toContain("current work");
  });

  it("does not create AGENTS.md in a repo that has not opted in", () => {
    const dir = makeTempRepo();
    updateContextFiles(dir, "main", state, []);

    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});

describe("devctx section markers", () => {
  const state = {
    projectName: "demo",
    description: "a demo project",
    currentFocus: "documenting the markers",
    lastUpdated: new Date().toISOString(),
    active: true,
    workingSessions: [],
  };

  it("does not eat prose that mentions the start marker", () => {
    const dir = makeTempRepo();
    // A doc describing this very feature names the marker in a sentence.
    writeFileSync(
      join(dir, "CLAUDE.md"),
      [
        "# Project",
        "",
        "- **Context sync:** writes a `<!-- DEVCTX:START -->` section to CLAUDE.md",
        "",
        "## Build",
        "",
        "npm run build",
        "",
        "<!-- DEVCTX:START -->",
        "old generated content",
        "<!-- DEVCTX:END -->",
        "",
      ].join("\n"),
    );

    updateContextFiles(dir, "main", state, []);

    const content = readFileSync(join(dir, "CLAUDE.md"), "utf-8");
    expect(content).toContain("## Build");
    expect(content).toContain("npm run build");
    expect(content).toContain("**Context sync:**");
    expect(content).not.toContain("old generated content");
    expect(content).toContain("documenting the markers");
  });
});

describe("context file discovery", () => {
  it("finds AGENTS.md when the repo has no CLAUDE.md", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "AGENTS.md"), "# Codex-only repo\n\nBuild with npm.\n");

    const found = readContextFile(dir);
    expect(found?.filename).toBe("AGENTS.md");
    expect(found?.content).toContain("Build with npm");
    expect(existingContextFiles(dir)).toEqual(["AGENTS.md"]);
  });

  it("prefers CLAUDE.md when both exist, and lists both for committing", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# Claude instructions\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Codex instructions\n");

    expect(readContextFile(dir)?.filename).toBe("CLAUDE.md");
    expect(existingContextFiles(dir)).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });

  it("returns null and an empty list when the repo has neither", () => {
    const dir = makeTempRepo();
    expect(readContextFile(dir)).toBeNull();
    expect(existingContextFiles(dir)).toEqual([]);
  });
});

describe("which context files devctx writes", () => {
  const state = {
    projectName: "demo",
    description: "a demo project",
    currentFocus: "staying in our lane",
    lastUpdated: new Date().toISOString(),
    active: true,
    workingSessions: [],
  };

  it("leaves a Codex-only repo alone: updates AGENTS.md, creates no CLAUDE.md", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "AGENTS.md"), "# Codex project\n");

    updateContextFiles(dir, "main", state, []);

    expect(readFileSync(join(dir, "AGENTS.md"), "utf-8")).toContain("staying in our lane");
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  it("leaves a Claude-only repo alone: updates CLAUDE.md, creates no AGENTS.md", () => {
    const dir = makeTempRepo();
    writeFileSync(join(dir, "CLAUDE.md"), "# Claude project\n");

    updateContextFiles(dir, "main", state, []);

    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("staying in our lane");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("defaults to CLAUDE.md when the repo has neither", () => {
    const dir = makeTempRepo();
    updateContextFiles(dir, "main", state, []);

    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });
});
