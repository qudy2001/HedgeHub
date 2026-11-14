import { useMemo } from "react";
import "../styles/desk-status.css";
import { deskAnchors } from "../../shared/aiScheduleTemplates.js";
import { deskStatus } from "../../shared/deskStatus.js";

const HEALTH = {
  ok: { pill: "pill--live", label: (lane) => `Ran ${ago(lane.ageDays)}` },
  late: { pill: "pill--warning", label: (lane) => `Late: last ran ${ago(lane.ageDays)}` },
  never: { pill: "pill--ghost", label: () => "Not run yet" }
};

function ago(days) {
  const minutes = Math.max(0, Math.round(days * 1440));
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(days)} days ago`;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// "2026-11-16" -> "16 Nov". The date is a calendar day, so it is formatted without a time zone shift.
function shortDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "n/a" : date.toLocaleString("en-GB");
}

// The hub anchor's title is a field of the ChatGPT template; the templates panel keeps edits in this browser.
function savedAnchors() {
  try {
    const saved = JSON.parse(localStorage.getItem("hedgehub.aiTemplates"));
    return deskAnchors({ hubAnchor: String(saved?.values?.["desk-chatgpt"]?.hubAnchor ?? "").trim() });
  } catch {
    return deskAnchors();
  }
}

function nextStep(row) {
  if (row.due) return { text: "Due now", tone: "warn" };
  if (row.archivingSoon) return { text: `Archives in ${plural(row.archivesInDays, "day")}`, tone: "warn" };
  if (row.stage === "resolved") return { text: `Archives in ${plural(row.archivesInDays, "day")}`, tone: "" };
  if (/^\d{4}/.test(row.nextCheck ?? "")) return { text: `Next ${shortDate(row.nextCheck)}`, tone: "" };
  return { text: "No next check", tone: "" };
}

function TopicRow({ row, summary }) {
  const step = nextStep(row);
  return (
    <details className="desk-status__topic">
      <summary>
        <span className="desk-status__title">{row.title}</span>
        <span className="desk-status__facts">
          <span className={`desk-status__stage desk-status__stage--${row.stage ?? "none"}`}>{row.stage ?? "not adopted"}</span>
          <span>Weight {row.weight}</span>
          <span>{row.sentiment}</span>
          <span className={step.tone ? "desk-status__warn" : ""}>{step.text}</span>
        </span>
      </summary>
      <p className="desk-status__updated">
        Updated {formatTimestamp(row.updatedAt)}
        {row.foreign ? ` · written by another lane's prompt` : ""}
        {row.legacy ? " · written before the desk, waiting for this lane's first run" : ""}
      </p>
      <pre>{summary}</pre>
    </details>
  );
}

function LaneCard({ lane, summaries }) {
  const health = HEALTH[lane.health];
  const { counts } = lane;
  const notes = [
    plural(counts.live, "live topic"),
    counts.due ? `${counts.due} due` : null,
    counts.legacy ? `${counts.legacy} not adopted` : null,
    counts.archivingSoon ? `${counts.archivingSoon} close to archiving` : null
  ].filter(Boolean);
  return (
    <div className="desk-status__lane">
      <div className="desk-status__lane-head">
        <div>
          <strong>{lane.name}</strong>
          <span className="desk-status__duty">{lane.duty}</span>
        </div>
        <span className={`pill ${health.pill}`}>{health.label(lane)}</span>
      </div>
      <p className="desk-status__meta">
        {lane.lastWrite ? `Last write ${formatTimestamp(lane.lastWrite)}. ` : `No topic carries "by ${lane.name}" yet. `}
        {notes.join(" · ")}.
      </p>
      {lane.anchorState !== "adopted" ? (
        <p className="desk-status__meta desk-status__warn">
          Anchor &quot;{lane.anchorTitle}&quot; {lane.anchorState === "missing" ? "has not been written" : "has not been rewritten by this lane"}.
        </p>
      ) : null}
      {lane.inbox.length ? (
        <ul className="desk-status__inbox">
          {lane.inbox.map((flag, index) => (
            <li key={index}>
              <span className="desk-status__label">Flag</span> {flag.text}
            </li>
          ))}
        </ul>
      ) : null}
      {lane.topics.length ? (
        <div className="desk-status__topics">
          {lane.topics.map((row) => (
            <TopicRow key={row.id} row={row} summary={summaries.get(row.id) ?? ""} />
          ))}
        </div>
      ) : (
        <p className="desk-status__meta">No topics in this lane yet.</p>
      )}
    </div>
  );
}

export default function DeskStatus({ topics = [], loading = false, onRefresh = null }) {
  const status = useMemo(() => deskStatus(topics, { anchors: savedAnchors() }), [topics]);
  const summaries = useMemo(() => new Map(topics.map((topic) => [topic.id, topic.summary ?? ""])), [topics]);
  const running = status.lanes.filter((lane) => lane.health === "ok").length;

  return (
    <article className="insight-card admin-users__panel">
      <section className="admin-users__section desk-status">
        <div className="admin-tasks__runs-header">
          <div className="desk-status__intro">
            <h3>Daily desk status</h3>
            <p className="admin-tasks__note">
              What each AI platform last wrote in its lane, read from the topics themselves: a lane counts as run when a topic
              carries its name. The run report itself stays on the platform. Click a topic for its summary.
            </p>
          </div>
          <div className="admin-tasks__runs-actions">
            <span className={`pill ${running === status.lanes.length ? "pill--live" : running ? "pill--warning" : "pill--ghost"}`}>
              {running} of {status.lanes.length} lanes running
            </span>
            {onRefresh ? (
              <button type="button" className="macro-layout-button" onClick={onRefresh} disabled={loading}>
                {loading ? "Loading…" : "Refresh"}
              </button>
            ) : null}
          </div>
        </div>
        {!status.started && !loading ? (
          <div className="app-state app-state--inline">
            No Daily desk run has been saved yet. Paste a Daily desk template below into its platform and run it once.
          </div>
        ) : null}
        <div className="desk-status__grid">
          {status.lanes.map((lane) => (
            <LaneCard key={lane.id} lane={lane} summaries={summaries} />
          ))}
        </div>
      </section>
    </article>
  );
}
