const BASE = "/api";

export async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

// --- Response types ---

export interface StatusResponse {
  initialized: boolean;
  project?: {
    name: string;
    description: string;
    focus: string;
    active: boolean;
    lastUpdated: string;
  };
  git?: {
    branch: string;
    isClean: boolean;
    staged: number;
    modified: number;
    untracked: number;
    ahead: number;
    behind: number;
    lastPush: string;
  };
  recentCommits?: Array<{
    hash: string;
    subject: string;
    author: string;
    date: string;
  }>;
  vitals?: Record<string, { timestamp: string; message: string } | null>;
}

export interface ActivityEntry {
  timestamp: string;
  type: string;
  message: string;
  branch: string;
  metadata?: Record<string, string>;
}

export interface ActivityResponse {
  entries: ActivityEntry[];
}

export interface Todo {
  id: string;
  text: string;
  status: string;
  branch?: string;
  priority: string;
  created: string;
  updated: string;
  tags?: string[];
  source?: string;
}

export interface SourceTodo {
  file: string;
  line: number;
  tag: string;
  text: string;
}

export interface TodosResponse {
  todos: Todo[];
  sourceTodos: SourceTodo[];
}

export interface SessionInfo {
  filename: string;
  timestamp: string;
}

export interface SessionsResponse {
  sessions: SessionInfo[];
}

export interface SessionContentResponse {
  filename: string;
  content: string;
}
