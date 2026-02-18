import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";

// ── Types ───────────────────────────────────────────────────

export interface ProjectScan {
  // Environment
  environment: "empty" | "files_no_git" | "git_no_devctx" | "git_with_devctx";
  rootDir: string;
  dirName: string;

  // Project identity (from package.json, Cargo.toml, etc.)
  detectedName: string | null;
  detectedDescription: string | null;

  // Language + runtime
  languages: string[];
  runtime: string | null; // e.g. "node", "python", "rust", "go"

  // Frameworks + tools
  frameworks: string[];
  buildTools: string[];
  cicd: string[];
  infra: string[];

  // Project stats
  fileCount: number;
  hasReadme: boolean;
  hasClaudeMd: boolean;
  hasEnvFile: boolean;
  hasLicense: boolean;
  hasTests: boolean;

  // Git state (if git exists)
  hasGit: boolean;
  commitCount: number;
  branchCount: number;
  hasRemote: boolean;

  // Build scripts detected
  scripts: Record<string, string>;
}

// ── Helpers ─────────────────────────────────────────────────

function fileExists(root: string, ...paths: string[]): boolean {
  return existsSync(join(root, ...paths));
}

function readJson(root: string, file: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(root, file), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readText(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), "utf-8");
  } catch {
    return null;
  }
}

function globMatch(root: string, pattern: string): boolean {
  // Simple: check if any file in root matches the start of the pattern
  try {
    const files = readdirSync(root);
    return files.some((f) => f.startsWith(pattern) || f.match(new RegExp(pattern.replace("*", ".*"))));
  } catch {
    return false;
  }
}

function countFiles(root: string, maxDepth: number = 3, depth: number = 0): number {
  if (depth > maxDepth) return 0;
  let count = 0;
  try {
    const entries = readdirSync(root);
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "node_modules" || entry === "__pycache__" || entry === "dist" || entry === "build" || entry === "target" || entry === ".devctx") continue;
      const fullPath = join(root, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) count++;
        else if (stat.isDirectory()) count += countFiles(fullPath, maxDepth, depth + 1);
      } catch { /* permission errors etc */ }
    }
  } catch { /* empty dir */ }
  return count;
}

function execSync_safe(cmd: string, cwd: string): string {
  try {
    return (execSync(cmd, { cwd, encoding: "utf-8", timeout: 5000 }) as string).trim();
  } catch {
    return "";
  }
}

// ── Main scanner ────────────────────────────────────────────

