import { Fragment, useEffect, useState } from "react";
import PaperTradeHistoryChart from "./PaperTradeHistoryChart.jsx";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";
import { getIbkrGatewayLoginUrl, isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";
import { countTradingDaysBetween } from "../tradingCalendar.js";

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

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDateLabel(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(date);
}

function getTodayIsoDate() {
  const today = new Date();
  return `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
    today.getDate()
  ).padStart(2, "0")}`;
}

function formatTimeLabel(value, { includeSeconds = false } = {}) {
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
    hour: "2-digit",
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined
  }).format(date);
}

function formatDateTimeLabel(value, { includeSeconds = false } = {}) {
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
    minute: "2-digit",
    second: includeSeconds ? "2-digit" : undefined
  }).format(date);
}

function formatSignedPercentValue(value, digits = 2) {
  if (value == null || Number.isNaN(Number(value))) {
    return "n/a";
  }

  const numericValue = Number(value);
  const prefix = numericValue > 0 ? "+" : numericValue < 0 ? "-" : "";
  return `${prefix}${Math.abs(numericValue).toFixed(digits)}%`;
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
              quantity: String(leg.quantity ?? ""),
              closedPrice:
                leg.closedPrice != null
                  ? String(leg.closedPrice)
                  : String(leg.currentPrice ?? "")
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
          quantity: String(leg.quantity ?? ""),
          closedPrice:
            leg.closedPrice != null
              ? String(leg.closedPrice)
              : String(leg.currentPrice ?? "")
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
      String(legDraft.quantity ?? "") !== String(leg.quantity ?? "") ||
      (String(order.status ?? "").toLowerCase() === "closed" &&
        String(legDraft.closedPrice ?? "") !== String(leg.closedPrice ?? leg.currentPrice ?? ""))
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
  const isClosed = String(order.status ?? "").toLowerCase() === "closed";

  return {
    purchaseDate: draft.purchaseDate,
    legs: order.legs.map((leg) => ({
      id: leg.id,
      entryPrice: draft.legs?.[String(leg.id)]?.entryPrice ?? leg.entryPrice,
      quantity: draft.legs?.[String(leg.id)]?.quantity ?? leg.quantity,
      ...(isClosed
        ? {
            closedPrice:
              draft.legs?.[String(leg.id)]?.closedPrice ??
              leg.closedPrice ??
              leg.currentPrice ??
              null
          }
        : {})
    }))
  };
}

function isIbkrPaperOrder(order) {
  return String(order?.execution?.route ?? "").trim().toLowerCase() === "ibkr-paper";
}

function normalizeExecutionStatusLabel(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "n/a";
  }

  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getExecutionTone(execution) {
  const status = String(execution?.status ?? "").trim().toLowerCase();

  if (status === "filled") {
    return "positive";
  }

  if (status === "cancelled" || status === "rejected" || status === "error" || status === "inactive") {
    return "negative";
  }

  return "";
}

function getActiveExecution(order) {
  if (String(order?.status ?? "").toLowerCase() === "closed") {
    return order?.closeExecution ?? order?.execution ?? null;
  }

  if (order?.closeExecution && String(order.closeExecution.status ?? "").trim()) {
    return {
      phase: "exit",
      execution: order.closeExecution
    };
  }

  if (order?.execution) {
    return {
      phase: "entry",
      execution: order.execution
    };
  }

  return null;
}

function hasWorkingBrokerOrder(order) {
  const activeExecution = getActiveExecution(order)?.execution;
  const status = String(activeExecution?.status ?? "").trim().toLowerCase();

  return ["pending_submit", "pre_submitted", "submitted", "pending_cancel", "pre_cancelled"].includes(status);
}

