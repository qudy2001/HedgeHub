import { useCallback, useEffect, useState } from "react";
import CompanyEventsPanel from "./components/CompanyEventsPanel.jsx";
import EconomicCalendarPanel from "./components/EconomicCalendarPanel.jsx";
import MacroHeatmapDashboard from "./components/MacroHeatmapDashboard.jsx";
import PaperTradingWorkspace from "./components/PaperTradingWorkspace.jsx";
import StrategyFinderWorkspace from "./components/StrategyFinderWorkspace.jsx";
import StrategyRail from "./components/StrategyRail.jsx";
import TradingViewWidget from "./components/TradingViewWidget.jsx";

function readRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const strategyMatch = pathname.match(/^\/strategies\/([^/]+)$/);

  if (pathname === "/paper-trading") {
    return {
      activeView: "paper",
      selectedStrategyId: "strategy-1"
    };
  }

  if (strategyMatch) {
    return {
      activeView: "strategy",
      selectedStrategyId: decodeURIComponent(strategyMatch[1])
    };
  }

  return {
    activeView: "dashboard",
    selectedStrategyId: "strategy-1"
  };
}

function buildPath(activeView, strategyId) {
  if (activeView === "paper") {
    return "/paper-trading";
  }

  if (activeView === "strategy" && strategyId) {
    return `/strategies/${encodeURIComponent(strategyId)}`;
  }

  return "/";
}

