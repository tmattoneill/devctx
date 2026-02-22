import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { scanSourceTodos } from "./scanner.js";

let tmpDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "scanner-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("scanSourceTodos", () => {
  it("parses JS // TODO comments", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "app.ts"), "// TODO: fix this\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("fix this");
    expect(todos[0].tag).toBe("TODO");
    expect(todos[0].file).toBe("app.ts");
    expect(todos[0].line).toBe(1);
  });

  it("strips trailing */ from CSS block comments", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "style.css"), "/* TODO: fix layout */\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("fix layout");
  });

  it("strips trailing --> from HTML comments", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "page.html"), "<!-- TODO: update nav -->\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("update nav");
  });

  it("parses Python # TODO comments", () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, "main.py"), "# TODO: refactor\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].text).toBe("refactor");
  });

  it("recognizes FIXME, HACK, and XXX tags", () => {
    const dir = makeTempDir();
    writeFileSync(
      join(dir, "code.ts"),
      "// FIXME: broken\n// HACK: workaround\n// XXX: temporary\n"
    );
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(3);
    expect(todos.map((t) => t.tag)).toEqual(["FIXME", "HACK", "XXX"]);
  });

  it("reports correct relative file paths and 1-indexed line numbers", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "util.ts"), "const x = 1;\n// TODO: check\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].file).toBe("src/util.ts");
    expect(todos[0].line).toBe(2);
  });

  it("skips files inside node_modules", () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "// TODO: hidden\n");
    writeFileSync(join(dir, "app.ts"), "// TODO: visible\n");
    const todos = scanSourceTodos(dir);
    expect(todos).toHaveLength(1);
    expect(todos[0].file).toBe("app.ts");
  });
});
