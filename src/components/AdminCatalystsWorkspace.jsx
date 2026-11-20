import { useCallback, useEffect, useMemo, useState } from "react";
import "../styles/catalysts-admin.css";

const CATEGORY_OPTIONS = [
  ["announcement", "Announcement"],
  ["operating-update", "Operating update"],
  ["regulatory", "Regulatory"]
];
const DATE_STATUS_OPTIONS = [
  ["unconfirmed", "Date unconfirmed"],
  ["estimated", "Estimated"],
  ["confirmed", "Confirmed"]
];
const EMPTY_FORM = {
  symbols: "",
  title: "",
  category: "announcement",
  date: "",
  dateStatus: "unconfirmed",
  source: "",
  sourceUrl: "",
  note: "",
  markVerified: false
};
const DAY_MS = 86_400_000;

function formatDate(value) {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleDateString("en-GB");
}

function daysAgo(value) {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? Math.floor((Date.now() - time) / DAY_MS) : null;
}

function describeReview(catalog) {
  if (!catalog.reviewedAt) {
    return "Never reviewed";
  }
  const days = daysAgo(catalog.reviewedAt);
  if (days == null || days < 0) {
    return `Reviewed ${formatDate(catalog.reviewedAt)}`;
  }
  return `Reviewed ${formatDate(catalog.reviewedAt)} (${days === 0 ? "today" : `${days} ${days === 1 ? "day" : "days"} ago`})`;
}

function sortEvents(events) {
  return [...events].sort(
    (a, b) => (a.date ?? "9999").localeCompare(b.date ?? "9999") || String(a.title).localeCompare(String(b.title))
  );
}

const toForm = (event) => ({
  symbols: (event.symbols ?? []).join(", "),
  title: event.title ?? "",
  category: event.category ?? "announcement",
  date: event.date ?? "",
  dateStatus: event.dateStatus ?? "unconfirmed",
  source: event.source ?? "",
  sourceUrl: event.sourceUrl ?? "",
  note: event.note ?? "",
  markVerified: false
});

