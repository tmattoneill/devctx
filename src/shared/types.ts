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
  source?: "manual" | "suggested";
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