function hasBrokerPosition(order) {
  return (order?.legs ?? [])
    .filter((leg) => leg?.kind === "option")
    .some((leg) => Number(leg?.quantity ?? 0) > 0);
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

function formatPurchaseDateTimeLabel(order) {
  const dateLabel = formatDateLabel(order.purchaseDate || order.createdAt?.slice(0, 10));
  const timeLabel = formatTimeLabel(order.createdAt, { includeSeconds: true });

  if (dateLabel === "n/a") {
    return timeLabel;
  }

  if (timeLabel === "n/a") {
    return dateLabel;
  }

  return `${dateLabel} ${timeLabel}`;
}

function getOrderExpirationDate(order) {
  return order.strategyCloseDate || order.polymarketResolutionDate || "";
}

function getOrderTagLabel(order) {
  return order.marketBias || order.strategyName || "Open";
}

function countTradingDaysUntil(dateValue, startValue = getTodayIsoDate()) {
  return countTradingDaysBetween(startValue, dateValue, {
    includeStart: false,
    includeEnd: true
  });
}

function getExpirationCountdown(order) {
  const expirationDate = getOrderExpirationDate(order);

  if (!expirationDate) {
    return null;
  }

  const tradingDays = countTradingDaysUntil(expirationDate);

  return {
    label: `(${tradingDays} trading day${tradingDays === 1 ? "" : "s"})`,
    tone: tradingDays < 3 ? "negative" : tradingDays < 10 ? "warning" : "positive"
  };
}

function buildPurchaseDateSummaryItem(order) {
  const timeLabel = formatTimeLabel(order.createdAt, { includeSeconds: true });

  return {
    label: "Date in",
    value: formatDateLabel(order.purchaseDate || order.createdAt?.slice(0, 10)),
    note: timeLabel === "n/a" ? "" : timeLabel
  };
}

const OPEN_ORDER_TABLE_COLUMNS = [
  { key: "holding", label: "Holding", sortable: true },
  { key: "initialCost", label: "Initial cost", sortable: true },
  { key: "dateIn", label: "Date in", sortable: true },
  { key: "expiration", label: "Expiration", sortable: true },
  { key: "asset", label: "Asset", sortable: true },
  { key: "strategyType", label: "Strategy type", sortable: true },
  { key: "tag", label: "Tag", sortable: true },
  { key: "maxProfit", label: "Max profit", sortable: true },
  { key: "maxLoss", label: "Max loss", sortable: true },
  { key: "unrealisedPnL", label: "Unrealised P&L", sortable: true },
  { key: "viewDetail", label: "View detail", sortable: false },
  { key: "orderTree", label: "Order tree", sortable: false },
  { key: "closeOrder", label: "Close order", sortable: false }
];

const OPEN_ORDER_TABLE_COLUMN_COUNT = OPEN_ORDER_TABLE_COLUMNS.length;

const CLOSED_ORDER_TABLE_COLUMNS = [
  { key: "holding", label: "Holding", sortable: true },
  { key: "dateIn", label: "Date in", sortable: true },
  { key: "closedAt", label: "Closed", sortable: true },
  { key: "asset", label: "Asset", sortable: true },
  { key: "strategyType", label: "Strategy type", sortable: true },
  { key: "tag", label: "Tag", sortable: true },
  { key: "entryValue", label: "Entry value", sortable: true },
  { key: "exitValue", label: "Exit value", sortable: true },
  { key: "realizedPnL", label: "Realized P&L", sortable: true },
  { key: "realizedPnLPercent", label: "Realized P&L %", sortable: true },
  { key: "viewDetail", label: "View detail", sortable: false },
  { key: "removeHistory", label: "Remove history", sortable: false }
];

const CLOSED_ORDER_TABLE_COLUMN_COUNT = CLOSED_ORDER_TABLE_COLUMNS.length;

function getCreatedTimePart(value) {
  const match = String(value ?? "").match(/(\d{2}:\d{2}:\d{2})/);
  return match?.[1] ?? "00:00:00";
}

function getTimestampValue(value) {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const normalizedValue =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value;
  const date = new Date(normalizedValue);

  return Number.isNaN(date.getTime()) ? Number.NEGATIVE_INFINITY : date.getTime();
}

function getPurchaseDateTimeSortValue(order) {
  const datePart = order.purchaseDate || order.createdAt?.slice(0, 10);
  if (!datePart) {
    return Number.NEGATIVE_INFINITY;
  }

  return getTimestampValue(`${datePart}T${getCreatedTimePart(order.createdAt)}Z`);
}

function getExpirationSortValue(order) {
  const expirationDate = getOrderExpirationDate(order);
  return expirationDate ? getTimestampValue(`${expirationDate}T00:00:00Z`) : Number.POSITIVE_INFINITY;
}

function getOpenOrderSortValue(order, key) {
  switch (key) {
    case "holding":
      return order.combinationLabel || "";
    case "initialCost":
      return Number(order.initialPurchaseValue ?? 0);
    case "dateIn":
      return getPurchaseDateTimeSortValue(order);
    case "expiration":
      return getExpirationSortValue(order);
    case "asset":
      return order.assetLabel || "";
    case "strategyType":
      return order.strategyType || "";
    case "tag":
      return getOrderTagLabel(order);
    case "maxProfit":
      return order.maxProfitUnbounded ? Number.POSITIVE_INFINITY : Number(order.maxProfit ?? Number.NEGATIVE_INFINITY);
    case "maxLoss":
      return Number(order.maxLoss ?? Number.POSITIVE_INFINITY);
    case "unrealisedPnL":
      return Number(order.profitLossValue ?? 0);
    default:
      return "";
  }
}

function getClosedOrderSortValue(order, key) {
  switch (key) {
    case "holding":
      return order.combinationLabel || "";
    case "dateIn":
      return getPurchaseDateTimeSortValue(order);
    case "closedAt":
      return getTimestampValue(order.closedAt || order.closedDate || "");
    case "asset":
      return order.assetLabel || "";
    case "strategyType":
      return order.strategyType || "";
    case "tag":
      return getOrderTagLabel(order);
    case "entryValue":
      return Number(order.initialPurchaseValue ?? 0);
    case "exitValue":
      return Number(order.currentHoldingValue ?? 0);
    case "realizedPnL":
      return Number(order.profitLossValue ?? 0);
    case "realizedPnLPercent":
      return Number(order.profitLossPercent ?? 0);
    default:
      return "";
  }
}

function compareSortValues(left, right) {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }

  return String(left ?? "").localeCompare(String(right ?? ""), undefined, {
    numeric: true,
    sensitivity: "base"
  });
}

