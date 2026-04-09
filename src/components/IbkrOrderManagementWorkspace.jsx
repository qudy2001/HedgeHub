import { Fragment, useEffect, useState } from "react";
import { getIbkrGatewayLoginUrl, isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";

const WORKING_EXECUTION_STATUSES = new Set([
  "pending_submit",
  "pre_submitted",
  "submitted",
  "pending_cancel",
  "pre_cancelled",
  "warn_state"
]);
const NEGATIVE_EXECUTION_STATUSES = new Set(["cancelled", "rejected", "error", "inactive"]);
const ORDER_FILTERS = [
  { id: "all", label: "All orders" },
  { id: "pending", label: "Pending" },
  { id: "open", label: "Open positions" },
  { id: "closed", label: "Closed" },
  { id: "cancelled", label: "Cancelled / failed" }
];

function normalizeStatus(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

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

function formatTimestamp(value) {
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

function normalizeExecutionStatusLabel(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "n/a";
  }

  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function isIbkrExecution(execution) {
  return String(execution?.route ?? "").trim().toLowerCase() === "ibkr-paper";
}

function getSmartExecution(order) {
  return order?.execution?.smart ?? null;
}

function normalizeSmartStatusLabel(value, enabled = false) {
  if (enabled !== true) {
    return "Disabled";
  }

  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return "Watching";
  }

  return normalized
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function getSmartStatusTone(smartExecution) {
  const status = String(smartExecution?.status ?? "").trim().toLowerCase();
  if (smartExecution?.enabled !== true) {
    return "";
  }

  if (status === "watching") {
    return "positive";
  }

  if (status === "pending_replace") {
    return "warning";
  }

  if (status === "paused") {
    return "negative";
  }

  return "";
}

function hasExecutionSignature(execution) {
  if (!execution || typeof execution !== "object") {
    return false;
  }

  return [
    execution.status,
    execution.submittedAt,
    execution.lastSyncAt,
    execution.filledAt,
    execution.cancelledAt,
    execution.brokerOrderId,
    execution.orderRef,
    execution.pendingReplyId
  ].some((value) => String(value ?? "").trim());
}

function getExecutionRecords(order) {
  const records = [];

  if (hasExecutionSignature(order?.execution)) {
    records.push({
      phase: "entry",
      execution: order.execution
    });
  }

  if (hasExecutionSignature(order?.closeExecution)) {
    records.push({
      phase: "exit",
      execution: order.closeExecution
    });
  }

  return records;
}

function getExecutionActivityTimestamp(execution) {
  return Math.max(
    formatTimestamp(execution?.cancelledAt),
    formatTimestamp(execution?.filledAt),
    formatTimestamp(execution?.lastSyncAt),
    formatTimestamp(execution?.submittedAt)
  );
}

function getLatestActivityTimestamp(order) {
  return Math.max(
    formatTimestamp(order?.closedAt),
    formatTimestamp(order?.updatedAt),
    ...getExecutionRecords(order).map((record) => getExecutionActivityTimestamp(record.execution))
  );
}

function getLatestExecutionRecord(order) {
  const records = [...getExecutionRecords(order)];
  records.sort(
    (left, right) =>
      getExecutionActivityTimestamp(right.execution) - getExecutionActivityTimestamp(left.execution)
  );
  return records[0] ?? null;
}

function isPendingConfirmation(execution) {
  return (
    normalizeStatus(execution?.status) === "pending_confirmation" &&
    String(execution?.pendingReplyId ?? "").trim().length > 0
  );
}

function isWorkingExecution(execution) {
  return WORKING_EXECUTION_STATUSES.has(normalizeStatus(execution?.status));
}

function isNegativeExecution(execution) {
  return NEGATIVE_EXECUTION_STATUSES.has(normalizeStatus(execution?.status));
}

function isFilledExecution(execution) {
  return normalizeStatus(execution?.status) === "filled";
}

function isClosedOrder(order) {
  return order?.isClosed === true || normalizeStatus(order?.status) === "closed";
}

function hasOpenPosition(order) {
  if (isClosedOrder(order)) {
    return false;
  }

  if (!isIbkrExecution(order?.execution)) {
    return true;
  }

  if (isFilledExecution(order?.execution)) {
    return true;
  }

  return hasExecutionSignature(order?.closeExecution);
}

function getWorkingExecutionRecord(order) {
  const records = getExecutionRecords(order).filter(
    (record) => isPendingConfirmation(record.execution) || isWorkingExecution(record.execution)
  );

  records.sort(
    (left, right) =>
      getExecutionActivityTimestamp(right.execution) - getExecutionActivityTimestamp(left.execution)
  );

  return records[0] ?? null;
}

function getNegativeExecutionRecord(order) {
  const records = getExecutionRecords(order).filter((record) => isNegativeExecution(record.execution));

  records.sort(
    (left, right) =>
      getExecutionActivityTimestamp(right.execution) - getExecutionActivityTimestamp(left.execution)
  );

  return records[0] ?? null;
}

function isPendingOrder(order) {
  return Boolean(getWorkingExecutionRecord(order));
}

function hasCancelledLifecycle(order) {
  return Boolean(getNegativeExecutionRecord(order));
}

function isIbkrManagedOrder(order) {
  return getExecutionRecords(order).some((record) => isIbkrExecution(record.execution));
}

function getLifecycleBadgeTone(tone) {
  if (tone === "warning") {
    return "pill--warning";
  }

  if (tone === "negative") {
    return "pill--short";
  }

  if (tone === "positive") {
    return "pill--live";
  }

  return "pill--ghost";
}

function getPrimaryLifecycle(order) {
  if (isClosedOrder(order)) {
    return {
      label: "Closed",
      tone: "neutral"
    };
  }

  const workingExecution = getWorkingExecutionRecord(order);
  if (workingExecution) {
    return {
      label: workingExecution.phase === "exit" ? "Pending exit" : "Pending entry",
      tone: "warning"
    };
  }

  const negativeExecution = getNegativeExecutionRecord(order);
  if (negativeExecution) {
    return {
      label:
        negativeExecution.phase === "exit"
          ? `Exit ${normalizeExecutionStatusLabel(negativeExecution.execution?.status)}`
          : normalizeExecutionStatusLabel(negativeExecution.execution?.status),
      tone: "negative"
    };
  }

  if (hasOpenPosition(order)) {
    return {
      label: "Open position",
      tone: "positive"
    };
  }

  return {
    label: "Local paper",
    tone: "neutral"
  };
}

function getLifecycleBadges(order) {
  const badges = [getPrimaryLifecycle(order)];

  if (!isClosedOrder(order) && hasOpenPosition(order) && badges[0].label !== "Open position") {
    badges.push({
      label: "Position open",
      tone: "positive"
    });
  }

  if (isPendingConfirmation(getWorkingExecutionRecord(order)?.execution)) {
    badges.push({
      label: "Confirm",
      tone: "warning"
    });
  }

  return badges;
}

function getPrimaryExecutionRecord(order) {
  return getWorkingExecutionRecord(order) ?? getLatestExecutionRecord(order);
}

function getExecutionLabel(record) {
  if (!record?.execution) {
    return "Local paper";
  }

  return `${record.phase === "exit" ? "Exit" : "Entry"} · ${
    isIbkrExecution(record.execution) ? "IBKR paper" : "Local paper"
  }`;
}

function getFillLabel(execution) {
  if (!execution) {
    return "Local paper tracking";
  }

  const filledQuantity = execution.filledQuantity;
  const totalQuantity = execution.totalQuantity;
  const remainingQuantity = execution.remainingQuantity;

  if (filledQuantity != null || totalQuantity != null) {
    return `Filled ${filledQuantity ?? 0} / ${totalQuantity ?? "n/a"}${
      remainingQuantity != null ? ` · Remaining ${remainingQuantity}` : ""
    }`;
  }

  return execution.orderType ? `${execution.orderType}${execution.tif ? ` · ${execution.tif}` : ""}` : "No fill data";
}

function getActivitySummary(order) {
  const primaryExecution = getPrimaryExecutionRecord(order);
  const execution = primaryExecution?.execution ?? null;
  const filledAt = execution?.filledAt ? formatDateTimeLabel(execution.filledAt, { includeSeconds: true }) : "n/a";
  const cancelledAt =
    execution?.cancelledAt ? formatDateTimeLabel(execution.cancelledAt, { includeSeconds: true }) : "n/a";

  if (isClosedOrder(order)) {
    return {
      title: `Closed ${formatDateTimeLabel(order.closedAt, { includeSeconds: true })}`,
      detail: execution?.filledAt ? `Broker fill ${filledAt}` : "Recorded in order history"
    };
  }

  if (isPendingConfirmation(execution)) {
    return {
      title: "Broker confirmation needed",
      detail: execution?.lastWarning || "IBKR is waiting for a confirmation reply"
    };
  }

  if (isWorkingExecution(execution)) {
    return {
      title: execution?.submittedAt
        ? `Submitted ${formatDateTimeLabel(execution.submittedAt, { includeSeconds: true })}`
        : "Working at broker",
      detail: execution?.lastSyncAt
        ? `Last sync ${formatDateTimeLabel(execution.lastSyncAt, { includeSeconds: true })}`
        : "Waiting for the next broker sync"
    };
  }

  if (isNegativeExecution(execution)) {
    return {
      title: `${normalizeExecutionStatusLabel(execution?.status)} ${cancelledAt !== "n/a" ? cancelledAt : ""}`.trim(),
      detail: execution?.lastError || execution?.statusDescription || "Broker order is no longer active"
    };
  }

  if (hasOpenPosition(order)) {
    return {
      title: order?.purchaseDate ? `Opened ${order.purchaseDate}` : "Open position",
      detail:
        execution?.filledAt
          ? `Broker fill ${filledAt}`
          : order?.updatedAt
            ? `Updated ${formatDateTimeLabel(order.updatedAt, { includeSeconds: true })}`
            : "Tracking live mark-to-market"
    };
  }

  return {
    title: "Awaiting lifecycle update",
    detail: execution?.lastSyncAt
      ? `Last sync ${formatDateTimeLabel(execution.lastSyncAt, { includeSeconds: true })}`
      : "No broker activity yet"
  };
}

function getStrategyRelationshipCopy(order) {
  const strategyName = order?.strategyName || "Strategy";
  const negativeExecution = getNegativeExecutionRecord(order);

  if (isClosedOrder(order)) {
    return `Closed order linked to ${strategyName}.`;
  }

  if (negativeExecution?.phase === "exit" && hasOpenPosition(order)) {
    return `Exit attempt is still linked to ${strategyName}; the underlying position remains open.`;
  }

  if (negativeExecution?.phase === "entry") {
    return `Entry lifecycle is still linked to ${strategyName}, even though the broker order was not completed.`;
  }

  if (isPendingOrder(order)) {
    return `Pending broker workflow for ${strategyName}.`;
  }

  return `Live position opened from ${strategyName}.`;
}

function getLegDescriptor(leg) {
  if (leg.kind === "binary") {
    return `${leg.action} ${leg.outcome}`;
  }

  return `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}${leg.optionType === "put" ? "P" : "C"} ${leg.expiry}`;
}

function getLegLink(order, leg) {
  if (leg.kind !== "binary") {
    return "";
  }

  const normalizedUrl = String(order?.polymarketUrl ?? "").trim();
  return normalizedUrl.startsWith("https://polymarket.com/event/") ? normalizedUrl : "";
}

function getLegTitle(order, leg) {
  if (leg.kind === "binary") {
    return order?.polymarketQuestion || leg.label || "Polymarket";
  }

  return leg?.contractSymbol || leg?.label || "Option";
}

function buildStrategyOptions(orders) {
  const grouped = new Map();

  (orders ?? []).forEach((order) => {
    const key = String(order?.strategyId ?? "strategy");
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        label: order?.strategyName || "Strategy",
        count: 0
      });
    }

    grouped.get(key).count += 1;
  });

  return [...grouped.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, {
      sensitivity: "base"
    })
  );
}

