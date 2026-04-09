import { useEffect, useMemo, useState } from "react";
import { buildMarketTimerModel, buildUnderlyingMarketMonitorModels } from "../marketTimers.js";
import LiveMonitoringPanel from "./LiveMonitoringPanel.jsx";

const OPTION_SESSION_ENTRY_KEYS = new Set(["option-pre", "option-open", "option-post"]);
const PINNED_UNDERLYING_MARKETS = [
  {
    source: "underlying-monitor-gold",
    label: "Gold",
    underlyingSymbol: "XAU-USD",
    referenceSymbol: "COMEX:GC1!"
  },
  {
    source: "underlying-monitor-oil",
    label: "Oil",
    underlyingSymbol: "WTI-USD",
    referenceSymbol: "NYMEX:CL1!"
  },
  {
    source: "underlying-monitor-spy-spx",
    label: "SPY / SPX",
    underlyingSymbol: "SPY",
    referenceSymbol: "NYSE:SPY"
  }
];

function getStateToneClassName(tone) {
  if (tone === "live") {
    return "macro-layout-diagnostics__state--live";
  }

  if (tone === "warning") {
    return "macro-layout-diagnostics__state--retrying";
  }

  return "macro-layout-diagnostics__state--idle";
}

export default function StrategyRail({
  sidebarId,
  activeView,
  strategies,
  selectedStrategyId,
  streamDiagnostics,
  marketStatusPayload,
  marketTimerContext,
  onOpenDashboard,
  onOpenSettings,
  onOpenScreening,
  onOpenPaperTrading,
  onOpenOrderManagement,
  onSelect,
  paperPortfolio,
  screeningSummary,
  isMobile = false,
  isOpen = true,
  onCloseMobile = null
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const paperSummary = paperPortfolio?.summary ?? null;
  const paperPnL = Number(paperSummary?.profitLossValue ?? 0);
  const closedPaperPnL = Number(paperSummary?.totalClosedProfitLossValue ?? 0);
  const marketTimerModel = useMemo(
    () => buildMarketTimerModel(marketTimerContext, marketStatusPayload, nowMs),
    [marketStatusPayload, marketTimerContext, nowMs]
  );
  const optionSessionEntries = useMemo(
    () => marketTimerModel?.entries.filter((entry) => OPTION_SESSION_ENTRY_KEYS.has(entry.key)) ?? [],
    [marketTimerModel]
  );
  const marketTimerEntries = useMemo(
    () => marketTimerModel?.entries.filter((entry) => !OPTION_SESSION_ENTRY_KEYS.has(entry.key)) ?? [],
    [marketTimerModel]
  );
  const underlyingMarketMonitorModels = useMemo(
    () => buildUnderlyingMarketMonitorModels(PINNED_UNDERLYING_MARKETS, marketStatusPayload, nowMs),
    [marketStatusPayload, nowMs]
  );
  const sidebarClassName = [
    "sidebar",
    isMobile ? "sidebar--mobile" : "",
    isMobile && isOpen ? "sidebar--open" : "",
    isMobile && !isOpen ? "sidebar--hidden" : ""
  ]
    .filter(Boolean)
    .join(" ");

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return (
    <aside id={sidebarId} className={sidebarClassName} aria-hidden={isMobile && !isOpen}>
      {isMobile ? (
        <div className="sidebar__mobile-bar">
          <span className="brand__eyebrow">Navigation</span>
          <button type="button" className="sidebar-close" onClick={onCloseMobile}>
            Hide sidebar
          </button>
        </div>
      ) : null}

      <div className="brand">
        <span className="brand__eyebrow">Hedge strategy desk</span>
        <h1>HedgeHub</h1>
        <p>
          Binary bets, options overlays, and live market context in one place.
        </p>
      </div>

      <div className="sidebar__section">
        <div className="sidebar-primary-nav">
          <LiveMonitoringPanel
            streamDiagnostics={streamDiagnostics}
            brokerStatus={paperPortfolio?.brokerStatus ?? null}
            className="sidebar-live-monitor"
          />

          {marketTimerModel ? (
            <div className="macro-layout-diagnostics sidebar-market-timers">
              <div className="sidebar-market-timers__header">
                <span className="brand__eyebrow">Market timers</span>
                <span
                  className={`macro-layout-diagnostics__state ${getStateToneClassName(marketTimerModel.status?.tone)}`}
                >
                  {marketTimerModel.status?.label ?? "Focus"}
                </span>
              </div>
              <strong className="sidebar-market-timers__title">{marketTimerModel.title}</strong>
              {marketTimerModel.subtitle ? <span className="sidebar-market-timers__subtitle">{marketTimerModel.subtitle}</span> : null}

              <div className="sidebar-market-timers__list">
                {optionSessionEntries.length ? (
                  <div
                    className="macro-layout-diagnostics__row sidebar-market-timers__row sidebar-market-timers__row--combined"
                  >
                    <span className="macro-layout-diagnostics__label sidebar-market-timers__label">Option</span>
                    <div className="sidebar-market-timers__combined-states">
                      {optionSessionEntries.map((entry) => (
                        <span key={entry.key} className="sidebar-market-timers__combined-state">
                          <span className="sidebar-market-timers__combined-label">
                            {entry.label.replace(/^Option\s+/u, "")}
                          </span>
                          <span className={`macro-layout-diagnostics__state ${getStateToneClassName(entry.tone)}`}>
                            {entry.countdown}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {marketTimerEntries.map((entry) => (
                  <div
                    key={entry.key}
                    className="macro-layout-diagnostics__row sidebar-market-timers__row"
                  >
                    <span className="macro-layout-diagnostics__label sidebar-market-timers__label">{entry.label}</span>
                    <span className={`macro-layout-diagnostics__state ${getStateToneClassName(entry.tone)}`}>
                      {entry.countdown}
                    </span>
                    <span className="sidebar-market-timers__detail">{entry.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {underlyingMarketMonitorModels.length ? (
            <div className="macro-layout-diagnostics sidebar-market-timers sidebar-underlying-monitor">
              <div className="sidebar-market-timers__header">
                <span className="brand__eyebrow">Underlying markets</span>
                <span className="macro-layout-diagnostics__state macro-layout-diagnostics__state--idle">
                  Tracked
                </span>
              </div>

              <div className="sidebar-underlying-monitor__list">
                {underlyingMarketMonitorModels.map((market) => (
                  <div
                    key={market.key}
                    className="macro-layout-diagnostics__row sidebar-underlying-monitor__row"
                  >
                    <span className="macro-layout-diagnostics__label sidebar-underlying-monitor__label">
                      {market.title}
                    </span>
                    <span className={`macro-layout-diagnostics__state ${getStateToneClassName(market.status?.tone)}`}>
                      {market.status?.label ?? "Closed"}
                    </span>
                    <span className="sidebar-underlying-monitor__detail">
                      Open {market.open?.countdown ?? "n/a"} · Close {market.close?.countdown ?? "n/a"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className={`dashboard-button ${activeView === "dashboard" ? "dashboard-button--active" : ""}`}
            onClick={onOpenDashboard}
          >
            Dashboard
          </button>
          <button
            type="button"
            className={`dashboard-button ${activeView === "settings" ? "dashboard-button--active" : ""}`}
            onClick={onOpenSettings}
          >
            Strategy settings
          </button>
          <button
            type="button"
            className={`dashboard-button ${activeView === "orders" ? "dashboard-button--active" : ""}`}
            onClick={onOpenOrderManagement}
          >
            Order management
          </button>
        </div>

        <div className="section-heading">
          <span>Strategies</span>
          <span className="pill pill--ghost">{strategies.length}</span>
        </div>

        <div className="strategy-list">
          {strategies.flatMap((strategy) => {
            const isActive = activeView === "strategy" && strategy.id === selectedStrategyId;
            const cards = [
              <button
                key={strategy.id}
                type="button"
                className={`strategy-card ${isActive ? "strategy-card--active" : ""}`}
                onClick={() => onSelect(strategy.id)}
              >
                <div className="strategy-card__topline">
                  <span className="strategy-card__name">{strategy.name}</span>
                  <span className={`pill ${strategy.status === "ready" ? "pill--live" : "pill--ghost"}`}>
                    {strategy.status}
                  </span>
                </div>
                {strategy.assetLabel ? <div className="strategy-card__asset">{strategy.assetLabel}</div> : null}
                <p>{strategy.description}</p>
              </button>
            ];

            if (strategy.id === "strategy-1") {
              cards.push(
                <button
                  key="screening-v2"
                  type="button"
                  className={`sidebar-nav-card ${activeView === "screening" ? "sidebar-nav-card--active" : ""}`}
                  onClick={onOpenScreening}
                >
                  <div className="strategy-card__topline">
                    <span className="strategy-card__name">Probability Mismatch</span>
                    <span className={`pill ${(screeningSummary?.executableEdges ?? 0) > 0 ? "pill--live" : "pill--ghost"}`}>
                      {screeningSummary?.executableEdges ?? 0} live
                    </span>
                  </div>
                  <p>Rank probability mismatch trades by execution quality, liquidity, and hedge strength.</p>
                </button>
              );
            }

            return cards;
          })}
        </div>
      </div>

      <div className="sidebar__section sidebar__section--summary">
        <button
          type="button"
          className={`paper-nav-card ${activeView === "paper" ? "paper-nav-card--active" : ""}`}
          onClick={onOpenPaperTrading}
        >
          <div className="section-heading">
            <span>Paper trading</span>
            <span className={`pill ${paperSummary?.openOrderCount ? "pill--live" : "pill--ghost"}`}>
              {paperSummary?.openOrderCount ?? 0} open
            </span>
          </div>

          <div className="summary-stack">
            <div className="summary-row">
              <span>Initial purchase value</span>
              <strong>
                {paperSummary?.initialPurchaseValue != null
                  ? `$${paperSummary.initialPurchaseValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}`
                  : "No holdings"}
              </strong>
            </div>
            <div className="summary-row">
              <span>Current holding value</span>
              <strong>
                {paperSummary?.currentHoldingValue != null
                  ? `$${paperSummary.currentHoldingValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}`
                  : "No holdings"}
              </strong>
            </div>
            <div className="summary-row">
              <span>Profit/Loss value</span>
              <strong className={paperPnL >= 0 ? "positive" : "negative"}>
                {paperSummary?.profitLossValue != null
                  ? `$${paperSummary.profitLossValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}`
                  : "n/a"}
              </strong>
            </div>
            <div className="summary-row">
              <span>Profit/Loss %</span>
              <strong className={paperPnL >= 0 ? "positive" : "negative"}>
                {paperSummary?.profitLossPercent != null
                  ? `${paperSummary.profitLossPercent.toFixed(2)}%`
                  : "n/a"}
              </strong>
            </div>
            <div className="summary-row">
              <span>Total closed orders P&amp;L</span>
              <strong className={closedPaperPnL >= 0 ? "positive" : "negative"}>
                {paperSummary?.totalClosedProfitLossValue != null
                  ? `$${paperSummary.totalClosedProfitLossValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}`
                  : "n/a"}
              </strong>
            </div>
          </div>
        </button>
      </div>

    </aside>
  );
}
