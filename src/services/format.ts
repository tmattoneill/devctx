import type { GitCommit, GitStatus } from "./git.js";
import type { ProjectState, Todo, ActivityEntry } from "../shared/types.js";

export function formatWhereAmI(
  repoRoot: string,
  status: GitStatus,
  state: ProjectState,
  recentCommits: GitCommit[],
  activeTodos: Todo[],
  recentActivity: ActivityEntry[],
  branchNotes: string,
  lastPush: string,
  currentVersion?: string
): string {
  const lines: string[] = [];

  // Header
  lines.push(`# 📍 ${state.projectName}`);
  if (state.description) lines.push(`> ${state.description}`);
  lines.push("");

  // Current focus
  if (state.currentFocus) {
    lines.push(`## 🎯 Current Focus`);
    lines.push(state.currentFocus);
    lines.push("");
  }

  // Git status
  lines.push(`## 🌿 Branch: \`${status.branch}\`${currentVersion ? ` — ${currentVersion}` : ""}`);
  if (status.isClean) {
    lines.push("Working tree is clean.");
  } else {
    if (status.staged.length > 0) lines.push(`- **Staged:** ${status.staged.length} file(s)`);
    if (status.modified.length > 0) lines.push(`- **Modified:** ${status.modified.length} file(s)`);
    if (status.untracked.length > 0) lines.push(`- **Untracked:** ${status.untracked.length} file(s)`);
  }
  if (status.ahead > 0) lines.push(`- ⬆️ ${status.ahead} commit(s) ahead of remote`);
  if (status.behind > 0) lines.push(`- ⬇️ ${status.behind} commit(s) behind remote`);
  lines.push("");

  // Last push
  lines.push(`**Last push:** ${lastPush}`);
  lines.push("");

  // Recent commits
  if (recentCommits.length > 0) {
    lines.push(`## 📝 Recent Commits`);
    for (const c of recentCommits.slice(0, 5)) {
      const date = new Date(c.date).toLocaleDateString();
      lines.push(`- \`${c.shortHash}\` ${c.subject} (${date})`);
    }
    lines.push("");
  }

  // Active todos
  if (activeTodos.length > 0) {
    lines.push(`## ✅ Active Todos (${activeTodos.length})`);
    const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const sorted = [...activeTodos].sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2));
    for (const todo of sorted) {
      const statusIcon = todo.status === "in_progress" ? "🔄" : todo.status === "blocked" ? "🚫" : "⬜";
      const priorityIcon = todo.priority === "critical" ? "🔴" : todo.priority === "high" ? "🟠" : todo.priority === "medium" ? "🟡" : "🟢";
      lines.push(`- ${statusIcon} ${priorityIcon} **${todo.text}** [${todo.id}]`);
    }
    lines.push("");
  }

  // Branch notes
  if (branchNotes) {
    lines.push(`## 📋 Branch Notes (\`${status.branch}\`)`);
    lines.push(branchNotes);
    lines.push("");
  }

  // Recent activity
  if (recentActivity.length > 0) {
    lines.push(`## 📊 Recent Activity`);
    for (const a of recentActivity.slice(0, 8)) {
      const time = new Date(a.timestamp).toLocaleString();
      const typeIcon = a.type === "commit" ? "💾" : a.type === "push" ? "🚀" : a.type === "build" ? "🔨" : a.type === "note" ? "📝" : a.type === "milestone" ? "🏆" : "📌";
      lines.push(`- ${typeIcon} ${a.message} (${time})`);
    }
    lines.push("");
  }

  // Last updated
  lines.push(`---`);
  lines.push(`*Last context update: ${new Date(state.lastUpdated).toLocaleString()}*`);

  return lines.join("\n");
}

export function formatTodoList(todos: Todo[], branch?: string): string {
  if (todos.length === 0) return branch ? `No todos found for branch \`${branch}\`.` : "No todos found.";

  const lines: string[] = [`# 📋 Todos (${todos.length})`];
  if (branch) lines.push(`Branch: \`${branch}\``);
  lines.push("");

  const groups: Record<string, Todo[]> = { todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of todos) {
    (groups[t.status] || groups.todo).push(t);
  }

  const sectionNames: Record<string, string> = {
    in_progress: "🔄 In Progress",
    blocked: "🚫 Blocked",
    todo: "⬜ To Do",
    done: "✅ Done",
  };

  for (const [status, label] of Object.entries(sectionNames)) {
    const items = groups[status];
    if (items && items.length > 0) {
      lines.push(`## ${label}`);
      for (const t of items) {
        const priorityIcon = t.priority === "critical" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🟡" : "🟢";
        const tags = t.tags?.length ? ` [${t.tags.join(", ")}]` : "";
        const suggestedTag = t.source === "suggested" ? " [suggested]" : "";
        lines.push(`- ${priorityIcon} **${t.text}**${suggestedTag}${tags} — \`${t.id}\``);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function formatActivityLog(entries: ActivityEntry[]): string {
  if (entries.length === 0) return "No activity logged yet.";

  const lines: string[] = [`# 📊 Activity Log (${entries.length} entries)`];
  lines.push("");

  for (const e of entries) {
    const time = new Date(e.timestamp).toLocaleString();
    const typeIcon = e.type === "commit" ? "💾" : e.type === "push" ? "🚀" : e.type === "build" ? "🔨" : e.type === "deploy" ? "🌐" : e.type === "note" ? "📝" : e.type === "milestone" ? "🏆" : "📌";
    lines.push(`### ${typeIcon} ${e.type.toUpperCase()} — ${time}`);
    lines.push(`Branch: \`${e.branch}\``);
    lines.push(e.message);
    if (e.metadata) {
      for (const [k, v] of Object.entries(e.metadata)) {
        lines.push(`- *${k}:* ${v}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}
