import { useState } from "react";

const money = (n) =>
  n == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(n);
const signed = (n = 0) => `${n > 0 ? "+" : ""}${n}`;
const views = [
  ["workspace", "Workspace", "chart"],
  ["scanner", "Scanner", "search"],
  ["backtests", "Backtests", "trend"],
  ["tracker", "Tracker", "target"],
];
const tabs = [
  ["workspace", "Overview"],
  ["analytics", "Stock & options"],
  ["distributions", "Distributions"],
  ["events", "Events"],
];
const titles = {
  scanner: "Find your next strategy",
  distributions: "Where activity is concentrated",
  analytics: "Understand the underlying",
  events: "Put market events in context",
  tracker: "What could move your strategy",
  backtests: "Test your strategy over time",
};

export default function MomentumWorkspace(w) {
  const { view, navigate, Icon, selected, row, layout, content, setModal } = w;
  const [search, setSearch] = useState("");
  const [trackingTab, setTrackingTab] = useState("tracking");
  const overview = view === "workspace";
  const inspector = ["workspace", "scanner", "analytics", "tracker"].includes(
    view,
  );
  const score = selected?.overall ?? selected?.adjustedRange?.join("–") ?? "—";
  const panel = (id, { heading = true } = {}) => {
    if (layout.hidden.includes(id)) return null;
    const definition = w.PANELS.find((p) => p[0] === id);
    return (
      <section className={`panel panel-${id}`} id={`studio-${id}`} key={id}>
        {id === "tracking" && (
          <h2 className="m-tracking-title">Tracked catalysts</h2>
        )}
        {heading && id !== "results" && w.panelHeader(...definition)}
        {!layout.collapsed.includes(id) && content(id)}
      </section>
    );
  };
  const panelGroup = (ids) =>
    layout.order
      .filter((id) => ids.includes(id))
      .map((id) => panel(id, { heading: id !== "tracking" }));
  const save = () => w.save().catch((e) => w.setError(e.message));
  function searchStock(e) {
    e.preventDefault();
    const ticker = search.trim().toUpperCase();
    if (w.rows.some((r) => r.symbol === ticker)) {
      w.selectSymbol(ticker);
      navigate("workspace");
      setSearch("");
    } else {
      w.setNotice(
        "Add this stock in Strategy settings, then scan to load its results.",
      );
      setModal({ type: "strategy" });
    }
  }
  function trackerView() {
    return (
      <section className="panel m-tracker">
        <div className="m-section-heading">
          <div>
            <h2>Market catalysts</h2>
            <p>Saved items stay until you remove them.</p>
          </div>
          <button onClick={w.newItem}>
            <Icon name="plus" /> Add item
          </button>
        </div>
        <div className="m-tabs" role="tablist" aria-label="Tracking lists">
          <button
            role="tab"
            aria-selected={trackingTab === "tracking"}
            onClick={() => setTrackingTab("tracking")}
          >
            Tracking <span>{w.items.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={trackingTab === "suggestions"}
            onClick={() => setTrackingTab("suggestions")}
          >
            Suggestions <span>{w.agent?.suggestions?.length ?? 0}</span>
          </button>
        </div>
        {trackingTab === "suggestions" ? (
          <div className="m-suggestions">
            <p>
              {w.agentAvailable
                ? "Review suggested checkpoints before adding them to your strategy."
                : "Live AI discovery is not configured. You can add and track items manually."}
            </p>
            <button onClick={w.refreshAgent}>Refresh suggestions</button>
            {(w.agent?.suggestions ?? []).map((item, i) => (
              <button
                className="m-tracker-row"
                key={item.id ?? i}
                onClick={() =>
                  setModal({ type: "item", item: { ...item, id: undefined } })
                }
              >
                <strong>{item.title}</strong>
                <span>Review & add →</span>
              </button>
            ))}
            {!w.agent?.suggestions?.length && (
              <p className="subtle">No suggestions available.</p>
            )}
          </div>
        ) : (
          <>
            <div className="tracker-controls">
              {[
                "All",
                "Strong bullish",
                "Bullish",
                "Neutral",
                "Bearish",
                "Strong bearish",
              ].map((s) => (
                <button
                  key={s}
                  className={w.agentFilter === s ? "active" : ""}
                  onClick={() => w.setAgentFilter(s)}
                >
                  {s}
                </button>
              ))}
              <label>
                <input
                  type="checkbox"
                  checked={w.showResolved}
                  onChange={(e) => w.setShowResolved(e.target.checked)}
                />{" "}
                Show resolved
              </label>
            </div>
            <div className="m-list-labels">
              <span>Catalyst</span>
              <span>Status</span>
              <span>{w.symbol} impact</span>
              <span />
            </div>
            {w.visibleItems.map((item) => {
              const c = selected?.contributions?.find((c) => c.id === item.id);
              return (
                <button
                  className="m-tracker-row"
                  key={item.id}
                  onClick={() => setModal({ type: "item", item })}
                >
                  <span>
                    <i
                      className={`m-dot ${item.status === "resolved" ? "resolved" : item.verified ? "monitoring" : "unverified"}`}
                    />
                    <strong>{item.title}</strong>
                  </span>
                  <span
                    className={`m-status ${item.status === "resolved" ? "resolved" : ""}`}
                  >
                    {!item.verified ? "Unverified" : item.status}
                  </span>
                  <b
                    className={
                      c?.points < 0
                        ? "negative"
                        : c?.points > 0
                          ? "positive"
                          : "subtle"
                    }
                  >
                    {item.verified && c ? signed(c.points) : "Excluded"}
                  </b>
                  <Icon name="arrow" size={15} />
                </button>
              );
            })}
            {!w.visibleItems.length && (
              <p className="empty-chart">
                No tracked items match these filters.
              </p>
            )}
            <div className="m-tracker-footer">
              <strong>
                Net tracked impact{" "}
                <span
                  className={
                    selected?.catalystImpact < 0 ? "negative" : "positive"
                  }
                >
                  {signed(selected?.catalystImpact)}
                </span>
              </strong>
              <span>
                Resolution and market direction are reviewed separately.
              </span>
            </div>
          </>
        )}
      </section>
    );
  }
  return (
    <div
      className={`m-shell mds-typography mds-theme-stable-${layout.theme === "dark" ? "dark" : "light"}Webex`}
    >
      <header className="m-header">
        <a href={`/momentum${w.demo ? "?demo=1" : ""}`} className="m-brand">
          <Icon name="chart" size={30} />
          <strong>HedgeHub</strong>
          <span>Momentum</span>
        </a>
        <form className="m-search" onSubmit={searchStock}>
          <Icon name="search" />
          <input
            aria-label="Find stock"
            placeholder="Find a stock in your workspace…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <kbd>↵</kbd>
        </form>
        <span className="m-mode">
          {w.demo ? "Interactive demo · Sample data" : "Research workspace"}
        </span>
        <button
          aria-label="Toggle theme"
          onClick={() =>
            w.updateLayout({
              theme: layout.theme === "light" ? "dark" : "light",
            })
          }
        >
          <Icon name="sun" />
        </button>
        <button
          className="m-avatar"
          title={w.demo ? "Use live data" : "Sign out"}
          onClick={() => (w.demo ? location.assign("/momentum") : w.logout())}
        >
          {w.user.username.slice(0, 2).toUpperCase()}
        </button>
      </header>
      <nav className="m-rail" aria-label="Main navigation">
        {views.map(([id, title, icon]) => (
          <button
            key={id}
            aria-current={
              view === id ||
              (id === "workspace" && tabs.some((t) => t[0] === view))
                ? "page"
                : undefined
            }
            onClick={() => navigate(id)}
          >
            <Icon name={icon} size={23} />
            <span>{title}</span>
          </button>
        ))}
        <div className="m-rail-bottom">
          <button onClick={() => setModal({ type: "layout" })}>
            <Icon name="settings" />
            <span>Customize</span>
          </button>
          <a href={`/builder${w.demo ? "?demo=1" : ""}`}>Studio ↗</a>
          <a href="/">Classic ↗</a>
        </div>
      </nav>
      <main className="m-canvas">
        <div className="m-page-heading">
          <div>
            <p className="m-breadcrumb">
              My workspace <span>/</span>{" "}
              {view === "workspace"
                ? "Strategies"
                : (views.find((v) => v[0] === view)?.[1] ?? view)}
            </p>
            <h1>
              {titles[view] ??
                `${w.symbol} ${row?.name ?? "strategy workspace"}`}
            </h1>
            <div className="m-subtitle">
              <select
                aria-label="Selected stock"
                value={w.symbol}
                onChange={(e) => w.selectSymbol(e.target.value)}
              >
                {[
                  ...new Set([
                    ...w.strategy.symbols,
                    ...w.rows.map((r) => r.symbol),
                  ]),
                ].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <strong>{money(row?.spot ?? w.dataset?.spot)}</strong>
              <button
                className="text-button"
                onClick={() => setModal({ type: "strategy" })}
              >
                {w.strategy.name} ⌄
              </button>
            </div>
          </div>
          <div className="m-page-actions">
            <button onClick={save}>
              {w.dirty ? "Save changes" : "Save layout"}
            </button>
            <button
              className="primary"
              disabled={w.busy}
              onClick={() => (view === "tracker" ? w.refreshAgent() : w.run())}
            >
              <Icon name={view === "tracker" ? "target" : "search"} />
              {w.busy
                ? "Scanning…"
                : view === "tracker"
                  ? "Scan for ideas"
                  : "Scan options"}
            </button>
          </div>
        </div>
        {tabs.some((t) => t[0] === view) && (
          <nav className="m-tabs" aria-label="Workspace views">
            {tabs.map(([id, title]) => (
              <button
                key={id}
                aria-current={view === id ? "page" : undefined}
                onClick={() => navigate(id)}
              >
                {title}
              </button>
            ))}
            <button
              className="m-customize"
              onClick={() => setModal({ type: "layout" })}
            >
              <Icon name="settings" size={15} /> Customize
            </button>
          </nav>
        )}
        {w.error && (
          <div className="notice error" role="alert">
            {w.error}
            <button aria-label="Dismiss error" onClick={() => w.setError("")}>
              ×
            </button>
          </div>
        )}
        {w.notice && (
          <div className="notice" role="status">
            {w.notice}
            <button aria-label="Dismiss notice" onClick={() => w.setNotice("")}>
              ×
            </button>
          </div>
        )}
        {w.phase && (
          <div className="notice" role="status">
            {w.phase}
            <progress value={w.job?.progress ?? 0} max="100" />
            <button onClick={w.cancel}>Cancel</button>
          </div>
        )}
        <div className={`m-content ${inspector ? "has-inspector" : ""}`}>
          <div className="m-primary">
            {overview && (
              <>
                {panelGroup(["payoff", "tracking", "results"])}
                <button
                  className="m-explore"
                  onClick={() => navigate("distributions")}
                >
                  Explore open interest & volume distributions{" "}
                  <Icon name="arrow" />
                </button>
              </>
            )}
            {view === "scanner" && (
              <>
                <div className="m-scan-summary">
                  <span>
                    <b>{w.rows.length}</b> candidates
                  </span>
                  <span>
                    <b>{w.items.length}</b> saved catalysts
                  </span>
                  <span>
                    {w.demo
                      ? "Sample data"
                      : "Provider coverage shown per result"}
                  </span>
                </div>
                {panel("results")}
                {panel("tracking", { heading: false })}
              </>
            )}
            {view === "analytics" && (
              <div className="m-analytics">
                {panelGroup(["technicals", "options"])}
              </div>
            )}
            {view === "distributions" && (
              <>
                <p className="m-view-intro">
                  Compare calls, puts and the expiry dates behind activity.
                  Hover a bar to explore its top dates.
                </p>
                <div className="m-distributions">
                  {panelGroup(["oi-distribution", "volume-distribution"])}
                </div>
              </>
            )}
            {view === "events" && (
              <>
                <p className="m-view-intro">
                  Explore observed price reactions and upcoming scenarios across
                  your selected time horizon.
                </p>
                <div className="m-events">{panelGroup(["past", "future"])}</div>
              </>
            )}
            {view === "tracker" && trackerView()}
            {view === "backtests" && w.backtests()}
            {layout.hidden.length > 0 && (
              <button
                className="m-explore"
                onClick={() => setModal({ type: "layout" })}
              >
                Manage hidden panels ({layout.hidden.length})
              </button>
            )}
          </div>
          {inspector && (
            <aside className="m-inspector" aria-label="Strategy insight">
              <h2>
                {view === "scanner"
                  ? "Why this ranks here"
                  : "Strategy insight"}
              </h2>
              <div className="m-score">
                <div>
                  Overall rating{" "}
                  <span>
                    {selected?.overall == null
                      ? "Estimated range"
                      : "Strategy quality"}
                  </span>
                </div>
                <strong>
                  {score}
                  <small>/100</small>
                </strong>
                {selected?.overall != null && (
                  <meter
                    min="0"
                    max="100"
                    value={selected.overall}
                    aria-label="Strategy rating"
                  />
                )}
                <div className="m-score-equation">
                  {selected?.baseScore ??
                    selected?.scoreRange?.join("–") ??
                    "—"}{" "}
                  base <span>{signed(selected?.catalystImpact)} catalysts</span>
                </div>
                <p>
                  {selected?.overall == null
                    ? "Liquidity unverified · range only"
                    : "Catalysts affect this strategy’s rating"}
                </p>
                <button
                  disabled={!selected}
                  onClick={() => setModal({ type: "rating", row: selected })}
                >
                  View breakdown <Icon name="arrow" size={15} />
                </button>
              </div>
              {(view === "scanner" || view === "tracker") && (
                <section className="m-contributions">
                  <h3>Tracked impact</h3>
                  {selected?.contributions?.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => {
                        const item = w.items.find((i) => i.id === c.id);
                        if (item) setModal({ type: "item", item });
                      }}
                    >
                      <span>{c.title}</span>
                      <b
                        className={
                          c.points < 0
                            ? "negative"
                            : c.points > 0
                              ? "positive"
                              : "subtle"
                        }
                      >
                        {signed(c.points)}
                      </b>
                    </button>
                  ))}
                  {!selected?.contributions?.length && (
                    <p>No eligible catalyst adjustments.</p>
                  )}
                </section>
              )}
              {overview && panel("hedges")}
              {panel("valuation")}
              {overview && (
                <button
                  className="m-explore"
                  onClick={() => navigate("events")}
                >
                  <Icon name="calendar" /> Explore calendar events →
                </button>
              )}
            </aside>
          )}
        </div>
        <footer className="m-footer">
          {w.demo
            ? "Sample data · Changes are local to this demo"
            : "Research workspace · Provider coverage varies"}
          <span>HedgeHub / Momentum edition</span>
        </footer>
      </main>
    </div>
  );
}
