#!/usr/bin/env node
/**
 * Generate Codex skills from the Claude Code slash commands.
 *
 * The two hosts want the same instructions in different envelopes: Claude Code
 * reads a flat `slash-commands/<name>.md` invoked as `/name`, Codex reads
 * `skills/<name>/SKILL.md` and fires it implicitly by matching the frontmatter
 * description. Keeping slash-commands as the single source means the two
 * cannot drift apart.
 *
 * Run with `npm run build:skills`.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(repoRoot, "slash-commands");
const OUTPUT_DIR = join(repoRoot, "skills");

/** Claude Code only. Codex has no status line, so a skill for it would be noise. */
const CLAUDE_ONLY = new Set(["devctx-statusline"]);

export function parseFrontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: text.trim() };

  const meta = {};
  for (const line of match[1].split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const value = line.slice(sep + 1).trim();
    meta[line.slice(0, sep).trim()] = value.startsWith('"') ? JSON.parse(value) : value;
  }
  return { meta, body: text.slice(match[0].length).trim() };
}

export function skillSources() {
  return readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .filter((name) => !CLAUDE_ONLY.has(name))
    .sort();
}

function generate() {
  // Rebuild from scratch so a deleted slash command does not leave an orphan skill
  if (existsSync(OUTPUT_DIR)) rmSync(OUTPUT_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const names = skillSources();
  for (const name of names) {
    const source = readFileSync(join(SOURCE_DIR, `${name}.md`), "utf-8");
    const { meta, body } = parseFrontmatter(source);

    if (!meta.description) {
      throw new Error(`slash-commands/${name}.md has no description in its frontmatter`);
    }

    const skill = [
      "---",
      `name: ${meta.name ?? name}`,
      // JSON string syntax is a valid YAML double-quoted scalar. Several
      // descriptions contain ": ", which is illegal in a plain scalar and
      // makes the whole skill fail to load.
      `description: ${JSON.stringify(meta.description)}`,
      "---",
      "",
      "<!-- Generated from slash-commands/" + name + ".md by scripts/gen-skills.mjs. Do not edit. -->",
      "",
      body,
      "",
    ].join("\n");

    mkdirSync(join(OUTPUT_DIR, name), { recursive: true });
    writeFileSync(join(OUTPUT_DIR, name, "SKILL.md"), skill);
  }

  console.log(`Generated ${names.length} Codex skills in skills/`);
  if (CLAUDE_ONLY.size > 0) {
    console.log(`Skipped (Claude Code only): ${[...CLAUDE_ONLY].join(", ")}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) generate();
