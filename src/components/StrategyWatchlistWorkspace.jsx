import { Fragment, useEffect, useMemo, useState } from "react";
import OptionMicrostructurePanel from "./OptionMicrostructurePanel.jsx";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";

function formatCurrency(value, currency = "USD", digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency,
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

function formatNumber(value, digits = 2) {
  if (value == null || Number.isNaN(value)) {
    return "n/a";
  }

  return Number(value).toFixed(digits);
}

function formatCompactCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: numericValue >= 1000 ? 1 : 0
  }).format(numericValue);
}

function formatExtrema(value, { unbounded = false, kind = "profit" } = {}) {
  if (unbounded) {
    return kind === "loss" ? "Unlimited loss" : "Unlimited";
  }

  return formatCurrency(value);
}

function parseIsoDate(value) {
  const iso = String(value ?? "").trim();
  if (!iso) {
    return null;
  }

  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function differenceInDays(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) {
    return null;
  }

  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function formatWatchlistTimestamp(timestamp) {
  if (!timestamp) {
    return "—";
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "—";
  }

  return parsed.toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatOptionalNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }

  return numericValue.toFixed(digits);
}

function formatOptionalCurrency(value, currency = "USD", digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }

  return formatCurrency(numericValue, currency, digits);
}

function formatOptionalPercent(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "—";
  }

  return `${numericValue.toFixed(digits)}%`;
}

function calculateSpreadPercent(bid, ask) {
  const numericBid = Number(bid);
  const numericAsk = Number(ask);
  if (!Number.isFinite(numericBid) || !Number.isFinite(numericAsk) || numericAsk === 0) {
    return null;
  }

  return ((numericAsk - numericBid) / numericAsk) * 100;
}

function calculateRewardRisk(maxProfit, maxLoss, maxProfitUnbounded, maxLossUnbounded) {
  if (maxProfitUnbounded || maxLossUnbounded) {
    return null;
  }

  const numericProfit = Number(maxProfit);
  const numericLoss = Number(maxLoss);
  if (!Number.isFinite(numericProfit) || !Number.isFinite(numericLoss) || numericLoss === 0) {
    return null;
  }

  return Math.abs(numericProfit / numericLoss);
}

function getWatchlistSourceLabel(item) {
  const source = String(item?.source ?? "").trim().toLowerCase();
  if (source === "tradingview") {
    return "TradingView";
  }

  if (source === "finder") {
    return item?.payload?.strategyName || "Strategy 1";
  }

  return item?.payload?.strategyName || "Saved setup";
}

function buildWatchlistScenarioOrder(item, finderRow = null) {
  const payload = item?.payload ?? {};
  const marketContext =
    payload.marketContext && typeof payload.marketContext === "object"
      ? payload.marketContext
      : payload.valuationContext && typeof payload.valuationContext === "object"
        ? payload.valuationContext
        : {};
  const currentProxySpot =
    Number(
      marketContext.currentProxySpot ??
        marketContext.currentUnderlyingSpot ??
        finderRow?.underlyingPrice ??
        0
    ) || 0;
  const currentUnderlyingSpot =
    Number(
      marketContext.currentUnderlyingSpot ??
        marketContext.currentProxySpot ??
        finderRow?.underlyingPrice ??
        0
    ) || currentProxySpot;
  const conversionRatio =
    Number(marketContext.conversionRatio ?? 0) ||
    (currentUnderlyingSpot > 0 && currentProxySpot > 0 ? currentProxySpot / currentUnderlyingSpot : 1);
  const targetUnderlyingValue =
    Number(marketContext.targetUnderlyingValue ?? finderRow?.breakevens?.[0] ?? currentUnderlyingSpot ?? 0) || 0;
  const marketReferenceYesPrice =
    Number(payload.marketReferenceYesPrice ?? marketContext.currentYesPrice ?? 0.5) || 0.5;

  return {
    id: String(item?.id ?? payload.combinationId ?? payload.combinationLabel ?? payload.assetLabel ?? ""),
    strategyId: String(payload.strategyId ?? item?.strategyId ?? "").trim(),
    strategyName: String(payload.strategyName ?? getWatchlistSourceLabel(item)).trim(),
    combinationId: String(payload.combinationId ?? item?.combinationId ?? "").trim(),
    combinationLabel: String(payload.combinationLabel ?? item?.title ?? "").trim(),
    assetLabel: String(payload.assetLabel ?? finderRow?.assetLabel ?? "").trim(),
    strategyType: String(payload.strategyType ?? finderRow?.strategyType ?? "").trim(),
    marketBias: String(payload.marketBias ?? finderRow?.marketBias ?? "").trim(),
    marketBiasTone: String(payload.marketBiasTone ?? finderRow?.marketBiasTone ?? "neutral").trim(),
    maxProfit: payload.maxProfit ?? finderRow?.maxProfit ?? null,
    maxLoss: payload.maxLoss ?? finderRow?.maxLoss ?? null,
    maxProfitUnbounded: payload.maxProfitUnbounded === true,
    maxLossUnbounded: payload.maxLossUnbounded === true,
    purchaseDate:
      String(payload.purchaseDate ?? "").trim() ||
      String(item?.createdAt ?? "").slice(0, 10) ||
      new Date().toISOString().slice(0, 10),
    polymarketMarketId: String(payload.polymarketMarketId ?? "").trim(),
    polymarketMarketSlug: String(payload.polymarketMarketSlug ?? "").trim(),
    polymarketEventSlug: String(payload.polymarketEventSlug ?? "").trim(),
    polymarketQuestion: String(payload.polymarketQuestion ?? "").trim(),
    polymarketUrl: String(payload.polymarketUrl ?? "").trim(),
    polymarketSource: String(payload.polymarketSource ?? "").trim(),
    polymarketResolutionDate: String(payload.polymarketResolutionDate ?? "").trim(),
    strategyCloseDate:
      String(payload.strategyCloseDate ?? "").trim() ||
      String(finderRow?.expiration ?? "").trim(),
    marketReferenceYesPrice,
    valuationContext: {
      proxySymbol: String(
        marketContext.proxySymbol ??
          marketContext.underlyingSymbol ??
          finderRow?.underlyingFamily ??
          payload.assetLabel ??
          ""
      ).trim(),
      underlyingSymbol: String(
        marketContext.underlyingSymbol ??
          finderRow?.underlyingSymbol ??
          finderRow?.assetLabel ??
          payload.assetLabel ??
          ""
      ).trim(),
      currentProxySpot,
      currentUnderlyingSpot,
      conversionRatio,
      targetUnderlyingValue,
      polymarketDirection: String(marketContext.polymarketDirection ?? "up").trim() || "up",
      polymarketTriggerType: String(marketContext.polymarketTriggerType ?? "touch").trim() || "touch",
      currentYesPrice: marketReferenceYesPrice
    },
    marketContext,
    legs: Array.isArray(payload.legs) ? payload.legs.map((leg) => ({ ...leg })) : [],
    execution:
      payload.execution && typeof payload.execution === "object"
        ? payload.execution
        : {
            route: "local-paper"
          },
    calculatorSnapshots: Array.isArray(payload.calculatorSnapshots) ? payload.calculatorSnapshots : [],
    status: String(payload.status ?? "open").trim() || "open",
    createdAt: item?.createdAt ?? payload.createdAt ?? null,
    closedAt: payload.closedAt ?? ""
  };
}