export default function App() {
  const initialRoute = readRoute();
  const [dashboard, setDashboard] = useState(null);
  const [strategyPayload, setStrategyPayload] = useState(null);
  const [activeView, setActiveView] = useState(initialRoute.activeView);
  const [selectedStrategyId, setSelectedStrategyId] = useState(initialRoute.selectedStrategyId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState(null);
  const [error, setError] = useState("");

  const applyAppState = useCallback((dashboardJson, strategyJson) => {
    setDashboard(dashboardJson);
    setStrategyPayload(strategyJson);
    setSelectedStrategyId((current) => current || strategyJson.strategies[0]?.id || "strategy-1");
    setError("");
  }, []);

  const fetchAppState = useCallback(async () => {
    const [dashboardResponse, strategyResponse] = await Promise.all([
      fetch("/api/dashboard"),
      fetch("/api/strategies")
    ]);

    if (!dashboardResponse.ok || !strategyResponse.ok) {
      throw new Error("Failed to load dashboard state");
    }

    const [dashboardJson, strategyJson] = await Promise.all([
      dashboardResponse.json(),
      strategyResponse.json()
    ]);

    return { dashboardJson, strategyJson };
  }, []);

  const syncAppState = useCallback(async () => {
    const { dashboardJson, strategyJson } = await fetchAppState();
    applyAppState(dashboardJson, strategyJson);
    return { dashboardJson, strategyJson };
  }, [applyAppState, fetchAppState]);

  const navigateTo = useCallback((nextView, strategyId = selectedStrategyId) => {
    setActiveView(nextView);
    if (strategyId) {
      setSelectedStrategyId(strategyId);
    }

    const nextPath = buildPath(nextView, strategyId);
    if (window.location.pathname !== nextPath) {
      window.history.pushState({ activeView: nextView, strategyId }, "", nextPath);
    }
  }, [selectedStrategyId]);

  const handleManualRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshNotice({
      tone: "info",
      message: "Refreshing live strategy data..."
    });

    try {
      const refreshResponse = await fetch("/api/refresh", {
        method: "POST"
      });

      const refreshPayload = await refreshResponse.json().catch(() => null);

      if (!refreshResponse.ok) {
        throw new Error(refreshPayload?.error || "Manual refresh failed");
      }

      const { dashboardJson, strategyJson } = await syncAppState();
      const warnings = [
        ...(refreshPayload?.warnings ?? []),
        ...(dashboardJson?.warnings ?? []),
        ...(strategyJson?.warnings ?? [])
      ].filter(Boolean);

      setRefreshNotice({
        tone: warnings.length ? "warning" : "success",
        message: warnings.length
          ? `Refresh complete with warnings: ${warnings.join(" | ")}`
          : `Refresh complete at ${new Date(
              refreshPayload?.lastUpdated ?? strategyJson?.lastUpdated ?? new Date().toISOString()
            ).toLocaleString("en-GB")}`
      });
    } catch (refreshError) {
      setRefreshNotice({
        tone: "error",
        message: refreshError.message
      });
    } finally {
      setRefreshing(false);
    }
  }, [syncAppState]);

  const mutatePaperOrders = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Paper-trading request failed");
    }

    await syncAppState();
    return payload;
  }, [syncAppState]);

  const handleCreatePaperOrder = useCallback((orderPayload) => {
    return mutatePaperOrders("/api/paper-orders", {
      method: "POST",
      body: JSON.stringify(orderPayload)
    });
  }, [mutatePaperOrders]);

  const handleUpdatePaperOrder = useCallback((orderId, patch) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch)
    });
  }, [mutatePaperOrders]);

  const handleDeletePaperOrder = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}`, {
      method: "DELETE"
    });
  }, [mutatePaperOrders]);

  const handleClosePaperOrder = useCallback((orderId, patch) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/close`, {
      method: "POST",
      body: JSON.stringify(patch ?? {})
    });
  }, [mutatePaperOrders]);

  useEffect(() => {
    let isActive = true;

    async function load() {
      try {
        const { dashboardJson, strategyJson } = await fetchAppState();

        if (!isActive) {
          return;
        }

        applyAppState(dashboardJson, strategyJson);
      } catch (loadError) {
        if (isActive) {
          setError(loadError.message);
        }
      } finally {
        if (isActive) {
          setLoading(false);
        }
      }
    }

    load();
    const interval = window.setInterval(load, 60_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, [applyAppState, fetchAppState]);

  useEffect(() => {
    function handlePopState() {
      const nextRoute = readRoute();
      setActiveView(nextRoute.activeView);
      setSelectedStrategyId(nextRoute.selectedStrategyId);
    }

    window.addEventListener("popstate", handlePopState);
    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  if (loading) {
    return <div className="app-state">Loading HedgeHub…</div>;
  }

  if (error) {
    return <div className="app-state">{error}</div>;
  }

  const strategies = strategyPayload?.strategies ?? [];
  const primaryStrategy = strategyPayload?.primaryStrategy;
  const paperPortfolio = strategyPayload?.paperPortfolio;
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? null;
  const heroStats = dashboard?.heroStats ?? [];
  const showStrategyFinder = activeView === "strategy" && selectedStrategyId === "strategy-1";
  const showPlannedStrategy = activeView === "strategy" && selectedStrategyId !== "strategy-1";
  const showPaperTrading = activeView === "paper";

  return (
    <div className="app-root">
      {dashboard?.calendarWidgets?.tickerTape ? (
        <TradingViewWidget
          bare
          type={dashboard.calendarWidgets.tickerTape.type}
          config={dashboard.calendarWidgets.tickerTape.config}
          containerClassName="app-header-banner tradingview-widget-container--ticker"
        />
      ) : null}

      <div className="app-shell">
        <div className="app-grid">
          <StrategyRail
            activeView={activeView}
            strategies={strategies}
            selectedStrategyId={selectedStrategyId}
            onOpenDashboard={() => navigateTo("dashboard")}
            onOpenPaperTrading={() => navigateTo("paper")}
            onSelect={(strategyId) => navigateTo("strategy", strategyId)}
            paperPortfolio={paperPortfolio}
          />

          {showPaperTrading ? (
            <PaperTradingWorkspace
              paperPortfolio={paperPortfolio}
              onUpdatePaperOrder={handleUpdatePaperOrder}
              onClosePaperOrder={handleClosePaperOrder}
              onDeletePaperOrder={handleDeletePaperOrder}
            />
          ) : showStrategyFinder ? (
            <StrategyFinderWorkspace
              strategyPayload={strategyPayload}
              strategyDefinition={selectedStrategy}
              onManualRefresh={handleManualRefresh}
              refreshing={refreshing}
              refreshNotice={refreshNotice}
              onCreatePaperOrder={handleCreatePaperOrder}
              onOpenPaperTrading={() => navigateTo("paper")}
            />
          ) : showPlannedStrategy ? (
            <main className="workspace">
              <header className="topbar">
                <div>
                  <span className="brand__eyebrow">Planned strategy</span>
                  <h2>{selectedStrategy?.name ?? "Strategy"}</h2>
                </div>
              </header>
              <article className="insight-card">
                <p className="card-copy">
                  This strategy slot is reserved, but the finder and calculator flow is currently implemented for
                  Strategy 1 first.
                </p>
              </article>
            </main>
          ) : (
            <main className="workspace">
              {dashboard?.warnings?.length ? (
                <div className="warning-strip">
                  {dashboard.warnings.map((warning) => (
                    <span key={warning}>{warning}</span>
                  ))}
                </div>
              ) : null}

              <section className="hero-stats">
                {heroStats.map((stat) => (
                  <article key={stat.label} className={`metric-card metric-card--${stat.accent}`}>
                    <span>{stat.label}</span>
                    <strong>{stat.value}</strong>
                  </article>
                ))}
              </section>

              <MacroHeatmapDashboard
                macroDashboard={dashboard?.macroDashboard}
                watchlist={dashboard?.watchlist ?? []}
              />

              <section className="scan-section">
                <div className="section-heading">
                  <span>Cross-asset scan</span>
                  <span className="pill pill--live">Polymarket + options</span>
                </div>

                <div className="scan-grid">
                  {(primaryStrategy?.scanUniverse ?? []).map((asset) => (
                    <article key={asset.id} className="scan-card">
                      <div className="scan-card__header">
                        <div>
                          <h3>{asset.label}</h3>
                          <span>{asset.optionSymbol} proxy</span>
                        </div>
                        <span className="pill pill--ghost">{asset.opportunities.length} matches</span>
                      </div>

                      {asset.opportunities.map((opportunity) => (
                        <a
                          key={`${asset.id}-${opportunity.question}`}
                          href={opportunity.url}
                          target="_blank"
                          rel="noreferrer"
                          className="opportunity"
                        >
                          <strong>{opportunity.question}</strong>
                          <div className="opportunity__meta">
                            <span>YES {opportunity.yesPrice}</span>
                            <span>
                              {opportunity.optionSymbol} {opportunity.optionStrike} {opportunity.optionExpiry}
                            </span>
                          </div>
                          <div className="opportunity__meta">
                            <span>Live option {opportunity.liveOptionPrice}</span>
                            <span>Target model {opportunity.theoreticalOptionPriceAtTarget}</span>
                          </div>
                          <div className="opportunity__profit">
                            {opportunity.projectedProfit != null
                              ? `$${opportunity.projectedProfit.toLocaleString()}`
                              : "n/a"}
                          </div>
                        </a>
                      ))}
                    </article>
                  ))}
                </div>
              </section>

              <section className="calendar-grid">
                <div className="calendar-column">
                  <EconomicCalendarPanel data={dashboard?.economicCalendar} />
                </div>

                <div className="calendar-column">
                  <CompanyEventsPanel data={dashboard?.companyEvents} />
                </div>
              </section>

            </main>
          )}
        </div>
      </div>
    </div>
  );
}
