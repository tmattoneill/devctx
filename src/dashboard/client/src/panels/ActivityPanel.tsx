import { useAPI } from "../hooks";
import type { ActivityResponse } from "../api";

const TYPE_ICONS: Record<string, string> = {
  commit: "commit",
  push: "push",
  build: "build",
  run: "run",
  test: "test",
  deploy: "deploy",
  note: "note",
  milestone: "milestone",
  session_start: "session",
  session_end: "session",
  branch_switch: "branch",
  merge: "merge",
};

export function ActivityPanel() {
  const { data, error, loading } = useAPI<ActivityResponse>("/activity?limit=50");

  if (loading) return <div className="panel-loading">Loading...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;

  const entries = data?.entries || [];

  return (
    <div className="panel">
      <h1>Activity Log</h1>
      {entries.length === 0 ? (
        <p>No activity logged yet.</p>
      ) : (
        <ul className="activity-list">
          {entries.map((e, i) => (
            <li key={i} className="activity-entry">
              <span className={`type-badge type-${e.type}`}>
                {TYPE_ICONS[e.type] || e.type}
              </span>
              <span className="activity-message">{e.message}</span>
              <span className="activity-meta">
                <code>{e.branch}</code>
                <time>{new Date(e.timestamp).toLocaleString()}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