function sortOrders(orders, sortConfig, getValue) {
  if (!sortConfig?.key) {
    return orders;
  }

  return [...orders].sort((left, right) => {
    const comparison = compareSortValues(
      getValue(left, sortConfig.key),
      getValue(right, sortConfig.key)
    );

    return sortConfig.direction === "desc" ? -comparison : comparison;
  });
}

function getNextSortConfig(current, key) {
  if (current.key === key) {
    return {
      key,
      direction: current.direction === "asc" ? "desc" : "asc"
    };
  }

  return {
    key,
    direction: "asc"
  };
}

function getSortIndicator(sortConfig, key) {
  if (sortConfig?.key !== key) {
    return "↕";
  }

  return sortConfig.direction === "desc" ? "↓" : "↑";
}

function SortableTableHeader({ column, sortConfig, onToggle }) {
  if (!column.sortable) {
    return column.label;
  }

  const isActive = sortConfig?.key === column.key;

  return (
    <button
      type="button"
      className={`paper-open-table__sort ${isActive ? "paper-open-table__sort--active" : ""}`}
      onClick={() => onToggle(column.key)}
    >
      <span>{column.label}</span>
      <span className="paper-open-table__sort-indicator" aria-hidden="true">
        {getSortIndicator(sortConfig, column.key)}
      </span>
    </button>
  );
}

function renderOpenOrderMetricCell(item) {
  return (
    <div className="paper-open-table__metric">
      {item.kind === "tag" ? (
        <span className={`bias-pill bias-pill--${item.tone ?? "neutral"}`}>{item.value}</span>
      ) : (
        <strong className={item.tone ?? ""}>{item.value}</strong>
      )}
      {item.note ? <small className={`paper-order-summary-note ${item.noteTone ?? ""}`}>{item.note}</small> : null}
    </div>
  );
}

function buildActiveLegRow(order, leg) {
  const proxySymbol = order.valuationContext?.proxySymbol || order.assetLabel || "Asset";
  const currentProxySpot = Number(order.valuationContext?.currentProxySpot ?? 0);
  const currentUnderlyingSpot = Number(order.valuationContext?.currentUnderlyingSpot ?? currentProxySpot);
  const targetUnderlyingValue = Number(order.valuationContext?.targetUnderlyingValue ?? 0);
  const profitLossValue = Number(leg.profitLossValue ?? NaN);
  const profitLossPercent = Number(leg.profitLossPercent ?? NaN);
  const profitLossTone =
    Number.isNaN(profitLossValue) || profitLossValue === 0 ? "" : profitLossValue > 0 ? "positive" : "negative";

  if (leg.kind === "binary") {
    return {
      id: leg.id,
      contractLabel: order.polymarketQuestion || leg.label || "Polymarket",
      contractHref: getLegUrl(order, leg),
      type: "Polymarket",
      side: leg.action === "SHORT" ? "Short" : "Long",
      sideTone: leg.action === "SHORT" ? "short" : "long",
      asset: order.assetLabel || proxySymbol,
      expiration: order.polymarketResolutionDate || order.strategyCloseDate || "n/a",
      reference: targetUnderlyingValue > 0 ? formatCurrency(targetUnderlyingValue) : "n/a",
      underlyingNow: formatCurrency(currentUnderlyingSpot || currentProxySpot),
      quantity: String(leg.quantity ?? "n/a"),
      entryPrice: formatCurrency(leg.entryPrice, 4),
      currentMark: formatCurrency(leg.currentPrice, 4),
      currentValue: formatCurrency(leg.currentExposure),
      profitLossPercent: formatSignedPercentValue(profitLossPercent),
      profitLossValue: formatCurrency(profitLossValue),
      profitLossTone
    };
  }

  const strike = Number(leg.strike ?? 0);

  return {
    id: leg.id,
    contractLabel: leg.contractSymbol || leg.label || "n/a",
    contractHref: "",
    type: "Option",
    side: leg.action === "SHORT" ? "Short" : "Long",
    sideTone: leg.action === "SHORT" ? "short" : "long",
    asset: leg.rootSymbol || order.assetLabel || proxySymbol,
    expiration: leg.expiry || order.strategyCloseDate || "n/a",
    reference: Number.isFinite(strike) && strike > 0 ? `${strike.toFixed(1)}${leg.optionType === "put" ? "P" : "C"}` : "n/a",
    underlyingNow: formatCurrency(currentProxySpot),
    quantity: String(leg.quantity ?? "n/a"),
    entryPrice: formatCurrency(leg.entryPrice),
    currentMark: formatCurrency(leg.currentPrice),
    currentValue: formatCurrency(leg.currentExposure),
    profitLossPercent: formatSignedPercentValue(profitLossPercent),
    profitLossValue: formatCurrency(profitLossValue),
    profitLossTone
  };
}

