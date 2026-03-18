export default function StrategyRail({
  activeView,
  strategies,
  selectedStrategyId,
  onOpenDashboard,
  onOpenPaperTrading,
  onSelect,
  paperPortfolio
}) {
  const paperSummary = paperPortfolio?.summary ?? null;
  const paperPnL = Number(paperSummary?.profitLossValue ?? 0);
  const closedPaperPnL = Number(paperSummary?.totalClosedProfitLossValue ?? 0);

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand__eyebrow">Hedge strategy desk</span>
        <h1>HedgeHub</h1>
        <p>
          Binary bets, options overlays, and live market context in one place.
        </p>
      </div>

      <div className="sidebar__section">
        <button
          type="button"
          className={`dashboard-button ${activeView === "dashboard" ? "dashboard-button--active" : ""}`}
          onClick={onOpenDashboard}
        >
          Dashboard
        </button>

        <div className="section-heading">
          <span>Strategies</span>
          <span className="pill pill--ghost">{strategies.length}</span>
        </div>

        <div className="strategy-list">
          {strategies.map((strategy) => {
            const isActive = activeView === "strategy" && strategy.id === selectedStrategyId;

            return (
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
            );
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