function describeWatchlistLeg(leg, scenarioOrder) {
  if (leg?.kind === "binary") {
    const resolutionLabel =
      scenarioOrder?.polymarketResolutionDate || scenarioOrder?.strategyCloseDate || "Resolution";
    return `${String(leg?.outcome ?? leg?.label ?? "Binary").toUpperCase()} · ${resolutionLabel}`;
  }

  if (leg?.kind === "stock") {
    return leg?.label || scenarioOrder?.assetLabel || "Stock";
  }

  const strikeLabel =
    leg?.strike == null || Number.isNaN(Number(leg?.strike))
      ? leg?.label || "Option"
      : `${formatOptionalNumber(leg.strike, 1)}${String(leg?.optionType ?? "call").toUpperCase()}`;
  const expiryLabel = String(leg?.expiry ?? leg?.expiration ?? scenarioOrder?.strategyCloseDate ?? "").trim();
  return expiryLabel ? `${strikeLabel} · ${expiryLabel}` : strikeLabel;
}

function getWatchlistLegReference(leg, scenarioOrder) {
  if (leg?.kind === "binary") {
    return {
      label: leg?.label || "Polymarket market",
      meta: scenarioOrder?.polymarketQuestion || "Binary leg",
      url: scenarioOrder?.polymarketUrl || ""
    };
  }

  if (leg?.kind === "stock") {
    return {
      label: leg?.label || scenarioOrder?.assetLabel || "Stock leg",
      meta: "Underlying stock",
      url: ""
    };
  }

  return {
    label:
      String(leg?.contractSymbol ?? "").trim() ||
      `${String(leg?.action ?? "LONG").toUpperCase()} ${String(leg?.optionType ?? "call").toUpperCase()} ${formatOptionalNumber(leg?.strike, 1)}`,
    meta: leg?.quoteSource || "Saved quote",
    url: ""
  };
}

function normalizeComboQuantityInput(value, fallback = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  const normalizedValue = Math.round(numericValue);
  if (normalizedValue < 1) {
    return fallback;
  }

  return normalizedValue;
}

