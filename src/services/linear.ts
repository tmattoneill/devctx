import type { Todo, LinearConfig } from "../shared/types.js";
import { getTodos, updateTodo, addTodo, markTodoSynced, getLinearConfig, saveLinearConfig } from "../shared/data.js";

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
    query AssignedIssues($teamId: ID!, $userId: ID!) {
      issues(
        filter: {
          team: { id: { eq: $teamId } }
          assignee: { id: { eq: $userId } }
          state: { type: { nin: ["completed", "canceled"] } }
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

// --- Fetch specific issues by ID ---

/**
 * Look up issues by ID whatever their state.
 *
 * fetchAssignedIssues filters completed and canceled issues out, so an issue
 * closed in Linear simply stops appearing rather than arriving with a done
 * state. Without this the local todo would stay open forever.
 */
export async function fetchIssuesByIds(apiKey: string, issueIds: string[]): Promise<LinearIssue[]> {
  if (issueIds.length === 0) return [];

  const query = `
    query IssuesByIds($ids: [ID!]!) {
      issues(filter: { id: { in: $ids } }) {
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
  }>(apiKey, query, { ids: issueIds });

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
    done: ["completed", "canceled"],
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
    case "canceled": return "done";
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

// --- Workflow state resolution ---

export type StateIdMap = Record<Todo["status"], string | null>;

/**
 * Resolve this team's workflow state IDs, one per devctx status.
 *
 * Cached on the config so devctx_todo_update can close a Linear issue without
 * first listing every team. A full sync passes refresh so a renamed or deleted
 * workflow state cannot leave a stale ID behind.
 */
export async function resolveStateIds(
  repoRoot: string,
  apiKey: string,
  config: LinearConfig,
  opts: { refresh?: boolean } = {},
): Promise<StateIdMap> {
  const statuses: Todo["status"][] = ["todo", "in_progress", "done", "blocked"];

  if (!opts.refresh && config.stateIds) {
    const cached = config.stateIds;
    if (statuses.every(status => cached[status])) {
      return {
        todo: cached.todo ?? null,
        in_progress: cached.in_progress ?? null,
        done: cached.done ?? null,
        blocked: cached.blocked ?? null,
      };
    }
  }

  const viewer = await fetchViewerAndTeams(apiKey);
  const team = viewer.teams.find(t => t.id === config.teamId);
  if (!team) {
    throw new Error(`Linear team ${config.teamKey} (${config.teamId}) is no longer visible to this API key`);
  }

  const resolved = {} as StateIdMap;
  const toPersist: Partial<Record<Todo["status"], string>> = {};
  for (const status of statuses) {
    const id = findStateId(team.states, config.statusMap, status);
    resolved[status] = id;
    if (id) toPersist[status] = id;
  }

  saveLinearConfig(repoRoot, { ...config, stateIds: toPersist });
  return resolved;
}

/**
 * Push one linked todo's current state to Linear.
 *
 * Sends the whole todo rather than only the fields that changed, so marking
 * something done here closes the issue there. Used by devctx_todo_update.
 */
export async function pushLinkedTodo(repoRoot: string, apiKey: string, todo: Todo): Promise<void> {
  if (!todo.linearId) return;

  const config = getLinearConfig(repoRoot);
  if (!config) throw new Error("Linear is not configured for this project");

  const stateIds = await resolveStateIds(repoRoot, apiKey, config);
  const stateId = stateIds[todo.status];
  if (!stateId) {
    throw new Error(`No Linear workflow state maps to "${todo.status}"`);
  }

  await updateLinearIssue(apiKey, todo.linearId, {
    stateId,
    priority: priorityToLinear(todo.priority),
    title: todo.text,
  });
}

// --- Sync result ---

export interface SyncResult {
  pulled: number;
  pushed: number;
  updated: number;
  /** Unlinked todos deliberately not pushed (currently: AI-suggested ones) */
  skipped: number;
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
  const result: SyncResult = { pulled: 0, pushed: 0, updated: 0, skipped: 0, errors: [] };

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

  // --- PULL: Linear → devctx ---
  if (direction === "both" || direction === "pull") {
    for (const issue of linearIssues) {
      // Find matching todo by linearId
      const existing = todos.find(t => t.linearId === issue.id);
      const newStatus = linearStateToDEvctxStatus(issue.state.type);

      if (existing) {
        // Update if Linear is newer than our last sync
        if (!existing.linearSyncedAt || issue.updatedAt > existing.linearSyncedAt) {
          markTodoSynced(repoRoot, existing.id, { status: newStatus });
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
        markTodoSynced(repoRoot, newTodo.id, {
          status: newStatus,
          linearId: issue.id,
          linearUrl: issue.url,
          linearIdentifier: issue.identifier,
        });
        result.pulled++;
      }
    }

    // Issues completed or canceled in Linear are filtered out of the query
    // above, so they vanish rather than arriving as done. Look up the linked
    // todos that went missing and take their real state.
    const openIds = new Set(linearIssues.map(i => i.id));
    const strandedIds = todos
      .filter(t => t.linearId && !openIds.has(t.linearId) && t.status !== "done")
      .map(t => t.linearId as string);

    if (strandedIds.length > 0) {
      try {
        for (const issue of await fetchIssuesByIds(apiKey, strandedIds)) {
          const local = todos.find(t => t.linearId === issue.id);
          if (!local) continue;

          const newStatus = linearStateToDEvctxStatus(issue.state.type);
          if (newStatus !== local.status) {
            markTodoSynced(repoRoot, local.id, { status: newStatus });
            result.updated++;
          }
        }
      } catch (err) {
        result.errors.push(`Failed to reconcile closed Linear issues: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Reload todos after pull changes
  const currentTodos = getTodos(repoRoot);

  // --- PUSH: devctx → Linear ---
  if (direction === "both" || direction === "push") {
    // Refresh rather than trust the cache: a workflow state renamed or deleted
    // in Linear would otherwise leave a stale ID that fails every push.
    let stateIds: StateIdMap;
    try {
      stateIds = await resolveStateIds(repoRoot, apiKey, config, { refresh: true });
    } catch (err) {
      // Without the team's states nothing can be mapped, and pushing anyway
      // would send title and priority while silently dropping status.
      result.errors.push(`Skipped push: could not resolve the team's workflow states: ${err instanceof Error ? err.message : String(err)}`);
      return result;
    }

    if (!stateIds.done) {
      result.errors.push(`No Linear workflow state matches "${config.statusMap.done}" — completed todos cannot close their issues.`);
    }

    for (const todo of currentTodos) {
      if (!todo.linearId) {
        // A todo finished before it ever reached Linear does not need an issue
        // opened just to close it again.
        if (todo.status === "done") continue;

        // devctx_goodbye writes AI-suggested todos automatically. Creating a
        // Linear issue for each of those would flood the team with machine
        // output the user never asked for, so they stay local until promoted.
        if (todo.source === "suggested") {
          result.skipped++;
          continue;
        }

        // Push new unlinked todo to Linear
        const stateId = stateIds[todo.status];
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
          markTodoSynced(repoRoot, todo.id, {
            linearId: created.id,
            linearUrl: created.url,
            linearIdentifier: created.identifier,
          });
          result.pushed++;
        } catch (err) {
          result.errors.push(`Failed to push todo "${todo.text}": ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (!todo.linearSyncedAt || todo.updated > todo.linearSyncedAt) {
        // Push updates for already-linked todos where devctx is newer. This is
        // the path that closes an issue when the todo is marked done.
        const stateId = stateIds[todo.status];
        if (!stateId) {
          result.errors.push(`No Linear state matches status "${todo.status}" for ${todo.linearIdentifier ?? todo.text} — status not synced`);
        }
        try {
          await updateLinearIssue(apiKey, todo.linearId, {
            ...(stateId ? { stateId } : {}),
            priority: priorityToLinear(todo.priority),
            title: todo.text,
          });
          markTodoSynced(repoRoot, todo.id);
          result.updated++;
        } catch (err) {
          result.errors.push(`Failed to update Linear issue ${todo.linearIdentifier}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }

  return result;
}