export function scanProject(rootDir: string): ProjectScan {
  const dirName = basename(rootDir);
  const hasGit = fileExists(rootDir, ".git");
  const hasDevctx = fileExists(rootDir, ".devctx", "state.json");

  // Determine environment
  const fileCount = countFiles(rootDir);
  let environment: ProjectScan["environment"];
  if (fileCount === 0 && !hasGit) {
    environment = "empty";
  } else if (!hasGit) {
    environment = "files_no_git";
  } else if (!hasDevctx) {
    environment = "git_no_devctx";
  } else {
    environment = "git_with_devctx";
  }

  const scan: ProjectScan = {
    environment,
    rootDir,
    dirName,
    detectedName: null,
    detectedDescription: null,
    languages: [],
    runtime: null,
    frameworks: [],
    buildTools: [],
    cicd: [],
    infra: [],
    fileCount,
    hasReadme: fileExists(rootDir, "README.md") || fileExists(rootDir, "readme.md"),
    hasClaudeMd: fileExists(rootDir, "CLAUDE.md"),
    hasEnvFile: fileExists(rootDir, ".env") || fileExists(rootDir, ".env.example") || fileExists(rootDir, ".env.local"),
    hasLicense: fileExists(rootDir, "LICENSE") || fileExists(rootDir, "LICENSE.md") || fileExists(rootDir, "LICENCE"),
    hasTests: false,
    hasGit,
    commitCount: 0,
    branchCount: 0,
    hasRemote: false,
    scripts: {},
  };

  if (environment === "empty") return scan;

  // ── Language + runtime detection ──

  // Node/JS/TS
  const pkg = readJson(rootDir, "package.json");
  if (pkg) {
    scan.languages.push("JavaScript");
    scan.runtime = "node";
    if (typeof pkg.name === "string") scan.detectedName = pkg.name;
    if (typeof pkg.description === "string") scan.detectedDescription = pkg.description;

    // Extract scripts
    if (pkg.scripts && typeof pkg.scripts === "object") {
      const scripts = pkg.scripts as Record<string, string>;
      for (const key of ["build", "test", "start", "dev", "lint", "deploy"]) {
        if (scripts[key]) scan.scripts[key] = scripts[key];
      }
    }

    if (fileExists(rootDir, "tsconfig.json")) {
      scan.languages.push("TypeScript");
    }

    // Framework detection from dependencies
    const allDeps = { ...(pkg.dependencies as Record<string, string> || {}), ...(pkg.devDependencies as Record<string, string> || {}) };
    if (allDeps["next"]) scan.frameworks.push("Next.js");
    if (allDeps["nuxt"]) scan.frameworks.push("Nuxt");
    if (allDeps["@angular/core"]) scan.frameworks.push("Angular");
    if (allDeps["vue"]) scan.frameworks.push("Vue");
    if (allDeps["react"]) scan.frameworks.push("React");
    if (allDeps["svelte"]) scan.frameworks.push("Svelte");
    if (allDeps["express"]) scan.frameworks.push("Express");
    if (allDeps["fastify"]) scan.frameworks.push("Fastify");
    if (allDeps["hono"]) scan.frameworks.push("Hono");
    if (allDeps["tailwindcss"]) scan.frameworks.push("Tailwind");
    if (allDeps["vite"]) scan.buildTools.push("Vite");
    if (allDeps["webpack"]) scan.buildTools.push("Webpack");
    if (allDeps["esbuild"]) scan.buildTools.push("esbuild");
    if (allDeps["prisma"] || allDeps["@prisma/client"]) scan.frameworks.push("Prisma");
    if (allDeps["drizzle-orm"]) scan.frameworks.push("Drizzle");
    if (allDeps["jest"] || allDeps["vitest"] || allDeps["mocha"]) scan.hasTests = true;

    // Package manager
    if (fileExists(rootDir, "pnpm-lock.yaml")) scan.buildTools.push("pnpm");
    else if (fileExists(rootDir, "yarn.lock")) scan.buildTools.push("Yarn");
    else if (fileExists(rootDir, "bun.lockb")) scan.buildTools.push("Bun");
    else if (fileExists(rootDir, "package-lock.json")) scan.buildTools.push("npm");
  }

  // Python
  if (fileExists(rootDir, "pyproject.toml") || fileExists(rootDir, "setup.py") || fileExists(rootDir, "requirements.txt") || fileExists(rootDir, "Pipfile")) {
    scan.languages.push("Python");
    scan.runtime = scan.runtime || "python";

    const pyproject = readText(rootDir, "pyproject.toml");
    if (pyproject) {
      const nameMatch = pyproject.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch && !scan.detectedName) scan.detectedName = nameMatch[1];
      const descMatch = pyproject.match(/^description\s*=\s*"([^"]+)"/m);
      if (descMatch && !scan.detectedDescription) scan.detectedDescription = descMatch[1];

      if (pyproject.includes("django")) scan.frameworks.push("Django");
      if (pyproject.includes("flask")) scan.frameworks.push("Flask");
      if (pyproject.includes("fastapi")) scan.frameworks.push("FastAPI");
      if (pyproject.includes("pytest")) scan.hasTests = true;
    }

    if (fileExists(rootDir, "Pipfile")) scan.buildTools.push("Pipenv");
    if (fileExists(rootDir, "poetry.lock")) scan.buildTools.push("Poetry");
    if (fileExists(rootDir, "uv.lock")) scan.buildTools.push("uv");
  }

  // Rust
  const cargoToml = readText(rootDir, "Cargo.toml");
  if (cargoToml) {
    scan.languages.push("Rust");
    scan.runtime = scan.runtime || "rust";
    scan.buildTools.push("Cargo");
    const nameMatch = cargoToml.match(/^name\s*=\s*"([^"]+)"/m);
    if (nameMatch && !scan.detectedName) scan.detectedName = nameMatch[1];
    const descMatch = cargoToml.match(/^description\s*=\s*"([^"]+)"/m);
    if (descMatch && !scan.detectedDescription) scan.detectedDescription = descMatch[1];
  }

  // Go
  if (fileExists(rootDir, "go.mod")) {
    scan.languages.push("Go");
    scan.runtime = scan.runtime || "go";
    const goMod = readText(rootDir, "go.mod");
    if (goMod) {
      const modMatch = goMod.match(/^module\s+(.+)$/m);
      if (modMatch && !scan.detectedName) {
        scan.detectedName = modMatch[1].split("/").pop() || modMatch[1];
      }
    }
  }

  // Java / Kotlin
  if (fileExists(rootDir, "pom.xml") || fileExists(rootDir, "build.gradle") || fileExists(rootDir, "build.gradle.kts")) {
    scan.languages.push("Java");
    if (fileExists(rootDir, "build.gradle.kts")) scan.languages.push("Kotlin");
    scan.runtime = scan.runtime || "jvm";
    if (fileExists(rootDir, "pom.xml")) scan.buildTools.push("Maven");
    if (fileExists(rootDir, "build.gradle") || fileExists(rootDir, "build.gradle.kts")) scan.buildTools.push("Gradle");
  }

  // C / C++
  if (fileExists(rootDir, "CMakeLists.txt")) {
    scan.languages.push("C/C++");
    scan.buildTools.push("CMake");
  }

  // Generic
  if (fileExists(rootDir, "Makefile")) scan.buildTools.push("Make");

  // ── CI/CD detection ──

  if (fileExists(rootDir, ".github", "workflows")) scan.cicd.push("GitHub Actions");
  if (fileExists(rootDir, ".gitlab-ci.yml")) scan.cicd.push("GitLab CI");
  if (fileExists(rootDir, "Jenkinsfile")) scan.cicd.push("Jenkins");
  if (fileExists(rootDir, ".circleci")) scan.cicd.push("CircleCI");
  if (fileExists(rootDir, ".travis.yml")) scan.cicd.push("Travis CI");
  if (fileExists(rootDir, "bitbucket-pipelines.yml")) scan.cicd.push("Bitbucket Pipelines");

  // ── Infra detection ──

  if (fileExists(rootDir, "Dockerfile") || fileExists(rootDir, "docker-compose.yml") || fileExists(rootDir, "docker-compose.yaml")) scan.infra.push("Docker");
  if (fileExists(rootDir, "vercel.json") || fileExists(rootDir, ".vercel")) scan.infra.push("Vercel");
  if (fileExists(rootDir, "netlify.toml")) scan.infra.push("Netlify");
  if (fileExists(rootDir, "fly.toml")) scan.infra.push("Fly.io");
  if (fileExists(rootDir, "serverless.yml") || fileExists(rootDir, "serverless.yaml")) scan.infra.push("Serverless");
  if (fileExists(rootDir, "terraform")) scan.infra.push("Terraform");
  if (fileExists(rootDir, "pulumi")) scan.infra.push("Pulumi");
  if (fileExists(rootDir, "k8s") || fileExists(rootDir, "kubernetes")) scan.infra.push("Kubernetes");
  if (fileExists(rootDir, "render.yaml")) scan.infra.push("Render");
  if (fileExists(rootDir, "railway.json") || fileExists(rootDir, "railway.toml")) scan.infra.push("Railway");

  // ── Test detection (additional) ──

  if (!scan.hasTests) {
    scan.hasTests = fileExists(rootDir, "tests") || fileExists(rootDir, "test") ||
      fileExists(rootDir, "__tests__") || fileExists(rootDir, "spec") ||
      fileExists(rootDir, "cypress") || fileExists(rootDir, "e2e") ||
      fileExists(rootDir, "pytest.ini") || fileExists(rootDir, ".pytest.ini");
  }

  // ── Git stats ──

  if (hasGit) {
    const commitCountStr = execSync_safe("git rev-list --count HEAD", rootDir);
    scan.commitCount = parseInt(commitCountStr, 10) || 0;
    const branchCountStr = execSync_safe("git branch | wc -l", rootDir);
    scan.branchCount = parseInt(branchCountStr, 10) || 0;
    scan.hasRemote = execSync_safe("git remote", rootDir).length > 0;
  }

  // Dedupe
  scan.languages = [...new Set(scan.languages)];
  scan.frameworks = [...new Set(scan.frameworks)];
  scan.buildTools = [...new Set(scan.buildTools)];
  scan.cicd = [...new Set(scan.cicd)];
  scan.infra = [...new Set(scan.infra)];

  return scan;
}

