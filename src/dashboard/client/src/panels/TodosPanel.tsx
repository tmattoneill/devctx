import { useAPI } from "../hooks";
import type { TodosResponse } from "../api";

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function TodosPanel() {
  const { data, error, loading } = useAPI<TodosResponse>("/todos");

  if (loading) return <div className="panel-loading">Loading...</div>;
  if (error) return <div className="panel-error">Error: {error}</div>;

  const todos = (data?.todos || [])
    .slice()
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2));
  const sourceTodos = data?.sourceTodos || [];

  const active = todos.filter((t) => t.status !== "done");
  const done = todos.filter((t) => t.status === "done");

  return (
    <div className="panel">
      <h1>Todos</h1>

      {active.length === 0 && done.length === 0 ? (
        <p>No todos.</p>
      ) : (
        <>
          {active.length > 0 && (
            <section className="card">
              <h2>Active ({active.length})</h2>
              <ul className="todo-list">
                {active.map((t) => (
                  <li key={t.id} className={`todo-item priority-${t.priority}`}>
                    <span className={`status-badge status-${t.status}`}>{t.status}</span>
                    <span className={`priority-dot priority-${t.priority}`} />
                    <span className="todo-text">{t.text}</span>
                    {t.branch && <code className="todo-branch">{t.branch}</code>}
                    {t.source === "suggested" && <span className="tag suggested">suggested</span>}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {done.length > 0 && (
            <section className="card">
              <h2>Done ({done.length})</h2>
              <ul className="todo-list done">
                {done.map((t) => (
                  <li key={t.id} className="todo-item done">
                    <span className="todo-text">{t.text}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {sourceTodos.length > 0 && (
        <section className="card">
          <h2>Code TODOs ({sourceTodos.length})</h2>
          <ul className="source-todo-list">
            {sourceTodos.slice(0, 30).map((t, i) => (
              <li key={i}>
                <span className="source-tag">{t.tag}</span>
                <code className="source-loc">{t.file}:{t.line}</code>
                <span>{t.text}</span>
              </li>
            ))}
            {sourceTodos.length > 30 && (
              <li className="more">...and {sourceTodos.length - 30} more</li>
            )}
          </ul>
        </section>
      )}
    </div>
  );
}
