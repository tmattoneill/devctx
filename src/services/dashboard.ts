import type { GitStatus, BranchInfo } from "./git.js";
import type { ProjectState, Todo, ActivityEntry } from "./state.js";

// ── Utility formatters ──────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function padRight(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return s + " ".repeat(len - s.length);
}

function padLeft(s: string, len: number): string {
  if (s.length >= len) return s.slice(0, len);
  return " ".repeat(len - s.length) + s;
}

function timeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (isNaN(then)) return "unknown";

  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function divider(label?: string): string {
  if (!label) return "─".repeat(62);
  const rest = 62 - label.length - 3;
  return "── " + label + " " + "─".repeat(Math.max(1, rest));
}

// ── Table builder ───────────────────────────────────────────

interface TableCol {
  header: string;
  width: number;
}

function tableRow(cols: TableCol[], values: string[]): string {
  const cells = cols.map((col, i) => " " + padRight(truncate(values[i] || "", col.width), col.width) + " ");
  return "│" + cells.join("│") + "│";
}

function tableBorder(cols: TableCol[], left: string, mid: string, right: string): string {
  const segments = cols.map((col) => "─".repeat(col.width + 2));
  return left + segments.join(mid) + right;
}

// ── Main dashboard builder ──────────────────────────────────

export interface DashboardData {
  state: ProjectState;
  status: GitStatus;
  branches: BranchInfo[];
  todos: Todo[];
  vitals: Record<string, ActivityEntry | null>;
  lastPush: string;
  remote: string;
  stashCount: number;
  lastCommitAge: string;
  narrative?: string;
}