// ── Source TODO scanner ─────────────────────────────────────

// Re-export SourceTodo from shared types for backwards compatibility
export type { SourceTodo } from "../shared/types.js";
import type { SourceTodo } from "../shared/types.js";

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java", ".kt",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".sh",
  ".yaml", ".yml", ".toml", ".md", ".html", ".css", ".scss",
  ".svelte", ".vue", ".swift", ".zig",
]);

const SKIP_DIRS = new Set([
  "node_modules", "__pycache__", "dist", "build", "target", ".devctx",
  ".git", "vendor", ".next", ".nuxt", "coverage", ".turbo",
]);

const TODO_PATTERN = /(?:\/\/|#|\*|--|\/\*|<!--)\s*(TODO|FIXME|HACK|XXX)\b[:\s]*(.*)/i;

const MAX_DEPTH = 5;
const MAX_FILES = 500;
const MAX_LINES_PER_FILE = 10000;

function collectFiles(dir: string, rootDir: string, depth: number, files: string[]): void {
  if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isFile()) {
          const ext = entry.substring(entry.lastIndexOf("."));
          if (SOURCE_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        } else if (stat.isDirectory()) {
          collectFiles(fullPath, rootDir, depth + 1, files);
        }
      } catch { /* permission errors */ }
    }
  } catch { /* empty dir */ }
}