export default function AdminCatalystsWorkspace({ onAuthRequired = null } = {}) {
  const [catalog, setCatalog] = useState({ events: [], reviewedAt: null, reviewStale: true, exists: false, filePath: "" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState(null);

  const events = useMemo(() => sortEvents(catalog.events), [catalog.events]);
  const countLabel = `${events.length} ${events.length === 1 ? "event" : "events"}`;
  const today = new Date().toISOString().slice(0, 10);

  const request = useCallback(
    async (url, options) => {
      const response = await fetch(url, options);
      if (response.status === 401) {
        onAuthRequired?.("Session expired");
        const authError = new Error("Authentication required");
        authError.code = "AUTH_REQUIRED";
        throw authError;
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || `Request failed (${response.status})`);
      }
      return payload;
    },
    [onAuthRequired]
  );

  // Runs one admin action with shared busy / error / notice handling.
  const run = useCallback(
    async (action, successMessage) => {
      setBusy(true);
      setError("");
      setNotice(null);
      try {
        const payload = await action();
        if (payload && Array.isArray(payload.events)) {
          setCatalog(payload);
        }
        if (successMessage) {
          setNotice({ tone: "success", message: successMessage });
        }
        return true;
      } catch (actionError) {
        if (String(actionError?.code ?? "") !== "AUTH_REQUIRED") {
          setError(actionError.message);
        }
        return false;
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    await run(() => request("/api/admin/catalysts"));
    setLoading(false);
  }, [request, run]);

  useEffect(() => {
    void load();
  }, [load]);

  const setField = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
  };

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    const url = editingId ? `/api/admin/catalysts/${encodeURIComponent(editingId)}` : "/api/admin/catalysts";
    const ok = await run(
      () =>
        request(url, {
          method: editingId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form)
        }),
      editingId ? "Catalyst updated." : "Catalyst added."
    );
    if (ok) {
      resetForm();
    }
  };

  const handleDelete = async (catalyst) => {
    if (!window.confirm(`Delete "${catalyst.title}"?`)) {
      return;
    }
    const ok = await run(
      () => request(`/api/admin/catalysts/${encodeURIComponent(catalyst.id)}`, { method: "DELETE" }),
      "Catalyst deleted."
    );
    if (ok && editingId === catalyst.id) {
      resetForm();
    }
  };

  const handleEdit = (catalyst) => {
    setEditingId(catalyst.id);
    setForm(toForm(catalyst));
    setNotice(null);
    setError("");
  };

  const handleReview = () =>
    run(() => request("/api/admin/catalysts/review", { method: "POST" }), "Marked as reviewed.");

  const canSubmit = form.symbols.trim() && form.title.trim() && form.sourceUrl.trim();

  return (
    <main className="workspace workspace--admin-catalysts">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Admin</span>
          <h2>Catalysts</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--ghost">{countLabel}</span>
          </div>
          <span className="timestamp">
            {loading ? "Loading…" : "Source-backed company events that calendars cannot cover."}
          </span>
        </div>
      </header>

      <article className="insight-card admin-users__panel">
        <div className={`admin-catalysts__review ${catalog.reviewStale ? "admin-catalysts__review--stale" : ""}`}>
          <div>
            <span className={`pill ${catalog.reviewStale ? "pill--warning" : "pill--live"}`}>
              {catalog.reviewStale ? "Review needed" : "Review current"}
            </span>{" "}
            <strong>{describeReview(catalog)}</strong>
            <p>
              Entry research flags a coverage gap when the calendar has not been reviewed against original sources in
              the last {catalog.reviewMaxAgeDays ?? 7} days. Mark it reviewed after rechecking every event.
            </p>
          </div>
          <button
            type="button"
            className="macro-layout-button macro-layout-button--primary"
            onClick={() => void handleReview()}
            disabled={busy || loading}
          >
            Mark reviewed
          </button>
        </div>

        <div className="admin-users__layout" style={{ marginTop: 18 }}>
          <section className="admin-users__section">
            <h3>{editingId ? "Edit catalyst" : "Add catalyst"}</h3>
            <form className="admin-users__form admin-catalysts__form" onSubmit={handleSubmit}>
              <label>
                <span>Symbols</span>
                <input
                  value={form.symbols}
                  onChange={setField("symbols")}
                  placeholder="TSLA, NVDA"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Title</span>
                <input
                  value={form.title}
                  onChange={setField("title")}
                  placeholder="Q4 deliveries report"
                  disabled={busy}
                />
              </label>
              <div className="admin-catalysts__pair">
                <label>
                  <span>Category</span>
                  <select value={form.category} onChange={setField("category")} disabled={busy}>
                    {CATEGORY_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Date status</span>
                  <select value={form.dateStatus} onChange={setField("dateStatus")} disabled={busy}>
                    {DATE_STATUS_OPTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label>
                <span>Date{form.dateStatus === "unconfirmed" ? " (optional)" : ""}</span>
                <input type="date" value={form.date} onChange={setField("date")} disabled={busy} />
              </label>
              <label>
                <span>Source name</span>
                <input
                  value={form.source}
                  onChange={setField("source")}
                  placeholder="Company investor relations"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Source URL</span>
                <input
                  type="url"
                  value={form.sourceUrl}
                  onChange={setField("sourceUrl")}
                  placeholder="https://…"
                  disabled={busy}
                />
              </label>
              <label>
                <span>Notes (optional)</span>
                <textarea rows={3} value={form.note} onChange={setField("note")} disabled={busy} />
              </label>
              {editingId ? (
                <label className="admin-catalysts__check">
                  <input
                    type="checkbox"
                    checked={form.markVerified}
                    onChange={setField("markVerified")}
                    disabled={busy}
                  />
                  <span>I re-verified the date and source today</span>
                </label>
              ) : null}

              <div className="admin-users__actions">
                <button
                  type="submit"
                  className="macro-layout-button macro-layout-button--primary"
                  disabled={busy || !canSubmit}
                >
                  {busy ? "Working…" : editingId ? "Save changes" : "Add catalyst"}
                </button>
                {editingId ? (
                  <button type="button" className="macro-layout-button" onClick={resetForm} disabled={busy}>
                    Cancel
                  </button>
                ) : null}
                <button type="button" className="macro-layout-button" onClick={() => void load()} disabled={busy || loading}>
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
            <h3>Calendar</h3>
            {loading ? (
              <div className="app-state app-state--inline admin-catalysts__empty">Loading catalysts…</div>
            ) : events.length ? (
              <div className="admin-users__list">
                {events.map((catalyst) => (
                  <div
                    key={catalyst.id}
                    className={`admin-users__row admin-catalysts__row ${
                      catalyst.date && catalyst.date < today ? "admin-catalysts__row--past" : ""
                    }`}
                  >
                    <div className="admin-users__identity">
                      <div className="admin-catalysts__symbols">
                        {(catalyst.symbols ?? []).map((symbol) => (
                          <span key={symbol} className="pill pill--ghost">
                            {symbol}
                          </span>
                        ))}
                      </div>
                      <strong>{catalyst.title}</strong>
                      <span className="timestamp">
                        {catalyst.date ? formatDate(catalyst.date) : "No date"} · {catalyst.dateStatus ?? "unconfirmed"} ·{" "}
                        {catalyst.category ?? "announcement"} · verified {formatDate(catalyst.verifiedAt)}
                      </span>
                      <span className="timestamp">
                        {catalyst.sourceUrl ? (
                          <a href={catalyst.sourceUrl} target="_blank" rel="noopener noreferrer">
                            {catalyst.source || catalyst.sourceUrl}
                          </a>
                        ) : (
                          "No source URL (ignored by research)"
                        )}
                      </span>
                      {catalyst.note ? <span className="admin-catalysts__note">{catalyst.note}</span> : null}
                    </div>
                    <div className="admin-users__badges">
                      <button
                        type="button"
                        className="macro-layout-button"
                        onClick={() => handleEdit(catalyst)}
                        disabled={busy}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="macro-layout-button"
                        onClick={() => void handleDelete(catalyst)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="app-state app-state--inline admin-catalysts__empty">
                No catalysts yet. Add product launches, regulatory deadlines or investor days that the earnings and
                economic calendars do not cover.
              </div>
            )}
            {catalog.filePath ? <div className="admin-catalysts__file">Stored in {catalog.filePath}</div> : null}
          </section>
        </div>
      </article>
    </main>
  );
}
