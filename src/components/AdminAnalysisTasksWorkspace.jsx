import { useCallback, useEffect, useMemo, useState } from "react";

const CADENCE_OPTIONS = ["", "hourly", "daily", "weekly", "monthly"];

function formatTimestamp(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return date.toLocaleString("en-GB");
}

export default function AdminAnalysisTasksWorkspace({ onAuthRequired = null } = {}) {
  const [definitions, setDefinitions] = useState([]);
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");

  const [prompt, setPrompt] = useState("");
  const [topicId, setTopicId] = useState("");
  const [cadence, setCadence] = useState("daily");

  const definitionCountLabel = useMemo(() => {
    const count = definitions.length;
    return `${count} ${count === 1 ? "definition" : "definitions"}`;
  }, [definitions.length]);

  const handleAuthError = useCallback(
    (response) => {
      if (response.status !== 401) {
        return;
      }

      onAuthRequired?.("Session expired");
      const authError = new Error("Authentication required");
      authError.code = "AUTH_REQUIRED";
      throw authError;
    },
    [onAuthRequired]
  );

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [definitionsResponse, topicsResponse] = await Promise.all([
        fetch("/api/admin/analysis-task-definitions"),
        fetch("/api/admin/market-topics")
      ]);
      handleAuthError(definitionsResponse);
      handleAuthError(topicsResponse);

      const [definitionsPayload, topicsPayload] = await Promise.all([
        definitionsResponse.json().catch(() => null),
        topicsResponse.json().catch(() => null)
      ]);

      if (!definitionsResponse.ok) {
        throw new Error(definitionsPayload?.error || `Failed to load task definitions (${definitionsResponse.status})`);
      }
      if (!topicsResponse.ok) {
        throw new Error(topicsPayload?.error || `Failed to load market topics (${topicsResponse.status})`);
      }

      setDefinitions(Array.isArray(definitionsPayload?.definitions) ? definitionsPayload.definitions : []);
      setTopics(Array.isArray(topicsPayload?.topics) ? topicsPayload.topics : []);
      setNotice(null);
    } catch (loadError) {
      if (String(loadError?.code ?? "") !== "AUTH_REQUIRED") {
        setError(loadError.message);
      }
    } finally {
      setLoading(false);
    }
  }, [handleAuthError]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  const handleCreateDefinition = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmedPrompt = prompt.trim();

      if (!trimmedPrompt) {
        setError("prompt is required");
        return;
      }

      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch("/api/admin/analysis-task-definitions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: trimmedPrompt,
            topicId: topicId || null,
            cadence: cadence || null,
            source: "user_requested"
          })
        });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to create task definition (${response.status})`);
        }

        setPrompt("");
        setDefinitions((current) => (payload?.definition ? [payload.definition, ...(current ?? [])] : current));
        setNotice({ tone: "success", message: "Task definition created." });
      } catch (createError) {
        if (String(createError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(createError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [cadence, handleAuthError, prompt, topicId]
  );

  const handleToggleActive = useCallback(
    async (definition) => {
      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch(`/api/admin/analysis-task-definitions/${definition.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ active: !definition.active })
        });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to update task definition (${response.status})`);
        }

        setDefinitions((current) =>
          (current ?? []).map((item) => (item.id === definition.id ? payload.definition : item))
        );
      } catch (updateError) {
        if (String(updateError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(updateError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [handleAuthError]
  );

  const handleDeleteDefinition = useCallback(
    async (id) => {
      setBusy(true);
      setError("");
      setNotice(null);

      try {
        const response = await fetch(`/api/admin/analysis-task-definitions/${id}`, { method: "DELETE" });
        handleAuthError(response);
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || `Failed to delete task definition (${response.status})`);
        }

        setDefinitions((current) => (current ?? []).filter((item) => item.id !== id));
        setNotice({ tone: "success", message: "Task definition deleted." });
      } catch (deleteError) {
        if (String(deleteError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(deleteError.message);
        }
      } finally {
        setBusy(false);
      }
    },
    [handleAuthError]
  );

  return (
    <main className="workspace workspace--admin-analysis-tasks">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Admin</span>
          <h2>Analysis task definitions</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--ghost">{definitionCountLabel}</span>
          </div>
          <span className="timestamp">
            {loading ? "Loading…" : "Manage recurring and one-off analysis tasks for the MCP queue."}
          </span>
        </div>
      </header>

      <article className="insight-card admin-users__panel">
        <div className="admin-users__layout">
          <section className="admin-users__section">
            <h3>Add task definition</h3>
            <form className="admin-users__form" onSubmit={handleCreateDefinition}>
              <label>
                <span>Prompt</span>
                <input
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  placeholder="Analyze the impact of..."
                  disabled={busy}
                />
              </label>
              <label>
                <span>Topic (optional)</span>
                <select value={topicId} onChange={(event) => setTopicId(event.target.value)} disabled={busy}>
                  <option value="">No topic</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.title}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Cadence</span>
                <select value={cadence} onChange={(event) => setCadence(event.target.value)} disabled={busy}>
                  {CADENCE_OPTIONS.map((option) => (
                    <option key={option || "one-off"} value={option}>
                      {option || "One-off"}
                    </option>
                  ))}
                </select>
              </label>

              <div className="admin-users__actions">
                <button
                  type="submit"
                  className="macro-layout-button macro-layout-button--primary"
                  disabled={busy || !prompt.trim()}
                >
                  {busy ? "Working…" : "Create"}
                </button>
                <button type="button" className="macro-layout-button" onClick={loadWorkspace} disabled={busy || loading}>
                  Refresh
                </button>
              </div>
            </form>

            {notice ? (
              <div className={`refresh-feedback refresh-feedback--${notice.tone || "info"}`}>{notice.message}</div>
            ) : null}
            {error ? <div className="refresh-feedback refresh-feedback--error">{error}</div> : null}
          </section>

          <section className="admin-users__section">
            <h3>Existing definitions</h3>
            {loading ? (
              <div className="app-state app-state--inline">Loading task definitions…</div>
            ) : definitions.length ? (
              <div className="admin-users__list">
                {definitions.map((definition) => (
                  <div key={definition.id} className="admin-users__row">
                    <div className="admin-users__identity">
                      <strong>{definition.prompt}</strong>
                      <span className="timestamp">
                        {definition.topicTitle || "No topic"} · {definition.cadence || "one-off"} · next run{" "}
                        {formatTimestamp(definition.nextRunAt)}
                      </span>
                    </div>
                    <div className="admin-users__badges">
                      <span className={`pill ${definition.active ? "pill--live" : "pill--short"}`}>
                        {definition.active ? "active" : "paused"}
                      </span>
                      <button
                        type="button"
                        className="macro-layout-button"
                        onClick={() => void handleToggleActive(definition)}
                        disabled={busy}
                      >
                        {definition.active ? "Pause" : "Resume"}
                      </button>
                      <button
                        type="button"
                        className="macro-layout-button"
                        onClick={() => void handleDeleteDefinition(definition.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="app-state app-state--inline">No task definitions yet.</div>
            )}
          </section>
        </div>
      </article>
    </main>
  );
}
