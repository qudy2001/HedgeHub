import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createMarketTimerContext } from "../marketTimers.js";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";
import OptionMicrostructurePanel from "./OptionMicrostructurePanel.jsx";
import { loadSavedFilters, persistSavedFilters } from "../savedFilters.js";

function formatCurrency(value) {
  if (value == null || value === "") {
    return "n/a";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `$${numericValue.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatCurrencyCompact(value) {
  if (value == null || value === "") {
    return "n/a";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  const absValue = Math.abs(numericValue);
  const sign = numericValue < 0 ? "-" : "";

  const formatScaled = (scaled, suffix) => `${sign}$${scaled.toFixed(2)}${suffix}`;

  if (absValue >= 1_000_000_000_000) {
    return formatScaled(absValue / 1_000_000_000_000, "T");
  }

  if (absValue >= 1_000_000_000) {
    return formatScaled(absValue / 1_000_000_000, "B");
  }

  if (absValue >= 1_000_000) {
    return formatScaled(absValue / 1_000_000, "M");
  }

  if (absValue >= 1_000) {
    return formatScaled(absValue / 1_000, "K");
  }

  return `${sign}${formatCurrency(absValue)}`;
}

function formatPercent(value) {
  if (value == null || value === "") {
    return "n/a";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${numericValue.toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  if (value == null || value === "") {
    return "n/a";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return numericValue.toFixed(digits);
}

function formatWholeNumber(value) {
  if (value == null || value === "") {
    return "n/a";
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(numericValue);
}

function formatQuoteSizePair(bidSize, askSize) {
  if (bidSize == null || askSize == null) {
    return "n/a";
  }

  const numericBidSize = Number(bidSize);
  const numericAskSize = Number(askSize);

  if (
    !Number.isFinite(numericBidSize) ||
    numericBidSize < 0 ||
    !Number.isFinite(numericAskSize) ||
    numericAskSize < 0
  ) {
    return "n/a";
  }

  return `${formatWholeNumber(numericBidSize)}/${formatWholeNumber(numericAskSize)}`;
}

function toOptionalNumber(value, fallback = null) {
  if (value == null) {
    return fallback;
  }

  if (typeof value === "string" && value.trim() === "") {
    return fallback;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function isShortTradeAction(action) {
  const normalized = String(action ?? "").trim().toLowerCase();
  return normalized.includes("sell") || normalized.includes("short");
}

function normalizeStrategyDirection(value) {
  return String(value ?? "").trim().toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function inferStrategyDirection(strategyType) {
  const normalized = String(strategyType ?? "").trim().toLowerCase();
  if (normalized.startsWith("short")) {
    return "SHORT";
  }

  if (normalized.startsWith("long")) {
    return "LONG";
  }

  return "LONG";
}

function formatStrategyTypeForDirection(strategyType, direction) {
  const normalizedDirection = normalizeStrategyDirection(direction);
  const raw = String(strategyType ?? "").trim();
  const rawLower = raw.toLowerCase();
  const baseLabel = rawLower.startsWith("long ") ? raw.slice(5) : rawLower.startsWith("short ") ? raw.slice(6) : raw;
  const prefix = normalizedDirection === "SHORT" ? "Short" : "Long";
  const core = baseLabel.trim();
  if (!core) {
    return prefix;
  }

  return `${prefix} ${core}`;
}

function invertPositionAction(action) {
  return String(action ?? "").trim().toUpperCase() === "SHORT" ? "LONG" : "SHORT";
}

function gcd(a, b) {
  const left = Math.max(Math.round(Number(a ?? 0) || 0), 0);
  const right = Math.max(Math.round(Number(b ?? 0) || 0), 0);
  if (!left) {
    return right;
  }

  if (!right) {
    return left;
  }

  let currentLeft = left;
  let currentRight = right;
  while (currentRight) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }

  return currentLeft;
}

function normalizeComboQuantityInput(value, fallback = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.max(Math.round(numericValue), 1);
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

  const stockExecution = position?.stockExecution ?? null;
  if (
    String(stockExecution?.status ?? "").trim().toLowerCase() === "pending_confirmation" &&
    String(stockExecution?.pendingReplyId ?? "").trim().length > 0
  ) {
    return {
      orderId,
      phase: "stock",
      messages: Array.isArray(stockExecution.pendingReplyMessages) ? stockExecution.pendingReplyMessages : []
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

function buildDeltaHedgePaperOrderPayload({
  row,
  strategyDefinition,
  purchaseDate,
  execution,
  comboQuantity
}) {
  if (!row) {
    return null;
  }

  const marketContext = row.marketContext ?? {};
  const normalizedComboQuantity = normalizeComboQuantityInput(comboQuantity, 1);
  const baseLegQuantity = Number(row.optionLegs?.[0]?.quantity ?? 1) || 1;

  return {
    strategyId: strategyDefinition?.id ?? "strategy-4",
    strategyName: strategyDefinition?.name ?? "Delta Hedge Scanner",
    strategySource: "Delta Hedge Scanner",
    combinationId: row.id,
    combinationLabel: `${row.symbol} · ${row.strategyType} · ${row.expiration}`,
    assetLabel: row.symbol,
    strategyType: row.strategyType,
    marketBias: "",
    marketBiasTone: "",
    maxProfit: null,
    maxLoss: row.straddleCost == null ? null : Number(row.straddleCost),
    maxProfitUnbounded: true,
    maxLossUnbounded: false,
    purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
    polymarketResolutionDate: row.expiration,
    strategyCloseDate: row.expiration,
    marketReferenceYesPrice: 0.5,
    hedgePlan: row.hedgePlan ?? null,
    monitoringEnabled: true,
    marketContext: {
      proxySymbol: marketContext.proxySymbol ?? row.symbol,
      underlyingSymbol: marketContext.underlyingSymbol ?? row.symbol,
      currentProxySpot: Number(marketContext.currentProxySpot ?? row.underlyingPrice ?? 0) || 0,
      currentUnderlyingSpot: Number(marketContext.currentUnderlyingSpot ?? row.underlyingPrice ?? 0) || 0,
      conversionRatio: Number(marketContext.conversionRatio ?? 1) || 1,
      targetUnderlyingValue: Number(marketContext.targetUnderlyingValue ?? row.underlyingPrice ?? 0) || 0,
      impliedVolatility: Number(marketContext.impliedVolatility ?? 0.24) || 0.24,
      riskFreeRate: Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425
    },
    legs: [
      ...(row.optionLegs ?? []).map((leg, index) => ({
        id: `${row.id}-leg-${index + 1}`,
        label: `${row.symbol} ${leg.expiration} ${leg.strike} ${String(leg.optionType ?? "call").toUpperCase()}`,
        kind: "option",
        action: leg.action,
        quantity: Math.max(Math.round((Number(leg.quantity ?? baseLegQuantity) || 1) * normalizedComboQuantity), 1),
        entryPrice: Number(leg.entryPrice ?? 0),
        contractMultiplier: Number(leg.contractMultiplier ?? 100) || 100,
        optionType: leg.optionType ?? "call",
        expiry: leg.expiration ?? row.expiration ?? "",
        strike: Number(leg.strike ?? 0),
        contractSymbol: leg.contractSymbol ?? "",
        rootSymbol: leg.rootSymbol ?? row.symbol,
        bid: leg.bid ?? null,
        ask: leg.ask ?? null,
        bidSize: leg.bidSize ?? null,
        askSize: leg.askSize ?? null,
        volume: leg.volume ?? null,
        openInterest: leg.openInterest ?? null,
        impliedVolatility: Number(leg.impliedVolatility ?? marketContext.impliedVolatility ?? 0.24) || 0.24,
        riskFreeRate: Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425,
        quoteSource: leg.quoteSource ?? "Delta hedge scan",
        isLive: leg.isLive === true
      }))
    ],
    execution:
      execution && typeof execution === "object"
        ? execution
        : {
            route: "local-paper"
          }
  };
}

function compareRows(left, right, sortKey, sortDirection) {
  const leftValue = left?.[sortKey];
  const rightValue = right?.[sortKey];

  if (typeof leftValue === "string" || typeof rightValue === "string") {
    const comparison = String(leftValue ?? "").localeCompare(String(rightValue ?? ""));
    return sortDirection === "asc" ? comparison : -comparison;
  }

  const numericLeft = Number(leftValue);
  const numericRight = Number(rightValue);
  if (!Number.isFinite(numericLeft) && !Number.isFinite(numericRight)) {
    return 0;
  }
  if (!Number.isFinite(numericLeft)) {
    return 1;
  }
  if (!Number.isFinite(numericRight)) {
    return -1;
  }

  return sortDirection === "asc" ? numericLeft - numericRight : numericRight - numericLeft;
}

function getQuoteQualityPillClass(value) {
  if (value === "NBBO") {
    return "pill pill--live";
  }
  if (value === "Live feed") {
    return "pill pill--warning";
  }
  return "pill pill--ghost";
}

const columns = [
  { key: "compositeScore", label: "Score" },
  { key: "opportunityStrategy", label: "Strategy" },
  { key: "symbol", label: "Ticker" },
  { key: "underlyingPrice", label: "Spot" },
  { key: "expiration", label: "Expiry" },
  { key: "daysToExpiry", label: "DTE" },
  { key: "strike", label: "Strike" },
  { key: "straddleCost", label: "Straddle" },
  { key: "impliedMovePct", label: "Implied move" },
  { key: "deltaChangeForOnePctMove", label: "Delta shift / 1%" },
  { key: "dailyBreakevenMovePct", label: "1d breakeven" },
  { key: "thetaBurnPctPerDay", label: "Theta burn" },
  { key: "spreadPct", label: "Spread" },
  { key: "liquidityScore", label: "Liquidity" },
  { key: "quoteQuality", label: "Quotes" }
];

const DELTA_HEDGE_COMPACT_MEDIA_QUERY = "(max-width: 1240px)";
const DELTA_HEDGE_COMPACT_COLUMN_KEYS = [
  "compositeScore",
  "opportunityStrategy",
  "symbol",
  "underlyingPrice",
  "expiration",
  "daysToExpiry",
  "strike",
  "straddleCost",
  "dailyBreakevenMovePct",
  "thetaBurnPctPerDay",
  "liquidityScore",
  "quoteQuality"
];

function matchesDeltaHedgeCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(DELTA_HEDGE_COMPACT_MEDIA_QUERY).matches;
}

function getDefaultDeltaHedgeVisibleColumnKeys(isCompactViewport = false) {
  if (isCompactViewport) {
    return DELTA_HEDGE_COMPACT_COLUMN_KEYS.filter((key) => columns.some((column) => column.key === key));
  }

  return columns.map((column) => column.key);
}

const MAX_SORT_PRIORITIES = 4;
const DELTA_HEDGE_FILTERS_STORAGE_KEY = "hedgehub:filters:delta-hedge";

function buildScenarioOrderFromDeltaRow(row, generatedAt) {
  if (!row) {
    return null;
  }

  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const marketContext = row.marketContext ?? {};
  const riskFreeRate = Number(marketContext.riskFreeRate ?? 0.0425) || 0.0425;
  const impliedVolatility = Number(marketContext.impliedVolatility ?? 0.24) || 0.24;

  return {
    strategyId: "strategy-4",
    strategyName: "Delta Hedge Scanner",
    id: row.id,
    combinationLabel: `${row.symbol} · ${row.strategyType} · ${row.expiration}`,
    assetLabel: row.symbol,
    strategyType: row.strategyType,
    purchaseDate,
    createdAt: generatedAt ?? null,
    closedAt: "",
    status: "open",
    polymarketMarketId: "",
    polymarketQuestion: `${row.symbol} delta hedge`,
    polymarketUrl: "",
    strategyCloseDate: row.expiration,
    polymarketResolutionDate: row.expiration,
    marketReferenceYesPrice: 0.5,
    valuationContext: {
      proxySymbol: marketContext.proxySymbol ?? row.symbol,
      underlyingSymbol: marketContext.underlyingSymbol ?? row.symbol,
      currentProxySpot: Number(marketContext.currentProxySpot ?? row.underlyingPrice ?? 0),
      currentUnderlyingSpot: Number(marketContext.currentUnderlyingSpot ?? row.underlyingPrice ?? 0),
      conversionRatio: Number(marketContext.conversionRatio ?? 1) || 1,
      targetUnderlyingValue: Number(marketContext.targetUnderlyingValue ?? row.underlyingPrice ?? 0),
      currentYesPrice: 0.5
    },
    legs: (row.optionLegs ?? []).map((leg, index) => ({
      id: `${row.id}:option:${index}`,
      label: `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}`,
      kind: "option",
      action: leg.action,
      quantity: Number(leg.quantity ?? 1),
      entryPrice: Number(leg.entryPrice ?? 0),
      contractMultiplier: Number(leg.contractMultiplier ?? 100),
      optionType: leg.optionType ?? "call",
      expiry: leg.expiration ?? row.expiration,
      strike: Number(leg.strike ?? 0),
      contractSymbol: leg.contractSymbol ?? "",
      rootSymbol: leg.rootSymbol ?? row.symbol,
      impliedVolatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
      riskFreeRate: Number(riskFreeRate) || 0.0425,
      quoteSource: leg.quoteSource ?? (leg.isLive === true ? "live" : "modeled"),
      isLive: leg.isLive === true
    }))
  };
}

export default function DeltaHedgeScannerWorkspace({
  strategyDefinition,
  paperPortfolio = null,
  onCreatePaperOrder = null,
  onConfirmPaperExecution = null,
  onOpenPaperTrading = null,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [tickerDraft, setTickerDraft] = useState("");
  const [tickerBusy, setTickerBusy] = useState(false);
  const [tickerFeedback, setTickerFeedback] = useState(null);
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [strategyDirection, setStrategyDirection] = useState("LONG");
  const [selectedQuoteQualities, setSelectedQuoteQualities] = useState([]);
  const [minLiquidity, setMinLiquidity] = useState("40");
  const [maxBreakevenMovePct, setMaxBreakevenMovePct] = useState("");
  const [maxThetaBurnPct, setMaxThetaBurnPct] = useState("");
  const [sortState, setSortState] = useState([{ key: "compositeScore", direction: "desc" }]);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(() =>
    getDefaultDeltaHedgeVisibleColumnKeys(matchesDeltaHedgeCompactViewport())
  );
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperComboQuantity, setPaperComboQuantity] = useState(1);
  const [paperComboQuantityInput, setPaperComboQuantityInput] = useState("1");
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);
  const [fundamentalsError, setFundamentalsError] = useState("");
  const [fundamentals, setFundamentals] = useState(null);
  const hasHydratedSavedFiltersRef = useRef(false);

  async function loadScan(force = false) {
    const nextRefreshing = payload != null;
    if (nextRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");

    try {
      const response = await fetch(`/api/strategies/strategy-4/scan${force ? "?force=true" : ""}`);
      const json = await response.json();

      if (!response.ok) {
        throw new Error(json.error || "Unable to load delta hedge rows");
      }

      setPayload(json);
      setSelectedRowId((current) => current || json.selectedRowId || json.rows?.[0]?.id || null);
      setDetailCollapsed(false);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadScan(false);
  }, []);

  useEffect(() => {
    const quoteQualities = payload?.filters?.quoteQualities ?? [];
    setSelectedQuoteQualities((current) => {
      const next = current.filter((quality) => quoteQualities.includes(quality));
      return next.length ? next : quoteQualities;
    });
  }, [payload?.filters?.quoteQualities]);

  useEffect(() => {
    if (!payload || hasHydratedSavedFiltersRef.current) {
      return;
    }

    const savedFilters = loadSavedFilters(DELTA_HEDGE_FILTERS_STORAGE_KEY);
    if (savedFilters) {
      const quoteQualities = payload?.filters?.quoteQualities ?? [];

      if (Array.isArray(savedFilters.selectedQuoteQualities)) {
        const nextQualities = savedFilters.selectedQuoteQualities.filter((quality) => quoteQualities.includes(quality));
        setSelectedQuoteQualities(nextQualities.length ? nextQualities : quoteQualities);
      }

      setMinLiquidity(typeof savedFilters.minLiquidity === "string" ? savedFilters.minLiquidity : "40");
      setMaxBreakevenMovePct(
        typeof savedFilters.maxBreakevenMovePct === "string" ? savedFilters.maxBreakevenMovePct : ""
      );
      setMaxThetaBurnPct(typeof savedFilters.maxThetaBurnPct === "string" ? savedFilters.maxThetaBurnPct : "");
      if (Array.isArray(savedFilters.visibleColumnKeys)) {
        const nextVisibleColumnKeys = columns
          .map((column) => column.key)
          .filter((key) => savedFilters.visibleColumnKeys.includes(key));
        setVisibleColumnKeys(
          nextVisibleColumnKeys.length
            ? nextVisibleColumnKeys
            : getDefaultDeltaHedgeVisibleColumnKeys(matchesDeltaHedgeCompactViewport())
        );
      }
    }

    hasHydratedSavedFiltersRef.current = true;
  }, [payload]);

  const opportunityRows = useMemo(() => {
    const deltaRows = (payload?.rows ?? []).map((row) => ({
      ...row,
      opportunityKind: "delta-hedge",
      opportunityStrategy: "ATM straddle"
    }));

    const volatilityRows = payload?.volatilityOpportunity?.rows ?? [];
    const rawScores = volatilityRows
      .map((row) => Number(row?.compositeScore ?? NaN))
      .filter((value) => Number.isFinite(value) && value > 0);
    const maxScore = rawScores.length ? Math.max(...rawScores) : null;

    const universeBySymbol = new Map((payload?.stockUniverse ?? []).map((stock) => [stock.symbol, stock]));
    const deltaUniverseRowsBySymbol = new Map();
    for (const row of payload?.universeRows ?? []) {
      const symbol = String(row?.symbol ?? "").trim().toUpperCase();
      if (!symbol) {
        continue;
      }

      const existing = deltaUniverseRowsBySymbol.get(symbol);
      if (!existing) {
        deltaUniverseRowsBySymbol.set(symbol, row);
        continue;
      }

      const existingScore = Number(existing?.compositeScore ?? Number.NEGATIVE_INFINITY);
      const rowScore = Number(row?.compositeScore ?? Number.NEGATIVE_INFINITY);
      if (
        (Number.isFinite(rowScore) && !Number.isFinite(existingScore)) ||
        (Number.isFinite(rowScore) && Number.isFinite(existingScore) && rowScore > existingScore)
      ) {
        deltaUniverseRowsBySymbol.set(symbol, row);
      }
    }

    const mappedVolRows = volatilityRows.map((row) => {
      const symbol = String(row?.symbol ?? "").trim().toUpperCase();
      const universeRow = deltaUniverseRowsBySymbol.get(symbol) ?? null;
      const companyName =
        String(universeBySymbol.get(symbol)?.label ?? universeRow?.companyName ?? "").trim() || symbol;
      const rawScore = toOptionalNumber(row?.compositeScore, null);
      const normalizedScore =
        rawScore != null && maxScore != null && maxScore > 0
          ? Math.min(Math.max((rawScore / maxScore) * 100, 0), 100)
          : null;

      return {
        ...(universeRow ?? {
          id: row?.id ?? `vol-opportunity:${symbol}`,
          symbol,
          companyName,
          strategyType: "Spot vs expectations",
          optionLegs: []
        }),
        id: row?.id ?? `vol-opportunity:${symbol}`,
        strategyType: "Spot vs expectations",
        opportunityKind: "spot-vs-expectations",
        opportunityStrategy: "Spot vs expectations",
        compositeScore: normalizedScore != null ? Number(normalizedScore.toFixed(2)) : universeRow?.compositeScore ?? null,
        volatilityOpportunity: row ?? null
      };
    });

    return [...deltaRows, ...mappedVolRows];
  }, [payload]);

  const filteredOpportunityRows = useMemo(() => {
    const minLiquidityThreshold = toOptionalNumber(minLiquidity, null);
    const maxBreakevenThreshold = toOptionalNumber(maxBreakevenMovePct, null);
    const maxThetaBurnThreshold = toOptionalNumber(maxThetaBurnPct, null);

    return opportunityRows.filter((row) => {
      const quoteQuality = String(row?.quoteQuality ?? "").trim();

      return (
        (!selectedQuoteQualities.length || selectedQuoteQualities.includes(quoteQuality)) &&
        (minLiquidityThreshold == null || Number(row.liquidityScore ?? 0) >= minLiquidityThreshold) &&
        (maxBreakevenThreshold == null ||
          row.dailyBreakevenMovePct == null ||
          Number(row.dailyBreakevenMovePct ?? Number.POSITIVE_INFINITY) <= maxBreakevenThreshold) &&
        (maxThetaBurnThreshold == null ||
          row.thetaBurnPctPerDay == null ||
          Number(row.thetaBurnPctPerDay ?? Number.POSITIVE_INFINITY) <= maxThetaBurnThreshold)
      );
    });
  }, [maxBreakevenMovePct, maxThetaBurnPct, minLiquidity, opportunityRows, selectedQuoteQualities]);

  const sortedOpportunityRows = useMemo(
    () =>
      [...filteredOpportunityRows].sort((left, right) => {
        for (const sortDescriptor of sortState) {
          if (!sortDescriptor?.key) {
            continue;
          }

          const direction = sortDescriptor.direction === "asc" ? "asc" : "desc";
          const comparedValue = compareRows(left, right, sortDescriptor.key, direction);
          if (comparedValue !== 0) {
            return comparedValue;
          }
        }

        return compareRows(left, right, "id", "asc");
      }),
    [filteredOpportunityRows, sortState]
  );
  const visibleColumns = useMemo(() => {
    const nextColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
    return nextColumns.length ? nextColumns : [columns[0]];
  }, [visibleColumnKeys]);
  const deltaHedgeTableMinWidth = useMemo(
    () => `${Math.max(visibleColumns.length * 140, 280)}px`,
    [visibleColumns.length]
  );

  useEffect(() => {
    if (!sortedOpportunityRows.length) {
      setSelectedRowId(null);
      setDetailCollapsed(false);
      return;
    }

    if (!sortedOpportunityRows.some((row) => row.id === selectedRowId)) {
      setSelectedRowId(sortedOpportunityRows[0].id);
      setDetailCollapsed(false);
    }
  }, [selectedRowId, sortedOpportunityRows]);

  const selectedRow = sortedOpportunityRows.find((row) => row.id === selectedRowId) ?? null;
  const baseStrategyDirection = inferStrategyDirection(selectedRow?.strategyType);
  const strategyTypeLabel = formatStrategyTypeForDirection(selectedRow?.strategyType, strategyDirection);
  const shouldInvertStrategy =
    normalizeStrategyDirection(strategyDirection) !== normalizeStrategyDirection(baseStrategyDirection);
  const directedOptionLegs = useMemo(() => {
    const legs = Array.isArray(selectedRow?.optionLegs) ? selectedRow.optionLegs : [];
    if (!legs.length || !shouldInvertStrategy) {
      return legs;
    }

    return legs.map((leg) => ({
      ...leg,
      action: invertPositionAction(leg.action)
    }));
  }, [selectedRow?.optionLegs, shouldInvertStrategy]);
  const directedSelectedRow = useMemo(() => {
    if (!selectedRow) {
      return null;
    }

    return {
      ...selectedRow,
      strategyType: strategyTypeLabel,
      optionLegs: directedOptionLegs
    };
  }, [directedOptionLegs, selectedRow, strategyTypeLabel]);

  useEffect(() => {
    if (!selectedRow) {
      return;
    }

    setStrategyDirection((current) => {
      const next = inferStrategyDirection(selectedRow.strategyType);
      return normalizeStrategyDirection(current) === next ? current : next;
    });
  }, [selectedRow?.id]);
  const selectedScenarioOrder = useMemo(
    () => buildScenarioOrderFromDeltaRow(directedSelectedRow, payload?.generatedAt),
    [directedSelectedRow, payload?.generatedAt]
  );
  const normalizedComboQuantity = useMemo(
    () => normalizeComboQuantityInput(paperComboQuantity, 1),
    [paperComboQuantity]
  );
  const scaledScenarioOrder = useMemo(() => {
    if (!selectedScenarioOrder) {
      return null;
    }

    if (normalizedComboQuantity === 1) {
      return selectedScenarioOrder;
    }

    return {
      ...selectedScenarioOrder,
      legs: (selectedScenarioOrder.legs ?? []).map((leg) => {
        if (leg?.kind !== "option") {
          return leg;
        }

        const baseQuantity = Number(leg.quantity ?? 0) || 0;
        return {
          ...leg,
          quantity: Math.max(Math.round(baseQuantity * normalizedComboQuantity), 1)
        };
      })
    };
  }, [normalizedComboQuantity, selectedScenarioOrder]);
  const scaledNetDeltaShares = useMemo(() => {
    const netDelta = Number(selectedRow?.netDeltaShares ?? NaN);
    if (!Number.isFinite(netDelta)) {
      return null;
    }

    return netDelta * normalizedComboQuantity;
  }, [normalizedComboQuantity, selectedRow?.netDeltaShares]);
  const selectedHedgePlan = useMemo(() => {
    if (!selectedRow || selectedRow.opportunityKind !== "delta-hedge") {
      return null;
    }

    return selectedRow.hedgePlan ?? null;
  }, [selectedRow]);
  const hedgeThresholdShares = useMemo(() => {
    if (!selectedHedgePlan) {
      return null;
    }

    const perContract = Number(selectedHedgePlan.deltaThresholdSharesPerContract ?? 10);
    if (!Number.isFinite(perContract) || perContract <= 0) {
      return null;
    }

    return perContract * normalizedComboQuantity;
  }, [normalizedComboQuantity, selectedHedgePlan]);
  const hedgePriceMoveThresholdPct = useMemo(() => {
    if (!selectedHedgePlan) {
      return null;
    }

    const threshold = Number(selectedHedgePlan.priceMoveThresholdPct ?? 0.01);
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return null;
    }

    return threshold;
  }, [selectedHedgePlan]);
  const hedgeExitDteDays = useMemo(() => {
    if (!selectedHedgePlan) {
      return null;
    }

    const threshold = Number(selectedHedgePlan.exitDteDays ?? 3);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return null;
    }

    return Math.round(threshold);
  }, [selectedHedgePlan]);
  const purchasePreview = useMemo(() => {
    if (!directedSelectedRow) {
      return null;
    }

    const optionRows = (directedSelectedRow.optionLegs ?? []).map((leg, index) => {
      const isShort = isShortTradeAction(leg.action);
      const baseQuantity = toOptionalNumber(leg.quantity, 1) ?? 1;
      const scaledQuantity = Math.max(Math.round(baseQuantity * normalizedComboQuantity), 1);
      const multiplier = toOptionalNumber(leg.contractMultiplier, 100) ?? 100;
      const fillPrice =
        !isShort
          ? toOptionalNumber(leg.ask, null) ??
            toOptionalNumber(leg.entryPrice, null) ??
            toOptionalNumber(leg.bid, null)
          : toOptionalNumber(leg.bid, null) ??
            toOptionalNumber(leg.entryPrice, null) ??
            toOptionalNumber(leg.ask, null);

      const cost =
        fillPrice == null || multiplier == null
          ? null
          : (isShort ? -1 : 1) * fillPrice * multiplier * scaledQuantity;

      return {
        id: `${directedSelectedRow.id}:purchase:${index}`,
        kind: "option",
        label: `${String(leg.optionType ?? "").toUpperCase()} ${formatCurrency(leg.strike)} · ${leg.expiration ?? directedSelectedRow.expiration}`,
        action: isShort ? "Sell" : "Buy",
        quantity: scaledQuantity,
        price: fillPrice,
        multiplier,
        cost
      };
    });

    const optionsCost =
      optionRows.length && optionRows.every((row) => Number.isFinite(row.cost))
        ? optionRows.reduce((total, row) => total + row.cost, 0)
        : null;

    const totalCost = optionsCost;

    return {
      optionsCost,
      totalCost,
      optionRows
    };
  }, [directedSelectedRow, normalizedComboQuantity]);
  const executionQualityContracts = useMemo(
    () =>
      (directedSelectedRow?.optionLegs ?? [])
        .filter((leg) => String(leg?.contractSymbol ?? "").trim())
        .map((leg, index) => ({
          contractSymbol: String(leg.contractSymbol).trim(),
          label:
            leg.contractSymbol ||
            `${selectedRow?.symbol || "Option"} ${index + 1} · ${formatCurrency(leg.strike)} · ${leg.expiration || "n/a"}`
        })),
    [directedSelectedRow?.optionLegs, selectedRow?.symbol]
  );
  const marketTimerContext = useMemo(() => {
    if (!selectedRow) {
      return null;
    }

    return createMarketTimerContext({
      source: "delta-hedge",
      label: selectedRow.symbol,
      optionSymbol: selectedRow.optionLegs?.[0]?.rootSymbol ?? selectedRow.symbol,
      underlyingSymbol: selectedRow.marketContext?.underlyingSymbol ?? selectedRow.symbol,
      referenceSymbol: selectedRow.symbol,
      optionExpiries: [
        selectedRow.expiration,
        ...(selectedRow.optionLegs ?? []).map((leg) => leg.expiration)
      ],
      exerciseStyle: "american",
      settlementType: "physical"
    });
  }, [selectedRow]);

  useEffect(() => {
    if (!onMarketTimerContextChange) {
      return undefined;
    }

    onMarketTimerContextChange(marketTimerContext);
    return () => {
      onMarketTimerContextChange(null);
    };
  }, [marketTimerContext, onMarketTimerContextChange]);

  useEffect(() => {
    setPaperOrderSaving(false);
    setPaperOrderState(null);
    setPaperTradeDate(selectedScenarioOrder?.purchaseDate ?? new Date().toISOString().slice(0, 10));
    setPaperComboQuantity(1);
    setPaperComboQuantityInput("1");
  }, [selectedRow?.id]);

  useEffect(() => {
    if (!selectedRow?.symbol) {
      setFundamentals(null);
      setFundamentalsError("");
      setFundamentalsLoading(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    async function loadFundamentals() {
      setFundamentalsLoading(true);
      setFundamentalsError("");

      try {
        const response = await fetch(`/api/stocks/${encodeURIComponent(selectedRow.symbol)}/fundamentals`, {
          signal: controller.signal
        });
        const json = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(json?.error || "Unable to load fundamentals");
        }

        if (!cancelled) {
          setFundamentals(json);
        }
      } catch (error) {
        if (!cancelled && error.name !== "AbortError") {
          setFundamentalsError(error.message);
          setFundamentals(null);
        }
      } finally {
        if (!cancelled) {
          setFundamentalsLoading(false);
        }
      }
    }

    void loadFundamentals();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [selectedRow?.symbol]);

  function handleStrategyDirectionChange(nextDirection) {
    const normalizedNextDirection = normalizeStrategyDirection(nextDirection);
    const normalizedCurrentDirection = normalizeStrategyDirection(strategyDirection);
    if (normalizedNextDirection === normalizedCurrentDirection) {
      return;
    }

    setStrategyDirection(normalizedNextDirection);
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

  async function handleCreatePaperTrade() {
    if (!directedSelectedRow || !onCreatePaperOrder) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      const execution = {
        route: "local-paper"
      };
      const createResponse = await onCreatePaperOrder(
        buildDeltaHedgePaperOrderPayload({
          row: directedSelectedRow,
          strategyDefinition,
          purchaseDate: paperTradeDate || new Date().toISOString().slice(0, 10),
          execution,
          comboQuantity: paperComboQuantity
        })
      );
      const pendingConfirmation = getPendingConfirmation(createResponse?.order);

      setPaperOrderState({
        tone: pendingConfirmation ? "warning" : "success",
        message: createResponse?.message || "Order saved to paper trading.",
        confirmation: pendingConfirmation
      });
    } catch (error) {
      setPaperOrderState({
        tone: "error",
        message: error.message,
        confirmation: null
      });
    } finally {
      setPaperOrderSaving(false);
    }
  }

  async function handlePaperExecutionConfirmation(confirmed) {
    const pendingConfirmation = paperOrderState?.confirmation;
    if (!pendingConfirmation?.orderId || !onConfirmPaperExecution) {
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
      setPaperOrderState((current) => ({
        tone: "error",
        message: error.message,
        confirmation: current?.confirmation ?? null
      }));
    } finally {
      setPaperOrderSaving(false);
    }
  }

  function toggleQuoteQuality(quality) {
    setSelectedQuoteQualities((current) => {
      if (current.includes(quality)) {
        return current.length === 1 ? current : current.filter((item) => item !== quality);
      }

      return [...current, quality];
    });
  }

  function handleSort(columnKey, options = {}) {
    const isAdditive = options.additive === true;

    setSortState((current) => {
      const currentSortState = Array.isArray(current) ? current : [];
      const existingIndex = currentSortState.findIndex((sortDescriptor) => sortDescriptor?.key === columnKey);
      const existingDescriptor = existingIndex >= 0 ? currentSortState[existingIndex] : null;
      const hasSingleActiveSort = existingIndex === 0 && currentSortState.length === 1;

      if (!isAdditive) {
        if (hasSingleActiveSort) {
          const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
          return [{ key: columnKey, direction }];
        }

        const direction = existingDescriptor?.direction === "asc" ? "asc" : "desc";
        return [{ key: columnKey, direction }];
      }

      if (existingIndex >= 0) {
        const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
        const nextSortState = [...currentSortState];
        nextSortState[existingIndex] = { key: columnKey, direction };
        return nextSortState;
      }

      const nextSortState =
        currentSortState.length >= MAX_SORT_PRIORITIES
          ? currentSortState.slice(0, MAX_SORT_PRIORITIES - 1)
          : currentSortState;

      return [...nextSortState, { key: columnKey, direction: "desc" }];
    });
  }

  function handleRowSelect(rowId) {
    setSelectedRowId(rowId);
    setDetailCollapsed(false);
  }

  function toggleVisibleColumn(columnKey) {
    setVisibleColumnKeys((current) => {
      if (current.includes(columnKey)) {
        return current.length === 1 ? current : current.filter((key) => key !== columnKey);
      }

      return columns.map((column) => column.key).filter((key) => key === columnKey || current.includes(key));
    });
  }

  function showAllColumns() {
    setVisibleColumnKeys(columns.map((column) => column.key));
  }

  function showCompactColumns() {
    setVisibleColumnKeys(getDefaultDeltaHedgeVisibleColumnKeys(true));
  }

  function resetFilters() {
    setSelectedQuoteQualities(payload?.filters?.quoteQualities ?? []);
    setMinLiquidity("40");
    setMaxBreakevenMovePct("");
    setMaxThetaBurnPct("");
    setVisibleColumnKeys(getDefaultDeltaHedgeVisibleColumnKeys(matchesDeltaHedgeCompactViewport()));
  }

  function saveFilters() {
    persistSavedFilters(DELTA_HEDGE_FILTERS_STORAGE_KEY, {
      selectedQuoteQualities,
      minLiquidity,
      maxBreakevenMovePct,
      maxThetaBurnPct,
      visibleColumnKeys
    });
  }

  function renderOpportunityCell(row, columnKey) {
    switch (columnKey) {
      case "compositeScore":
        return formatNumber(row.compositeScore);
      case "opportunityStrategy":
        return row.opportunityStrategy;
      case "symbol":
        return (
          <div className="finder-cell-stack">
            <strong>{row.symbol}</strong>
            <span className="screening-v2__subtle">{row.companyName}</span>
          </div>
        );
      case "underlyingPrice":
        return formatCurrency(row.underlyingPrice);
      case "expiration":
        return row.expiration;
      case "daysToExpiry":
        return formatWholeNumber(row.daysToExpiry);
      case "strike":
        return formatCurrency(row.strike);
      case "straddleCost":
        return formatCurrency(row.straddleCost);
      case "impliedMovePct":
        return formatPercent(row.impliedMovePct);
      case "deltaChangeForOnePctMove":
        return formatNumber(row.deltaChangeForOnePctMove);
      case "dailyBreakevenMovePct":
        return formatPercent(row.dailyBreakevenMovePct);
      case "thetaBurnPctPerDay":
        return formatPercent(row.thetaBurnPctPerDay);
      case "spreadPct":
        return formatPercent(row.spreadPct);
      case "liquidityScore":
        return formatNumber(row.liquidityScore);
      case "quoteQuality":
        return row.quoteQuality;
      default:
        return "";
    }
  }

  async function handleAddTicker() {
    const symbol = tickerDraft.trim().toUpperCase();
    if (!symbol) {
      setTickerFeedback({
        tone: "error",
        message: "Enter a stock ticker first."
      });
      return;
    }

    setTickerBusy(true);
    setTickerFeedback(null);
    try {
      const response = await fetch("/api/strategies/strategy-4/tickers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ symbol })
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to add stock ticker");
      }

      setTickerDraft("");
      setTickerFeedback({
        tone: "success",
        message: `Added ${symbol} to the scanner universe.`
      });
      await loadScan(true);
    } catch (tickerError) {
      setTickerFeedback({
        tone: "error",
        message: tickerError.message
      });
    } finally {
      setTickerBusy(false);
    }
  }

  async function handleRemoveTicker(symbol) {
    setTickerBusy(true);
    setTickerFeedback(null);
    try {
      const response = await fetch(`/api/strategies/strategy-4/tickers/${encodeURIComponent(symbol)}`, {
        method: "DELETE"
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to remove stock ticker");
      }

      setTickerFeedback({
        tone: "success",
        message: `Removed ${symbol} from the custom scanner universe.`
      });
      await loadScan(true);
    } catch (tickerError) {
      setTickerFeedback({
        tone: "error",
        message: tickerError.message
      });
    } finally {
      setTickerBusy(false);
    }
  }

  if (loading) {
    return <div className="app-state">Loading delta hedge scanner…</div>;
  }

  if (error) {
    return <div className="app-state">{error}</div>;
  }

  return (
    <main className="workspace workspace--screening-v2 workspace--delta-hedge">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Delta Hedge Scanner</span>
          <h2>{strategyDefinition?.name ?? "Stock delta hedge scanner"}</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{payload?.summary?.candidates ?? 0} candidates</span>
            <span className="pill pill--ghost">{payload?.summary?.liveCandidates ?? 0} live</span>
          </div>
          <button type="button" className="finder-action" onClick={() => loadScan(true)} disabled={refreshing}>
            {refreshing ? "Refreshing…" : "Refresh scan"}
          </button>
        </div>
      </header>

      {payload?.warnings?.length ? (
        <div className="warning-strip">
          {payload.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      <section className="screening-v2__summary-grid">
        <article className="insight-card screening-v2__summary-card">
          <span>Symbols scanned</span>
          <strong>{payload?.summary?.symbolsScanned ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Live candidates</span>
          <strong>{payload?.summary?.liveCandidates ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg liquidity</span>
          <strong>{formatNumber(payload?.summary?.averageLiquidityScore, 1)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg 1d breakeven</span>
          <strong>{formatPercent(payload?.summary?.averageBreakevenMovePct)}</strong>
        </article>
      </section>

      <article className="insight-card screening-v2__filters">
        <div className="strategy-settings__page-head">
          <div>
            <span className="brand__eyebrow">Scanner Universe</span>
            <h3>Add stock tickers</h3>
          </div>
          <p className="card-copy">
            Add more U.S. optionable names to this scan. Custom tickers are persisted and scanned alongside the
            default watchlist.
          </p>
        </div>

        {tickerFeedback ? (
          <div className={`refresh-feedback refresh-feedback--${tickerFeedback.tone}`}>
            <span>{tickerFeedback.message}</span>
          </div>
        ) : null}

        <div className="delta-hedge__ticker-form">
          <label className="delta-hedge__ticker-input">
            <span>Ticker</span>
            <input
              value={tickerDraft}
              placeholder="TSM"
              onChange={(event) => setTickerDraft(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleAddTicker();
                }
              }}
            />
          </label>
          <button type="button" className="finder-action" onClick={handleAddTicker} disabled={tickerBusy}>
            {tickerBusy ? "Saving…" : "Add ticker"}
          </button>
        </div>

        <div className="delta-hedge__ticker-list">
          {(payload?.stockUniverse ?? []).map((stock) => (
            <div key={stock.symbol} className={`delta-hedge__ticker-chip ${stock.isCustom ? "delta-hedge__ticker-chip--custom" : ""}`}>
              <div className="finder-cell-stack">
                <strong>{stock.symbol}</strong>
                <span className="screening-v2__subtle">{stock.label}</span>
              </div>
              {stock.isCustom ? (
                <button
                  type="button"
                  className="delta-hedge__ticker-remove"
                  onClick={() => handleRemoveTicker(stock.symbol)}
                  disabled={tickerBusy}
                  aria-label={`Remove ${stock.symbol}`}
                >
                  Remove
                </button>
              ) : (
                <span className="pill pill--ghost">Default</span>
              )}
            </div>
          ))}
        </div>
      </article>

      <article className="insight-card screening-v2__filters">
        <div className="strategy-settings__page-head">
          <div>
            <span className="brand__eyebrow">Filters</span>
            <h3>Focus on hedgeable names</h3>
          </div>
          <p className="card-copy">
            This scan ranks ATM straddles on your screenshot watchlist by liquidity, gamma response, and one-day theta
            break-even move.
          </p>
        </div>

        <div className="screening-v2__filter-grid">
          <label>
            <span>Min liquidity</span>
            <input value={minLiquidity} onChange={(event) => setMinLiquidity(event.target.value)} />
          </label>
          <label>
            <span>Max 1d breakeven %</span>
            <input value={maxBreakevenMovePct} onChange={(event) => setMaxBreakevenMovePct(event.target.value)} />
          </label>
          <label>
            <span>Max theta burn %</span>
            <input value={maxThetaBurnPct} onChange={(event) => setMaxThetaBurnPct(event.target.value)} />
          </label>
        </div>

        <div className="screening-v2__pill-row">
          {(payload?.filters?.quoteQualities ?? []).map((quality) => (
            <button
              key={quality}
              type="button"
              className={`finder-action ${selectedQuoteQualities.includes(quality) ? "tv-finder__filter-control--active" : ""}`}
              onClick={() => toggleQuoteQuality(quality)}
            >
              {quality}
            </button>
          ))}
          <button type="button" className="finder-action" onClick={saveFilters}>
            Save filters
          </button>
          <button type="button" className="finder-action" onClick={resetFilters}>
            Reset filters
          </button>
          <details className="finder-menu">
            <summary className="finder-control">
              <span>Columns</span>
            </summary>
            <div className="finder-menu__panel">
              <div className="finder-menu__header">
                <strong>Visible columns</strong>
                <div className="finder-menu__header-actions">
                  <button type="button" className="finder-menu__reset" onClick={showAllColumns}>
                    All
                  </button>
                  <button type="button" className="finder-menu__reset" onClick={showCompactColumns}>
                    Compact
                  </button>
                </div>
              </div>
              <div className="finder-menu__list">
                {columns.map((column) => {
                  const isActive = visibleColumnKeys.includes(column.key);
                  return (
                    <button
                      key={column.key}
                      type="button"
                      className={`finder-menu__option ${isActive ? "finder-menu__option--active" : ""}`}
                      onClick={() => toggleVisibleColumn(column.key)}
                      disabled={isActive && visibleColumnKeys.length === 1}
                    >
                      <span>{column.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </details>
        </div>
      </article>

      <section className="screening-v2__selected-layout">
        <article className="insight-card screening-v2__table-card">
          <div className="strategy-settings__page-head">
            <div>
              <span className="brand__eyebrow">OPPORTUNITY SCREENER</span>
              <h3>Ranked opportunities</h3>
            </div>
            <p className="card-copy">
              Combines delta-hedge ATM straddles with spot-vs-expectations volatility signals. Scores are indicators,
              not trade instructions.
            </p>
          </div>

          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table" style={{ minWidth: deltaHedgeTableMinWidth }}>
              <thead>
                <tr>
                  {visibleColumns.map((column) => (
                    <th key={column.key}>
                      <button
                        type="button"
                        title="Click to sort. Shift-click (or Ctrl/⌘-click) to add up to 4 sort priorities."
                        onClick={(event) =>
                          handleSort(column.key, {
                            additive: event.shiftKey || event.metaKey || event.ctrlKey
                          })
                        }
                      >
                        <span>{column.label}</span>
                        {(() => {
                          const sortIndex = sortState.findIndex(
                            (sortDescriptor) => sortDescriptor?.key === column.key
                          );
                          if (sortIndex < 0) {
                            return null;
                          }

                          const sortDescriptor = sortState[sortIndex];
                          const direction = sortDescriptor?.direction === "asc" ? "asc" : "desc";

                          return (
                            <span className="finder-sort__indicator" aria-hidden="true">
                              <span className="finder-sort__priority">{sortIndex + 1}</span>
                              <span className="finder-sort__direction">{direction === "asc" ? "↑" : "↓"}</span>
                            </span>
                          );
                        })()}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedOpportunityRows.length ? (
                  sortedOpportunityRows.map((row) => {
                    const isSelected = row.id === selectedRowId;

                    return (
                      <Fragment key={row.id}>
                        <tr
                          aria-expanded={isSelected && !detailCollapsed}
                          className={isSelected ? "screening-v2__table-row--active" : ""}
                          onClick={() => handleRowSelect(row.id)}
                        >
                          {visibleColumns.map((column) => (
                            <td key={`${row.id}:${column.key}`}>{renderOpportunityCell(row, column.key)}</td>
                          ))}
                        </tr>

                        {isSelected && !detailCollapsed ? (
                          <tr className="tv-finder__detail-row">
                            <td colSpan={visibleColumns.length} className="tv-finder__detail-cell">
                              <section className="selection-banner tv-finder__selection-banner">
                                <div className="selection-banner__title">
                                  <span className="brand__eyebrow">Selected setup</span>
                                  <strong>
                                    {row.symbol} · {row.strategyType} · {row.expiration}
                                  </strong>
                                </div>
                                <div className="selection-banner__actions">
                                  <div className="detail-badges">
                                    <span className={getQuoteQualityPillClass(row.quoteQuality)}>{row.quoteQuality}</span>
                                    <span className="pill pill--ghost">{formatWholeNumber(row.daysToExpiry)} DTE</span>
                                    <span className="pill pill--live">Score {formatNumber(row.compositeScore)}</span>
                                    {row.opportunityKind === "delta-hedge" ? (
                                      <span className="pill pill--ghost">Hedge plan: Dynamic</span>
                                    ) : null}
                                  </div>
                                  <button
                                    type="button"
                                    className={`chart-toggle ${!detailCollapsed ? "chart-toggle--active" : ""}`}
                                    aria-expanded={!detailCollapsed}
                                    onClick={() => setDetailCollapsed((current) => !current)}
                                  >
                                    Collapse details
                                  </button>
                                </div>
                              </section>

                              <div className="tv-finder__detail-stack">
                                {selectedRow ? (
                                  <>
                                    <div className="screening-v2__selected-top">
                                      <div className="screening-v2__selected-head">
                                          <div className="screening-v2__selected-copy">
                                            <span className="brand__eyebrow">Selected setup</span>
                                          <h3>{selectedRow.symbol} · {strategyTypeLabel}</h3>
                                          <p className="screening-v2__selected-question">
                                            {selectedRow.companyName} with {selectedRow.daysToExpiry} DTE and an ATM strike near{" "}
                                            {formatCurrency(selectedRow.strike)}.
                                          </p>
                                        </div>
                                        <div className="status-block__actions">
                                          <span className={getQuoteQualityPillClass(selectedRow.quoteQuality)}>{selectedRow.quoteQuality}</span>
                                          <span className="pill pill--ghost">{formatWholeNumber(selectedRow.daysToExpiry)} DTE</span>
                                        </div>
                                      </div>

                                      {paperOrderState ? (
                                        <div className={`refresh-feedback refresh-feedback--${paperOrderState.tone}`}>
                                          <span>{paperOrderState.message}</span>
                                          {paperOrderState.confirmation?.orderId ? (
                                            <div className="refresh-feedback__actions">
                                              <button
                                                type="button"
                                                className={`chart-toggle ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                                                onClick={() => handlePaperExecutionConfirmation(true)}
                                                disabled={paperOrderSaving || !onConfirmPaperExecution}
                                              >
                                                {paperOrderSaving ? "Working..." : "Submit anyway"}
                                              </button>
                                              <button
                                                type="button"
                                                className="chart-toggle"
                                                onClick={() => handlePaperExecutionConfirmation(false)}
                                                disabled={paperOrderSaving || !onConfirmPaperExecution}
                                              >
                                                Decline
                                              </button>
                                            </div>
                                          ) : null}
                                        </div>
                                      ) : null}

                                      <section className="paper-order-ticket">
                                        <div className="paper-order-ticket__copy">
                                          <div className="paper-order-ticket__headline">
                                            <span className="brand__eyebrow">Trade this setup</span>
                                            <strong className="paper-order-ticket__title">
                                              {selectedRow.symbol} · {strategyTypeLabel}
                                            </strong>
                                          </div>
                                          <div className="paper-order-ticket__status">
                                            <span className="pill pill--ghost">Local route</span>
                                            {selectedRow.opportunityKind === "delta-hedge" ? (
                                              <span className="pill pill--ghost">Hedge: Dynamic (no entry hedge)</span>
                                            ) : null}
                                          </div>
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
                                              value={strategyDirection}
                                              onChange={(event) => handleStrategyDirectionChange(event.target.value)}
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
                                                  key={`qty-preset:${preset}`}
                                                  type="button"
                                                  className={`chart-toggle chart-toggle--compact ${paperComboQuantity === preset ? "chart-toggle--active" : ""}`}
                                                  onClick={() => applyPaperComboQuantity(preset)}
                                                  disabled={!selectedRow}
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
                                            className={`finder-action ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                                            onClick={handleCreatePaperTrade}
                                            disabled={paperOrderSaving || !onCreatePaperOrder}
                                          >
                                            {paperOrderSaving ? "Saving..." : "Place order"}
                                          </button>
                                          {onOpenPaperTrading ? (
                                            <button type="button" className="chart-toggle" onClick={onOpenPaperTrading}>
                                              View holdings
                                            </button>
                                          ) : null}
                                        </div>
                                      </section>

                                      <div className="screening-v2__selected-grid">
                                        <div className="screening-v2__selected-panel">
                                          <h4>Core metrics</h4>
                                            <div className="summary-stack">
                                              <div className="summary-row">
                                                <span>Composite score</span>
                                                <strong>{formatNumber(selectedRow.compositeScore)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Spot / strike</span>
                                                <strong>{formatCurrency(selectedRow.underlyingPrice)} / {formatCurrency(selectedRow.strike)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Straddle cost</span>
                                                <strong>{formatCurrency(selectedRow.straddleCost)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Implied move to expiry</span>
                                                <strong>{formatCurrency(selectedRow.impliedMoveUsd)} ({formatPercent(selectedRow.impliedMovePct)})</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Option net delta{normalizedComboQuantity !== 1 ? ` (${normalizedComboQuantity}x)` : ""}</span>
                                                <strong>
                                                  {scaledNetDeltaShares == null
                                                    ? "n/a"
                                                    : `${scaledNetDeltaShares >= 0 ? "+" : ""}${formatNumber(scaledNetDeltaShares)} shares`}
                                                </strong>
                                              </div>
                                            </div>
                                          </div>

                                        <div className="delta-hedge__selected-stack">
                                          <div className="screening-v2__selected-panel">
                                            <h4>Hedge mechanics</h4>
                                            <div className="summary-stack delta-hedge__metric-grid">
                                              <div className="summary-row">
                                                <span>Delta shift for a 1% move</span>
                                                <strong>{formatNumber(selectedRow.deltaChangeForOnePctMove)} shares</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>1-day theta burn</span>
                                                <strong>{formatCurrency(selectedRow.thetaPerDay)} ({formatPercent(selectedRow.thetaBurnPctPerDay)})</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>1-day breakeven move</span>
                                                <strong>{formatCurrency(selectedRow.dailyBreakevenMoveUsd)} ({formatPercent(selectedRow.dailyBreakevenMovePct)})</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Move for 10 delta change</span>
                                                <strong>{formatCurrency(selectedRow.rebalanceMoveForTenDeltaUsd)} ({formatPercent(selectedRow.rebalanceMoveForTenDeltaPct)})</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Spread / liquidity</span>
                                                <strong>{formatPercent(selectedRow.spreadPct)} / {formatNumber(selectedRow.liquidityScore)}</strong>
                                              </div>
                                            </div>
                                          </div>

                                          <div className="screening-v2__selected-panel">
                                            <h4>Underlying + hedge plan</h4>
                                            <div className="paper-order-ticket__status">
                                              {selectedHedgePlan ? (
                                                <>
                                                  <span className="pill pill--ghost">Initial hedge: none</span>
                                                  {hedgeThresholdShares != null ? (
                                                    <span className="pill pill--ghost">
                                                      Rebalance if |Δ| ≥ {formatWholeNumber(Math.round(hedgeThresholdShares))} shares
                                                    </span>
                                                  ) : null}
                                                  {hedgePriceMoveThresholdPct != null ? (
                                                    <span className="pill pill--ghost">
                                                      Recheck if |move| ≥ {formatPercent(hedgePriceMoveThresholdPct * 100)}
                                                    </span>
                                                  ) : null}
                                                  {hedgeExitDteDays != null ? (
                                                    <span className="pill pill--ghost">
                                                      Exit signal if DTE ≤ {formatWholeNumber(hedgeExitDteDays)}
                                                    </span>
                                                  ) : null}
                                                </>
                                              ) : (
                                                <span className="pill pill--ghost">Hedge plan: n/a</span>
                                              )}
                                            </div>
                                            {fundamentalsLoading ? (
                                              <div className="app-state app-state--inline">Loading fundamentals…</div>
                                            ) : fundamentalsError ? (
                                              <div className="refresh-feedback refresh-feedback--error">
                                                <span>{fundamentalsError}</span>
                                              </div>
                                            ) : null}

                                            <div className="summary-stack delta-hedge__metric-grid">
                                              <div className="summary-row">
                                                <span>Market cap</span>
                                                <strong>{formatCurrencyCompact(fundamentals?.marketCapUsd)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>P/E (TTM)</span>
                                                <strong>{formatNumber(fundamentals?.peTtm, 2)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Dividend yield</span>
                                                <strong>{fundamentals?.dividendYield == null ? "n/a" : formatPercent(fundamentals.dividendYield)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Beta (1y)</span>
                                                <strong>{formatNumber(fundamentals?.beta1y, 2)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>52w range</span>
                                                <strong>
                                                  {fundamentals?.low52w == null || fundamentals?.high52w == null
                                                    ? "n/a"
                                                    : `${formatCurrency(fundamentals.low52w)} – ${formatCurrency(fundamentals.high52w)}`}
                                                </strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Avg vol (30d)</span>
                                                <strong>{formatWholeNumber(fundamentals?.averageVolume30d)}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Sector</span>
                                                <strong>{fundamentals?.sector ?? "n/a"}</strong>
                                              </div>
                                              <div className="summary-row">
                                                <span>Industry</span>
                                                <strong>{fundamentals?.industry ?? "n/a"}</strong>
                                              </div>
                                            </div>
                                          </div>
                                        </div>
                                      </div>
                                    </div>

                                    <div className="screening-v2__detail-grid">
                                      <article className="insight-card">
                                        <span className="brand__eyebrow">Assumptions</span>
                                        <h3>How to read the score</h3>
                                        <div className="summary-stack">
                                          {(payload?.assumptions ?? []).map((assumption) => (
                                            <div key={assumption} className="summary-row">
                                              <span>{assumption}</span>
                                            </div>
                                          ))}
                                        </div>
                                      </article>

                                      <article className="insight-card screening-v2__selected-panel screening-v2__selected-panel--contracts">
                                        <div className="screening-v2__contracts-header">
                                          <h4>Option legs</h4>
                                          {purchasePreview?.totalCost != null ? (
                                            <span className="pill pill--ghost">Total cost {formatCurrency(purchasePreview.totalCost)}</span>
                                          ) : null}
                                        </div>
                                        {purchasePreview ? (
                                          <div className="screening-v2__purchase-table-wrap">
                                            <table className="screening-v2__purchase-table">
                                              <thead>
                                                <tr>
                                                  <th>Instrument</th>
                                                  <th>Action</th>
                                                  <th>Qty</th>
                                                  <th>Price</th>
                                                  <th>Cost</th>
                                                </tr>
                                              </thead>
                                              <tbody>
                                                {(purchasePreview.optionRows ?? []).map((row) => (
                                                  <tr key={row.id}>
                                                    <td>{row.label}</td>
                                                    <td>
                                                      <span className={`pill ${row.action === "Buy" ? "pill--long" : "pill--short"}`}>
                                                        {row.action}
                                                      </span>
                                                    </td>
                                                    <td>{formatWholeNumber(row.quantity)} contracts</td>
                                                    <td>{formatCurrency(row.price)}</td>
                                                    <td>{formatCurrency(row.cost)}</td>
                                                  </tr>
                                                ))}
                                                <tr className="screening-v2__purchase-total">
                                                  <td colSpan={4}>Total</td>
                                                  <td>{formatCurrency(purchasePreview.totalCost)}</td>
                                                </tr>
                                              </tbody>
                                            </table>
                                          </div>
                                        ) : null}
                                        <div className="screening-v2__contract-table-wrap">
                                          <table className="screening-v2__contract-table">
                                            <thead>
                                              <tr>
                                                <th>Leg</th>
                                                <th>Strike</th>
                                                <th>Expiry</th>
                                                <th>Entry</th>
                                                <th>Bid/ask</th>
                                                <th>Size</th>
                                                <th>Volume</th>
                                                <th>OI</th>
                                                <th>IV</th>
                                                <th>Source</th>
                                              </tr>
                                            </thead>
                                            <tbody>
                                              {(directedSelectedRow?.optionLegs ?? []).map((leg) => (
                                                <tr key={`${leg.contractSymbol}:${leg.optionType}`}>
                                                  <td>{String(leg.optionType ?? "").toUpperCase()}</td>
                                                  <td>{formatCurrency(leg.strike)}</td>
                                                  <td>{leg.expiration}</td>
                                                  <td>{formatCurrency(leg.entryPrice)}</td>
                                                  <td>
                                                    {formatCurrency(leg.bid, "USD")} / {formatCurrency(leg.ask, "USD")}
                                                  </td>
                                                  <td>{formatQuoteSizePair(leg.bidSize, leg.askSize)}</td>
                                                  <td>{formatWholeNumber(leg.volume)}</td>
                                                  <td>{formatWholeNumber(leg.openInterest)}</td>
                                                  <td>{formatPercent(Number(leg.impliedVolatility ?? 0) * 100)}</td>
                                                  <td>{leg.quoteSource}</td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        </div>
                                      </article>

                                      <OptionMicrostructurePanel contracts={executionQualityContracts} />
                                    </div>
                                  </>
                                ) : (
                                  <article className="insight-card">
                                    <p className="card-copy">Pick a row to inspect the hedge metrics in more detail.</p>
                                  </article>
                                )}

                                {scaledScenarioOrder ? (
                                  <PaperTradeScenarioPanel
                                    order={scaledScenarioOrder}
                                    lastUpdated={payload?.generatedAt}
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
                  })
                ) : (
                  <tr>
                    <td colSpan={columns.length}>
                      No opportunities match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
    </main>
  );
}
