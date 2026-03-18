import { useEffect, useState } from "react";
import PaperTradeHistoryChart from "./PaperTradeHistoryChart.jsx";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";

function formatCurrency(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }).format(Number(value));
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  return `${Number(value).toFixed(2)}%`;
}

function formatDateLabel(value) {
  if (!value) {
    return "n/a";
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function formatDateTimeLabel(value) {
  if (!value) {
    return "n/a";
  }

  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(normalizedValue);

  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function buildDrafts(orders) {
  return Object.fromEntries(
    (orders ?? []).map((order) => [
      String(order.id),
      {
        purchaseDate: order.purchaseDate ?? "",
        legs: Object.fromEntries(
          (order.legs ?? []).map((leg) => [
            String(leg.id),
            {
              entryPrice: String(leg.entryPrice ?? ""),
              quantity: String(leg.quantity ?? "")
            }
          ])
        )
      }
    ])
  );
}

function buildDefaultDraft(order) {
  if (!order) {
    return {
      purchaseDate: "",
      legs: {}
    };
  }

  return {
    purchaseDate: order.purchaseDate ?? "",
    legs: Object.fromEntries(
      (order.legs ?? []).map((leg) => [
        String(leg.id),
        {
          entryPrice: String(leg.entryPrice ?? ""),
          quantity: String(leg.quantity ?? "")
        }
      ])
    )
  };
}

function hasOrderDraftChanged(order, draft) {
  if (!draft) {
    return false;
  }

  if ((draft.purchaseDate ?? "") !== (order.purchaseDate ?? "")) {
    return true;
  }

  return (order.legs ?? []).some((leg) => {
    const legDraft = draft.legs?.[String(leg.id)];
    if (!legDraft) {
      return false;
    }

    return (
      String(legDraft.entryPrice ?? "") !== String(leg.entryPrice ?? "") ||
      String(legDraft.quantity ?? "") !== String(leg.quantity ?? "")
    );
  });
}

function groupOrdersByStrategy(orders) {
  return Object.values(
    (orders ?? []).reduce((groups, order) => {
      const key = order.strategyId || "paper";
      if (!groups[key]) {
        groups[key] = {
          id: key,
          strategyName: order.strategyName || "Strategy",
          orders: []
        };
      }

      groups[key].orders.push(order);
      return groups;
    }, {})
  );
}

function buildPatchFromDraft(order, draft) {
  return {
    purchaseDate: draft.purchaseDate,
    legs: order.legs.map((leg) => ({
      id: leg.id,
      entryPrice: draft.legs?.[String(leg.id)]?.entryPrice ?? leg.entryPrice,
      quantity: draft.legs?.[String(leg.id)]?.quantity ?? leg.quantity
    }))
  };
}

function renderLegDescriptor(leg) {
  if (leg.kind === "binary") {
    return `${leg.action} ${leg.outcome}`;
  }

  return `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}${leg.optionType === "put" ? "P" : "C"} ${leg.expiry}`;
}

function getLegTitle(order, leg) {
  if (leg.kind === "binary") {
    return order.polymarketQuestion || leg.label;
  }

  return leg.label;
}

function getPolymarketEventUrl(url) {
  const normalizedUrl = String(url ?? "").trim();
  return normalizedUrl.startsWith("https://polymarket.com/event/") ? normalizedUrl : "";
}

function derivePolymarketEventSlug(url) {
  const eventUrl = getPolymarketEventUrl(url);
  if (!eventUrl) {
    return "";
  }

  const match = eventUrl.match(/^https:\/\/polymarket\.com\/event\/([^/?#]+)/i);
  return match?.[1] ?? "";
}

function getLegUrl(order, leg) {
  return leg.kind === "binary" ? getPolymarketEventUrl(order.polymarketUrl) : "";
}

function getPolymarketReferenceLine(order, leg) {
  if (leg.kind !== "binary") {
    return "";
  }

  const parts = [];
  const marketId = String(leg.polymarketMarketId || order.polymarketMarketId || "").trim();
  const marketSlug = String(order.polymarketMarketSlug || "").trim();
  const eventSlug = String(order.polymarketEventSlug || derivePolymarketEventSlug(order.polymarketUrl) || "").trim();

  if (marketId) {
    parts.push(`ID ${marketId}`);
  }

  if (marketSlug) {
    parts.push(`slug ${marketSlug}`);
  }

  if (eventSlug) {
    parts.push(`event ${eventSlug}`);
  }

  if (parts.length) {
    return parts.join(" · ");
  }

  return String(order.polymarketSource || "").toLowerCase() === "seed"
    ? "Seed fallback market · no live slug/event yet"
    : "";
}

function formatBoundedCurrency(value, isUnbounded = false) {
  if (isUnbounded) {
    return "Unbounded";
  }

  return formatCurrency(value);
}

function getOrderExpirationDate(order) {
  return order.strategyCloseDate || order.polymarketResolutionDate || "";
}

function getOrderTagLabel(order) {
  return order.marketBias || order.strategyName || "Open";
}

function OrderSummaryStrip({ items }) {
  return (
    <div className="paper-order-summary-strip">
      {items.map((item) => (
        <div key={item.label} className="paper-order-summary-cell">
          <span>{item.label}</span>
          {item.kind === "tag" ? (
            <strong>
              <span className={`bias-pill bias-pill--${item.tone ?? "neutral"}`}>{item.value}</span>
            </strong>
          ) : (
            <strong className={item.tone ?? ""}>{item.value}</strong>
          )}
        </div>
      ))}
    </div>
  );
}

function OpenOrderCard({
  order,
  draft,
  isDirty,
  feedback,
  orderBusy,
  isExpanded,
  lastUpdated,
  onToggle,
  onResetDraft,
  onSave,
  onClose,
  onDelete,
  onUpdateDraft,
  onSaveCalculatorSnapshot
}) {
  const orderEventUrl = getPolymarketEventUrl(order.polymarketUrl);
  const expirationDate = getOrderExpirationDate(order);
  const summaryItems = [
    { label: "Initial cost", value: formatCurrency(order.initialPurchaseValue) },
    { label: "Date in", value: formatDateLabel(order.purchaseDate) },
    { label: "Expiration", value: formatDateLabel(expirationDate) },
    { label: "Asset", value: order.assetLabel || "n/a" },
    { label: "Strategy type", value: order.strategyType || "Custom" },
    { label: "Tag", value: getOrderTagLabel(order), kind: "tag", tone: order.marketBiasTone ?? "neutral" },
    { label: "Max profit", value: formatBoundedCurrency(order.maxProfit, order.maxProfitUnbounded) },
    { label: "Max loss", value: formatBoundedCurrency(order.maxLoss, order.maxLossUnbounded) },
    { label: "Unrealised P&L", value: formatCurrency(order.profitLossValue), tone: Number(order.profitLossValue) >= 0 ? "positive" : "negative" }
  ];

  return (
    <article
      className={`paper-order-card ${isExpanded ? "paper-order-card--expanded" : "paper-order-card--collapsed"}`}
    >
      <div className="paper-order-card__header">
        <div>
          <span className="brand__eyebrow">Open holding</span>
          <h3>{order.combinationLabel}</h3>
          <p className="paper-order-card__meta">
            {order.assetLabel} · {order.strategyType || "Custom"} · Purchased {formatDateLabel(order.purchaseDate)}
          </p>
        </div>
        <div className="paper-order-card__actions">
          <span className={`pill ${Number(order.profitLossValue) >= 0 ? "pill--live" : "pill--ghost"}`}>
            {formatCurrency(order.profitLossValue)}
          </span>
          {orderEventUrl ? (
            <a href={orderEventUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
              Open market
            </a>
          ) : null}
          <button
            type="button"
            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggle}
            disabled={orderBusy}
          >
            {isExpanded ? "Collapse" : "Expand"}
          </button>
        </div>
      </div>

      <OrderSummaryStrip items={summaryItems} />

      {isExpanded ? (
        <div className="paper-order-card__body">
          <PaperTradeHistoryChart history={order.history} />
          <PaperTradeScenarioPanel
            order={order}
            lastUpdated={lastUpdated}
            onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
          />

          <div className="paper-order-editbar">
            <label>
              <span>Purchase date</span>
              <input
                type="date"
                value={draft.purchaseDate}
                onChange={(event) =>
                  onUpdateDraft(order.id, (current) => ({
                    ...current,
                    purchaseDate: event.target.value
                  }))
                }
              />
            </label>

            <div className="paper-order-editbar__actions">
              <button type="button" className="chart-toggle" onClick={onResetDraft} disabled={!isDirty || orderBusy}>
                Reset
              </button>
              <button
                type="button"
                className={`chart-toggle ${isDirty ? "chart-toggle--active" : ""}`}
                onClick={onSave}
                disabled={!isDirty || orderBusy}
              >
                {orderBusy ? "Saving..." : "Save changes"}
              </button>
              <button type="button" className="chart-toggle" onClick={onDelete} disabled={orderBusy}>
                Remove
              </button>
            </div>
          </div>

          <div className="paper-legs-table">
            <div className="paper-legs-table__head">
              <span>Sub item</span>
              <span>Type</span>
              <span>Purchase price</span>
              <span>Contracts</span>
              <span>Current mark</span>
              <span>Current value</span>
              <span>P&amp;L</span>
            </div>
            {order.legs.map((leg) => {
              const legDraft = draft.legs?.[String(leg.id)] ?? {
                entryPrice: String(leg.entryPrice ?? ""),
                quantity: String(leg.quantity ?? "")
              };
              const legUrl = getLegUrl(order, leg);
              const polymarketReferenceLine = getPolymarketReferenceLine(order, leg);

              return (
                <div key={leg.id} className="paper-legs-table__row">
                  <span className="paper-legs-table__label">
                    <strong>{getLegTitle(order, leg)}</strong>
                    <small>{renderLegDescriptor(leg)}</small>
                    {legUrl ? (
                      <a href={legUrl} target="_blank" rel="noreferrer">
                        {legUrl}
                      </a>
                    ) : null}
                    {polymarketReferenceLine ? <small>{polymarketReferenceLine}</small> : null}
                  </span>
                  <span>{leg.kind === "binary" ? "Polymarket" : "Option"}</span>
                  <span>
                    <input
                      type="number"
                      min="0"
                      max={leg.kind === "binary" ? "1" : undefined}
                      step="0.01"
                      value={legDraft.entryPrice}
                      onChange={(event) =>
                        onUpdateDraft(order.id, (current) => ({
                          ...current,
                          legs: {
                            ...current.legs,
                            [String(leg.id)]: {
                              ...(current.legs?.[String(leg.id)] ?? {}),
                              entryPrice: event.target.value
                            }
                          }
                        }))
                      }
                    />
                  </span>
                  <span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={legDraft.quantity}
                      onChange={(event) =>
                        onUpdateDraft(order.id, (current) => ({
                          ...current,
                          legs: {
                            ...current.legs,
                            [String(leg.id)]: {
                              ...(current.legs?.[String(leg.id)] ?? {}),
                              quantity: event.target.value
                            }
                          }
                        }))
                      }
                    />
                  </span>
                  <span>{formatCurrency(leg.currentPrice, leg.kind === "binary" ? 4 : 2)}</span>
                  <span>{formatCurrency(leg.currentExposure)}</span>
                  <span className={Number(leg.profitLossValue) >= 0 ? "positive" : "negative"}>
                    {formatCurrency(leg.profitLossValue)}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="paper-order-footer">
            <span>
              Live context: {order.valuationContext.proxySymbol || "Proxy"} {formatCurrency(order.valuationContext.currentProxySpot)}
            </span>
            <span>YES mark {formatPercent((order.valuationContext.currentYesPrice ?? 0) * 100)}</span>
            <span>Target {formatCurrency(order.valuationContext.targetUnderlyingValue)}</span>
          </div>
        </div>
      ) : null}

      <div className="paper-order-card__dock">
        <div className="paper-order-card__dock-copy">
          <span>{isExpanded ? "Expanded details" : "Collapsed by default"}</span>
          <strong>{getOrderTagLabel(order)}</strong>
        </div>
        <div className="paper-order-card__dock-actions">
          <button
            type="button"
            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggle}
            disabled={orderBusy}
          >
            {isExpanded ? "Hide details" : "View details"}
          </button>
          <button
            type="button"
            className="chart-toggle paper-order-card__close-button"
            onClick={onClose}
            disabled={orderBusy}
          >
            {orderBusy ? "Working..." : "Close order"}
          </button>
        </div>
      </div>

      {feedback ? (
        <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </article>
  );
}

function ClosedOrderCard({
  order,
  isExpanded,
  lastUpdated,
  onToggle,
  onDeletePaperOrder,
  onSaveCalculatorSnapshot,
  busyOrderId,
  setBusyOrderId,
  setFeedbackByOrder,
  feedback
}) {
  async function handleDelete() {
    if (!window.confirm(`Remove closed order "${order.combinationLabel}" from history?`)) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      await onDeletePaperOrder(order.id);
    } catch (error) {
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "error",
          message: error.message
        }
      }));
    } finally {
      setBusyOrderId(null);
    }
  }

  const orderBusy = busyOrderId === String(order.id);
  const orderEventUrl = getPolymarketEventUrl(order.polymarketUrl);
  const summaryItems = [
    { label: "Date in", value: formatDateLabel(order.purchaseDate) },
    { label: "Closed", value: formatDateLabel(order.closedDate || order.closedAt?.slice(0, 10)) },
    { label: "Asset", value: order.assetLabel || "n/a" },
    { label: "Strategy type", value: order.strategyType || "Custom" },
    { label: "Tag", value: getOrderTagLabel(order), kind: "tag", tone: order.marketBiasTone ?? "neutral" },
    { label: "Entry value", value: formatCurrency(order.initialPurchaseValue) },
    { label: "Exit value", value: formatCurrency(order.currentHoldingValue) },
    {
      label: "Realized P&L",
      value: formatCurrency(order.profitLossValue),
      tone: Number(order.profitLossValue) >= 0 ? "positive" : "negative"
    },
    {
      label: "Realized P&L %",
      value: formatPercent(order.profitLossPercent),
      tone: Number(order.profitLossValue) >= 0 ? "positive" : "negative"
    }
  ];

  return (
    <article className={`paper-order-card paper-order-card--closed ${isExpanded ? "paper-order-card--expanded" : "paper-order-card--collapsed"}`}>
      <div className="paper-order-card__header">
        <div>
          <span className="brand__eyebrow">Closed order</span>
          <h3>{order.combinationLabel}</h3>
          <p className="paper-order-card__meta">
            {order.assetLabel} · {order.strategyType || "Custom"} · Bought {formatDateTimeLabel(order.createdAt)} · Closed{" "}
            {formatDateTimeLabel(order.closedAt)}
          </p>
        </div>
        <div className="paper-order-card__actions">
          <span className={`pill ${Number(order.profitLossValue) >= 0 ? "pill--live" : "pill--ghost"}`}>
            {formatCurrency(order.profitLossValue)}
          </span>
          {orderEventUrl ? (
            <a href={orderEventUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
              Open market
            </a>
          ) : null}
        </div>
      </div>

      <OrderSummaryStrip items={summaryItems} />

      {isExpanded ? (
        <div className="paper-order-card__body">
          <PaperTradeHistoryChart history={order.history} />
          <PaperTradeScenarioPanel
            order={order}
            lastUpdated={lastUpdated}
            onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
          />

          <div className="paper-legs-table paper-legs-table--history">
            <div className="paper-legs-table__head">
              <span>Sub item</span>
              <span>Type</span>
              <span>Entry price</span>
              <span>Exit price</span>
              <span>Contracts</span>
              <span>Realized P&amp;L</span>
            </div>
            {order.legs.map((leg) => (
              <div key={leg.id} className="paper-legs-table__row paper-legs-table__row--history">
                <span className="paper-legs-table__label">
                  <strong>{getLegTitle(order, leg)}</strong>
                  <small>{renderLegDescriptor(leg)}</small>
                  {getLegUrl(order, leg) ? (
                    <a href={getLegUrl(order, leg)} target="_blank" rel="noreferrer">
                      {getLegUrl(order, leg)}
                    </a>
                  ) : null}
                </span>
                <span>{leg.kind === "binary" ? "Polymarket" : "Option"}</span>
                <span>{formatCurrency(leg.entryPrice, leg.kind === "binary" ? 4 : 2)}</span>
                <span>{formatCurrency(leg.currentPrice, leg.kind === "binary" ? 4 : 2)}</span>
                <span>{leg.quantity}</span>
                <span className={Number(leg.profitLossValue) >= 0 ? "positive" : "negative"}>
                  {formatCurrency(leg.profitLossValue)}
                </span>
              </div>
            ))}
          </div>

          <div className="paper-order-footer">
            <span>Bought date {formatDateLabel(order.purchaseDate)}</span>
            <span>Bought time {formatDateTimeLabel(order.createdAt)}</span>
            <span>Close time {formatDateTimeLabel(order.closedAt)}</span>
            <span>Proxy {order.valuationContext.proxySymbol || "Proxy"}</span>
            <span>Target {formatCurrency(order.valuationContext.targetUnderlyingValue)}</span>
          </div>
        </div>
      ) : null}

      <div className="paper-order-card__dock">
        <div className="paper-order-card__dock-copy">
          <span>{isExpanded ? "Expanded details" : "Collapsed by default"}</span>
          <strong>{getOrderTagLabel(order)}</strong>
        </div>
        <div className="paper-order-card__dock-actions">
          <button
            type="button"
            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggle}
            disabled={orderBusy}
          >
            {isExpanded ? "Hide details" : "View details"}
          </button>
          <button type="button" className="chart-toggle paper-order-card__close-button" onClick={handleDelete} disabled={orderBusy}>
            Remove history
          </button>
        </div>
      </div>

      {feedback ? (
        <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}
    </article>
  );
}

export default function PaperTradingWorkspace({
  paperPortfolio,
  lastUpdated,
  onUpdatePaperOrder,
  onClosePaperOrder,
  onDeletePaperOrder,
  onSaveCalculatorSnapshot
}) {
  const openOrders = paperPortfolio?.openOrders ?? paperPortfolio?.orders ?? [];
  const closedOrders = paperPortfolio?.closedOrders ?? [];
  const summary = paperPortfolio?.summary ?? {};
  const [drafts, setDrafts] = useState(() => buildDrafts(openOrders));
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [feedbackByOrder, setFeedbackByOrder] = useState({});
  const [expandedOrderKey, setExpandedOrderKey] = useState(null);

  useEffect(() => {
    setDrafts(buildDrafts(openOrders));
  }, [openOrders]);

  useEffect(() => {
    setExpandedOrderKey((current) =>
      [...openOrders, ...closedOrders].some((order) => current === `order:${order.id}`) ? current : null
    );
  }, [openOrders, closedOrders]);

  function updateDraft(orderId, updater) {
    setDrafts((current) => {
      const existing =
        current[String(orderId)] ??
        buildDefaultDraft(openOrders.find((order) => String(order.id) === String(orderId)));
      const nextDraft = updater(existing);

      return {
        ...current,
        [String(orderId)]: nextDraft
      };
    });
  }

  async function handleSave(order) {
    const draft = drafts[String(order.id)] ?? buildDefaultDraft(order);

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      await onUpdatePaperOrder(order.id, buildPatchFromDraft(order, draft));

      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "success",
          message: "Paper order updated."
        }
      }));
    } catch (error) {
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "error",
          message: error.message
        }
      }));
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleClose(order) {
    const draft = drafts[String(order.id)] ?? buildDefaultDraft(order);

    if (!window.confirm(`Close open order "${order.combinationLabel}" and move it to history?`)) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      await onClosePaperOrder(order.id, buildPatchFromDraft(order, draft));
    } catch (error) {
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "error",
          message: error.message
        }
      }));
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleDelete(order, label = "paper order") {
    if (!window.confirm(`Remove ${label} "${order.combinationLabel}"?`)) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      await onDeletePaperOrder(order.id);
    } catch (error) {
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "error",
          message: error.message
        }
      }));
    } finally {
      setBusyOrderId(null);
    }
  }

  const groupedOpenOrders = groupOrdersByStrategy(openOrders);
  const groupedClosedOrders = groupOrdersByStrategy(closedOrders);

  return (
    <main className="workspace workspace--paper-trading">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Paper trading</span>
          <h2>Holding combinations</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--ghost">{summary.openOrderCount ?? 0} open</span>
            <span className="pill pill--ghost">{summary.closedOrderCount ?? 0} closed</span>
          </div>
          <span className="timestamp">
            Manage open paper orders, then close them into history with realized P&amp;L snapshots.
          </span>
        </div>
      </header>

      <section className="paper-summary-grid">
        <article className="metric-card metric-card--amber">
          <span>Initial purchase value</span>
          <strong>{formatCurrency(summary.initialPurchaseValue)}</strong>
        </article>
        <article className="metric-card metric-card--sky">
          <span>Current holding value</span>
          <strong>{formatCurrency(summary.currentHoldingValue)}</strong>
        </article>
        <article className="metric-card metric-card--teal">
          <span>Profit / loss value</span>
          <strong className={Number(summary.profitLossValue) >= 0 ? "positive" : "negative"}>
            {formatCurrency(summary.profitLossValue)}
          </strong>
        </article>
        <article className="metric-card metric-card--rose">
          <span>Profit / loss %</span>
          <strong className={Number(summary.profitLossValue) >= 0 ? "positive" : "negative"}>
            {formatPercent(summary.profitLossPercent)}
          </strong>
        </article>
        <article className="metric-card metric-card--emerald">
          <span>Total P&amp;L for all closed orders</span>
          <strong className={Number(summary.totalClosedProfitLossValue) >= 0 ? "positive" : "negative"}>
            {formatCurrency(summary.totalClosedProfitLossValue)}
          </strong>
        </article>
      </section>

      {openOrders.length === 0 && closedOrders.length === 0 ? (
        <section className="paper-empty-state">
          <span className="brand__eyebrow">No paper trades yet</span>
          <h3>Start a new order from the strategy calculator.</h3>
          <p>
            Save a configured hedge combination from the strategy page and it will appear here with live mark-to-market tracking.
          </p>
        </section>
      ) : null}

      {openOrders.length > 0 || closedOrders.length > 0 ? (
        <section className="paper-group">
          <div className="section-heading">
            <span>Open orders</span>
            <span className="pill pill--ghost">{summary.openOrderCount ?? 0}</span>
          </div>

          {openOrders.length === 0 ? (
            <div className="paper-subempty-state">
              <strong>No open orders right now.</strong>
              <span>Closed orders stay below in history, and new paper trades can still be started from the strategy page.</span>
            </div>
          ) : (
            <div className="paper-groups">
              {groupedOpenOrders.map((group) => (
                <section key={group.id} className="paper-subgroup">
                  <div className="section-heading">
                    <span>{group.strategyName}</span>
                    <span className="pill pill--ghost">{group.orders.length} combinations</span>
                  </div>

                  <div className="paper-order-list">
                    {group.orders.map((order) => {
                      const draft = drafts[String(order.id)] ?? buildDefaultDraft(order);
                      const isDirty = hasOrderDraftChanged(order, draft);
                      const feedback = feedbackByOrder[String(order.id)];
                      const orderBusy = busyOrderId === String(order.id);
                      const orderKey = `order:${order.id}`;
                      const isExpanded = expandedOrderKey === orderKey;

                      return (
                        <OpenOrderCard
                          key={order.id}
                          order={order}
                          draft={draft}
                          isDirty={isDirty}
                          feedback={feedback}
                          orderBusy={orderBusy}
                          isExpanded={isExpanded}
                          lastUpdated={lastUpdated}
                          onToggle={() =>
                            setExpandedOrderKey((current) =>
                              current === orderKey ? null : orderKey
                            )
                          }
                          onResetDraft={() =>
                            setDrafts((current) => ({
                              ...current,
                              [String(order.id)]: buildDefaultDraft(order)
                            }))
                          }
                          onSave={() => handleSave(order)}
                          onClose={() => handleClose(order)}
                          onDelete={() => handleDelete(order, "open order")}
                          onUpdateDraft={updateDraft}
                          onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {closedOrders.length ? (
        <section className="paper-group">
          <div className="section-heading">
            <span>Closed order history</span>
            <span className="pill pill--ghost">{summary.closedOrderCount ?? 0}</span>
          </div>

          <div className="paper-groups">
            {groupedClosedOrders.map((group) => (
              <section key={group.id} className="paper-subgroup">
                <div className="section-heading">
                  <span>{group.strategyName}</span>
                  <span className="pill pill--ghost">{group.orders.length} closed</span>
                </div>

                <div className="paper-order-list">
                  {group.orders.map((order) => (
                    <ClosedOrderCard
                      key={order.id}
                      order={order}
                      isExpanded={expandedOrderKey === `order:${order.id}`}
                      lastUpdated={lastUpdated}
                      onToggle={() =>
                        setExpandedOrderKey((current) =>
                          current === `order:${order.id}` ? null : `order:${order.id}`
                        )
                      }
                      onDeletePaperOrder={onDeletePaperOrder}
                      onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                      busyOrderId={busyOrderId}
                      setBusyOrderId={setBusyOrderId}
                      setFeedbackByOrder={setFeedbackByOrder}
                      feedback={feedbackByOrder[String(order.id)]}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