function orderMatchesFilter(order, filterId) {
  switch (filterId) {
    case "pending":
      return isPendingOrder(order);
    case "open":
      return hasOpenPosition(order);
    case "closed":
      return isClosedOrder(order);
    case "cancelled":
      return hasCancelledLifecycle(order);
    default:
      return true;
  }
}

function filterCount(orders, filterId) {
  return (orders ?? []).filter((order) => orderMatchesFilter(order, filterId)).length;
}

function sumProfitLoss(orders) {
  return (orders ?? []).reduce((sum, order) => sum + (Number(order?.profitLossValue ?? 0) || 0), 0);
}

function getDisplayedHoldingValue(order) {
  if (isClosedOrder(order) || hasOpenPosition(order)) {
    return formatCurrency(order.currentHoldingValue);
  }

  return "n/a";
}

function getDisplayedProfitLoss(order) {
  if (isClosedOrder(order) || hasOpenPosition(order)) {
    return {
      value: formatCurrency(order.profitLossValue),
      percent: formatPercent(order.profitLossPercent),
      tone: Number(order.profitLossValue) >= 0 ? "positive" : "negative"
    };
  }

  return {
    value: "Awaiting fill",
    percent: "No live P&L yet",
    tone: ""
  };
}

function canSyncExecution(order) {
  return getExecutionRecords(order).some((record) => isIbkrExecution(record.execution));
}

