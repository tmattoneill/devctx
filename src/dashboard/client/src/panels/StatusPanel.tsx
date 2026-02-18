import { useAPI } from "../hooks";
import type { StatusResponse } from "../api";

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function StatusPanel() {
  const { data, error, loading } = useAPI<StatusResponse>("/status");

  if (loading) return <div className="panel-loading">Loading...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;
  if (!data?.initialized) return <div className="panel-error">devctx not initialized</div>;

  const { project, git, recentCommits, vitals } = data;

  return (
    <div className="panel">
      <h1>{project?.name}</h1>
      {project?.description && <p className="subtitle">{project.description}</p>}

      {project?.focus && (
        <section className="card">
          <h2>Focus</h2>
          <p>{project.focus}</p>
        </section>
      )}

      <section className="card">
        <h2>Git</h2>
        <dl className="info-grid">
          <dt>Branch</dt>
          <dd><code>{git?.branch}</code></dd>
          <dt>Working tree</dt>
          <dd>
            {git?.isClean
              ? "Clean"
              : [
                  git?.staged ? `${git.staged} staged` : "",
                  git?.modified ? `${git.modified} modified` : "",
                  git?.untracked ? `${git.untracked} untracked` : "",
                ].filter(Boolean).join(", ")}
          </dd>
          {(git?.ahead ?? 0) > 0 && (<><dt>Ahead</dt><dd>{git?.ahead} commit(s)</dd></>)}
          {(git?.behind ?? 0) > 0 && (<><dt>Behind</dt><dd>{git?.behind} commit(s)</dd></>)}
          <dt>Last push</dt>
          <dd>{git?.lastPush || "never"}</dd>
        </dl>
      </section>

      {recentCommits && recentCommits.length > 0 && (
        <section className="card">
          <h2>Recent Commits</h2>
          <ul className="commit-list">
            {recentCommits.map((c) => (
              <li key={c.hash}>
                <code className="hash">{c.hash}</code>
                <span className="subject">{c.subject}</span>
                <span className="meta">{c.author} &middot; {timeAgo(c.date)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {vitals && (
        <section className="card">
          <h2>Vitals</h2>
          <table className="vitals-table">
            <thead>
              <tr><th>Event</th><th>When</th><th>Detail</th></tr>
            </thead>
            <tbody>
              {["build", "test", "run", "push", "deploy", "session_start"].map((key) => {
                const v = vitals[key];
                return (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>{v ? timeAgo(v.timestamp) : "never"}</td>
                    <td className="truncate">{v?.message || "\u2014"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
