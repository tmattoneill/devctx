import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";
import { addTodo, normalizeForComparison, isSimilarToAny } from "./data.js";

let tmpDirs: string[] = [];

function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "data-test-"));
  tmpDirs.push(dir);
  // addTodo needs ensuredevctxDir which needs a .gitignore-writeable dir
  // and getTodos reads from .devctx/todos.json
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

describe("addTodo — ID uniqueness", () => {
  it("generates 100 unique IDs for rapid addTodo calls", () => {
    const dir = makeTempRepo();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const todo = addTodo(dir, `Task ${i}`);
      ids.add(todo.id);
    }
    expect(ids.size).toBe(100);
  });

  it("generates IDs matching the expected format", () => {
    const dir = makeTempRepo();
    const todo = addTodo(dir, "Test task");
    expect(todo.id).toMatch(/^todo_[0-9a-f]{10}$/);
  });
});

describe("normalizeForComparison", () => {
  it("lowercases and splits on punctuation", () => {
    const result = normalizeForComparison("Fix src/utils.ts:42");
    expect(result).toContain("fix");
    expect(result).toContain("src");
    expect(result).toContain("util");
  });

  it("removes stop words", () => {
    const result = normalizeForComparison("add the tests for new feature");
    // "add", "the", "for", "new" are stop words
    expect(result).not.toContain("add");
    expect(result).not.toContain("the");
    expect(result).not.toContain("for");
    expect(result).not.toContain("new");
    expect(result).toContain("test");
    expect(result).toContain("featur");
  });

  it("applies pseudo-stemming", () => {
    // Note: pseudoStem chains all replacements, so "documentation" → "document" (-ation) → "docu" (-ment)
    expect(normalizeForComparison("documentation")).toContain("docu");
    expect(normalizeForComparison("versioning")).toContain("version");  // -ing stripped
    expect(normalizeForComparison("tracked")).toContain("track");       // -ed stripped
  });

  it("returns sorted and deduplicated words", () => {
    const result = normalizeForComparison("test test beta alpha");
    const words = result.split(" ");
    expect(words).toEqual([...new Set(words)].sort());
  });
});

describe("isSimilarToAny", () => {
  it("detects exact duplicate text", () => {
    const existing = [normalizeForComparison("Add tests for scanner")];
    expect(isSimilarToAny("Add tests for scanner", existing)).toBe(true);
  });

  it("detects semantically similar text", () => {
    const existing = [normalizeForComparison("Add automated tests for the TODO scanner")];
    expect(isSimilarToAny("Write tests for TODO scanner to prevent regression", existing)).toBe(true);
  });

  it("returns false for completely different text", () => {
    const existing = [normalizeForComparison("Fix database connection pooling")];
    expect(isSimilarToAny("Add dark mode to dashboard", existing)).toBe(false);
  });

  it("returns false for empty existing list", () => {
    expect(isSimilarToAny("Add tests for scanner", [])).toBe(false);
  });
});
