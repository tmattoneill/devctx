import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
  branch: string;
}

export interface GitStatus {
  branch: string;
  isClean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  ahead: number;
  behind: number;
}

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 10000 }).trim();
  } catch {
    return "";
  }
}

export function hasGitRepo(cwd: string): boolean {
  return existsSync(join(cwd, ".git"));
}

export function initGitRepo(cwd: string, defaultBranch: string = "main"): boolean {
  try {
    execSync(`git init -b ${defaultBranch}`, { cwd, encoding: "utf-8", timeout: 10000 });

    // Set user config if not already set (needed for commits)
    const userName = exec("git config user.name", cwd);
    const userEmail = exec("git config user.email", cwd);
    if (!userName) exec('git config user.name "Developer"', cwd);
    if (!userEmail) exec('git config user.email "dev@localhost"', cwd);

    return true;
  } catch {
    return false;
  }
}

export function createInitialCommit(cwd: string, message: string = "Initial commit (devctx)"): boolean {
  try {
    // Stage everything that exists
    exec("git add -A", cwd);
    const status = exec("git status --porcelain", cwd);
    if (status.length > 0) {
      execSync(`git commit -m "${message}"`, { cwd, encoding: "utf-8", timeout: 10000 });
    } else {
      // Nothing to stage, create empty initial commit
      execSync(`git commit --allow-empty -m "${message}"`, { cwd, encoding: "utf-8", timeout: 10000 });
    }
    return true;
  } catch {
    return false;
  }
}

export function commitFiles(cwd: string, files: string[], message: string): boolean {
  try {
    for (const file of files) {
      exec(`git add -- "${file}"`, cwd);
    }
    const status = exec("git status --porcelain", cwd);
    if (!status) return false; // nothing to commit
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd, encoding: "utf-8", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

export function getDiff(cwd: string): string {
  // Staged + unstaged changes
  const staged = exec("git diff --cached --stat", cwd);
  const unstaged = exec("git diff --stat", cwd);
  const untracked = exec("git ls-files --others --exclude-standard", cwd);
  const parts: string[] = [];
  if (staged) parts.push("Staged:\n" + staged);
  if (unstaged) parts.push("Unstaged:\n" + unstaged);
  if (untracked) parts.push("Untracked:\n" + untracked);
  return parts.join("\n\n") || "No changes";
}

export function getRepoRoot(cwd: string): string | null {
  const root = exec("git rev-parse --show-toplevel", cwd);
  return root || null;
}

export function getCurrentBranch(cwd: string): string {
  return exec("git rev-parse --abbrev-ref HEAD", cwd) || "unknown";
}

export function getRemoteUrl(cwd: string): string {
  return exec("git remote get-url origin", cwd) || "no remote";
}

export function getRecentCommits(cwd: string, count: number = 10, branch?: string): GitCommit[] {
  const branchArg = branch || "";
  const format = "%H|%h|%s|%an|%ai";
  const raw = exec(`git log ${branchArg} --format="${format}" -n ${count}`, cwd);
  if (!raw) return [];

  const currentBranch = getCurrentBranch(cwd);

  return raw.split("\n").filter(Boolean).map((line) => {
    const [hash, shortHash, subject, author, date] = line.split("|");
    return { hash, shortHash, subject, author, date, branch: branch || currentBranch };
  });
}

export function getGitStatus(cwd: string): GitStatus {
  const branch = getCurrentBranch(cwd);
  const statusRaw = exec("git status --porcelain", cwd);
  const lines = statusRaw.split("\n").filter(Boolean);

  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of lines) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    const file = line.slice(3);

    if (indexStatus !== " " && indexStatus !== "?") staged.push(file);
    if (workTreeStatus === "M" || workTreeStatus === "D") modified.push(file);
    if (indexStatus === "?") untracked.push(file);
  }

  // Get ahead/behind
  let ahead = 0;
  let behind = 0;
  const aheadBehind = exec("git rev-list --left-right --count HEAD...@{upstream}", cwd);
  if (aheadBehind) {
    const parts = aheadBehind.split("\t");
    ahead = parseInt(parts[0], 10) || 0;
    behind = parseInt(parts[1], 10) || 0;
  }

  return {
    branch,
    isClean: lines.length === 0,
    staged,
    modified,
    untracked,
    ahead,
    behind,
  };
}

export function getBranches(cwd: string): string[] {
  const raw = exec("git branch --format='%(refname:short)'", cwd);
  return raw.split("\n").filter(Boolean).map((b) => b.replace(/^'|'$/g, ""));
}

export function getLastPush(cwd: string, branch?: string): string {
  const b = branch || getCurrentBranch(cwd);
  const raw = exec(`git log origin/${b} -1 --format="%h %s (%ai)"`, cwd);
  return raw || "No pushes found for this branch";
}

export function getDiffSummary(cwd: string, since?: string): string {
  const sinceArg = since ? `--since="${since}"` : "-n 1";
  return exec(`git diff --stat HEAD~1 HEAD`, cwd) || "No changes";
}

export function getTags(cwd: string, count: number = 5): string[] {
  const raw = exec(`git tag --sort=-creatordate | head -${count}`, cwd);
  return raw.split("\n").filter(Boolean);
}

export interface BranchInfo {
  name: string;
  shortHash: string;
  subject: string;
  date: string;
  relativeDate: string;
  isCurrent: boolean;
  merged: boolean;
}

export function getDefaultBranch(cwd: string): string {
  // Try common defaults
  for (const name of ["main", "master", "develop"]) {
    const exists = exec(`git rev-parse --verify ${name}`, cwd);
    if (exists) return name;
  }
  // Fall back to first branch
  const branches = getBranches(cwd);
  return branches[0] || "main";
}

export function getAllBranches(cwd: string): BranchInfo[] {
  const current = getCurrentBranch(cwd);
  const defaultBranch = getDefaultBranch(cwd);
  const format = "%(refname:short)|%(objectname:short)|%(subject)|%(committerdate:iso)|%(committerdate:relative)";
  const raw = exec(`git branch --format="${format}" --sort=-committerdate`, cwd);
  if (!raw) return [];

  // Get list of branches fully merged into the default branch
  const mergedRaw = exec(`git branch --merged ${defaultBranch} --format="%(refname:short)"`, cwd);
  const mergedSet = new Set(
    mergedRaw.split("\n").filter(Boolean).map(b => b.trim())
  );

  return raw.split("\n").filter(Boolean).map((line) => {
    const parts = line.split("|");
    const name = parts[0];
    return {
      name,
      shortHash: parts[1],
      subject: parts[2],
      date: parts[3],
      relativeDate: parts[4],
      isCurrent: name === current,
      // Default branch and current are never "dead"
      merged: name !== defaultBranch && name !== current && mergedSet.has(name),
    };
  });
}

export function getStashCount(cwd: string): number {
  const raw = exec("git stash list", cwd);
  if (!raw) return 0;
  return raw.split("\n").filter(Boolean).length;
}

export function getLastCommitAge(cwd: string): string {
  return exec("git log -1 --format=%cr", cwd) || "never";
}