function ActiveContractsTree({ order, compact = false }) {
  if (!(order.legs ?? []).length) {
    return null;
  }

  const rows = order.legs.map((leg) => buildActiveLegRow(order, leg));

  return (
    <section className={`paper-contract-tree ${compact ? "paper-contract-tree--inline" : ""}`}>
      <div className="paper-contract-tree__table-wrap">
        <table className="paper-contract-tree__table">
          <thead>
            <tr>
              <th scope="col">Contract / market</th>
              <th scope="col">Type</th>
              <th scope="col">Side</th>
              <th scope="col">Asset</th>
              <th scope="col">Expiration</th>
              <th scope="col">Strike / target</th>
              <th scope="col">Underlying now</th>
              <th scope="col">Quantity</th>
              <th scope="col">Entry price</th>
              <th scope="col">Current mark</th>
              <th scope="col">Current value</th>
              <th scope="col">P/L%</th>
              <th scope="col">P/L</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="paper-contract-tree__name-cell">
                  {row.contractHref ? (
                    <a href={row.contractHref} target="_blank" rel="noreferrer">
                      {row.contractLabel}
                    </a>
                  ) : (
                    <span>{row.contractLabel}</span>
                  )}
                </td>
                <td>
                  <span className={`pill ${row.type === "Polymarket" ? "pill--ghost" : "pill--live"}`}>
                    {row.type}
                  </span>
                </td>
                <td>
                  <span className={`pill ${row.sideTone === "short" ? "pill--short" : "pill--long"}`}>
                    {row.side}
                  </span>
                </td>
                <td>{row.asset}</td>
                <td>{row.expiration}</td>
                <td>{row.reference}</td>
                <td>{row.underlyingNow}</td>
                <td>{row.quantity}</td>
                <td>{row.entryPrice}</td>
                <td>{row.currentMark}</td>
                <td>{row.currentValue}</td>
                <td className={row.profitLossTone}>{row.profitLossPercent}</td>
                <td className={row.profitLossTone}>{row.profitLossValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BrokerExecutionPanel({
  order,
  orderBusy,
  onRetryEntry,
  onSyncExecution,
  onCancelExecution
}) {
  if (!isIbkrPaperOrder(order)) {
    return null;
  }

  const activeExecution = getActiveExecution(order);
  const execution = activeExecution?.execution ?? order.execution ?? null;
  const statusTone = getExecutionTone(execution);
  const canRetryEntry =
    activeExecution?.phase !== "exit" &&
    ["cancelled", "rejected", "error", "inactive"].includes(String(order.execution?.status ?? "").trim().toLowerCase());

  return (
    <section className="paper-broker-panel">
      <div className="paper-broker-panel__copy">
        <span className="brand__eyebrow">IBKR paper execution</span>
        <strong>
          {activeExecution?.phase === "exit" ? "Exit order" : "Entry order"} ·{" "}
          <span className={statusTone}>{normalizeExecutionStatusLabel(execution?.status)}</span>
        </strong>
        <p>
          Account {execution?.accountId || "n/a"}
          {execution?.orderType ? ` · ${execution.orderType}` : ""}
          {execution?.tif ? ` · ${execution.tif}` : ""}
          {execution?.brokerOrderId ? ` · Order ${execution.brokerOrderId}` : ""}
        </p>
        {execution?.statusDescription ? <small>{execution.statusDescription}</small> : null}
        {execution?.lastError ? <small className="negative">{execution.lastError}</small> : null}
        {execution?.lastWarning ? <small>{execution.lastWarning}</small> : null}
      </div>

      <div className="paper-broker-panel__metrics">
        <span>Filled {execution?.filledQuantity ?? "n/a"}</span>
        <span>Remaining {execution?.remainingQuantity ?? "n/a"}</span>
        <span>
          Last sync {execution?.lastSyncAt ? formatDateTimeLabel(execution.lastSyncAt, { includeSeconds: true }) : "n/a"}
        </span>
      </div>

      <div className="paper-broker-panel__actions">
        <button type="button" className="chart-toggle" onClick={onSyncExecution} disabled={orderBusy}>
          {orderBusy ? "Working..." : "Sync broker"}
        </button>
        <button
          type="button"
          className="chart-toggle"
          onClick={onCancelExecution}
          disabled={orderBusy || !hasWorkingBrokerOrder(order)}
        >
          Cancel broker order
        </button>
        <button
          type="button"
          className="chart-toggle"
          onClick={onRetryEntry}
          disabled={orderBusy || !canRetryEntry}
        >
          Retry entry
        </button>
      </div>
    </section>
  );
}

function OpenOrderDetails({
  order,
  draft,
  isDirty,
  orderBusy,
  lastUpdated,
  onResetDraft,
  onRetryEntry,
  onSyncExecution,
  onCancelExecution,
  onSave,
  onDelete,
  onUpdateDraft,
  onSaveCalculatorSnapshot,
  theme
}) {
  return (
    <div className="paper-order-card__body paper-open-table__expanded-body">
      <PaperTradeHistoryChart history={order.history} theme={theme} />
      <PaperTradeScenarioPanel
        order={order}
        lastUpdated={lastUpdated}
        onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
        theme={theme}
      />
      <BrokerExecutionPanel
        order={order}
        orderBusy={orderBusy}
        onRetryEntry={onRetryEntry}
        onSyncExecution={onSyncExecution}
        onCancelExecution={onCancelExecution}
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
                  disabled={isIbkrPaperOrder(order) && leg.kind === "option"}
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
                  disabled={isIbkrPaperOrder(order) && leg.kind === "option"}
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
  );
}

function OpenOrderTableRows({
  order,
  draft,
  isDirty,
  feedback,
  orderBusy,
  isExpanded,
  isTreeExpanded,
  lastUpdated,
  onToggle,
  onToggleTree,
  onResetDraft,
  onRetryEntry,
  onSyncExecution,
  onCancelExecution,
  onSave,
  onClose,
  onDelete,
  onUpdateDraft,
  onSaveCalculatorSnapshot,
  theme
}) {
  const expirationDate = getOrderExpirationDate(order);
  const expirationCountdown = getExpirationCountdown(order);
  const summaryItems = [
    { label: "Initial cost", value: formatCurrency(order.initialPurchaseValue) },
    buildPurchaseDateSummaryItem(order),
    {
      label: "Expiration",
      value: formatDateLabel(expirationDate),
      note: expirationCountdown?.label ?? "",
      noteTone: expirationCountdown?.tone ?? ""
    },
    { label: "Asset", value: order.assetLabel || "n/a" },
    { label: "Strategy type", value: order.strategyType || "Custom" },
    { label: "Tag", value: getOrderTagLabel(order), kind: "tag", tone: order.marketBiasTone ?? "neutral" },
    { label: "Max profit", value: formatBoundedCurrency(order.maxProfit, order.maxProfitUnbounded) },
    { label: "Max loss", value: formatBoundedCurrency(order.maxLoss, order.maxLossUnbounded) },
    {
      label: "Unrealised P&L",
      value: formatCurrency(order.profitLossValue),
      tone: Number(order.profitLossValue) >= 0 ? "positive" : "negative"
    }
  ];

  return (
    <Fragment>
      <tr
        className={[
          "paper-open-table__row",
          isExpanded ? "paper-open-table__row--detail-open" : "",
          isTreeExpanded ? "paper-open-table__row--tree-open" : ""
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <td className="paper-open-table__cell paper-open-table__cell--holding">
          <div className="paper-open-table__holding">
            <strong>{order.combinationLabel}</strong>
            <small>Purchased {formatPurchaseDateTimeLabel(order)}</small>
          </div>
        </td>
        {summaryItems.map((item) => (
          <td key={item.label} className="paper-open-table__cell">
            {renderOpenOrderMetricCell(item)}
          </td>
        ))}
        <td className="paper-open-table__cell paper-open-table__cell--action">
          <button
            type="button"
            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggle}
            disabled={orderBusy}
          >
            {isExpanded ? "Hide details" : "View details"}
          </button>
        </td>
        <td className="paper-open-table__cell paper-open-table__cell--action">
          <button
            type="button"
            className={`chart-toggle ${isTreeExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggleTree}
            disabled={orderBusy}
          >
            {isTreeExpanded ? "Collapse order tree" : "Expand order tree"}
          </button>
        </td>
        <td className="paper-open-table__cell paper-open-table__cell--action">
          <button
            type="button"
            className="chart-toggle paper-order-card__close-button"
            onClick={onClose}
            disabled={orderBusy}
          >
            {orderBusy
              ? "Working..."
              : isIbkrPaperOrder(order)
                ? order.closeExecution
                  ? "Exit working"
                  : "Send exit order"
                : "Close order"}
          </button>
        </td>
      </tr>

      {isTreeExpanded ? (
        <tr
          className={`paper-open-table__branch-row ${isExpanded ? "paper-open-table__branch-row--detail-open" : ""}`}
        >
          <td colSpan={OPEN_ORDER_TABLE_COLUMN_COUNT}>
            <ActiveContractsTree order={order} compact />
          </td>
        </tr>
      ) : null}

      {isExpanded ? (
        <tr className="paper-open-table__detail-row">
          <td colSpan={OPEN_ORDER_TABLE_COLUMN_COUNT}>
            <div className="paper-open-table__detail">
              {feedback ? (
                <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
                  <span>{feedback.message}</span>
                </div>
              ) : null}
              <OpenOrderDetails
                order={order}
                draft={draft}
                isDirty={isDirty}
                orderBusy={orderBusy}
                lastUpdated={lastUpdated}
                onResetDraft={onResetDraft}
                onRetryEntry={onRetryEntry}
                onSyncExecution={onSyncExecution}
                onCancelExecution={onCancelExecution}
                onSave={onSave}
                onDelete={onDelete}
                onUpdateDraft={onUpdateDraft}
                onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                theme={theme}
              />
            </div>
          </td>
        </tr>
      ) : feedback ? (
        <tr className="paper-open-table__feedback-row">
          <td colSpan={OPEN_ORDER_TABLE_COLUMN_COUNT}>
            <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
              <span>{feedback.message}</span>
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

function ClosedOrderDetails({
  order,
  draft,
  isDirty,
  orderBusy,
  lastUpdated,
  onResetDraft,
  onSave,
  onDelete,
  onUpdateDraft,
  onSaveCalculatorSnapshot,
  theme
}) {
  return (
    <div className="paper-order-card__body paper-open-table__expanded-body">
      <PaperTradeHistoryChart history={order.history} theme={theme} />
      <PaperTradeScenarioPanel
        order={order}
        lastUpdated={lastUpdated}
        onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
        theme={theme}
      />

      <div className="paper-order-editbar">
        <div className="paper-order-editbar__copy">
          <span className="brand__eyebrow">Closed contract values</span>
          <p>Edit the recorded entry and exit prices to correct the realized fill marks.</p>
        </div>

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
        </div>
      </div>

      <div className="paper-legs-table paper-legs-table--history">
        <div className="paper-legs-table__head">
          <span>Sub item</span>
          <span>Type</span>
          <span>Entry price</span>
          <span>Exit price</span>
          <span>Contracts</span>
          <span>Realized P&amp;L</span>
        </div>
        {order.legs.map((leg) => {
          const legDraft = draft.legs?.[String(leg.id)] ?? {
            entryPrice: String(leg.entryPrice ?? ""),
            quantity: String(leg.quantity ?? ""),
            closedPrice:
              leg.closedPrice != null
                ? String(leg.closedPrice)
                : String(leg.currentPrice ?? "")
          };

          return (
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
              <span>
                <input
                  type="number"
                  min="0"
                  max={leg.kind === "binary" ? "1" : undefined}
                  step={leg.kind === "binary" ? "0.0001" : "0.01"}
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
                  max={leg.kind === "binary" ? "1" : undefined}
                  step={leg.kind === "binary" ? "0.0001" : "0.01"}
                  value={legDraft.closedPrice}
                  onChange={(event) =>
                    onUpdateDraft(order.id, (current) => ({
                      ...current,
                      legs: {
                        ...current.legs,
                        [String(leg.id)]: {
                          ...(current.legs?.[String(leg.id)] ?? {}),
                          closedPrice: event.target.value
                        }
                      }
                    }))
                  }
                />
              </span>
              <span>{leg.quantity}</span>
              <span className={Number(leg.profitLossValue) >= 0 ? "positive" : "negative"}>
                {formatCurrency(leg.profitLossValue)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="paper-order-footer">
        <span>Bought date {formatDateLabel(order.purchaseDate)}</span>
        <span>Bought time {formatDateTimeLabel(order.createdAt, { includeSeconds: true })}</span>
        <span>Close time {formatDateTimeLabel(order.closedAt, { includeSeconds: true })}</span>
        <span>Proxy {order.valuationContext.proxySymbol || "Proxy"}</span>
        <span>Target {formatCurrency(order.valuationContext.targetUnderlyingValue)}</span>
      </div>
    </div>
  );
}

function ClosedOrderTableRows({
  order,
  draft,
  isDirty,
  orderBusy,
  isExpanded,
  lastUpdated,
  onToggle,
  onResetDraft,
  onSave,
  onDelete,
  onUpdateDraft,
  onSaveCalculatorSnapshot,
  feedback,
  theme
}) {
  const summaryItems = [
    buildPurchaseDateSummaryItem(order),
    { label: "Closed", value: formatDateTimeLabel(order.closedAt, { includeSeconds: true }) },
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
    <Fragment>
      <tr className={`paper-open-table__row ${isExpanded ? "paper-open-table__row--expanded" : ""}`}>
        <td className="paper-open-table__cell paper-open-table__cell--holding">
          <div className="paper-open-table__holding">
            <strong>{order.combinationLabel}</strong>
            <small>
              Bought {formatPurchaseDateTimeLabel(order)} · Closed {formatDateTimeLabel(order.closedAt, { includeSeconds: true })}
            </small>
          </div>
        </td>
        {summaryItems.map((item) => (
          <td key={item.label} className="paper-open-table__cell">
            {renderOpenOrderMetricCell(item)}
          </td>
        ))}
        <td className="paper-open-table__cell paper-open-table__cell--action">
          <button
            type="button"
            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
            onClick={onToggle}
            disabled={orderBusy}
          >
            {isExpanded ? "Hide details" : "View details"}
          </button>
        </td>
        <td className="paper-open-table__cell paper-open-table__cell--action">
          <button
            type="button"
            className="chart-toggle paper-order-card__close-button"
            onClick={onDelete}
            disabled={orderBusy}
          >
            Remove history
          </button>
        </td>
      </tr>

      {isExpanded ? (
        <tr className="paper-open-table__detail-row">
          <td colSpan={CLOSED_ORDER_TABLE_COLUMN_COUNT}>
            <div className="paper-open-table__detail">
              {feedback ? (
                <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
                  <span>{feedback.message}</span>
                </div>
              ) : null}
              <ClosedOrderDetails
                order={order}
                draft={draft}
                isDirty={isDirty}
                orderBusy={orderBusy}
                lastUpdated={lastUpdated}
                onResetDraft={onResetDraft}
                onSave={onSave}
                onDelete={onDelete}
                onUpdateDraft={onUpdateDraft}
                onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                theme={theme}
              />
            </div>
          </td>
        </tr>
      ) : feedback ? (
        <tr className="paper-open-table__feedback-row">
          <td colSpan={CLOSED_ORDER_TABLE_COLUMN_COUNT}>
            <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
              <span>{feedback.message}</span>
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

export default function PaperTradingWorkspace({
  paperPortfolio,
  lastUpdated,
  onUpdatePaperOrder,
  onClosePaperOrder,
  onDeletePaperOrder,
  onSaveCalculatorSnapshot,
  onExecutePaperOrder,
  onSyncPaperExecution,
  onCancelPaperExecution,
  theme = "dark"
}) {
  const openOrders = paperPortfolio?.openOrders ?? paperPortfolio?.orders ?? [];
  const closedOrders = paperPortfolio?.closedOrders ?? [];
  const allOrders = [...openOrders, ...closedOrders];
  const summary = paperPortfolio?.summary ?? {};
  const ibkrStatus = paperPortfolio?.brokerStatus?.ibkr ?? null;
  const ibkrReady = isIbkrReady(ibkrStatus);
  const ibkrReloginNeeded = isIbkrReloginNeeded(ibkrStatus);
  const ibkrLoginUrl = getIbkrGatewayLoginUrl();
  const [drafts, setDrafts] = useState(() => buildDrafts(allOrders));
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [feedbackByOrder, setFeedbackByOrder] = useState({});
  const [expandedOrderKey, setExpandedOrderKey] = useState(null);
  const [expandedTreeOrderIds, setExpandedTreeOrderIds] = useState([]);
  const [openSortConfig, setOpenSortConfig] = useState({ key: null, direction: "asc" });
  const [closedSortConfig, setClosedSortConfig] = useState({ key: null, direction: "asc" });

  useEffect(() => {
    setDrafts(buildDrafts(allOrders));
  }, [openOrders, closedOrders]);

  useEffect(() => {
    setExpandedOrderKey((current) =>
      [...openOrders, ...closedOrders].some((order) => current === `order:${order.id}`) ? current : null
    );
  }, [openOrders, closedOrders]);

  useEffect(() => {
    const validOpenIds = new Set((openOrders ?? []).map((order) => String(order.id)));
    setExpandedTreeOrderIds((current) => current.filter((orderId) => validOpenIds.has(String(orderId))));
  }, [openOrders]);

  function updateDraft(orderId, updater) {
    setDrafts((current) => {
      const existing =
        current[String(orderId)] ??
        buildDefaultDraft(allOrders.find((order) => String(order.id) === String(orderId)));
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

    if (
      !window.confirm(
        isIbkrPaperOrder(order)
          ? `Send an IBKR paper exit order for "${order.combinationLabel}"? The order will move to history after the broker exit fills.`
          : `Close open order "${order.combinationLabel}" and move it to history?`
      )
    ) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      const payload = await onClosePaperOrder(order.id, buildPatchFromDraft(order, draft));

      if (isIbkrPaperOrder(order) && payload?.message) {
        setFeedbackByOrder((current) => ({
          ...current,
          [String(order.id)]: {
            tone: "success",
            message: payload.message
          }
        }));
      }
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

  async function handleRetryEntry(order) {
    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      const payload = await onExecutePaperOrder(order.id, {
        purpose: "entry"
      });
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "success",
          message: payload?.message ?? "IBKR paper entry order submitted."
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

  async function handleSyncExecution(order) {
    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      const payload = await onSyncPaperExecution(order.id);
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "success",
          message: payload?.message ?? "Broker execution synced."
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

  async function handleCancelExecution(order) {
    if (!window.confirm(`Cancel the active IBKR paper order for "${order.combinationLabel}"?`)) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      const payload = await onCancelPaperExecution(order.id);
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "success",
          message: payload?.message ?? "Cancel request sent to IBKR."
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
            {ibkrReady
              ? "Manage local paper orders, or sync IBKR paper fills and exit orders without leaving HedgeHub."
              : ibkrReloginNeeded
                ? (
                    <>
                      IBKR session expired or was signed out. Re-login at{" "}
                      <a href={ibkrLoginUrl} target="_blank" rel="noreferrer">
                        {ibkrLoginUrl}
                      </a>{" "}
                      and HedgeHub should reconnect within a few seconds.
                    </>
                  )
                : "Manage open paper orders, then close them into history with realized P&L snapshots."}
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

                  <div className="paper-open-table-wrap">
                    <table className="paper-open-table">
                      <thead>
                        <tr>
                          {OPEN_ORDER_TABLE_COLUMNS.map((column) => (
                            <th key={column.key} scope="col">
                              <SortableTableHeader
                                column={column}
                                sortConfig={openSortConfig}
                                onToggle={(key) =>
                                  setOpenSortConfig((current) => getNextSortConfig(current, key))
                                }
                              />
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortOrders(group.orders, openSortConfig, getOpenOrderSortValue).map((order) => {
                          const draft = drafts[String(order.id)] ?? buildDefaultDraft(order);
                          const isDirty = hasOrderDraftChanged(order, draft);
                          const feedback = feedbackByOrder[String(order.id)];
                          const orderBusy = busyOrderId === String(order.id);
                          const orderKey = `order:${order.id}`;
                          const isExpanded = expandedOrderKey === orderKey;
                          const isTreeExpanded = expandedTreeOrderIds.includes(String(order.id));

                          return (
                            <OpenOrderTableRows
                              key={order.id}
                              order={order}
                              draft={draft}
                              isDirty={isDirty}
                              feedback={feedback}
                              orderBusy={orderBusy}
                              isExpanded={isExpanded}
                              isTreeExpanded={isTreeExpanded}
                              lastUpdated={lastUpdated}
                              onToggle={() =>
                                setExpandedOrderKey((current) =>
                                  current === orderKey ? null : orderKey
                                )
                              }
                              onToggleTree={() =>
                                setExpandedTreeOrderIds((current) =>
                                  current.includes(String(order.id))
                                    ? current.filter((orderId) => orderId !== String(order.id))
                                    : [...current, String(order.id)]
                                )
                              }
                              onResetDraft={() =>
                                setDrafts((current) => ({
                                  ...current,
                                  [String(order.id)]: buildDefaultDraft(order)
                                }))
                              }
                              onRetryEntry={() => handleRetryEntry(order)}
                              onSyncExecution={() => handleSyncExecution(order)}
                              onCancelExecution={() => handleCancelExecution(order)}
                              onSave={() => handleSave(order)}
                              onClose={() => handleClose(order)}
                              onDelete={() => handleDelete(order, "open order")}
                              onUpdateDraft={updateDraft}
                              onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                              theme={theme}
                            />
                          );
                        })}
                      </tbody>
                    </table>
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

                <div className="paper-open-table-wrap">
                  <table className="paper-open-table">
                    <thead>
                      <tr>
                        {CLOSED_ORDER_TABLE_COLUMNS.map((column) => (
                          <th key={column.key} scope="col">
                            <SortableTableHeader
                              column={column}
                              sortConfig={closedSortConfig}
                              onToggle={(key) =>
                                setClosedSortConfig((current) => getNextSortConfig(current, key))
                              }
                            />
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortOrders(group.orders, closedSortConfig, getClosedOrderSortValue).map((order) => {
                        const draft = drafts[String(order.id)] ?? buildDefaultDraft(order);
                        const isDirty = hasOrderDraftChanged(order, draft);
                        const orderBusy = busyOrderId === String(order.id);

                        return (
                          <ClosedOrderTableRows
                            key={order.id}
                            order={order}
                            draft={draft}
                            isDirty={isDirty}
                            orderBusy={orderBusy}
                            isExpanded={expandedOrderKey === `order:${order.id}`}
                            lastUpdated={lastUpdated}
                            onToggle={() =>
                              setExpandedOrderKey((current) =>
                                current === `order:${order.id}` ? null : `order:${order.id}`
                              )
                            }
                            onResetDraft={() =>
                              setDrafts((current) => ({
                                ...current,
                                [String(order.id)]: buildDefaultDraft(order)
                              }))
                            }
                            onSave={() => handleSave(order)}
                            onDelete={() => handleDelete(order, "closed order")}
                            onUpdateDraft={updateDraft}
                            onSaveCalculatorSnapshot={onSaveCalculatorSnapshot}
                            feedback={feedbackByOrder[String(order.id)]}
                            theme={theme}
                          />
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