function canCancelExecution(order) {
  const workingExecution = getWorkingExecutionRecord(order);

  return Boolean(
    workingExecution &&
      isIbkrExecution(workingExecution.execution) &&
      String(workingExecution.execution?.brokerOrderId ?? "").trim()
  );
}

function canRetryEntry(order) {
  return !isClosedOrder(order) && isIbkrExecution(order?.execution) && isNegativeExecution(order?.execution);
}

function OrderFilterButton({ active, label, count, onClick }) {
  return (
    <button
      type="button"
      className={`chart-toggle chart-toggle--compact ${active ? "chart-toggle--active" : ""}`}
      onClick={onClick}
    >
      {label} <span className="order-desk__filter-count">{count}</span>
    </button>
  );
}

function ContractTree({ order }) {
  if (!(order?.legs ?? []).length) {
    return null;
  }

  return (
    <section className="paper-contract-tree paper-contract-tree--inline order-desk__contract-tree">
      <div className="paper-contract-tree__table-wrap">
        <table className="paper-contract-tree__table">
          <thead>
            <tr>
              <th scope="col">Contract / market</th>
              <th scope="col">Descriptor</th>
              <th scope="col">Type</th>
              <th scope="col">Quantity</th>
              <th scope="col">Entry</th>
              <th scope="col">{isClosedOrder(order) ? "Exit" : "Current"}</th>
              <th scope="col">Value</th>
              <th scope="col">P&amp;L</th>
            </tr>
          </thead>
          <tbody>
            {(order.legs ?? []).map((leg) => {
              const legHref = getLegLink(order, leg);
              const legPnL = Number(leg?.profitLossValue ?? 0);

              return (
                <tr key={leg.id}>
                  <td className="paper-contract-tree__name-cell">
                    {legHref ? (
                      <a href={legHref} target="_blank" rel="noreferrer">
                        {getLegTitle(order, leg)}
                      </a>
                    ) : (
                      <span>{getLegTitle(order, leg)}</span>
                    )}
                  </td>
                  <td>{getLegDescriptor(leg)}</td>
                  <td>{leg.kind === "binary" ? "Polymarket" : "Option"}</td>
                  <td>{leg.quantity ?? "n/a"}</td>
                  <td>{formatCurrency(leg.entryPrice, leg.kind === "binary" ? 4 : 2)}</td>
                  <td>{formatCurrency(leg.currentPrice, leg.kind === "binary" ? 4 : 2)}</td>
                  <td>{formatCurrency(leg.currentExposure)}</td>
                  <td className={legPnL >= 0 ? "positive" : "negative"}>{formatCurrency(legPnL)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OrderDetailPanel({
  order,
  orderBusy,
  feedback,
  onOpenStrategy,
  onOpenPaperTrading,
  onSyncExecution,
  onCancelExecution,
  onRetryEntry,
  onRespondExecutionConfirmation,
  onToggleSmartExecution
}) {
  const primaryExecution = getPrimaryExecutionRecord(order);
  const execution = primaryExecution?.execution ?? null;
  const smartExecution = primaryExecution?.phase === "entry" ? getSmartExecution(order) : null;
  const smartAvailable =
    primaryExecution?.phase !== "exit" && String(execution?.orderType ?? "").trim().toUpperCase() === "LMT";
  const smartEnabled = smartExecution?.enabled === true;
  const smartStatusTone = getSmartStatusTone(smartExecution);
  const lifecycle = getPrimaryLifecycle(order);
  const pendingConfirmation = isPendingConfirmation(getWorkingExecutionRecord(order)?.execution);
  const displayedProfitLoss = getDisplayedProfitLoss(order);

  return (
    <div className="order-desk__detail-panel">
      <div className="order-desk__detail-head">
        <div className="order-desk__detail-copy">
          <span className="brand__eyebrow">Strategy relationship</span>
          <h3>{order.strategyName || "Strategy"}</h3>
          <p>{getStrategyRelationshipCopy(order)}</p>
        </div>

        <div className="order-desk__detail-actions">
          <button type="button" className="chart-toggle" onClick={() => onOpenStrategy(order.strategyId || "strategy-1")}>
            Open strategy
          </button>
          <button type="button" className="chart-toggle" onClick={onOpenPaperTrading}>
            Open paper trading
          </button>
          {canSyncExecution(order) ? (
            <button type="button" className="chart-toggle" onClick={onSyncExecution} disabled={orderBusy}>
              {orderBusy ? "Working..." : "Sync broker"}
            </button>
          ) : null}
          {pendingConfirmation && onRespondExecutionConfirmation ? (
            <button
              type="button"
              className="chart-toggle"
              onClick={() => onRespondExecutionConfirmation(true)}
              disabled={orderBusy}
            >
              {orderBusy ? "Working..." : "Submit anyway"}
            </button>
          ) : null}
          {pendingConfirmation && onRespondExecutionConfirmation ? (
            <button
              type="button"
              className="chart-toggle"
              onClick={() => onRespondExecutionConfirmation(false)}
              disabled={orderBusy}
            >
              Decline
            </button>
          ) : null}
          {canCancelExecution(order) ? (
            <button type="button" className="chart-toggle" onClick={onCancelExecution} disabled={orderBusy}>
              Cancel broker order
            </button>
          ) : null}
          {canRetryEntry(order) ? (
            <button type="button" className="chart-toggle" onClick={onRetryEntry} disabled={orderBusy}>
              Retry entry
            </button>
          ) : null}
          {smartAvailable && onToggleSmartExecution ? (
            <button
              type="button"
              className={`chart-toggle ${smartEnabled ? "chart-toggle--active" : ""}`}
              onClick={onToggleSmartExecution}
              disabled={orderBusy || pendingConfirmation}
            >
              {smartEnabled ? "Disable smart entry" : "Enable smart entry"}
            </button>
          ) : null}
        </div>
      </div>

      {feedback ? (
        <div className={`refresh-feedback refresh-feedback--${feedback.tone}`}>
          <span>{feedback.message}</span>
        </div>
      ) : null}

      <section className="paper-order-metrics order-desk__detail-grid">
        <article className="paper-order-metric">
          <span>Lifecycle</span>
          <strong>{lifecycle.label}</strong>
          <small>{getExecutionLabel(primaryExecution)}</small>
        </article>
        <article className="paper-order-metric">
          <span>Strategy / asset</span>
          <strong>{order.assetLabel || "n/a"}</strong>
          <small>{order.strategyType || order.strategyName || "Strategy"}</small>
        </article>
        <article className="paper-order-metric">
          <span>{isClosedOrder(order) ? "Realized P&L" : "Unrealized P&L"}</span>
          <strong className={displayedProfitLoss.tone}>{displayedProfitLoss.value}</strong>
          <small>{displayedProfitLoss.percent}</small>
        </article>
        <article className="paper-order-metric">
          <span>Exposure</span>
          <strong>{formatCurrency(order.initialPurchaseValue)}</strong>
          <small>
            {isClosedOrder(order) ? "Exit value" : "Current value"} {getDisplayedHoldingValue(order)}
          </small>
        </article>
      </section>

      <section className="order-desk__execution-grid">
        <article className="paper-order-metric order-desk__execution-card">
          <span>Broker status</span>
          <strong>{normalizeExecutionStatusLabel(execution?.status ?? (isClosedOrder(order) ? "closed" : "local"))}</strong>
          <small>{execution?.statusDescription || execution?.lastError || execution?.lastWarning || "No broker warnings"}</small>
        </article>
        {smartAvailable ? (
          <article className="paper-order-metric order-desk__execution-card">
            <span>Smart entry</span>
            <strong className={smartStatusTone}>{normalizeSmartStatusLabel(smartExecution?.status, smartEnabled)}</strong>
            <small>{smartExecution?.lastDecisionReason || "Conservative stale-limit monitoring is ready for this order."}</small>
          </article>
        ) : null}
        <article className="paper-order-metric order-desk__execution-card">
          <span>Account / refs</span>
          <strong>{execution?.accountId || "n/a"}</strong>
          <small>{execution?.orderRef ? `Ref ${execution.orderRef}` : "No order ref"}</small>
          <small>{execution?.brokerOrderId ? `Broker order ${execution.brokerOrderId}` : "No broker order id"}</small>
        </article>
        <article className="paper-order-metric order-desk__execution-card">
          <span>Submitted / sync</span>
          <strong>{execution?.submittedAt ? formatDateTimeLabel(execution.submittedAt, { includeSeconds: true }) : "n/a"}</strong>
          <small>
            {execution?.lastSyncAt
              ? `Last sync ${formatDateTimeLabel(execution.lastSyncAt, { includeSeconds: true })}`
              : "No broker sync yet"}
          </small>
        </article>
        <article className="paper-order-metric order-desk__execution-card">
          <span>Profit window</span>
          <strong>{formatCurrency(order.maxProfit)}</strong>
          <small>
            Max loss {order.maxLoss != null ? formatCurrency(order.maxLoss) : "n/a"}
            {order.maxProfitUnbounded === true ? " · Profit unbounded" : ""}
            {order.maxLossUnbounded === true ? " · Loss unbounded" : ""}
          </small>
        </article>
      </section>

      <ContractTree order={order} />
    </div>
  );
}

export default function IbkrOrderManagementWorkspace({
  paperPortfolio,
  lastUpdated,
  onUpdatePaperOrder,
  onExecutePaperOrder,
  onConfirmPaperExecution = null,
  onSyncPaperExecution,
  onCancelPaperExecution,
  onOpenStrategy,
  onOpenPaperTrading
}) {
  const hasLoadedOrders =
    Array.isArray(paperPortfolio?.openOrders) ||
    Array.isArray(paperPortfolio?.closedOrders) ||
    Array.isArray(paperPortfolio?.orders);
  const openOrders = paperPortfolio?.openOrders ?? paperPortfolio?.orders ?? [];
  const closedOrders = paperPortfolio?.closedOrders ?? [];
  const allOrders = [...openOrders, ...closedOrders];
  const ibkrStatus = paperPortfolio?.brokerStatus?.ibkr ?? null;
  const ibkrReady = isIbkrReady(ibkrStatus);
  const ibkrReloginNeeded = isIbkrReloginNeeded(ibkrStatus);
  const ibkrLoginUrl = getIbkrGatewayLoginUrl();
  const [scope, setScope] = useState("ibkr");
  const [selectedFilter, setSelectedFilter] = useState("all");
  const [selectedStrategyId, setSelectedStrategyId] = useState("all");
  const [expandedOrderId, setExpandedOrderId] = useState(null);
  const [busyOrderId, setBusyOrderId] = useState(null);
  const [feedbackByOrder, setFeedbackByOrder] = useState({});
  const hasIbkrOrders = allOrders.some((order) => isIbkrManagedOrder(order));

  useEffect(() => {
    if (scope === "ibkr" && !hasIbkrOrders && allOrders.length) {
      setScope("all");
    }
  }, [allOrders.length, hasIbkrOrders, scope]);

  const scopedOrders = allOrders.filter((order) => (scope === "all" ? true : isIbkrManagedOrder(order)));
  const strategyOptions = buildStrategyOptions(scopedOrders);

  useEffect(() => {
    if (selectedStrategyId !== "all" && !strategyOptions.some((strategy) => strategy.id === selectedStrategyId)) {
      setSelectedStrategyId("all");
    }
  }, [selectedStrategyId, strategyOptions]);

  const visibleOrders = [...scopedOrders]
    .filter((order) => orderMatchesFilter(order, selectedFilter))
    .filter((order) => selectedStrategyId === "all" || String(order.strategyId) === selectedStrategyId)
    .sort((left, right) => getLatestActivityTimestamp(right) - getLatestActivityTimestamp(left));
  const pendingOrders = scopedOrders.filter((order) => isPendingOrder(order));
  const openPositions = scopedOrders.filter((order) => hasOpenPosition(order));
  const closedHistory = scopedOrders.filter((order) => isClosedOrder(order));
  const cancelledOrders = scopedOrders.filter((order) => hasCancelledLifecycle(order));

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

  async function handleToggleSmartExecution(order) {
    if (typeof onUpdatePaperOrder !== "function") {
      return;
    }

    const currentSmart = getSmartExecution(order) ?? {};
    const nextEnabled = currentSmart.enabled !== true;

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      await onUpdatePaperOrder(order.id, {
        execution: {
          smart: {
            ...currentSmart,
            enabled: nextEnabled,
            status: nextEnabled ? "watching" : "disabled",
            pendingLimitPrice: null,
            lastDecision: nextEnabled ? "armed" : "disabled",
            lastDecisionReason: nextEnabled
              ? "Smart pricing enabled. HedgeHub will monitor this entry order and reprice stale limits conservatively."
              : "Smart pricing disabled by user."
          }
        }
      });

      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: "success",
          message: nextEnabled ? "Smart entry enabled for this order." : "Smart entry disabled for this order."
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

  async function handleRespondExecutionConfirmation(order, confirmed) {
    if (!onConfirmPaperExecution) {
      return;
    }

    setBusyOrderId(String(order.id));
    setFeedbackByOrder((current) => ({
      ...current,
      [String(order.id)]: null
    }));

    try {
      const payload = await onConfirmPaperExecution(order.id, {
        confirmed
      });
      setFeedbackByOrder((current) => ({
        ...current,
        [String(order.id)]: {
          tone: confirmed === true ? "success" : "warning",
          message:
            payload?.message ??
            (confirmed === true ? "Broker confirmation sent." : "Broker confirmation declined.")
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

  return (
    <main className="workspace workspace--order-management">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">IBKR order management</span>
          <h2>Execution blotter</h2>
        </div>

        <div className="status-block">
          <div className="status-block__actions order-desk__header-actions">
            <button type="button" className="chart-toggle" onClick={onOpenPaperTrading}>
              Open paper trading
            </button>
            <span className={`pill ${ibkrReady ? "pill--live" : ibkrReloginNeeded ? "pill--warning" : "pill--ghost"}`}>
              {ibkrReady
                ? `IBKR ready${ibkrStatus?.selectedAccount ? ` · ${ibkrStatus.selectedAccount}` : ""}`
                : ibkrReloginNeeded
                  ? "IBKR relogin required"
                  : "Local order view"}
            </span>
          </div>

          <span className="timestamp">
            {ibkrReady
              ? `Tracking strategy-linked IBKR paper orders and position lifecycle updates${lastUpdated ? ` · ${formatDateTimeLabel(lastUpdated, { includeSeconds: true })}` : ""}.`
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
                : "Use this blotter to review pending, open, closed, and cancelled strategy orders from one place."}
          </span>
        </div>
      </header>

      <section className="paper-summary-grid">
        <article className="metric-card metric-card--amber">
          <span>Pending orders</span>
          <strong>{pendingOrders.length}</strong>
        </article>
        <article className="metric-card metric-card--sky">
          <span>Open positions</span>
          <strong>{openPositions.length}</strong>
        </article>
        <article className="metric-card metric-card--rose">
          <span>Cancelled / failed</span>
          <strong>{cancelledOrders.length}</strong>
        </article>
        <article className="metric-card metric-card--emerald">
          <span>Closed orders</span>
          <strong>{closedHistory.length}</strong>
        </article>
        <article className="metric-card metric-card--teal">
          <span>Unrealized P&amp;L</span>
          <strong className={sumProfitLoss(openPositions) >= 0 ? "positive" : "negative"}>
            {formatCurrency(sumProfitLoss(openPositions))}
          </strong>
        </article>
        <article className="metric-card metric-card--emerald">
          <span>Realized P&amp;L</span>
          <strong className={sumProfitLoss(closedHistory) >= 0 ? "positive" : "negative"}>
            {formatCurrency(sumProfitLoss(closedHistory))}
          </strong>
        </article>
      </section>

      <section className="paper-group order-desk__filters-panel">
        <div className="order-desk__toolbar">
          <div className="order-desk__filter-group">
            <span className="brand__eyebrow">Scope</span>
            <div className="chart-toggle-group">
              <OrderFilterButton
                active={scope === "ibkr"}
                label="IBKR routed"
                count={allOrders.filter((order) => isIbkrManagedOrder(order)).length}
                onClick={() => setScope("ibkr")}
              />
              <OrderFilterButton
                active={scope === "all"}
                label="All paper orders"
                count={allOrders.length}
                onClick={() => setScope("all")}
              />
            </div>
          </div>

          <div className="order-desk__filter-group">
            <span className="brand__eyebrow">Lifecycle</span>
            <div className="chart-toggle-group">
              {ORDER_FILTERS.map((filter) => (
                <OrderFilterButton
                  key={filter.id}
                  active={selectedFilter === filter.id}
                  label={filter.label}
                  count={filterCount(scopedOrders, filter.id)}
                  onClick={() => setSelectedFilter(filter.id)}
                />
              ))}
            </div>
          </div>

          <div className="order-desk__filter-group">
            <span className="brand__eyebrow">Strategy</span>
            <div className="chart-toggle-group">
              <OrderFilterButton
                active={selectedStrategyId === "all"}
                label="All strategies"
                count={scopedOrders.length}
                onClick={() => setSelectedStrategyId("all")}
              />
              {strategyOptions.map((strategy) => (
                <OrderFilterButton
                  key={strategy.id}
                  active={selectedStrategyId === strategy.id}
                  label={strategy.label}
                  count={strategy.count}
                  onClick={() => setSelectedStrategyId(strategy.id)}
                />
              ))}
            </div>
          </div>
        </div>
      </section>

      {!hasLoadedOrders && paperPortfolio?.summary ? (
        <section className="paper-empty-state">
          <span className="brand__eyebrow">Loading order blotter</span>
          <h3>Fetching the latest strategy-linked order lifecycle.</h3>
          <p>Open, pending, closed, and cancelled rows will appear here as soon as the live paper portfolio finishes loading.</p>
        </section>
      ) : visibleOrders.length === 0 ? (
        <section className="paper-empty-state">
          <span className="brand__eyebrow">No matching orders</span>
          <h3>{scope === "ibkr" ? "No IBKR-routed strategy orders match this filter." : "No strategy orders match this filter."}</h3>
          <p>
            Adjust the lifecycle or strategy filters above, or open the paper-trading workspace to place a new strategy-linked order.
          </p>
        </section>
      ) : (
        <section className="paper-group">
          <div className="section-heading">
            <span>Order blotter</span>
            <span className="pill pill--ghost">{visibleOrders.length} rows</span>
          </div>

          <div className="paper-open-table-wrap order-desk__table-wrap">
            <table className="paper-open-table order-desk__table">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Strategy</th>
                  <th scope="col">Lifecycle</th>
                  <th scope="col">Exposure</th>
                  <th scope="col">P&amp;L</th>
                  <th scope="col">Broker refs</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {visibleOrders.map((order) => {
                  const primaryExecution = getPrimaryExecutionRecord(order);
                  const execution = primaryExecution?.execution ?? null;
                  const activity = getActivitySummary(order);
                  const displayedProfitLoss = getDisplayedProfitLoss(order);
                  const orderBusy = busyOrderId === String(order.id);
                  const isExpanded = expandedOrderId === String(order.id);

                  return (
                    <Fragment key={order.id}>
                      <tr className={`paper-open-table__row ${isExpanded ? "paper-open-table__row--detail-open" : ""}`}>
                        <td className="paper-open-table__cell paper-open-table__cell--holding">
                          <div className="paper-open-table__holding order-desk__holding">
                            <strong>{order.combinationLabel || "Order"}</strong>
                            <div className="order-desk__badge-row">
                              {getLifecycleBadges(order).map((badge) => (
                                <span key={badge.label} className={`pill ${getLifecycleBadgeTone(badge.tone)}`}>
                                  {badge.label}
                                </span>
                              ))}
                            </div>
                            <small>
                              {order.assetLabel || "n/a"}
                              {order.strategyType ? ` · ${order.strategyType}` : ""}
                              {order.purchaseDate ? ` · Opened ${order.purchaseDate}` : ""}
                            </small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric order-desk__stack">
                            <button
                              type="button"
                              className="order-desk__link-button"
                              onClick={() => onOpenStrategy(order.strategyId || "strategy-1")}
                            >
                              {order.strategyName || "Strategy"}
                            </button>
                            <small>{order.strategyId || "n/a"}</small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric">
                            <strong>{getExecutionLabel(primaryExecution)}</strong>
                            <small>{normalizeExecutionStatusLabel(execution?.status ?? (isClosedOrder(order) ? "closed" : "local"))}</small>
                            <small>{execution?.statusDescription || execution?.lastWarning || execution?.lastError || "Strategy-linked lifecycle"}</small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric">
                            <strong>{formatCurrency(order.initialPurchaseValue)}</strong>
                            <small>
                              {isClosedOrder(order) ? "Exit value" : "Current value"} {getDisplayedHoldingValue(order)}
                            </small>
                            <small>{getFillLabel(execution)}</small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric">
                            <strong className={displayedProfitLoss.tone}>{displayedProfitLoss.value}</strong>
                            <small>{isClosedOrder(order) ? "Realized" : hasOpenPosition(order) ? "Unrealized" : "Awaiting fill"}</small>
                            <small>{displayedProfitLoss.percent}</small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric">
                            <strong>{execution?.accountId || "n/a"}</strong>
                            <small>{execution?.orderRef ? `Ref ${execution.orderRef}` : "No order ref"}</small>
                            <small>{execution?.brokerOrderId ? `Order ${execution.brokerOrderId}` : "No broker id"}</small>
                          </div>
                        </td>
                        <td className="paper-open-table__cell">
                          <div className="paper-open-table__metric">
                            <strong>{activity.title}</strong>
                            <small>{activity.detail}</small>
                            {execution?.lastSyncAt ? (
                              <small>Sync {formatDateTimeLabel(execution.lastSyncAt, { includeSeconds: true })}</small>
                            ) : null}
                          </div>
                        </td>
                        <td className="paper-open-table__cell paper-open-table__cell--action">
                          <button
                            type="button"
                            className={`chart-toggle ${isExpanded ? "chart-toggle--active" : ""}`}
                            onClick={() =>
                              setExpandedOrderId((current) =>
                                current === String(order.id) ? null : String(order.id)
                              )
                            }
                            disabled={orderBusy}
                          >
                            {isExpanded ? "Hide detail" : "View detail"}
                          </button>
                        </td>
                      </tr>

                      {isExpanded ? (
                        <tr className="paper-open-table__detail-row">
                          <td colSpan={8}>
                            <div className="paper-open-table__detail">
                              <OrderDetailPanel
                                order={order}
                                orderBusy={orderBusy}
                                feedback={feedbackByOrder[String(order.id)]}
                                onOpenStrategy={onOpenStrategy}
                                onOpenPaperTrading={onOpenPaperTrading}
                                onSyncExecution={() => handleSyncExecution(order)}
                                onCancelExecution={() => handleCancelExecution(order)}
                                onRetryEntry={() => handleRetryEntry(order)}
                                onToggleSmartExecution={() => handleToggleSmartExecution(order)}
                                onRespondExecutionConfirmation={(confirmed) =>
                                  handleRespondExecutionConfirmation(order, confirmed)
                                }
                              />
                            </div>
                          </td>
                        </tr>
                      ) : feedbackByOrder[String(order.id)] ? (
                        <tr className="paper-open-table__feedback-row">
                          <td colSpan={8}>
                            <div className={`refresh-feedback refresh-feedback--${feedbackByOrder[String(order.id)].tone}`}>
                              <span>{feedbackByOrder[String(order.id)].message}</span>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