export function scanSourceTodos(rootDir: string): SourceTodo[] {
  const files: string[] = [];
  collectFiles(rootDir, rootDir, 0, files);

  const todos: SourceTodo[] = [];

  for (const filePath of files) {
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const lineCount = Math.min(lines.length, MAX_LINES_PER_FILE);

      for (let i = 0; i < lineCount; i++) {
        const match = lines[i].match(TODO_PATTERN);
        if (match) {
          const relativePath = filePath.substring(rootDir.length + 1);
          todos.push({
            file: relativePath,
            line: i + 1,
            tag: match[1].toUpperCase(),
            text: match[2].replace(/\s*(?:\*\/|-->)\s*$/, "").trim(),
          });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return todos;
}

export function formatSourceTodos(todos: SourceTodo[]): string {
  if (todos.length === 0) return "No code TODOs found.";

  const tagCounts: Record<string, number> = {};
  for (const t of todos) {
    tagCounts[t.tag] = (tagCounts[t.tag] || 0) + 1;
  }

  const countParts = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => `${count} ${tag}`);

  const lines: string[] = [
    `**Code TODOs found:** ${todos.length} (${countParts.join(", ")})`,
    "",
  ];

  const display = todos.slice(0, 20);
  for (const t of display) {
    lines.push(`- **${t.tag}** \`${t.file}:${t.line}\` ${t.text}`);
  }

  if (todos.length > 20) {
    lines.push(`\n... and ${todos.length - 20} more`);
  }

  return lines.join("\n");
}

// ── Format scan for display ─────────────────────────────────

export function formatScanReport(scan: ProjectScan): string {
  const lines: string[] = [];

  const envLabels: Record<string, string> = {
    empty: "📂 Empty directory — no files, no git",
    files_no_git: "📁 Files found, no git repository",
    git_no_devctx: "🔀 Git repo, devctx not yet initialized",
    git_with_devctx: "✅ Git repo with existing devctx",
  };

  lines.push(`**Environment:** ${envLabels[scan.environment]}`);
  lines.push(`**Directory:** \`${scan.rootDir}\``);

  if (scan.detectedName) lines.push(`**Detected name:** ${scan.detectedName}`);
  if (scan.detectedDescription) lines.push(`**Detected description:** ${scan.detectedDescription}`);

  if (scan.languages.length > 0) lines.push(`**Languages:** ${scan.languages.join(", ")}`);
  if (scan.runtime) lines.push(`**Runtime:** ${scan.runtime}`);
  if (scan.frameworks.length > 0) lines.push(`**Frameworks:** ${scan.frameworks.join(", ")}`);
  if (scan.buildTools.length > 0) lines.push(`**Build tools:** ${scan.buildTools.join(", ")}`);
  if (scan.cicd.length > 0) lines.push(`**CI/CD:** ${scan.cicd.join(", ")}`);
  if (scan.infra.length > 0) lines.push(`**Infrastructure:** ${scan.infra.join(", ")}`);

  if (Object.keys(scan.scripts).length > 0) {
    lines.push(`**Scripts:** ${Object.entries(scan.scripts).map(([k, v]) => `\`${k}\` → \`${v}\``).join(", ")}`);
  }

  lines.push(`**Files:** ~${scan.fileCount} | README: ${scan.hasReadme ? "✅" : "❌"} | Tests: ${scan.hasTests ? "✅" : "❌"} | License: ${scan.hasLicense ? "✅" : "❌"}`);

  if (scan.hasGit) {
    lines.push(`**Git:** ${scan.commitCount} commits, ${scan.branchCount} branches, remote: ${scan.hasRemote ? "✅" : "❌"}`);
  }

  return lines.join("\n");
}

// ── Generate auto-description from scan ─────────────────────

export function generateAutoDescription(scan: ProjectScan): string {
  const parts: string[] = [];

  if (scan.detectedDescription) return scan.detectedDescription;

  const name = scan.detectedName || scan.dirName;

  if (scan.languages.length > 0) {
    parts.push(`${scan.languages.join("/")} project`);
  } else {
    parts.push("Project");
  }

  if (scan.frameworks.length > 0) {
    parts.push(`using ${scan.frameworks.slice(0, 3).join(", ")}`);
  }

  if (scan.infra.length > 0) {
    parts.push(`deployed via ${scan.infra.slice(0, 2).join(", ")}`);
  }

  return `${name}: ${parts.join(" ")}`;
}
