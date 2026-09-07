import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

/**
 * The Codex skills in skills/ are generated from slash-commands/ by
 * scripts/gen-skills.mjs. These guard the two ways that goes wrong: the sets
 * drifting apart, and frontmatter that Codex cannot parse.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SLASH_DIR = join(repoRoot, "slash-commands");
const SKILLS_DIR = join(repoRoot, "skills");

/** Claude Code only, deliberately not generated as a skill. */
const CLAUDE_ONLY = ["devctx-statusline"];

function slashCommandNames(): string[] {
  return readdirSync(SLASH_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

function skillNames(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Minimal frontmatter reader. Deliberately strict about the shapes Codex accepts. */
function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("no frontmatter block");

  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) throw new Error(`unparseable frontmatter line: ${line}`);

    const key = line.slice(0, sep).trim();
    const raw = line.slice(sep + 1).trim();

    // A plain YAML scalar may not contain ": ". Several descriptions do, so
    // they must be double-quoted or the whole skill fails to load.
    if (!raw.startsWith('"') && raw.includes(": ")) {
      throw new Error(`${key} contains ": " but is not quoted`);
    }
    meta[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return meta;
}

describe("generated Codex skills", () => {
  it("covers every slash command except the Claude-only ones", () => {
    const expected = slashCommandNames().filter((n) => !CLAUDE_ONLY.includes(n));
    expect(skillNames()).toEqual(expected);
  });

  it("does not generate a skill for Claude-only commands", () => {
    for (const name of CLAUDE_ONLY) {
      expect(existsSync(join(SKILLS_DIR, name))).toBe(false);
    }
  });

  it("gives every skill parseable frontmatter with a name and description", () => {
    for (const name of skillNames()) {
      const meta = frontmatter(readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf-8"));
      expect(meta.name).toBe(name);
      expect(meta.description ?? "").not.toBe("");
      // Codex truncates long descriptions in the skill listing it shows the model
      expect(meta.description.length).toBeLessThan(250);
    }
  });

  it("keeps every slash command's own frontmatter parseable too", () => {
    for (const name of slashCommandNames()) {
      const meta = frontmatter(readFileSync(join(SLASH_DIR, `${name}.md`), "utf-8"));
      expect(meta.name).toBe(name);
      expect(meta.description ?? "").not.toBe("");
    }
  });

  it("carries the source body through to the skill", () => {
    const source = readFileSync(join(SLASH_DIR, "devctx-goodbye.md"), "utf-8");
    const skill = readFileSync(join(SKILLS_DIR, "devctx-goodbye", "SKILL.md"), "utf-8");
    expect(skill).toContain("Call the `devctx_goodbye` tool");
    expect(source).toContain("Call the `devctx_goodbye` tool");
  });
});
