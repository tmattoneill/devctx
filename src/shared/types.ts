export interface ProjectState {
  projectName: string;
  description: string;
  currentFocus: string;
  lastUpdated: string;
  active: boolean;
  workingSessions: WorkingSession[];
}

export interface WorkingSession {
  started: string;
  ended?: string;
  summary: string;
  branch: string;
}

export interface Todo {
  id: string;
  text: string;
  status: "todo" | "in_progress" | "done" | "blocked";
  branch?: string;
  priority: "low" | "medium" | "high" | "critical";
  created: string;
  updated: string;
  tags?: string[];
  source?: "manual" | "suggested" | "linear";
  linearId?: string;          // Linear issue UUID (stable, used for API calls)
  linearUrl?: string;         // https://linear.app/team/issue/PROJ-123
  linearIdentifier?: string;  // human-readable "PROJ-123"
  linearSyncedAt?: string;    // ISO timestamp of last sync
  linearSyncError?: string;   // why the last push to Linear failed, if it did
}

export interface LinearConfig {
  teamId: string;
  teamKey: string;
  userId?: string;
  statusMap: {
    todo: string;         // default: "Todo"
    in_progress: string;  // default: "In Progress"
    done: string;         // default: "Done"
    blocked: string;      // default: "Blocked"
  };
  defaultPriority: number;  // Linear int: 1=Urgent, 2=High, 3=Medium, 4=Low
  /**
   * Resolved workflow state IDs for this team, keyed by devctx status.
   * Cached so a single todo update can push its status without first listing
   * teams. Refreshed on every full devctx_linear_sync.
   */
  stateIds?: Partial<Record<Todo["status"], string>>;
}

export interface ActivityEntry {
  timestamp: string;
  type: "commit" | "push" | "build" | "run" | "test" | "deploy" | "note" | "session_start" | "session_end" | "milestone" | "custom" | "branch_switch" | "merge" | "version";
  message: string;
  branch: string;
  metadata?: Record<string, string>;
}

export interface SourceTodo {
  file: string;   // relative path from repo root
  line: number;
  tag: string;    // "TODO" | "FIXME" | "HACK" | "XXX"
  text: string;   // the comment text after the tag
}
