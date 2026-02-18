import { useState } from "react";
import { StatusPanel } from "./panels/StatusPanel";
import { ActivityPanel } from "./panels/ActivityPanel";
import { TodosPanel } from "./panels/TodosPanel";
import { SessionsPanel } from "./panels/SessionsPanel";

type View = "status" | "activity" | "todos" | "sessions";

export function App() {
  const [view, setView] = useState<View>("status");

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="sidebar-header">devctx</div>
        <ul className="nav-list">
          {(["status", "activity", "todos", "sessions"] as const).map((v) => (
            <li key={v}>
              <button
                className={`nav-btn ${view === v ? "active" : ""}`}
                onClick={() => setView(v)}
              >
                {v.charAt(0).toUpperCase() + v.slice(1)}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <main className="content">
        {view === "status" && <StatusPanel />}
        {view === "activity" && <ActivityPanel />}
        {view === "todos" && <TodosPanel />}
        {view === "sessions" && <SessionsPanel />}
      </main>
    </div>
  );
}