export function buildDashboard(data: DashboardData): string {
  const { state, status, branches, todos, vitals, lastPush, remote, stashCount, lastCommitAge, narrative } = data;
  const lines: string[] = [];

  // ── HEADER ──
  const statusIcon = state.active ? "▶ ACTIVE" : "⏸ PAUSED";
  lines.push(`devctx ${statusIcon} ── ${state.projectName}`);
  lines.push("═".repeat(62));

  // ── NARRATIVE ──
  if (narrative) {
    lines.push("");
    lines.push(narrative);
    lines.push("");
    lines.push(divider());
  }

  // ── CORE INFO ──
  lines.push("");
  lines.push(`🌿 Branch    ${status.branch}`);
  if (state.currentFocus) {
    lines.push(`🎯 Focus     ${truncate(state.currentFocus, 50)}`);
  }
  const shortRemote = remote.replace(/^https?:\/\//, "").replace(/\.git$/, "");
  lines.push(`📡 Remote    ${truncate(shortRemote, 50)}`);

  // ── WORKING TREE ──
  lines.push("");
  lines.push(divider("Working Tree"));
  if (status.isClean) {
    lines.push("  ✨ Clean — nothing to commit");
  } else {
    if (status.staged.length > 0) lines.push(`  Staged:    ${status.staged.length} file(s)`);
    if (status.modified.length > 0) lines.push(`  Modified:  ${status.modified.length} file(s)`);
    if (status.untracked.length > 0) lines.push(`  Untracked: ${status.untracked.length} file(s)`);
    if (stashCount > 0) lines.push(`  Stashed:   ${stashCount} entr${stashCount === 1 ? "y" : "ies"}`);
  }

  const syncParts: string[] = [];
  if (status.ahead > 0) syncParts.push(`⬆ ${status.ahead} ahead`);
  if (status.behind > 0) syncParts.push(`⬇ ${status.behind} behind`);
  if (syncParts.length > 0) {
    lines.push(`  ${syncParts.join(" · ")}`);
  }

  // ── BRANCHES ──
  const otherBranches = branches.filter((b) => !b.isCurrent);
  const liveBranches = otherBranches.filter((b) => !b.merged);
  const deadBranches = otherBranches.filter((b) => b.merged);

  lines.push("");
  lines.push(divider(`Branches (${liveBranches.length} live, ${deadBranches.length} merged)`));

  if (branches.length === 0) {
    lines.push("  No branches found");
  } else {
    const branchCols: TableCol[] = [
      { header: "Branch", width: 24 },
      { header: "Commit", width: 7 },
      { header: "Age", width: 12 },
      { header: "Status", width: 9 },
    ];

    lines.push(tableBorder(branchCols, "┌", "┬", "┐"));
    lines.push(tableRow(branchCols, branchCols.map((c) => c.header)));
    lines.push(tableBorder(branchCols, "├", "┼", "┤"));

    const currentBranch = branches.find((b) => b.isCurrent);

    if (currentBranch) {
      lines.push(tableRow(branchCols, [
        "→ " + truncate(currentBranch.name, 21),
        currentBranch.shortHash,
        currentBranch.relativeDate || timeAgo(currentBranch.date),
        "★ current",
      ]));
    }

    const sortedLive = liveBranches.slice(0, 6);
    const sortedDead = deadBranches.slice(0, 8 - sortedLive.length);

    for (const b of sortedLive) {
      lines.push(tableRow(branchCols, [
        "  " + truncate(b.name, 21),
        b.shortHash,
        b.relativeDate || timeAgo(b.date),
        "🟢 live",
      ]));
    }

    for (const b of sortedDead) {
      lines.push(tableRow(branchCols, [
        "  " + truncate(b.name, 21),
        b.shortHash,
        b.relativeDate || timeAgo(b.date),
        "💀 merged",
      ]));
    }

    const remaining = otherBranches.length - sortedLive.length - sortedDead.length;
    if (remaining > 0) {
      lines.push(tableRow(branchCols, [`  … +${remaining} more`, "", "", ""]));
    }

    lines.push(tableBorder(branchCols, "└", "┴", "┘"));
  }

  // ── TODOS ──
  const activeTodos = todos.filter((t) => t.status !== "done");
  const branchTodos = activeTodos.filter((t) => !t.branch || t.branch === status.branch);

  lines.push("");
  lines.push(divider(`Todos — ${status.branch} (${branchTodos.length} active, ${activeTodos.length} total)`));

  if (branchTodos.length === 0) {
    lines.push("  No active todos for this branch");
  } else {
    const priorityIcon: Record<string, string> = { critical: "🔴", high: "🟠", medium: "🟡", low: "🟢" };
    const statusLabel: Record<string, string> = { todo: "TODO", in_progress: " WIP", blocked: "BLKD" };
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

    const sorted = [...branchTodos].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));

    for (const todo of sorted.slice(0, 8)) {
      const icon = priorityIcon[todo.priority] || "⬜";
      const st = statusLabel[todo.status] || todo.status;
      const text = truncate(todo.text, 48);
      lines.push(`  ${icon} ${padRight(text, 48)} ${padLeft(st, 4)}`);
    }
    if (branchTodos.length > 8) {
      lines.push(`  … +${branchTodos.length - 8} more`);
    }
  }

  // ── VITALS ──
  lines.push("");
  lines.push(divider("Vitals"));

  const vitalsCols: TableCol[] = [
    { header: "Event", width: 13 },
    { header: "When", width: 12 },
    { header: "Detail", width: 30 },
  ];

  lines.push(tableBorder(vitalsCols, "┌", "┬", "┐"));

  function vitalRow(label: string, entry: ActivityEntry | null | undefined, fallbackWhen?: string, fallbackDetail?: string) {
    lines.push(tableRow(vitalsCols, [
      label,
      entry ? timeAgo(entry.timestamp) : (fallbackWhen || "never"),
      entry ? truncate(entry.message, 30) : (fallbackDetail || "—"),
    ]));
  }

  vitalRow("Last Commit", null, lastCommitAge, truncate(lastPush, 30));
  vitalRow("Last Build", vitals["build"]);
  vitalRow("Last Run", vitals["run"]);
  vitalRow("Last Test", vitals["test"]);
  vitalRow("Last Push", vitals["push"]);
  vitalRow("Last Deploy", vitals["deploy"]);
  vitalRow("Session", vitals["session_start"], "—", "no session logged");

  lines.push(tableBorder(vitalsCols, "└", "┴", "┘"));

  // ── FOOTER ──
  lines.push("");
  lines.push(`Updated: ${new Date(state.lastUpdated).toLocaleString()}`);

  return lines.join("\n");
}