function getPendingConfirmation(order) {
  const record = order && typeof order === "object" ? order : null;
  const position =
    record?.position && typeof record.position === "object"
      ? record.position
      : record;
  const orderId = record?.id ?? position?.id ?? null;
  const entryExecution = position?.execution ?? null;
  if (
    String(entryExecution?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
    String(entryExecution?.pendingReplyId ?? "").trim().length > 0
  ) {
    return {
      orderId,
      phase: "entry",
      messages: Array.isArray(entryExecution.pendingReplyMessages) ? entryExecution.pendingReplyMessages : []
    };
  }

  const exitExecution = position?.closeExecution ?? null;
  if (
    String(exitExecution?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
    String(exitExecution?.pendingReplyId ?? "").trim().length > 0
  ) {
    return {
      orderId,
      phase: "exit",
      messages: Array.isArray(exitExecution.pendingReplyMessages) ? exitExecution.pendingReplyMessages : []
    };
  }

  return null;
}

function normalizeStrategyDirection(value) {
  return String(value ?? "").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function invertLegAction(action) {
  return String(action ?? "").trim().toUpperCase() === "SHORT" ? "LONG" : "SHORT";
}

function buildConfiguredOrderPayload(item, order, configuration = {}) {
  const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
  const normalizedDirection = normalizeStrategyDirection(configuration.direction);
  const comboQuantity = normalizeComboQuantityInput(configuration.comboQuantity, 1) ?? 1;
  const baseLegs = Array.isArray(order?.legs) ? order.legs : [];
  const configuredLegs = baseLegs.map((leg) => {
    const baseQuantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
    const nextQuantity = baseQuantity > 0 ? Math.max(Math.round(baseQuantity * comboQuantity), 1) : baseQuantity;

    return {
      ...leg,
      quantity: nextQuantity,
      action: normalizedDirection === "SHORT" ? invertLegAction(leg?.action) : leg?.action
    };
  });

  return {
    ...payload,
    ...order,
    strategySource:
      String(order?.strategySource ?? "").trim() ||
      String(payload.strategySource ?? "").trim() ||
      String(payload.source ?? "").trim() ||
      String(item?.source ?? "").trim(),
    purchaseDate:
      String(configuration.purchaseDate ?? "").trim() ||
      String(order?.purchaseDate ?? "").trim() ||
      String(payload.purchaseDate ?? "").trim() ||
      String(item?.createdAt ?? "").slice(0, 10) ||
      new Date().toISOString().slice(0, 10),
    marketContext:
      order?.marketContext && typeof order.marketContext === "object"
        ? { ...order.marketContext }
        : payload.marketContext && typeof payload.marketContext === "object"
          ? { ...payload.marketContext }
          : payload.marketContext,
    valuationContext:
      order?.valuationContext && typeof order.valuationContext === "object"
        ? { ...order.valuationContext }
        : payload.valuationContext && typeof payload.valuationContext === "object"
          ? { ...payload.valuationContext }
          : payload.valuationContext,
    legs: configuredLegs,
    execution: {
      route: "local-paper"
    }
  };
}

export default function StrategyWatchlistWorkspace({
  setupWatchlist = [],
  finderRows = [],
  onOpenFinderRow = null,
  onDeleteSetupWatchlistItem = null,
  onCreatePaperOrder = null,
  onConfirmPaperExecution = null,
  onOpenPaperTrading = null,
  paperPortfolio = null,
  lastUpdated = null,
  theme = "dark"
}) {
  const [pendingId, setPendingId] = useState("");
  const [pendingAction, setPendingAction] = useState("");
  const [notice, setNotice] = useState(null);
  const [expandedItemId, setExpandedItemId] = useState("");
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperStrategyDirection, setPaperStrategyDirection] = useState("LONG");
  const [paperComboQuantity, setPaperComboQuantity] = useState(1);
  const [paperComboQuantityInput, setPaperComboQuantityInput] = useState("1");
  const watchlistItems = useMemo(
    () => (Array.isArray(setupWatchlist) ? setupWatchlist : []),
    [setupWatchlist]
  );
  const finderRowsById = useMemo(() => {
    const items = Array.isArray(finderRows) ? finderRows : [];
    return new Map(items.map((row) => [String(row?.id ?? ""), row]));
  }, [finderRows]);
  const sortedItems = useMemo(() => {
    return [...watchlistItems].sort((left, right) => {
      const leftDate = new Date(left?.createdAt ?? 0).getTime();
      const rightDate = new Date(right?.createdAt ?? 0).getTime();
      if (Number.isFinite(leftDate) && Number.isFinite(rightDate) && leftDate !== rightDate) {
        return rightDate - leftDate;
      }
      return String(left?.id ?? "").localeCompare(String(right?.id ?? ""));
    });
  }, [watchlistItems]);

  const canDelete = typeof onDeleteSetupWatchlistItem === "function";
  const canCreateOrder = typeof onCreatePaperOrder === "function";
  const canOpenDetail = typeof onOpenFinderRow === "function";
  const canConfirmExecution = typeof onConfirmPaperExecution === "function";
  const expandedItem = useMemo(
    () => sortedItems.find((item) => String(item?.id ?? "") === expandedItemId) ?? null,
    [expandedItemId, sortedItems]
  );
  const expandedFinderRow = useMemo(() => {
    const rowId = String(
      expandedItem?.combinationId ??
        expandedItem?.payload?.combinationId ??
        ""
    ).trim();
    return rowId ? finderRowsById.get(rowId) ?? null : null;
  }, [expandedItem, finderRowsById]);
  const expandedScenarioOrder = useMemo(
    () => (expandedItem ? buildWatchlistScenarioOrder(expandedItem, expandedFinderRow) : null),
    [expandedFinderRow, expandedItem]
  );
  const normalizedPaperComboQuantity = useMemo(
    () => normalizeComboQuantityInput(paperComboQuantity, 1),
    [paperComboQuantity]
  );
  const directedExpandedScenarioOrder = useMemo(() => {
    if (!expandedScenarioOrder) {
      return null;
    }

    if (normalizeStrategyDirection(paperStrategyDirection) !== "SHORT") {
      return expandedScenarioOrder;
    }

    return {
      ...expandedScenarioOrder,
      legs: (expandedScenarioOrder.legs ?? []).map((leg) => ({
        ...leg,
        action: invertLegAction(leg?.action)
      }))
    };
  }, [expandedScenarioOrder, paperStrategyDirection]);
  const expandedMicrostructureContracts = useMemo(
    () =>
      (directedExpandedScenarioOrder?.legs ?? [])
        .filter((leg) => leg?.kind === "option" && String(leg?.contractSymbol ?? "").trim())
        .map((leg, index) => ({
          contractSymbol: String(leg.contractSymbol).trim(),
          label:
            leg.referenceLabel ||
            `${directedExpandedScenarioOrder?.assetLabel || "Option"} ${index + 1} · ${describeWatchlistLeg(
              leg,
              directedExpandedScenarioOrder
            )}`,
          anchorAt: expandedItem?.createdAt ?? null
        })),
    [directedExpandedScenarioOrder, expandedItem?.createdAt]
  );
  const previewScenarioOrder = useMemo(() => {
    if (!directedExpandedScenarioOrder) {
      return null;
    }

    if (normalizedPaperComboQuantity === 1) {
      return directedExpandedScenarioOrder;
    }

    return {
      ...directedExpandedScenarioOrder,
      legs: (directedExpandedScenarioOrder.legs ?? []).map((leg) => {
        const baseQuantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
        return {
          ...leg,
          quantity: baseQuantity > 0 ? Math.max(Math.round(baseQuantity * normalizedPaperComboQuantity), 1) : baseQuantity
        };
      })
    };
  }, [directedExpandedScenarioOrder, normalizedPaperComboQuantity]);

  useEffect(() => {
    if (!expandedItemId) {
      return;
    }

    if (!sortedItems.some((item) => String(item?.id ?? "") === expandedItemId)) {
      setExpandedItemId("");
    }
  }, [expandedItemId, sortedItems]);

  useEffect(() => {
    if (!expandedScenarioOrder || !expandedItemId) {
      return;
    }

    setPaperTradeDate(
      String(expandedScenarioOrder.purchaseDate ?? "").trim() ||
        String(expandedItem?.createdAt ?? "").slice(0, 10) ||
        new Date().toISOString().slice(0, 10)
    );
    setPaperOrderState(null);
    setPaperOrderSaving(false);
    setPaperStrategyDirection("LONG");
    setPaperComboQuantity(1);
    setPaperComboQuantityInput("1");
  }, [expandedItemId]);

  async function handleRemove(event, itemId) {
    event?.stopPropagation?.();

    if (!canDelete || !itemId || pendingId) {
      return;
    }

    setNotice(null);
    setPendingId(itemId);
    setPendingAction("remove");

    try {
      await onDeleteSetupWatchlistItem(itemId);
      if (expandedItemId === itemId) {
        setExpandedItemId("");
      }
    } catch (error) {
      setNotice({
        tone: "error",
        message: error?.message || "Failed to remove watchlist item"
      });
    } finally {
      setPendingId("");
      setPendingAction("");
    }
  }

  function applyPaperComboQuantity(nextComboQuantity, { syncInput = true } = {}) {
    const normalizedComboQuantity = normalizeComboQuantityInput(nextComboQuantity, paperComboQuantity);
    setPaperComboQuantity(normalizedComboQuantity);
    if (syncInput) {
      setPaperComboQuantityInput(String(normalizedComboQuantity));
    }
  }

  function handlePaperComboQuantityChange(event) {
    const nextValue = event.target.value;
    setPaperComboQuantityInput(nextValue);
    const normalizedComboQuantity = normalizeComboQuantityInput(nextValue, null);
    if (normalizedComboQuantity != null) {
      applyPaperComboQuantity(normalizedComboQuantity, { syncInput: false });
    }
  }

  function handlePaperComboQuantityBlur() {
    setPaperComboQuantityInput(String(paperComboQuantity));
  }

  async function handleCreatePaperTrade(event, item, scenarioOrder) {
    event?.stopPropagation?.();

    if (!canCreateOrder || !scenarioOrder || paperOrderSaving) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      const response = await onCreatePaperOrder(buildConfiguredOrderPayload(item, scenarioOrder, {
        purchaseDate: paperTradeDate,
        direction: paperStrategyDirection,
        comboQuantity: paperComboQuantity
      }));
      const pendingConfirmation = getPendingConfirmation(response?.order);

      setPaperOrderState({
        tone: pendingConfirmation ? "warning" : "success",
        message: response?.message ?? "Paper order saved.",
        confirmation: pendingConfirmation
      });
    } catch (error) {
      setPaperOrderState({
        tone: "error",
        message: error?.message || "Failed to create paper order",
        confirmation: null
      });
    } finally {
      setPaperOrderSaving(false);
    }
  }

  async function handlePaperExecutionConfirmation(confirmed) {
    const pendingConfirmation = paperOrderState?.confirmation;
    if (!pendingConfirmation?.orderId || !canConfirmExecution) {
      return;
    }

    setPaperOrderSaving(true);

    try {
      const payload = await onConfirmPaperExecution(pendingConfirmation.orderId, {
        confirmed
      });
      const nextConfirmation = getPendingConfirmation(payload?.order);

      setPaperOrderState({
        tone:
          confirmed !== true
            ? "warning"
            : nextConfirmation
              ? "warning"
              : "success",
        message:
          payload?.message ??
          (confirmed === true
            ? "Broker confirmation sent."
            : "Broker confirmation declined."),
        confirmation: nextConfirmation
      });
    } catch (error) {
      setPaperOrderState({
        tone: "error",
        message: error?.message || "Unable to respond to broker confirmation.",
        confirmation: pendingConfirmation
      });
    } finally {
      setPaperOrderSaving(false);
    }
  }

  function handleToggleDetail(event, itemId) {
    event?.stopPropagation?.();
    setExpandedItemId((current) => (current === itemId ? "" : itemId));
  }

  function handleRowClick(item) {
    const itemId = String(item?.id ?? "");
    if (!itemId) {
      return;
    }

    setNotice(null);
    setExpandedItemId((current) => (current === itemId ? "" : itemId));
  }

  function handleOpenFinderDetail(event, item) {
    event?.stopPropagation?.();

    const rowId = String(item?.combinationId ?? item?.payload?.combinationId ?? "").trim();
    if (!canOpenDetail || !rowId) {
      return;
    }

    onOpenFinderRow(rowId);
  }

  return (
    <main className="workspace workspace--strategy-watchlist">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Watchlist</span>
          <h2>Saved setups for later trading</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{sortedItems.length} saved</span>
            {onOpenPaperTrading ? (
              <button type="button" className="chart-toggle chart-toggle--compact" onClick={onOpenPaperTrading}>
                View holdings
              </button>
            ) : null}
          </div>
        </div>
      </header>

      {notice ? (
        <div className={`refresh-feedback refresh-feedback--${notice.tone ?? "info"}`}>
          <span>{notice.message}</span>
        </div>
      ) : null}

      <section className="insight-card">
        <div className="section-heading">
          <span>Saved setups</span>
          <span className="pill pill--ghost">{sortedItems.length}</span>
        </div>

        {sortedItems.length ? (
          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table watchlist__table">
              <thead>
                <tr>
                  <th>Actions</th>
                  <th>Expiration</th>
                  <th>Days</th>
                  <th>Asset</th>
                  <th>Strategy type</th>
                  <th>Tag</th>
                  <th>Max profit</th>
                  <th>Max loss</th>
                  <th>Reward/Risk</th>
                  <th>Opt vol</th>
                  <th>Theo price</th>
                  <th>Bid/Ask</th>
                  <th>Bid-ask spread</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => {
                  const itemId = String(item?.id ?? "");
                  const payload = item?.payload ?? {};
                  const rowId = String(item?.combinationId ?? payload?.combinationId ?? "");
                  const finderRow = rowId ? finderRowsById.get(rowId) ?? null : null;
                  const scenarioOrder = buildWatchlistScenarioOrder(item, finderRow);
                  const optionLegs = (scenarioOrder?.legs ?? []).filter((leg) => leg?.kind === "option");
                  const legRows = scenarioOrder?.legs ?? [];
                  const expiration =
                    scenarioOrder?.strategyCloseDate ||
                    scenarioOrder?.polymarketResolutionDate ||
                    finderRow?.expiration ||
                    "";
                  const days = finderRow?.days ?? differenceInDays(new Date().toISOString().slice(0, 10), expiration);
                  const assetLabel = finderRow?.assetLabel ?? scenarioOrder?.assetLabel ?? "—";
                  const strategyType = finderRow?.strategyType ?? scenarioOrder?.strategyType ?? "—";
                  const tagLabel = finderRow?.marketBias ?? scenarioOrder?.marketBias ?? "Neutral";
                  const tagTone = finderRow?.marketBiasTone ?? scenarioOrder?.marketBiasTone ?? "neutral";
                  const maxProfit = finderRow?.maxProfit ?? scenarioOrder?.maxProfit ?? null;
                  const maxLoss = finderRow?.maxLoss ?? scenarioOrder?.maxLoss ?? null;
                  const maxProfitUnbounded = finderRow?.maxProfitUnbounded === true || scenarioOrder?.maxProfitUnbounded === true;
                  const maxLossUnbounded = finderRow?.maxLossUnbounded === true || scenarioOrder?.maxLossUnbounded === true;
                  const rewardRisk =
                    finderRow?.rewardRisk ??
                    calculateRewardRisk(maxProfit, maxLoss, maxProfitUnbounded, maxLossUnbounded);
                  const fallbackOptionVolume = optionLegs.reduce(
                    (sum, leg) => sum + (Number(leg?.volume ?? 0) || 0),
                    0
                  );
                  const optVol =
                    finderRow?.normalizedOptionVolume ??
                    payload?.normalizedOptionVolume ??
                    (fallbackOptionVolume > 0 ? fallbackOptionVolume : null);
                  const theoPrice = finderRow?.theoPrice ?? payload?.theoPrice ?? null;
                  const bid =
                    finderRow?.bid ??
                    payload?.bid ??
                    (optionLegs.length
                      ? optionLegs.reduce((sum, leg) => sum + (Number(leg?.bid ?? 0) || 0), 0)
                      : null);
                  const ask =
                    finderRow?.ask ??
                    payload?.ask ??
                    (optionLegs.length
                      ? optionLegs.reduce((sum, leg) => sum + (Number(leg?.ask ?? 0) || 0), 0)
                      : null);
                  const bidAskSpread =
                    finderRow?.bidAskSpread ??
                    payload?.bidAskSpread ??
                    calculateSpreadPercent(bid, ask);
                  const isPending = pendingId === itemId;
                  const isExpanded = expandedItemId === itemId;
                  const sourceLabel = getWatchlistSourceLabel(item);
                  const underlyingPrice =
                    scenarioOrder?.valuationContext?.currentProxySpot ??
                    scenarioOrder?.valuationContext?.currentUnderlyingSpot ??
                    finderRow?.underlyingPrice ??
                    null;
                  const externalUrl =
                    String(payload?.pageUrl ?? payload?.externalUrl ?? "").trim() ||
                    scenarioOrder?.polymarketUrl ||
                    "";
                  const externalLabel = payload?.pageUrl ? "Open TradingView" : scenarioOrder?.polymarketUrl ? "Open Polymarket" : "";
                  const removePending = isPending && pendingAction === "remove";

                  return (
                    <Fragment key={itemId}>
                      <tr
                        className={isExpanded ? "screening-v2__table-row--active watchlist__row--active" : ""}
                        onClick={() => handleRowClick(item)}
                        aria-expanded={isExpanded}
                      >
                        <td>
                          <div className="chart-toggle-group">
                            <button
                              type="button"
                              className={`chart-toggle chart-toggle--compact ${isExpanded ? "chart-toggle--active" : ""}`}
                              onClick={(event) => handleToggleDetail(event, itemId)}
                            >
                              {isExpanded ? "Hide details" : "Show details"}
                            </button>
                            <button
                              type="button"
                              className={`chart-toggle chart-toggle--compact ${removePending ? "chart-toggle--active" : ""}`}
                              onClick={(event) => handleRemove(event, itemId)}
                              disabled={!canDelete || isPending}
                            >
                              {removePending ? "Working..." : "Remove"}
                            </button>
                          </div>
                        </td>
                        <td>{expiration || "—"}</td>
                        <td>{days ?? "—"}</td>
                        <td>{assetLabel}</td>
                        <td>{strategyType}</td>
                        <td>
                          <span className={`bias-pill bias-pill--${tagTone}`}>{tagLabel}</span>
                        </td>
                        <td className={maxProfitUnbounded ? "" : Number(maxProfit) >= 0 ? "positive" : "negative"}>
                          {formatExtrema(maxProfit, { unbounded: maxProfitUnbounded, kind: "profit" })}
                        </td>
                        <td className={maxLossUnbounded ? "" : Number(maxLoss) >= 0 ? "positive" : "negative"}>
                          {formatExtrema(maxLoss, { unbounded: maxLossUnbounded, kind: "loss" })}
                        </td>
                        <td>{rewardRisk != null ? formatNumber(rewardRisk, 2) : "—"}</td>
                        <td>{optVol != null ? formatCompactCount(optVol) : "—"}</td>
                        <td>{theoPrice != null ? formatNumber(theoPrice, 2) : "—"}</td>
                        <td>{bid != null || ask != null ? `${formatOptionalNumber(bid, 2)} / ${formatOptionalNumber(ask, 2)}` : "—"}</td>
                        <td className="negative">{bidAskSpread != null ? `${formatNumber(bidAskSpread, 2)}%` : "—"}</td>
                        <td>{formatWatchlistTimestamp(item?.createdAt)}</td>
                      </tr>
                      {isExpanded ? (
                        <tr className="watchlist__detail-row">
                          <td colSpan={14}>
                            <div className="watchlist__detail" onClick={(event) => event.stopPropagation()}>
                              <section className="selection-banner watchlist__selection-banner">
                                <div className="selection-banner__title">
                                  <span className="brand__eyebrow">Saved setup detail</span>
                                  <strong>
                                    {scenarioOrder?.combinationLabel ||
                                      `${assetLabel} · ${strategyType}${expiration ? ` · ${expiration}` : ""}`}
                                  </strong>
                                </div>
                                <div className="selection-banner__actions">
                                  <div className="detail-badges">
                                    <span className="pill pill--ghost">{sourceLabel}</span>
                                    {expiration ? <span className="pill pill--ghost">{expiration}</span> : null}
                                    {days != null ? <span className="pill pill--ghost">{days} DTE</span> : null}
                                    <span className="pill pill--live">Added {formatWatchlistTimestamp(item?.createdAt)}</span>
                                  </div>
                                  <div className="watchlist__detail-actions">
                                    {externalUrl && externalLabel ? (
                                      <a href={externalUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                                        {externalLabel}
                                      </a>
                                    ) : null}
                                    {item?.source === "finder" && canOpenDetail ? (
                                      <button
                                        type="button"
                                        className="chart-toggle"
                                        onClick={(event) => handleOpenFinderDetail(event, item)}
                                      >
                                        Open full strategy page
                                      </button>
                                    ) : null}
                                    <button
                                      type="button"
                                      className={`chart-toggle ${removePending ? "chart-toggle--active" : ""}`}
                                      onClick={(event) => handleRemove(event, itemId)}
                                      disabled={!canDelete || isPending}
                                    >
                                      {removePending ? "Working..." : "Remove"}
                                    </button>
                                    <button
                                      type="button"
                                      className="chart-toggle chart-toggle--active"
                                      onClick={(event) => handleToggleDetail(event, itemId)}
                                    >
                                      Collapse details
                                    </button>
                                  </div>
                                </div>
                              </section>

                              <div className="screening-v2__selected-grid">
                                <section className="screening-v2__selected-panel">
                                  <h4>Strategy overview</h4>
                                  <div className="summary-stack">
                                    <div className="summary-row">
                                      <span>Underlying price</span>
                                      <strong>{formatOptionalCurrency(underlyingPrice)}</strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Strategy type</span>
                                      <strong>{strategyType || "—"}</strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Max profit</span>
                                      <strong className={maxProfitUnbounded ? "" : Number(maxProfit) >= 0 ? "positive" : "negative"}>
                                        {formatExtrema(maxProfit, { unbounded: maxProfitUnbounded, kind: "profit" })}
                                      </strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Max loss</span>
                                      <strong className={maxLossUnbounded ? "" : Number(maxLoss) >= 0 ? "positive" : "negative"}>
                                        {formatExtrema(maxLoss, { unbounded: maxLossUnbounded, kind: "loss" })}
                                      </strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Reward/Risk</span>
                                      <strong>{rewardRisk != null ? formatNumber(rewardRisk, 2) : "—"}</strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Signal tag</span>
                                      <strong>
                                        <span className={`bias-pill bias-pill--${tagTone}`}>{tagLabel}</span>
                                      </strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Contracts / legs</span>
                                      <strong>{legRows.length || 0}</strong>
                                    </div>
                                    <div className="summary-row">
                                      <span>Bid/Ask spread</span>
                                      <strong className="negative">{formatOptionalPercent(bidAskSpread)}</strong>
                                    </div>
                                  </div>
                                </section>

                                <section className="screening-v2__selected-panel screening-v2__selected-panel--contracts">
                                  <h4>Contract details</h4>
                                  <div className="screening-v2__contract-table-wrap">
                                    <table className="screening-v2__contract-table">
                                      <thead>
                                        <tr>
                                          <th>Action</th>
                                          <th>Qty</th>
                                          <th>Leg</th>
                                          <th>Entry</th>
                                          <th>Bid</th>
                                          <th>Ask</th>
                                          <th>Mark</th>
                                          <th>Vol / OI</th>
                                          <th>Reference</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {legRows.map((leg, index) => {
                                          const bidValue = Number(leg?.bid ?? NaN);
                                          const askValue = Number(leg?.ask ?? NaN);
                                          const markValue =
                                            Number.isFinite(Number(leg?.mark))
                                              ? Number(leg.mark)
                                              : Number.isFinite(bidValue) && Number.isFinite(askValue)
                                                ? (bidValue + askValue) / 2
                                                : null;
                                          const reference = getWatchlistLegReference(leg, scenarioOrder);

                                          return (
                                            <tr key={`${itemId}:${leg?.id ?? index}`}>
                                              <td>{String(leg?.action ?? "").toUpperCase() || "—"}</td>
                                              <td>{formatOptionalNumber(leg?.quantity, 0)}</td>
                                              <td>{describeWatchlistLeg(leg, scenarioOrder)}</td>
                                              <td>{formatOptionalCurrency(leg?.entryPrice)}</td>
                                              <td>{formatOptionalCurrency(leg?.bid)}</td>
                                              <td>{formatOptionalCurrency(leg?.ask)}</td>
                                              <td>{formatOptionalCurrency(markValue)}</td>
                                              <td>
                                                {leg?.kind === "option"
                                                  ? `${formatCompactCount(leg?.volume)} / ${formatCompactCount(leg?.openInterest)}`
                                                  : "—"}
                                              </td>
                                              <td>
                                                <div className="screening-v2__contract-link">
                                                  {reference.url ? (
                                                    <a href={reference.url} target="_blank" rel="noreferrer">
                                                      {reference.label}
                                                    </a>
                                                  ) : (
                                                    <strong>{reference.label}</strong>
                                                  )}
                                                  <span>{reference.meta}</span>
                                                </div>
                                              </td>
                                            </tr>
                                          );
                                        })}
                                      </tbody>
                                    </table>
                                  </div>
                                </section>

                                <OptionMicrostructurePanel
                                  title="Microstructure"
                                  contracts={expandedMicrostructureContracts}
                                  anchorAt={expandedItem?.createdAt ?? null}
                                  anchorLabel="Since watchlist"
                                />
                              </div>

                              <section className="paper-order-ticket">
                                <div className="paper-order-ticket__copy">
                                  <div className="paper-order-ticket__headline">
                                    <span className="brand__eyebrow">Place this order</span>
                                    <strong className="paper-order-ticket__title">
                                      {assetLabel} · {strategyType || sourceLabel}
                                    </strong>
                                  </div>
                                  <div className="paper-order-ticket__status">
                                    <span className="pill pill--ghost">Local route</span>
                                  </div>
                                  <p className="paper-order-ticket__note">
                                    Save the current setup directly into the local portfolio without sending it to a
                                    broker connection.
                                  </p>
                                </div>
                                <div className="paper-order-ticket__actions">
                                  <label>
                                    <span>Purchase date</span>
                                    <input
                                      type="date"
                                      value={paperTradeDate}
                                      onChange={(event) => setPaperTradeDate(event.target.value)}
                                    />
                                  </label>
                                  <label>
                                    <span>Direction</span>
                                    <select
                                      value={paperStrategyDirection}
                                      onChange={(event) => setPaperStrategyDirection(event.target.value)}
                                    >
                                      <option value="LONG">Long</option>
                                      <option value="SHORT">Short</option>
                                    </select>
                                  </label>
                                  <label className="paper-order-ticket__quantity">
                                    <span>Quantity</span>
                                    <div className="paper-order-ticket__quantity-controls">
                                      {[1, 5, 10].map((preset) => (
                                        <button
                                          key={`watchlist-qty-preset:${preset}`}
                                          type="button"
                                          className={`chart-toggle chart-toggle--compact ${paperComboQuantity === preset ? "chart-toggle--active" : ""}`}
                                          onClick={() => applyPaperComboQuantity(preset)}
                                          disabled={!legRows.length}
                                        >
                                          {preset}x
                                        </button>
                                      ))}
                                      <input
                                        className="paper-order-ticket__quantity-input"
                                        type="number"
                                        min="1"
                                        step="1"
                                        value={paperComboQuantityInput}
                                        onChange={handlePaperComboQuantityChange}
                                        onBlur={handlePaperComboQuantityBlur}
                                      />
                                    </div>
                                  </label>
                                  <button
                                    type="button"
                                    className={`chart-toggle ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                                    onClick={(event) => handleCreatePaperTrade(event, item, scenarioOrder)}
                                    disabled={paperOrderSaving || !canCreateOrder || !legRows.length}
                                    title={!legRows.length ? "This saved setup has no tradable legs." : ""}
                                  >
                                    {paperOrderSaving ? "Saving..." : "Start new order"}
                                  </button>
                                  {onOpenPaperTrading ? (
                                    <button type="button" className="chart-toggle" onClick={onOpenPaperTrading}>
                                      View holdings
                                    </button>
                                  ) : null}
                                </div>
                              </section>

                              {paperOrderState ? (
                                <div className={`refresh-feedback refresh-feedback--${paperOrderState.tone}`}>
                                  <span>{paperOrderState.message}</span>
                                  {paperOrderState.confirmation?.orderId ? (
                                    <div className="refresh-feedback__actions">
                                      <button
                                        type="button"
                                        className={`chart-toggle ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                                        onClick={() => handlePaperExecutionConfirmation(true)}
                                        disabled={paperOrderSaving || !canConfirmExecution}
                                      >
                                        {paperOrderSaving ? "Working..." : "Submit anyway"}
                                      </button>
                                      <button
                                        type="button"
                                        className="chart-toggle"
                                        onClick={() => handlePaperExecutionConfirmation(false)}
                                        disabled={paperOrderSaving || !canConfirmExecution}
                                      >
                                        Decline
                                      </button>
                                    </div>
                                  ) : null}
                                </div>
                              ) : null}

                              {scenarioOrder?.legs?.length ? (
                                <PaperTradeScenarioPanel
                                  order={previewScenarioOrder ?? scenarioOrder}
                                  lastUpdated={lastUpdated ?? item?.updatedAt ?? item?.createdAt ?? null}
                                  className="paper-scenario-card--screening"
                                  defaultOpen={true}
                                  theme={theme}
                                />
                              ) : null}
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
        ) : (
          <div className="app-state app-state--inline">
            No saved setups yet. Open a strategy detail and click “Add to watchlist”.
          </div>
        )}
      </section>
    </main>
  );
}
