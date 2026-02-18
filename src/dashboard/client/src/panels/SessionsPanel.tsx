import { useState } from "react";
import { useAPI } from "../hooks";
import { fetchJSON } from "../api";
import type { SessionsResponse, SessionContentResponse } from "../api";

export function SessionsPanel() {
  const { data, error, loading } = useAPI<SessionsResponse>("/sessions");
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);

  if (loading) return <div className="panel-loading">Loading...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;

  const sessions = data?.sessions || [];

  async function loadSession(filename: string) {
    setContentLoading(true);
    setSelectedFile(filename);
    try {
      const res = await fetchJSON<SessionContentResponse>(`/sessions/${filename}`);
      setSelectedContent(res.content);
    } catch {
      setSelectedContent("Failed to load session.");
    } finally {
      setContentLoading(false);
    }
  }

  return (
    <div className="panel">
      <h1>Sessions</h1>
      {sessions.length === 0 ? (
        <p>No session records yet.</p>
      ) : (
        <div className="sessions-layout">
          <ul className="session-list">
            {sessions.map((s) => (
              <li key={s.filename}>
                <button
                  className={`session-btn ${selectedFile === s.filename ? "active" : ""}`}
                  onClick={() => loadSession(s.filename)}
                >
                  {new Date(s.timestamp).toLocaleString()}
                </button>
              </li>
            ))}
          </ul>
          <div className="session-content">
            {contentLoading && <div className="panel-loading">Loading...</div>}
            {!contentLoading && selectedContent && (
              <pre className="session-pre">{selectedContent}</pre>
            )}
            {!contentLoading && !selectedContent && (
              <p className="session-placeholder">Select a session to view.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
