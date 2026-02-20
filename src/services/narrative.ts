import Anthropic from "@anthropic-ai/sdk";
import type { GitCommit, GitStatus, BranchInfo } from "./git.js";
import type { ProjectState, Todo, ActivityEntry, SourceTodo } from "../shared/types.js";
import { getLatestSessionContent } from "../shared/data.js";

const MODEL = "claude-sonnet-4-20250514";
const MAX_TOKENS = 600;
const GOODBYE_MAX_TOKENS = 1200;

// ── Narrative context (status dashboard) ─────────────────────

export interface NarrativeContext {
  state: ProjectState;
  status: GitStatus;
  branches: BranchInfo[];
  recentCommits: GitCommit[];
  recentActivity: ActivityEntry[];
  todos: Todo[];
  branchNotes: string;
  lastPush: string;
  repoRoot?: string;
}

function buildPrompt(ctx: NarrativeContext): string {
  const parts: string[] = [];

  // Include last session summary if available
  if (ctx.repoRoot) {
    const sessionContent = getLatestSessionContent(ctx.repoRoot);
    if (sessionContent) {
      parts.push("Last session summary (from goodbye):");
      parts.push(sessionContent.slice(0, 2000));
      parts.push("");
    }
  }

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

// ── Goodbye context + summary ────────────────────────────────

export interface GoodbyeContext extends NarrativeContext {
  claudeMdContent: string;
  userMessage?: string;
  sessionDuration?: string;
  commitCount: number;
  sourceTodos?: SourceTodo[];
  sourceTodoDiff?: { added: SourceTodo[]; resolved: SourceTodo[] };
}

const GOODBYE_SYSTEM_PROMPT = `You are a development assistant writing a comprehensive session wrap-up. This is a "save game" document — the developer is ending their session and needs a detailed record of what happened so they (or another developer) can pick up exactly where they left off.

Write in second person ("You were working on..."). Be specific and concrete — reference actual commit hashes, branch names, file names, and todo items. Never be vague or generic.

Structure your response in exactly three sections:

## What happened
A detailed narrative of this session's work. Reference specific commits, branches, files changed. Describe the progression of work — what was started, what was completed, what changed direction. This should read like a handover document.

## Unfinished work
Infer from uncommitted changes, WIP branches, partial implementations, failing tests, ahead/behind status. Be specific about what's mid-stream and what state it's in.

## Suggested next steps
Write 3-7 actionable items based on what was done. If commits were made but not pushed, suggest pushing. If tests were added but coverage is partial, suggest completing coverage. If a branch was started but not merged, suggest completing or merging it. If the user left a parting note, incorporate that context.

CRITICAL: Do NOT suggest items that overlap with or duplicate the existing todos listed in the context. Check the "Existing todos" section carefully — if a todo already covers the topic (even with different wording), do NOT include it. Only suggest genuinely NEW action items that are not already tracked.

After your narrative, output the suggested next steps as a parseable JSON array wrapped in a \`\`\`json code block. Each item should have "text" (string) and "priority" (one of: "low", "medium", "high", "critical"). Example:

\`\`\`json
[{"text": "Push goodbye-log branch to remote", "priority": "medium"}, {"text": "Add tests for hook installation", "priority": "high"}]
\`\`\`

Keep the narrative to ~300 words. The JSON block is in addition to the narrative.`;

function buildGoodbyePrompt(ctx: GoodbyeContext): string {
  const parts: string[] = [];

  parts.push(`Project: ${ctx.state.projectName}`);
  if (ctx.state.description) parts.push(`Description: ${ctx.state.description}`);
  if (ctx.state.currentFocus) parts.push(`Current focus: ${ctx.state.currentFocus}`);
  if (ctx.userMessage) parts.push(`Developer's parting note: "${ctx.userMessage}"`);
  if (ctx.sessionDuration) parts.push(`Session duration: ${ctx.sessionDuration}`);
  parts.push(`Current branch: ${ctx.status.branch}`);
  parts.push(`Last push: ${ctx.lastPush}`);
  parts.push(`Commits this session: ${ctx.commitCount}`);
  parts.push("");

  // Working tree
  if (!ctx.status.isClean) {
    const changes: string[] = [];
    if (ctx.status.staged.length) changes.push(`${ctx.status.staged.length} staged`);
    if (ctx.status.modified.length) changes.push(`${ctx.status.modified.length} modified`);
    if (ctx.status.untracked.length) changes.push(`${ctx.status.untracked.length} untracked`);
    parts.push(`Working tree: ${changes.join(", ")}`);
    if (ctx.status.staged.length) parts.push(`  Staged files: ${ctx.status.staged.join(", ")}`);
    if (ctx.status.modified.length) parts.push(`  Modified files: ${ctx.status.modified.join(", ")}`);
    if (ctx.status.untracked.length) parts.push(`  Untracked files: ${ctx.status.untracked.join(", ")}`);
  } else {
    parts.push("Working tree: clean");
  }
  if (ctx.status.ahead) parts.push(`${ctx.status.ahead} commits ahead of remote`);
  if (ctx.status.behind) parts.push(`${ctx.status.behind} commits behind remote`);
  parts.push("");

  // Commits
  if (ctx.recentCommits.length > 0) {
    parts.push("Git commits:");
    for (const c of ctx.recentCommits.slice(0, 15)) {
      parts.push(`  ${c.shortHash} ${c.subject} (${c.author}, ${c.date})`);
    }
    parts.push("");
  }

  // Activity log
  if (ctx.recentActivity.length > 0) {
    parts.push("Activity log:");
    for (const a of ctx.recentActivity.slice(0, 20)) {
      parts.push(`  [${a.type}] ${a.message} (${a.timestamp}, branch: ${a.branch})`);
    }
    parts.push("");
  }

  // Branches
  if (ctx.branches.length > 0) {
    parts.push("Branches:");
    for (const b of ctx.branches.slice(0, 10)) {
      const status = b.isCurrent ? "★ current" : b.merged ? "merged" : "live";
      parts.push(`  ${b.name}: ${b.shortHash} "${b.subject}" (${b.relativeDate}) [${status}]`);
    }
    parts.push("");
  }

  // Todos
  const activeTodos = ctx.todos.filter(t => t.status !== "done");
  if (activeTodos.length > 0) {
    parts.push("Existing todos:");
    for (const t of activeTodos) {
      parts.push(`  [${t.priority}] [${t.status}] ${t.text}`);
    }
    parts.push("");
  }

  // Branch notes
  if (ctx.branchNotes) {
    parts.push("Branch notes:");
    parts.push(ctx.branchNotes);
    parts.push("");
  }

  // Source TODOs
  if (ctx.sourceTodos && ctx.sourceTodos.length > 0) {
    parts.push(`Code TODOs in source (${ctx.sourceTodos.length} total):`);
    for (const t of ctx.sourceTodos.slice(0, 15)) {
      parts.push(`  [${t.tag}] ${t.file}:${t.line} — ${t.text}`);
    }
    if (ctx.sourceTodos.length > 15) {
      parts.push(`  ... and ${ctx.sourceTodos.length - 15} more`);
    }
    parts.push("");
  }

  if (ctx.sourceTodoDiff) {
    if (ctx.sourceTodoDiff.added.length > 0) {
      parts.push(`New code TODOs added this session (${ctx.sourceTodoDiff.added.length}):`);
      for (const t of ctx.sourceTodoDiff.added.slice(0, 10)) {
        parts.push(`  + [${t.tag}] ${t.file}:${t.line} — ${t.text}`);
      }
      parts.push("");
    }
    if (ctx.sourceTodoDiff.resolved.length > 0) {
      parts.push(`Code TODOs resolved this session (${ctx.sourceTodoDiff.resolved.length}):`);
      for (const t of ctx.sourceTodoDiff.resolved.slice(0, 10)) {
        parts.push(`  - [${t.tag}] ${t.file}:${t.line} — ${t.text}`);
      }
      parts.push("");
    }
  }

  // CLAUDE.md excerpt
  if (ctx.claudeMdContent) {
    parts.push("CLAUDE.md (project instructions):");
    parts.push(ctx.claudeMdContent.slice(0, 1500));
    parts.push("");
  }

  return parts.join("\n");
}

export interface GoodbyeResult {
  narrative: string;
  todos: Array<{ text: string; priority: "low" | "medium" | "high" | "critical" }>;
}

function extractTodosFromResponse(text: string): Array<{ text: string; priority: "low" | "medium" | "high" | "critical" }> {
  const jsonMatch = text.match(/```json\s*\n([\s\S]*?)\n\s*```/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    if (!Array.isArray(parsed)) return [];

    const validPriorities = new Set(["low", "medium", "high", "critical"]);
    return parsed
      .filter((item: unknown) => {
        if (typeof item !== "object" || item === null) return false;
        const obj = item as Record<string, unknown>;
        return typeof obj.text === "string" && typeof obj.priority === "string" && validPriorities.has(obj.priority);
      })
      .map((item: Record<string, string>) => ({
        text: item.text,
        priority: item.priority as "low" | "medium" | "high" | "critical",
      }));
  } catch {
    return [];
  }
}

function stripJsonBlock(text: string): string {
  return text.replace(/\n*```json\s*\n[\s\S]*?\n\s*```\s*$/, "").trim();
}

export async function generateGoodbyeSummary(ctx: GoodbyeContext): Promise<GoodbyeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return generateFallbackGoodbye(ctx);
  }

  try {
    const client = new Anthropic({ apiKey });
    const contextText = buildGoodbyePrompt(ctx);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: GOODBYE_MAX_TOKENS,
      system: GOODBYE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Here is the session context:\n\n${contextText}\n\nWrite the session wrap-up summary.`,
        },
      ],
    });

    const textBlock = response.content.find(b => b.type === "text");
    if (textBlock && textBlock.type === "text") {
      const todos = extractTodosFromResponse(textBlock.text);
      const narrative = stripJsonBlock(textBlock.text);
      return { narrative, todos };
    }

    return generateFallbackGoodbye(ctx);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`Goodbye summary generation failed: ${errMsg}`);
    return generateFallbackGoodbye(ctx);
  }
}

function generateFallbackGoodbye(ctx: GoodbyeContext): GoodbyeResult {
  const lines: string[] = [];
  const todos: GoodbyeResult["todos"] = [];

  // What happened
  lines.push("## What happened");
  if (ctx.recentCommits.length > 0) {
    lines.push(`You made ${ctx.commitCount} commit(s) on \`${ctx.status.branch}\`.`);
    for (const c of ctx.recentCommits.slice(0, 5)) {
      lines.push(`- \`${c.shortHash}\` ${c.subject}`);
    }
  } else {
    lines.push("No commits were made this session.");
  }
  if (ctx.userMessage) {
    lines.push(`\nYour note: "${ctx.userMessage}"`);
  }
  lines.push("");

  // Unfinished work
  lines.push("## Unfinished work");
  if (!ctx.status.isClean) {
    if (ctx.status.modified.length) lines.push(`- ${ctx.status.modified.length} modified file(s) not yet committed`);
    if (ctx.status.untracked.length) lines.push(`- ${ctx.status.untracked.length} untracked file(s)`);
    if (ctx.status.staged.length) lines.push(`- ${ctx.status.staged.length} staged file(s) ready to commit`);
  } else {
    lines.push("Working tree is clean.");
  }
  if (ctx.status.ahead > 0) {
    lines.push(`- ${ctx.status.ahead} commit(s) ahead of remote — not yet pushed`);
    todos.push({ text: `Push ${ctx.status.branch} to remote`, priority: "medium" });
  }
  lines.push("");

  // Suggested next steps
  lines.push("## Suggested next steps");

  if (ctx.status.ahead > 0) {
    lines.push(`- Push \`${ctx.status.branch}\` to remote (${ctx.status.ahead} commits ahead)`);
  }
  if (!ctx.status.isClean) {
    lines.push("- Review and commit uncommitted changes");
    todos.push({ text: "Review and commit uncommitted changes", priority: "medium" });
  }

  const activeTodos = ctx.todos.filter(t => t.status !== "done" && t.status !== "blocked");
  if (activeTodos.length > 0) {
    lines.push("- Continue working on existing todos:");
    for (const t of activeTodos.slice(0, 3)) {
      lines.push(`  - ${t.text}`);
    }
  }

  lines.push("");
  lines.push("*ℹ️ Set ANTHROPIC_API_KEY for AI-generated session summaries.*");

  return { narrative: lines.join("\n"), todos };
}
