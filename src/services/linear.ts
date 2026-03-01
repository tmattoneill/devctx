import type { Todo, LinearConfig } from "../shared/types.js";
import { getTodos, updateTodo, addTodo } from "../shared/data.js";

const LINEAR_API_URL = "https://api.linear.app/graphql";

// --- Base GraphQL request ---

async function linearRequest<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(LINEAR_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": apiKey, // Linear uses raw key, no "Bearer" prefix
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API HTTP ${response.status}: ${response.statusText}`);
  }

  const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

  if (json.errors?.length) {
    throw new Error(`Linear API error: ${json.errors.map(e => e.message).join(", ")}`);
  }

  if (!json.data) {
    throw new Error("Linear API returned no data");
  }

  return json.data;
}

// --- Types for Linear API responses ---

interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: {
    nodes: Array<{ id: string; name: string; type: string }>;
  };
}

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string; type: string };
}

// --- Viewer and teams ---

export async function fetchViewerAndTeams(apiKey: string): Promise<{
  userId: string;
  teams: Array<{ id: string; key: string; name: string; states: Array<{ id: string; name: string; type: string }> }>;
}> {
  const query = `
    query Viewer {
      viewer {
        id
        teams {
          nodes {
            id
            key
            name
            states {
              nodes {
                id
                name
                type
              }
            }
          }
        }
      }
    }
  `;

  const data = await linearRequest<{
    viewer: {
      id: string;
      teams: { nodes: LinearTeam[] };
    };
  }>(apiKey, query);

  return {
    userId: data.viewer.id,
    teams: data.viewer.teams.nodes.map(t => ({
      id: t.id,
      key: t.key,
      name: t.name,
      states: t.states.nodes,
    })),
  };
}

// --- Fetch assigned issues ---

export async function fetchAssignedIssues(apiKey: string, teamId: string, userId: string): Promise<LinearIssue[]> {
  const query = `
    query AssignedIssues($teamId: String!, $userId: ID!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          assignee: { id: { eq: $userId } }
          state: { type: { nin: ["completed", "cancelled"] } }
        }
      ) {
        nodes {
          id
          identifier
          title
          url
          priority
          updatedAt
          state {
            id
            name
            type
          }
        }
      }
    }
  `;

  const data = await linearRequest<{
    issues: { nodes: LinearIssue[] };
  }>(apiKey, query, { teamId, userId });

  return data.issues.nodes;
}

// --- Create Linear issue ---

export async function createLinearIssue(
  apiKey: string,
  teamId: string,
  assigneeId: string,
  stateId: string,
  title: string,
  priority: number
): Promise<{ id: string; identifier: string; url: string }> {
  const mutation = `
    mutation CreateIssue($teamId: String!, $assigneeId: String!, $stateId: String!, $title: String!, $priority: Int!) {
      issueCreate(input: {
        teamId: $teamId
        assigneeId: $assigneeId
        stateId: $stateId
        title: $title
        priority: $priority
      }) {
        success
        issue {
          id
          identifier
          url
        }
      }
    }
  `;

  const data = await linearRequest<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } };
  }>(apiKey, mutation, { teamId, assigneeId, stateId, title, priority });

  if (!data.issueCreate.success) {
    throw new Error("Linear issueCreate mutation returned success=false");
  }

  return data.issueCreate.issue;
}

// --- Update Linear issue ---

export async function updateLinearIssue(
  apiKey: string,
  issueId: string,
  updates: { stateId?: string; priority?: number; title?: string }
): Promise<{ id: string; identifier: string }> {
  const mutation = `
    mutation UpdateIssue($issueId: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $issueId, input: $input) {
        success
        issue {
          id
          identifier
        }
      }
    }
  `;

  const data = await linearRequest<{
    issueUpdate: { success: boolean; issue: { id: string; identifier: string } };
  }>(apiKey, mutation, { issueId, input: updates });

  if (!data.issueUpdate.success) {
    throw new Error("Linear issueUpdate mutation returned success=false");
  }

  return data.issueUpdate.issue;
}

// --- Status mapping helpers ---

/** Map a devctx todo status to the closest Linear state in a team's state list */
function findStateId(
  states: Array<{ id: string; name: string; type: string }>,
  statusMap: LinearConfig["statusMap"],
  devctxStatus: Todo["status"]
): string | null {
  const targetName = statusMap[devctxStatus];

  // Try exact name match first
  const exact = states.find(s => s.name.toLowerCase() === targetName.toLowerCase());
  if (exact) return exact.id;

  // Fall back to type match
  const typeMapping: Record<string, string[]> = {
    todo: ["unstarted", "backlog"],
    in_progress: ["started"],
    done: ["completed", "cancelled"],
    blocked: ["unstarted", "backlog"],
  };

  const acceptableTypes = typeMapping[devctxStatus] ?? ["unstarted"];
  const byType = states.find(s => acceptableTypes.includes(s.type));
  return byType?.id ?? null;
}

/** Map a Linear state type to a devctx todo status */
function linearStateToDEvctxStatus(stateType: string): Todo["status"] {
  switch (stateType) {
    case "started": return "in_progress";
    case "completed":
    case "cancelled": return "done";
    default: return "todo";
  }
}

/** Map a devctx priority to a Linear priority int */
function priorityToLinear(priority: Todo["priority"]): number {
  switch (priority) {
    case "critical": return 1; // Urgent
    case "high": return 2;
    case "medium": return 3;
    case "low": return 4;
    default: return 3;
  }
}

// --- Sync result ---

export interface SyncResult {
  pulled: number;
  pushed: number;
  updated: number;
  errors: string[];
}

// --- Main sync function ---

export async function syncWithLinear(
  repoRoot: string,
  apiKey: string,
  config: LinearConfig,
  direction: "both" | "pull" | "push",
  branch: string
): Promise<SyncResult> {
  const result: SyncResult = { pulled: 0, pushed: 0, updated: 0, errors: [] };

  const userId = config.userId;
  if (!userId) {
    throw new Error("Linear config is missing userId. Run devctx_linear_sync with configure=true first.");
  }

  // Fetch current Linear issues assigned to user
  let linearIssues: LinearIssue[] = [];
  if (direction === "both" || direction === "pull") {
    try {
      linearIssues = await fetchAssignedIssues(apiKey, config.teamId, userId);
    } catch (err) {
      throw new Error(`Failed to fetch Linear issues: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const todos = getTodos(repoRoot);
  const now = new Date().toISOString();

  // --- PULL: Linear → devctx ---
  if (direction === "both" || direction === "pull") {
    for (const issue of linearIssues) {
      // Find matching todo by linearId
      const existing = todos.find(t => t.linearId === issue.id);
      const newStatus = linearStateToDEvctxStatus(issue.state.type);

      if (existing) {
        // Update if Linear is newer than our last sync
        if (!existing.linearSyncedAt || issue.updatedAt > existing.linearSyncedAt) {
          updateTodo(repoRoot, existing.id, {
            status: newStatus,
            linearSyncedAt: now,
          });
          result.updated++;
        }
      } else {
        // Create new devctx todo from Linear issue
        const newTodo = addTodo(
          repoRoot,
          issue.title,
          issue.priority === 1 ? "critical" : issue.priority === 2 ? "high" : issue.priority === 4 ? "low" : "medium",
          branch,
          undefined,
          "linear"
        );
        updateTodo(repoRoot, newTodo.id, {
          status: newStatus,
          linearId: issue.id,
          linearUrl: issue.url,
          linearIdentifier: issue.identifier,
          linearSyncedAt: now,
        });
        result.pulled++;
      }
    }
  }

  // Reload todos after pull changes
  const currentTodos = getTodos(repoRoot);

  // --- PUSH: devctx → Linear ---
  if (direction === "both" || direction === "push") {
    // Build team states lookup
    let teamStates: Array<{ id: string; name: string; type: string }> = [];
    try {
      const viewer = await fetchViewerAndTeams(apiKey);
      const team = viewer.teams.find(t => t.id === config.teamId);
      teamStates = team?.states ?? [];
    } catch (err) {
      result.errors.push(`Failed to fetch team states for push: ${err instanceof Error ? err.message : String(err)}`);
    }

    for (const todo of currentTodos) {
      if (todo.status === "done") continue;

      if (!todo.linearId) {
        // Push new unlinked todo to Linear
        const stateId = findStateId(teamStates, config.statusMap, todo.status);
        if (!stateId) {
          result.errors.push(`No Linear state found for status "${todo.status}" for todo "${todo.text}"`);
          continue;
        }

        try {
          const created = await createLinearIssue(
            apiKey,
            config.teamId,
            userId,
            stateId,
            todo.text,
            priorityToLinear(todo.priority)
          );
          updateTodo(repoRoot, todo.id, {
            linearId: created.id,
            linearUrl: created.url,
            linearIdentifier: created.identifier,
            linearSyncedAt: now,
          });
          result.pushed++;
        } catch (err) {
          result.errors.push(`Failed to push todo "${todo.text}": ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (!todo.linearSyncedAt || todo.updated > todo.linearSyncedAt) {
        // Push updates for already-linked todos where devctx is newer
        const stateId = findStateId(teamStates, config.statusMap, todo.status);
        try {
          await updateLinearIssue(apiKey, todo.linearId, {
            ...(stateId ? { stateId } : {}),
            priority: priorityToLinear(todo.priority),
            title: todo.text,
          });
          updateTodo(repoRoot, todo.id, { linearSyncedAt: now });
          result.updated++;
        } catch (err) {
          result.errors.push(`Failed to update Linear issue ${todo.linearIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  return result;
}
