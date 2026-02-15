import Anthropic from "@anthropic-ai/sdk";
import type { GitCommit, GitStatus, BranchInfo } from "./git.js";
import type { ProjectState, Todo, ActivityEntry } from "./state.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 600;

interface NarrativeContext {
  state: ProjectState;
  status: GitStatus;
  branches: BranchInfo[];
  recentCommits: GitCommit[];
  recentActivity: ActivityEntry[];
  todos: Todo[];
  branchNotes: string;
  lastPush: string;
}

function buildPrompt(ctx: NarrativeContext): string {
  const parts: string[] = [];

  parts.push(`Project: ${ctx.state.projectName}`);
  if (ctx.state.description) parts.push(`Description: ${ctx.state.description}`);
  if (ctx.state.currentFocus) parts.push(`Current focus: ${ctx.state.currentFocus}`);
  parts.push(`Current branch: ${ctx.status.branch}`);
  parts.push(`Last push: ${ctx.lastPush}`);
  parts.push("");

  // Working tree
  if (!ctx.status.isClean) {
    const changes: string[] = [];
    if (ctx.status.staged.length) changes.push(`${ctx.status.staged.length} staged`);
    if (ctx.status.modified.length) changes.push(`${ctx.status.modified.length} modified`);
    if (ctx.status.untracked.length) changes.push(`${ctx.status.untracked.length} untracked`);
    parts.push(`Working tree: ${changes.join(", ")}`);
  } else {
    parts.push("Working tree: clean");
  }
  if (ctx.status.ahead) parts.push(`${ctx.status.ahead} commits ahead of remote`);
  if (ctx.status.behind) parts.push(`${ctx.status.behind} commits behind remote`);
  parts.push("");

  // Recent commits
  if (ctx.recentCommits.length > 0) {
    parts.push("Recent commits:");
    for (const c of ctx.recentCommits.slice(0, 10)) {
      parts.push(`  ${c.shortHash} ${c.subject} (${c.author}, ${c.date})`);
    }
    parts.push("");
  }

  // Activity log
  if (ctx.recentActivity.length > 0) {
    parts.push("Recent activity log:");
    for (const a of ctx.recentActivity.slice(0, 15)) {
      parts.push(`  [${a.type}] ${a.message} (${a.timestamp}, branch: ${a.branch})`);
    }
    parts.push("");
  }

  // Branches
  if (ctx.branches.length > 1) {
    parts.push("Active branches:");
    for (const b of ctx.branches.slice(0, 8)) {
      parts.push(`  ${b.isCurrent ? "→ " : "  "}${b.name}: ${b.shortHash} "${b.subject}" (${b.relativeDate})`);
    }
    parts.push("");
  }

  // Todos
  const activeTodos = ctx.todos.filter(t => t.status !== "done");
  if (activeTodos.length > 0) {
    parts.push("Active todos:");
    for (const t of activeTodos) {
      parts.push(`  [${t.priority}] [${t.status}] ${t.text}${t.branch ? ` (branch: ${t.branch})` : ""}`);
    }
    parts.push("");
  }

  const doneTodos = ctx.todos.filter(t => t.status === "done");
  if (doneTodos.length > 0) {
    parts.push(`Completed todos (${doneTodos.length}):`);
    for (const t of doneTodos.slice(0, 5)) {
      parts.push(`  ✓ ${t.text}`);
    }
    parts.push("");
  }

  // Branch notes
  if (ctx.branchNotes) {
    parts.push("Branch notes:");
    parts.push(ctx.branchNotes);
    parts.push("");
  }

  return parts.join("\n");
}

const SYSTEM_PROMPT = `You are a development assistant writing a brief project status narrative. Your job is to read the project context (commits, activity log, todos, branch notes) and write a concise, helpful summary that gets a developer back up to speed.

Write in second person ("you did X", "next steps are Y"). Be specific — reference actual commit messages, branch names, and todo items. Structure your response as:

1. **Last session recap** (2-3 sentences): What was accomplished based on recent commits and activity log entries. Mention specific changes and the branch they were on.

2. **Current state** (1-2 sentences): Where things stand right now — deployed or not, any uncommitted work, ahead/behind remote.

3. **Next steps**: A short bullet list of what to do next, drawn from active todos (prioritized by urgency) and any obvious gaps (e.g. "changes committed but not pushed", "tests not run").

Keep it to ~150 words. Be direct and useful, not chatty. If there's very little activity data, say so and focus on what you can see from git history and todos.`;

export async function generateNarrative(ctx: NarrativeContext): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return generateFallbackNarrative(ctx);
  }

  try {
    const client = new Anthropic({ apiKey });

    const contextText = buildPrompt(ctx);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the current project context:\n\n${contextText}\n\nWrite the status narrative.`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      return textBlock.text;
    }

    return generateFallbackNarrative(ctx);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Narrative generation failed: ${errMsg}`);
    return generateFallbackNarrative(ctx);
  }
}

/**
 * Deterministic fallback when no API key is available.
 * Still useful — just less eloquent.
 */
function generateFallbackNarrative(ctx: NarrativeContext): string {
  const lines: string[] = [];

  // Last session recap from commits
  if (ctx.recentCommits.length > 0) {
    const commitSummary = ctx.recentCommits
      .slice(0, 3)
      .map(c => `"${c.subject}"`)
      .join(", ");
    lines.push(`Recent work on \`${ctx.status.branch}\`: ${commitSummary}.`);
  } else {
    lines.push("No recent commits found.");
  }

  // Activity recap
  const pushes = ctx.recentActivity.filter(a => a.type === "push");
  const deploys = ctx.recentActivity.filter(a => a.type === "deploy");
  const builds = ctx.recentActivity.filter(a => a.type === "build");

  if (deploys.length > 0) {
    lines.push(`Last deployed: ${deploys[0].message} (${new Date(deploys[0].timestamp).toLocaleString()}).`);
  } else if (pushes.length > 0) {
    lines.push(`Last pushed but not yet deployed. Push: ${pushes[0].message}.`);
  } else if (ctx.recentCommits.length > 0) {
    lines.push("Changes committed but no push or deploy logged.");
  }

  // Current state
  if (!ctx.status.isClean) {
    const parts: string[] = [];
    if (ctx.status.staged.length) parts.push(`${ctx.status.staged.length} staged`);
    if (ctx.status.modified.length) parts.push(`${ctx.status.modified.length} modified`);
    if (ctx.status.untracked.length) parts.push(`${ctx.status.untracked.length} untracked`);
    lines.push(`Working tree has uncommitted changes: ${parts.join(", ")}.`);
  }

  if (ctx.status.ahead > 0) {
    lines.push(`${ctx.status.ahead} commit(s) ahead of remote — consider pushing.`);
  }

  // Next steps from todos
  const activeTodos = ctx.todos
    .filter(t => t.status !== "done")
    .sort((a, b) => {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (order[a.priority] ?? 2) - (order[b.priority] ?? 2);
    });

  if (activeTodos.length > 0) {
    lines.push("");
    lines.push("Next steps:");
    for (const t of activeTodos.slice(0, 5)) {
      const icon = t.priority === "critical" ? "🔴" : t.priority === "high" ? "🟠" : t.priority === "medium" ? "🟡" : "🟢";
      const statusTag = t.status === "in_progress" ? " (in progress)" : t.status === "blocked" ? " (blocked)" : "";
      lines.push(`  ${icon} ${t.text}${statusTag}`);
    }
  }

  lines.push("");
  lines.push("ℹ️ Set ANTHROPIC_API_KEY for AI-generated narratives.");

  return lines.join("\n");
}
