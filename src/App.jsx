import { useCallback, useEffect, useRef, useState } from "react";
import CompanyEventsPanel from "./components/CompanyEventsPanel.jsx";
import EconomicCalendarPanel from "./components/EconomicCalendarPanel.jsx";
import MacroHeatmapDashboard from "./components/MacroHeatmapDashboard.jsx";
import PaperTradingWorkspace from "./components/PaperTradingWorkspace.jsx";
import StrategyFinderWorkspace from "./components/StrategyFinderWorkspace.jsx";
import StrategyRail from "./components/StrategyRail.jsx";
import StrategySettingsWorkspace from "./components/StrategySettingsWorkspace.jsx";
import StrategyScreeningWorkspace from "./components/StrategyScreeningWorkspace.jsx";
import TradingViewStrategyWorkspace from "./components/TradingViewStrategyWorkspace.jsx";
import TradingViewWidget from "./components/TradingViewWidget.jsx";
import VolCrushEarningsWorkspace from "./components/VolCrushEarningsWorkspace.jsx";
import { getInitialTheme, THEME_STORAGE_KEY } from "./theme.js";

function readRoute() {
  const pathname = window.location.pathname.replace(/\/+$/, "") || "/";
  const strategyMatch = pathname.match(/^\/strategies\/([^/]+)$/);

  if (pathname === "/paper-trading") {
    return {
      activeView: "paper",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/screening") {
    return {
      activeView: "screening",
      selectedStrategyId: "strategy-1"
    };
  }

  if (pathname === "/strategy-settings") {
    return {
      activeView: "settings",
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

  if (activeView === "screening") {
    return "/screening";
  }

  if (activeView === "settings") {
    return "/strategy-settings";
  }

  if (activeView === "strategy" && strategyId) {
    return `/strategies/${encodeURIComponent(strategyId)}`;
  }

  return "/";
}

function isTimestampStale(timestamp, maxAgeMs) {
  if (!timestamp) {
    return true;
  }

  const parsedTimestamp = new Date(timestamp).getTime();
  if (Number.isNaN(parsedTimestamp)) {
    return true;
  }

  return Date.now() - parsedTimestamp > maxAgeMs;
}

const ROUTE_REFRESH_STALE_MS = 6 * 60 * 1000;

function buildPaperPortfolioPreview(paperPortfolio) {
  if (!paperPortfolio) {
    return null;
  }

  return {
    summary: paperPortfolio.summary ?? null,
    brokerStatus: paperPortfolio.brokerStatus ?? null
  };
}

export default function App() {
  const initialRoute = readRoute();
  const [theme, setTheme] = useState(() => getInitialTheme());
  const [dashboard, setDashboard] = useState(null);
  const [streamDiagnostics, setStreamDiagnostics] = useState(null);
  const [strategyPayload, setStrategyPayload] = useState(null);
  const [paperPortfolioPreview, setPaperPortfolioPreview] = useState(null);
  const [paperPortfolio, setPaperPortfolio] = useState(null);
  const [paperPortfolioLastUpdated, setPaperPortfolioLastUpdated] = useState(null);
  const [activeView, setActiveView] = useState(initialRoute.activeView);
  const [selectedStrategyId, setSelectedStrategyId] = useState(initialRoute.selectedStrategyId);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNotice, setRefreshNotice] = useState(null);
  const [error, setError] = useState("");
  const strategyRefreshKeyRef = useRef(null);

  const applyAppState = useCallback((dashboardJson, strategyJson) => {
    setDashboard(dashboardJson);
    setStreamDiagnostics(dashboardJson?.streamDiagnostics ?? null);
    setStrategyPayload(strategyJson);
    setPaperPortfolioPreview(strategyJson.paperPortfolioPreview ?? null);
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

  const applyPaperPortfolioUpdate = useCallback((nextPaperPortfolio, lastUpdated = null) => {
    setPaperPortfolio(nextPaperPortfolio ?? null);
    setPaperPortfolioPreview(buildPaperPortfolioPreview(nextPaperPortfolio));
    setPaperPortfolioLastUpdated(lastUpdated ?? new Date().toISOString());
  }, []);

  const fetchPaperPortfolio = useCallback(async () => {
    const response = await fetch("/api/paper-portfolio");
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Failed to load paper portfolio");
    }

    applyPaperPortfolioUpdate(payload?.paperPortfolio ?? null, payload?.lastUpdated ?? null);
    return payload;
  }, [applyPaperPortfolioUpdate]);

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

  const runStrategyRefresh = useCallback(async ({ announceStart = true } = {}) => {
    setRefreshing(true);
    if (announceStart) {
      setRefreshNotice({
        tone: "info",
        message: "Refreshing live strategy data..."
      });
    }

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

      if (announceStart || warnings.length) {
        setRefreshNotice({
          tone: warnings.length ? "warning" : "success",
          message: warnings.length
            ? `Refresh complete with warnings: ${warnings.join(" | ")}`
            : `Refresh complete at ${new Date(
                refreshPayload?.lastUpdated ?? strategyJson?.lastUpdated ?? new Date().toISOString()
              ).toLocaleString("en-GB")}`
        });
      }
    } catch (refreshError) {
      setRefreshNotice({
        tone: "error",
        message: refreshError.message
      });
    } finally {
      setRefreshing(false);
    }
  }, [syncAppState]);

  const handleManualRefresh = useCallback(() => {
    return runStrategyRefresh({ announceStart: true });
  }, [runStrategyRefresh]);

  const mutatePaperOrders = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      if (payload?.paperPortfolio) {
        applyPaperPortfolioUpdate(payload.paperPortfolio, new Date().toISOString());
      }
      throw new Error(payload?.error || "Paper-trading request failed");
    }

    if (payload?.paperPortfolio) {
      applyPaperPortfolioUpdate(payload.paperPortfolio, new Date().toISOString());
    } else {
      await syncAppState();
    }

    return payload;
  }, [applyPaperPortfolioUpdate, syncAppState]);

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

  const handleSaveCalculatorSnapshot = useCallback((orderId, snapshotPayload) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/calculator-snapshots`, {
      method: "POST",
      body: JSON.stringify(snapshotPayload)
    });
  }, [mutatePaperOrders]);

  const handleExecutePaperOrder = useCallback((orderId, payload = {}) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/execute`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }, [mutatePaperOrders]);

  const handleSyncPaperExecution = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/sync-execution`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }, [mutatePaperOrders]);

  const handleCancelPaperExecution = useCallback((orderId) => {
    return mutatePaperOrders(`/api/paper-orders/${encodeURIComponent(orderId)}/cancel-execution`, {
      method: "POST",
      body: JSON.stringify({})
    });
  }, [mutatePaperOrders]);

  const mutateStrategyAssets = useCallback(async (url, options = {}) => {
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json"
      },
      ...options
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(payload?.error || "Strategy settings request failed");
    }

    await syncAppState();
    return payload;
  }, [syncAppState]);

  const handleSaveStrategyAssetMapping = useCallback((assetConfig) => {
    return mutateStrategyAssets(`/api/strategy-assets/${encodeURIComponent(assetConfig.id)}`, {
      method: "PUT",
      body: JSON.stringify(assetConfig)
    });
  }, [mutateStrategyAssets]);

  const handleDeleteStrategyAssetMapping = useCallback((assetId) => {
    return mutateStrategyAssets(`/api/strategy-assets/${encodeURIComponent(assetId)}`, {
      method: "DELETE"
    });
  }, [mutateStrategyAssets]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (_error) {
      // Ignore storage failures and keep the theme in memory.
    }

    return () => {
      if (root.dataset.theme === theme) {
        delete root.dataset.theme;
      }
    };
  }, [theme]);

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

    return () => {
      isActive = false;
    };
  }, [applyAppState, fetchAppState]);

  useEffect(() => {
    let isActive = true;

    async function loadStreamDiagnostics() {
      try {
        const response = await fetch("/api/stream-status");

        if (!response.ok) {
          throw new Error(`Diagnostics request failed with ${response.status}`);
        }

        const payload = await response.json();
        if (isActive) {
          setStreamDiagnostics(payload);
        }
      } catch (_error) {
        // Keep the last known diagnostics visible if the lightweight status call fails.
      }
    }

    void loadStreamDiagnostics();
    const interval = window.setInterval(() => {
      void loadStreamDiagnostics();
    }, 15_000);

    return () => {
      isActive = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    if (loading) {
      return;
    }

    if (
      !(activeView === "screening" || (activeView === "strategy" && selectedStrategyId === "strategy-1"))
    ) {
      strategyRefreshKeyRef.current = null;
      return;
    }

    const refreshKey = `${activeView}:${selectedStrategyId}`;
    if (strategyRefreshKeyRef.current === refreshKey) {
      return;
    }

    strategyRefreshKeyRef.current = refreshKey;
    if (!isTimestampStale(dashboard?.lastUpdated, ROUTE_REFRESH_STALE_MS)) {
      return;
    }

    void runStrategyRefresh({ announceStart: false });
  }, [activeView, dashboard?.lastUpdated, loading, runStrategyRefresh, selectedStrategyId]);

  useEffect(() => {
    if (loading || activeView !== "paper") {
      return;
    }

    if (!paperPortfolio) {
      void fetchPaperPortfolio().catch((paperLoadError) => {
        setRefreshNotice({
          tone: "error",
          message: paperLoadError.message
        });
      });
    }

    const source = new EventSource("/api/paper-orders/stream");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);

        if (payload?.paperPortfolio) {
          applyPaperPortfolioUpdate(payload.paperPortfolio, payload.lastUpdated ?? new Date().toISOString());
        }
      } catch (streamError) {
        console.error("Unable to parse paper-trading stream payload:", streamError);
      }
    };

    return () => {
      source.close();
    };
  }, [activeView, applyPaperPortfolioUpdate, fetchPaperPortfolio, loading, paperPortfolio]);

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
  const v2Screener = strategyPayload?.v2Screener;
  const strategyPaperContext = paperPortfolio ?? paperPortfolioPreview;
  const selectedStrategy = strategies.find((strategy) => strategy.id === selectedStrategyId) ?? null;
  const heroStats = dashboard?.heroStats ?? [];
  const showSettings = activeView === "settings";
  const showScreening = activeView === "screening";
  const showStrategyFinder = activeView === "strategy" && selectedStrategyId === "strategy-1";
  const showVolCrushEarnings = activeView === "strategy" && selectedStrategyId === "strategy-2";
  const showTradingViewStrategyFinder =
    activeView === "strategy" && selectedStrategyId === "strategy-tv-finder";
  const showPlannedStrategy =
    activeView === "strategy" && !showStrategyFinder && !showVolCrushEarnings && !showTradingViewStrategyFinder;
  const showPaperTrading = activeView === "paper";
  const nextThemeLabel = theme === "dark" ? "Light mode" : "Dark mode";

  return (
    <div className="app-root">
      {dashboard?.calendarWidgets?.tickerTape ? (
        <TradingViewWidget
          bare
          type={dashboard.calendarWidgets.tickerTape.type}
          config={dashboard.calendarWidgets.tickerTape.config}
          theme={theme}
          containerClassName="app-header-banner tradingview-widget-container--ticker"
        />
      ) : null}

      <div className="app-shell">
        <div className="app-toolbar">
          <button
            type="button"
            className="theme-toggle"
            aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme((currentTheme) => (currentTheme === "dark" ? "light" : "dark"))}
          >
            {nextThemeLabel}
          </button>
        </div>

        <div className="app-grid">
          <StrategyRail
            activeView={activeView}
            strategies={strategies}
            selectedStrategyId={selectedStrategyId}
            streamDiagnostics={streamDiagnostics}
            onOpenDashboard={() => navigateTo("dashboard")}
            onOpenSettings={() => navigateTo("settings")}
            onOpenScreening={() => navigateTo("screening")}
            onOpenPaperTrading={() => navigateTo("paper")}
            onSelect={(strategyId) => navigateTo("strategy", strategyId)}
            paperPortfolio={paperPortfolioPreview}
            screeningSummary={v2Screener?.summary ?? null}
          />

          {showPaperTrading ? (
            <PaperTradingWorkspace
              paperPortfolio={paperPortfolio ?? paperPortfolioPreview}
              lastUpdated={paperPortfolioLastUpdated ?? strategyPayload?.lastUpdated ?? null}
              onUpdatePaperOrder={handleUpdatePaperOrder}
              onClosePaperOrder={handleClosePaperOrder}
              onDeletePaperOrder={handleDeletePaperOrder}
              onSaveCalculatorSnapshot={handleSaveCalculatorSnapshot}
              onExecutePaperOrder={handleExecutePaperOrder}
              onSyncPaperExecution={handleSyncPaperExecution}
              onCancelPaperExecution={handleCancelPaperExecution}
              theme={theme}
            />
          ) : showScreening ? (
            <StrategyScreeningWorkspace
              screenerPayload={v2Screener}
              onManualRefresh={handleManualRefresh}
              refreshing={refreshing}
              refreshNotice={refreshNotice}
              theme={theme}
            />
          ) : showSettings ? (
            <StrategySettingsWorkspace
              strategyPayload={strategyPayload}
              onSaveStrategyAssetMapping={handleSaveStrategyAssetMapping}
              onDeleteStrategyAssetMapping={handleDeleteStrategyAssetMapping}
            />
          ) : showStrategyFinder ? (
            <StrategyFinderWorkspace
              strategyPayload={strategyPayload}
              strategyDefinition={selectedStrategy}
              onManualRefresh={handleManualRefresh}
              refreshing={refreshing}
              refreshNotice={refreshNotice}
              paperPortfolio={strategyPaperContext}
              onCreatePaperOrder={handleCreatePaperOrder}
              onOpenPaperTrading={() => navigateTo("paper")}
              theme={theme}
            />
          ) : showVolCrushEarnings ? (
            <VolCrushEarningsWorkspace
              strategyDefinition={selectedStrategy}
              onCreatePaperOrder={handleCreatePaperOrder}
              onOpenPaperTrading={() => navigateTo("paper")}
              theme={theme}
            />
          ) : showTradingViewStrategyFinder ? (
            <TradingViewStrategyWorkspace
              strategyDefinition={selectedStrategy}
              theme={theme}
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
                theme={theme}
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
                              {opportunity.optionSymbol} {opportunity.optionStrike}
                              {opportunity.optionType === "put" ? "P" : "C"} {opportunity.optionExpiry}
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
