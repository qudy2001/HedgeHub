import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { createMarketTimerContext } from "../marketTimers.js";
import { getIbkrGatewayLoginUrl, isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";
import { getChartPalette } from "../theme.js";
import { loadSavedFilters, persistSavedFilters } from "../savedFilters.js";
import { isTwsReady } from "../twsStatus.js";

const COVERED_INCOME_FILTERS_STORAGE_KEY = "hedgehub:filters:covered-income";
const MAX_SORT_PRIORITIES = 4;
const DEFAULT_RISK_FREE_RATE = 0.0425;

const defaultFilters = {
  symbols: "TSLA, AAPL, NVDA, SPY",
  maxAllocatedCash: "100000",
  strategyModes: ["cash_secured_put", "covered_call", "covered_strangle"],
  targetDte: [7, 15, 21, 30],
  minOptionVolume: "50",
  minOpenInterest: "100",
  maxBidAskSpreadPct: "10",
  putDeltaMin: "0.15",
  putDeltaMax: "0.30",
  callDeltaMin: "0.10",
  callDeltaMax: "0.25",
  excludeEarningsBeforeExpiry: true
};

const strategyModeLabels = {
  cash_secured_put: "Cash-secured put",
  covered_call: "Covered call",
  covered_strangle: "Covered strangle"
};

const columns = [
  { key: "symbol", label: "Symbol" },
  { key: "strategyType", label: "Strategy" },
  { key: "expiryDate", label: "Expiry" },
  { key: "dte", label: "DTE" },
  { key: "stockPrice", label: "Spot" },
  { key: "strikePrice", label: "Strike" },
  { key: "annualizedReturnOnAllocatedCashPct", label: "Ann ret %" },
  { key: "evAnnualized", label: "EV ann %" },
  { key: "evPerBuyingPower", label: "EV/BP" },
  { key: "ivRank", label: "IV rank" },
  { key: "liquidityScore", label: "Liquidity" },
  { key: "earningsFlag", label: "Earnings" },
  { key: "beta", label: "Beta" },
  { key: "sectorExposure", label: "Sector overlap" },
  { key: "allocationImpact", label: "Alloc impact" },
  { key: "netVegaImpact", label: "Net vega" },
  { key: "correlationCluster", label: "Corr cluster" },
  { key: "downsideBreakeven", label: "Down breakeven" },
  { key: "finalStrategyScore", label: "Score" }
];

const COVERED_INCOME_DEFAULT_COLUMN_KEYS = [
  "symbol",
  "strategyType",
  "expiryDate",
  "dte",
  "stockPrice",
  "strikePrice",
  "annualizedReturnOnAllocatedCashPct",
  "evPerBuyingPower",
  "ivRank",
  "liquidityScore",
  "earningsFlag",
  "downsideBreakeven",
  "finalStrategyScore"
];

const COVERED_INCOME_COMPACT_MEDIA_QUERY = "(max-width: 1240px)";
const COVERED_INCOME_COMPACT_COLUMN_KEYS = COVERED_INCOME_DEFAULT_COLUMN_KEYS;

function matchesCoveredIncomeCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(COVERED_INCOME_COMPACT_MEDIA_QUERY).matches;
}

function getDefaultCoveredIncomeVisibleColumnKeys(isCompactViewport = false) {
  const requestedKeys = isCompactViewport
    ? COVERED_INCOME_COMPACT_COLUMN_KEYS
    : COVERED_INCOME_DEFAULT_COLUMN_KEYS;
  return requestedKeys.filter((key) => columns.some((column) => column.key === key));
}

function ensureCoveredIncomeColumnsVisible(currentKeys = [], requiredKeys = []) {
  const nextKeys = currentKeys.filter((key) => columns.some((column) => column.key === key));
  const missingRequiredKeys = requiredKeys.filter((key) => !nextKeys.includes(key));
  return missingRequiredKeys.length ? [...nextKeys, ...missingRequiredKeys] : nextKeys;
}

function formatCurrency(value) {
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
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: Math.abs(numericValue) >= 1_000_000 ? "compact" : "standard",
    maximumFractionDigits: 2
  }).format(numericValue);
}

function formatPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${numericValue.toFixed(2)}%`;
}

function formatDecimalAsPercent(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${(numericValue * 100).toFixed(2)}%`;
}

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return numericValue.toFixed(digits);
}

function formatWholeNumber(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(numericValue);
}

function formatStrategyType(value) {
  return strategyModeLabels[value] ?? String(value ?? "").replaceAll("_", " ");
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

function buildScenarioOrderFromCoveredIncomeRow(row, generatedAt) {
  if (!row) {
    return null;
  }

  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const currentSpot = toOptionalNumber(row.stockPrice, 0) || 0;
  const expiryDate = String(row.expiryDate ?? "").trim();
  const optionVolatility =
    toOptionalNumber(row.priceZones?.atmIv, null) ??
    toOptionalNumber(row.put?.iv, null) ??
    toOptionalNumber(row.call?.iv, null) ??
    0.24;
  const optionQuantity = Math.max(Math.round(toOptionalNumber(row.contracts, 0) || 0), 0);
  const shareQuantity = Math.max(Math.round(toOptionalNumber(row.sharesRequired, 0) || 0), 0);
  const optionLegs = [];

  if (row.put && optionQuantity > 0) {
    optionLegs.push({
      id: `${row.id}:put`,
      label: `SHORT PUT ${row.put.strike}`,
      kind: "option",
      action: "SHORT",
      quantity: optionQuantity,
      entryPrice: toOptionalNumber(row.put.mid, 0) || 0,
      contractMultiplier: 100,
      optionType: "put",
      expiry: expiryDate,
      strike: toOptionalNumber(row.put.strike, 0) || 0,
      contractSymbol: row.put.contractSymbol ?? "",
      rootSymbol: row.symbol,
      impliedVolatility: toOptionalNumber(row.put.iv, optionVolatility) || optionVolatility,
      riskFreeRate: DEFAULT_RISK_FREE_RATE,
      quoteSource: "scan",
      isLive: false
    });
  }

  if (row.call && optionQuantity > 0) {
    optionLegs.push({
      id: `${row.id}:call`,
      label: `SHORT CALL ${row.call.strike}`,
      kind: "option",
      action: "SHORT",
      quantity: optionQuantity,
      entryPrice: toOptionalNumber(row.call.mid, 0) || 0,
      contractMultiplier: 100,
      optionType: "call",
      expiry: expiryDate,
      strike: toOptionalNumber(row.call.strike, 0) || 0,
      contractSymbol: row.call.contractSymbol ?? "",
      rootSymbol: row.symbol,
      impliedVolatility: toOptionalNumber(row.call.iv, optionVolatility) || optionVolatility,
      riskFreeRate: DEFAULT_RISK_FREE_RATE,
      quoteSource: "scan",
      isLive: false
    });
  }

  const stockLegs =
    shareQuantity > 0
      ? [
          {
            id: `${row.id}:stock`,
            label: `${row.symbol} shares`,
            kind: "stock",
            action: "LONG",
            quantity: shareQuantity,
            entryPrice: currentSpot
          }
        ]
      : [];

  return {
    strategyId: "strategy-1",
    strategyName: "Covered Income Scanner",
    id: row.id,
    combinationLabel: `${row.symbol} · ${formatStrategyType(row.strategyType)} · ${expiryDate}`,
    assetLabel: row.symbol,
    strategyType: row.strategyType,
    purchaseDate,
    createdAt: generatedAt ?? null,
    closedAt: "",
    status: "open",
    polymarketMarketId: "",
    polymarketQuestion: "",
    polymarketUrl: "",
    strategyCloseDate: expiryDate,
    polymarketResolutionDate: expiryDate,
    marketReferenceYesPrice: 0.5,
    valuationContext: {
      proxySymbol: row.symbol,
      underlyingSymbol: row.symbol,
      currentProxySpot: currentSpot,
      currentUnderlyingSpot: currentSpot,
      conversionRatio: 1,
      targetUnderlyingValue: currentSpot,
      currentYesPrice: 0.5
    },
    legs: [...stockLegs, ...optionLegs]
  };
}

function buildInitialFilters() {
  const saved = loadSavedFilters(COVERED_INCOME_FILTERS_STORAGE_KEY);
  if (!saved || typeof saved !== "object") {
    return defaultFilters;
  }

  return {
    ...defaultFilters,
    ...saved,
    strategyModes: Array.isArray(saved.strategyModes) && saved.strategyModes.length
      ? saved.strategyModes
      : defaultFilters.strategyModes,
    targetDte: Array.isArray(saved.targetDte) && saved.targetDte.length
      ? saved.targetDte
      : defaultFilters.targetDte,
    excludeEarningsBeforeExpiry: saved.excludeEarningsBeforeExpiry !== false,
    visibleColumnKeys:
      Array.isArray(saved.visibleColumnKeys) && saved.visibleColumnKeys.length
        ? saved.visibleColumnKeys.filter((key) => columns.some((column) => column.key === key))
        : getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport())
  };
}

function buildRequestPayload(filters) {
  return {
    symbols: String(filters.symbols ?? "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean),
    maxAllocatedCash: Number(filters.maxAllocatedCash ?? 0),
    strategyModes: filters.strategyModes,
    targetDte: filters.targetDte,
    minOptionVolume: Number(filters.minOptionVolume ?? 0),
    minOpenInterest: Number(filters.minOpenInterest ?? 0),
    maxBidAskSpreadPct: Number(filters.maxBidAskSpreadPct ?? 0),
    putDeltaRange: {
      min: Number(filters.putDeltaMin ?? 0),
      max: Number(filters.putDeltaMax ?? 0)
    },
    callDeltaRange: {
      min: Number(filters.callDeltaMin ?? 0),
      max: Number(filters.callDeltaMax ?? 0)
    },
    excludeEarningsBeforeExpiry: filters.excludeEarningsBeforeExpiry !== false
  };
}

function calculateIbkrNetLimitPrice(optionLegs) {
  const normalizedLegs = (optionLegs ?? []).filter((leg) => Number(leg?.quantity ?? 0) > 0);
  if (!normalizedLegs.length) {
    return null;
  }

  if (normalizedLegs.length === 1) {
    return Number(normalizedLegs[0].entryPrice ?? 0) || 0;
  }

  const gcd = (left, right) => {
    const safeLeft = Math.max(Math.round(Number(left ?? 0) || 0), 0);
    const safeRight = Math.max(Math.round(Number(right ?? 0) || 0), 0);
    if (!safeLeft) {
      return safeRight;
    }
    if (!safeRight) {
      return safeLeft;
    }

    let currentLeft = safeLeft;
    let currentRight = safeRight;
    while (currentRight) {
      const remainder = currentLeft % currentRight;
      currentLeft = currentRight;
      currentRight = remainder;
    }

    return currentLeft;
  };

  const comboQuantity = normalizedLegs.reduce(
    (current, leg) => gcd(current, Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0)),
    0
  );
  const normalizedComboQuantity = comboQuantity || 1;

  return normalizedLegs.reduce((sum, leg) => {
    const ratio = Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0) / normalizedComboQuantity || 1;
    const signedPrice =
      leg.action === "SHORT" ? -(Number(leg.entryPrice ?? 0) || 0) : Number(leg.entryPrice ?? 0) || 0;
    return sum + signedPrice * ratio;
  }, 0);
}

function parseLimitPriceCents(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return Math.round(numericValue * 100);
}

function formatLimitPriceCents(value) {
  return (Number(value ?? 0) / 100).toFixed(2);
}

function buildTwsLimitPriceWindow(strategyLimitPrice, selectedLimitPrice) {
  const anchorCents = parseLimitPriceCents(strategyLimitPrice) ?? parseLimitPriceCents(selectedLimitPrice);
  if (anchorCents == null) {
    return [];
  }

  const windowOffsets = 10;
  const priceCents = new Set();
  for (let offset = -windowOffsets; offset <= windowOffsets; offset += 1) {
    priceCents.add(anchorCents + offset);
  }

  const selectedCents = parseLimitPriceCents(selectedLimitPrice);
  if (selectedCents != null) {
    priceCents.add(selectedCents);
  }

  return Array.from(priceCents)
    .sort((left, right) => left - right)
    .map(formatLimitPriceCents);
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

function getPrimaryStrikeValue(row) {
  return toOptionalNumber(row?.put?.strike, null) ?? toOptionalNumber(row?.call?.strike, null);
}

function formatStrikeCell(row) {
  const labels = [];
  if (row?.put?.strike != null) {
    labels.push(`${formatNumber(row.put.strike, 2)}P`);
  }
  if (row?.call?.strike != null) {
    labels.push(`${formatNumber(row.call.strike, 2)}C`);
  }
  return labels.length ? labels.join(" / ") : "n/a";
}

function getPayoffExtrema(row) {
  const points = Array.isArray(row?.detail?.payoffCurve) ? row.detail.payoffCurve : [];
  if (!points.length) {
    return { maxProfit: null, maxLoss: null };
  }

  let maxProfit = null;
  let maxLoss = null;
  points.forEach((point) => {
    const pnl = Number(point?.pnl);
    if (!Number.isFinite(pnl)) {
      return;
    }
    maxProfit = maxProfit == null ? pnl : Math.max(maxProfit, pnl);
    maxLoss = maxLoss == null ? pnl : Math.min(maxLoss, pnl);
  });

  return { maxProfit, maxLoss };
}

function buildCoveredIncomePaperOrderPayload({
  order,
  row,
  strategyDefinition,
  purchaseDate,
  execution
}) {
  if (!order || !row) {
    return null;
  }

  const payoffExtrema = getPayoffExtrema(row);
  const valuationContext = order.valuationContext ?? {};
  const impliedVolatility =
    Number(row?.priceZones?.atmIv ?? row?.put?.iv ?? row?.call?.iv ?? 0.24) || 0.24;
  const riskFreeRate = DEFAULT_RISK_FREE_RATE;

  return {
    strategyId: strategyDefinition?.id ?? "strategy-5",
    strategyName: strategyDefinition?.name ?? "Covered Income Scanner",
    combinationId: order.id ?? row.id,
    combinationLabel:
      order.combinationLabel ??
      `${row.symbol} · ${formatStrategyType(row.strategyType)} · ${row.expiryDate}`,
    assetLabel: order.assetLabel ?? row.symbol,
    strategyType: formatStrategyType(row.strategyType),
    marketBias: "",
    marketBiasTone: "",
    maxProfit: payoffExtrema.maxProfit,
    maxLoss: payoffExtrema.maxLoss,
    maxProfitUnbounded: false,
    maxLossUnbounded: false,
    purchaseDate: purchaseDate || order.purchaseDate || new Date().toISOString().slice(0, 10),
    polymarketMarketId: order.polymarketMarketId ?? "",
    polymarketQuestion: order.polymarketQuestion ?? "",
    polymarketUrl: order.polymarketUrl ?? "",
    polymarketResolutionDate: order.polymarketResolutionDate ?? row.expiryDate,
    strategyCloseDate: order.strategyCloseDate ?? row.expiryDate,
    marketReferenceYesPrice: Number(order.marketReferenceYesPrice ?? 0.5) || 0.5,
    monitoringEnabled: true,
    marketContext: {
      proxySymbol: valuationContext.proxySymbol ?? row.symbol,
      underlyingSymbol: valuationContext.underlyingSymbol ?? row.symbol,
      currentProxySpot: Number(valuationContext.currentProxySpot ?? row.stockPrice ?? 0) || 0,
      currentUnderlyingSpot: Number(valuationContext.currentUnderlyingSpot ?? row.stockPrice ?? 0) || 0,
      conversionRatio: Number(valuationContext.conversionRatio ?? 1) || 1,
      targetUnderlyingValue: Number(valuationContext.targetUnderlyingValue ?? row.stockPrice ?? 0) || 0,
      impliedVolatility,
      riskFreeRate
    },
    valuationContext: {
      proxySymbol: valuationContext.proxySymbol ?? row.symbol,
      underlyingSymbol: valuationContext.underlyingSymbol ?? row.symbol,
      currentProxySpot: Number(valuationContext.currentProxySpot ?? row.stockPrice ?? 0) || 0,
      currentUnderlyingSpot: Number(valuationContext.currentUnderlyingSpot ?? row.stockPrice ?? 0) || 0,
      conversionRatio: Number(valuationContext.conversionRatio ?? 1) || 1,
      targetUnderlyingValue: Number(valuationContext.targetUnderlyingValue ?? row.stockPrice ?? 0) || 0,
      currentYesPrice: Number(valuationContext.currentYesPrice ?? 0.5) || 0.5
    },
    legs: (order.legs ?? []).map((leg, index) => {
      if (leg?.kind === "stock") {
        return {
          id: leg.id ?? `${row.id}-stock-${index + 1}`,
          label: leg.label ?? `${row.symbol} shares`,
          kind: "stock",
          action: leg.action ?? "LONG",
          quantity: Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0),
          entryPrice: Number(leg.entryPrice ?? row.stockPrice ?? 0) || 0
        };
      }

      return {
        id: leg.id ?? `${row.id}-option-${index + 1}`,
        label: leg.label ?? `${row.symbol} ${leg.expiry} ${leg.strike}`,
        kind: "option",
        action: leg.action,
        quantity: Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0),
        entryPrice: Number(leg.entryPrice ?? 0) || 0,
        contractMultiplier: Number(leg.contractMultiplier ?? 100) || 100,
        optionType: leg.optionType ?? "call",
        expiry: leg.expiry ?? row.expiryDate ?? "",
        strike: Number(leg.strike ?? 0) || 0,
        contractSymbol: leg.contractSymbol ?? "",
        rootSymbol: leg.rootSymbol ?? row.symbol,
        bid: leg.bid ?? null,
        ask: leg.ask ?? null,
        bidSize: leg.bidSize ?? null,
        askSize: leg.askSize ?? null,
        volume: leg.volume ?? null,
        openInterest: leg.openInterest ?? null,
        impliedVolatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
        riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate,
        quoteSource: leg.quoteSource ?? "Covered income scan",
        isLive: leg.isLive === true
      };
    }),
    execution:
      execution && typeof execution === "object"
        ? execution
        : {
            route: "local-paper"
          }
  };
}

function compareRows(left, right, sortKey, sortDirection) {
  const leftValue = readSortValue(left, sortKey);
  const rightValue = readSortValue(right, sortKey);

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

function readSortValue(row, key) {
  if (!row) {
    return null;
  }

  switch (key) {
    case "symbol":
      return row.symbol;
    case "stockPrice":
      return row.stockPrice;
    case "strikePrice":
      return getPrimaryStrikeValue(row);
    case "strategyType":
      return formatStrategyType(row.strategyType);
    case "expiryDate":
      return row.expiryDate;
    case "dte":
      return row.dte;
    case "annualizedReturnOnAllocatedCashPct":
      return row.returns?.annualizedReturnOnAllocatedCashPct ?? null;
    case "evAnnualized":
      return row.intelligence?.ev?.evAnnualized ?? null;
    case "evPerBuyingPower":
      return row.intelligence?.ev?.evPerBuyingPower ?? calculateEvPerBuyingPower(row);
    case "probabilityOfProfit":
      return calculateProbabilityOfProfit(row);
    case "ivRank":
      return row.intelligence?.volatility?.ivRank52w ?? null;
    case "liquidityScore":
      return row.score?.liquidityScore ?? null;
    case "beta":
      return row.intelligence?.beta ?? null;
    case "sectorExposure":
      return row.intelligence?.portfolioImpact?.sectorExposureCount ?? null;
    case "allocationImpact":
      return row.intelligence?.portfolioImpact?.portfolioAllocationImpact ?? null;
    case "netVegaImpact":
      return row.intelligence?.portfolioImpact?.netVegaChange ?? null;
    case "correlationCluster":
      return row.intelligence?.portfolioImpact?.correlationCluster ?? "";
    case "downsideBreakeven":
      return row.breakevens?.downsideBreakeven ?? null;
    case "earningsFlag":
      return row.risk?.earningsBeforeExpiry === true ? 1 : 0;
    case "finalStrategyScore":
      return row.score?.finalStrategyScore ?? null;
    default:
      return null;
  }
}

function formatCell(row, key) {
  switch (key) {
    case "symbol":
      return row.symbol;
    case "stockPrice":
      return formatCurrency(row.stockPrice);
    case "strikePrice":
      return formatStrikeCell(row);
    case "strategyType":
      return formatStrategyType(row.strategyType);
    case "expiryDate":
      return row.expiryDate;
    case "dte":
      return formatWholeNumber(row.dte);
    case "annualizedReturnOnAllocatedCashPct":
      return formatPercent(row.returns?.annualizedReturnOnAllocatedCashPct);
    case "evAnnualized":
      return formatPercent(row.intelligence?.ev?.evAnnualized);
    case "evPerBuyingPower":
      return formatDecimalAsPercent(row.intelligence?.ev?.evPerBuyingPower ?? calculateEvPerBuyingPower(row));
    case "probabilityOfProfit":
      return formatPercent(calculateProbabilityOfProfit(row));
    case "ivRank":
      return formatPercent(row.intelligence?.volatility?.ivRank52w);
    case "liquidityScore":
      return formatWholeNumber(row.score?.liquidityScore);
    case "beta":
      return formatNumber(row.intelligence?.beta, 2);
    case "sectorExposure":
      return `${row.intelligence?.portfolioImpact?.sectorOverlap ?? "n/a"}${Number.isFinite(Number(row.intelligence?.portfolioImpact?.sectorExposureCount)) ? ` (${formatWholeNumber(row.intelligence?.portfolioImpact?.sectorExposureCount)})` : ""}`;
    case "allocationImpact":
      return formatCurrencyCompact(row.intelligence?.portfolioImpact?.portfolioAllocationImpact);
    case "netVegaImpact":
      return formatNumber(row.intelligence?.portfolioImpact?.netVegaChange, 0);
    case "correlationCluster":
      return row.intelligence?.portfolioImpact?.correlationCluster ?? "n/a";
    case "downsideBreakeven":
      return formatCurrency(row.breakevens?.downsideBreakeven);
    case "earningsFlag":
      return row.risk?.earningsBeforeExpiry ? "Flag" : "Clear";
    case "finalStrategyScore":
      return formatWholeNumber(row.score?.finalStrategyScore);
    default:
      return "n/a";
  }
}

function getHigherIsBetterTone(value, { goodMin, cautionMin }) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "neutral";
  }
  if (numericValue >= goodMin) {
    return "good";
  }
  if (numericValue >= cautionMin) {
    return "caution";
  }
  return "risk";
}

function getLowerIsBetterTone(value, { goodMax, cautionMax }) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "neutral";
  }
  if (numericValue <= goodMax) {
    return "good";
  }
  if (numericValue <= cautionMax) {
    return "caution";
  }
  return "risk";
}

function calculateDownsideBufferPct(row) {
  const stockPrice = Number(row?.stockPrice);
  const downsideBreakeven = Number(row?.breakevens?.downsideBreakeven);
  if (!Number.isFinite(stockPrice) || !(stockPrice > 0) || !Number.isFinite(downsideBreakeven)) {
    return null;
  }
  return ((stockPrice - downsideBreakeven) / stockPrice) * 100;
}

function calculateCalledAwayUpsidePct(row) {
  const stockPrice = Number(row?.stockPrice);
  const calledAwayPrice = Number(row?.breakevens?.calledAwayPrice);
  if (!Number.isFinite(stockPrice) || !(stockPrice > 0) || !Number.isFinite(calledAwayPrice)) {
    return null;
  }
  return ((calledAwayPrice - stockPrice) / stockPrice) * 100;
}

function calculateEvPerBuyingPower(row) {
  const buyingPower = Number(row?.capital?.allocatedCashUsed);
  const premium = Number(row?.premium?.totalPremium);
  const stockPrice = Number(row?.stockPrice);
  const downsideBreakeven = Number(row?.breakevens?.downsideBreakeven);
  const putDelta = Math.abs(Number(row?.put?.delta) || 0);
  const contracts = Math.max(Number(row?.contracts) || 0, 0);

  if (!Number.isFinite(buyingPower) || !(buyingPower > 0) || !Number.isFinite(premium)) {
    return null;
  }

  const downsideBuffer =
    Number.isFinite(stockPrice) && Number.isFinite(downsideBreakeven)
      ? Math.max(stockPrice - downsideBreakeven, 0)
      : null;
  const downsideProbability = Math.max(putDelta, 0.08);
  const downsidePenalty =
    downsideBuffer != null ? downsideBuffer * 100 * contracts * downsideProbability * 0.55 : 0;
  const expectedValue = premium - downsidePenalty;

  return Number.isFinite(expectedValue) ? expectedValue / buyingPower : null;
}

function calculateProbabilityOfProfit(row) {
  const existingProbability = Number(row?.probabilityOfProfit);
  if (Number.isFinite(existingProbability)) {
    return existingProbability;
  }

  const payoffCurve = Array.isArray(row?.detail?.payoffCurve) ? row.detail.payoffCurve : [];
  if (!payoffCurve.length) {
    return null;
  }

  const positivePoints = payoffCurve.filter((point) => Number(point?.pnl ?? 0) > 0).length;
  return (positivePoints / payoffCurve.length) * 100;
}

function getCellHeatMeta(row, key) {
  switch (key) {
    case "annualizedReturnOnAllocatedCashPct":
      return {
        tone: getHigherIsBetterTone(row.returns?.annualizedReturnOnAllocatedCashPct, { goodMin: 24, cautionMin: 12 }),
        title: "Annualized return on allocated cash: green >= 24%, yellow 12%-23.99%, red < 12%."
      };
    case "evAnnualized":
      return {
        tone: getHigherIsBetterTone(row.intelligence?.ev?.evAnnualized, { goodMin: 18, cautionMin: 8 }),
        title: "Expected value annualized: green >= 18%, yellow 8%-17.99%, red < 8%."
      };
    case "evPerBuyingPower":
      return {
        tone: getHigherIsBetterTone(
          (Number(row.intelligence?.ev?.evPerBuyingPower ?? calculateEvPerBuyingPower(row)) || 0) * 100,
          { goodMin: 1.5, cautionMin: 0.5 }
        ),
        title: "Expected value per buying power: green >= 1.5%, yellow 0.5%-1.49%, red < 0.5%."
      };
    case "probabilityOfProfit":
      return {
        tone: getHigherIsBetterTone(calculateProbabilityOfProfit(row), { goodMin: 70, cautionMin: 55 }),
        title: "Probability of profit: green >= 70%, yellow 55%-69.99%, red < 55%."
      };
    case "ivRank":
      return {
        tone: getHigherIsBetterTone(row.intelligence?.volatility?.ivRank52w, { goodMin: 65, cautionMin: 40 }),
        title: "IV rank regime: richer premium gets a warmer tone for income structures."
      };
    case "liquidityScore":
      return {
        tone: getHigherIsBetterTone(row.score?.liquidityScore, { goodMin: 70, cautionMin: 55 }),
        title: "Liquidity score: green >= 70, yellow 55-69, red < 55."
      };
    case "beta":
      return {
        tone: getLowerIsBetterTone(Math.abs(row.intelligence?.beta), { goodMax: 0.95, cautionMax: 1.3 }),
        title: "Lower beta usually adds less portfolio market sensitivity."
      };
    case "sectorExposure":
      return {
        tone:
          row.intelligence?.portfolioImpact?.sectorOverlap === "high"
            ? "risk"
            : row.intelligence?.portfolioImpact?.sectorOverlap === "medium"
              ? "caution"
              : "good",
        title: "How much this trade adds to an already-held sector bucket."
      };
    case "allocationImpact":
      return {
        tone: getLowerIsBetterTone(row.intelligence?.portfolioImpact?.portfolioAllocationImpact, { goodMax: 15000, cautionMax: 35000 }),
        title: "Smaller incremental allocation reduces concentration pressure."
      };
    case "netVegaImpact":
      return {
        tone: getLowerIsBetterTone(Math.abs(row.intelligence?.portfolioImpact?.netVegaChange), { goodMax: 80, cautionMax: 160 }),
        title: "Lower absolute vega impact keeps portfolio volatility exposure more balanced."
      };
    case "correlationCluster":
      return {
        tone:
          row.intelligence?.portfolioImpact?.correlationOverlap === "high"
            ? "risk"
            : row.intelligence?.portfolioImpact?.correlationOverlap === "medium"
              ? "caution"
              : "good",
        title: "Hidden overlap detector to catch fake diversification."
      };
    case "downsideBreakeven": {
      const downsideBufferPct = calculateDownsideBufferPct(row);
      return downsideBufferPct != null ? {
        tone: getHigherIsBetterTone(downsideBufferPct, { goodMin: 10, cautionMin: 5 }),
        title: `Downside cushion vs spot: green >= 10%, yellow 5%-9.99%, red < 5%. Current cushion ${formatPercent(downsideBufferPct)}.`
      } : null;
    }
    case "earningsFlag":
      return {
        tone: row.risk?.earningsBeforeExpiry ? "risk" : "good",
        title: row.risk?.earningsBeforeExpiry
          ? "Earnings before expiry adds elevated gap risk."
          : "No earnings event before expiry."
      };
    case "finalStrategyScore":
      return {
        tone: getHigherIsBetterTone(row.score?.finalStrategyScore, { goodMin: 70, cautionMin: 55 }),
        title: "Composite strategy score: green >= 70, yellow 55-69, red < 55."
      };
    default:
      return null;
  }
}

function renderHeatCell(row, key) {
  const content = formatCell(row, key);
  const heat = getCellHeatMeta(row, key);
  if (!heat || content === "—" || content === "n/a") {
    return content;
  }

  return (
    <span className={`covered-income__heat-badge covered-income__heat-badge--${heat.tone}`} title={heat.title}>
      {content}
    </span>
  );
}

function formatPayoffTooltip(value, name) {
  if (name === "pnl") {
    return formatCurrency(value);
  }
  if (name === "spot") {
    return formatCurrency(value);
  }
  return value;
}

function calculateSpreadPercent(bid, ask) {
  const numericBid = Number(bid);
  const numericAsk = Number(ask);
  if (!Number.isFinite(numericBid) || !Number.isFinite(numericAsk) || numericAsk < numericBid) {
    return null;
  }

  const mid = (numericBid + numericAsk) / 2;
  if (!(mid > 0)) {
    return null;
  }

  return ((numericAsk - numericBid) / mid) * 100;
}

function getRiskToneClassName(isFlagged) {
  return isFlagged ? "pill pill--ghost covered-income__flag covered-income__flag--warning" : "pill pill--ghost";
}

function toggleArrayValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function toggleNumericValue(values, value) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value].sort((left, right) => left - right);
}

function PayoffChart({ row, theme = "dark" }) {
  const chartTheme = getChartPalette(theme);
  const points = Array.isArray(row?.detail?.payoffCurve) ? row.detail.payoffCurve : [];
  if (!points.length) {
    return null;
  }

  return (
    <article className="insight-card covered-income__chart-card">
      <div className="detail-chart__header">
        <div>
          <span className="brand__eyebrow">Payoff diagram</span>
          <h3>Expiry P&amp;L</h3>
          <p className="detail-chart__copy">
            The stock leg is included, so covered calls and covered strangles do not double-count upside loss above the
            short call strike.
          </p>
        </div>
      </div>

      <div className="chart-frame">
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={points}>
            <CartesianGrid stroke={chartTheme.grid} strokeDasharray="3 3" />
            <XAxis
              dataKey="spot"
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            />
            <YAxis
              tick={{ fill: chartTheme.axis, fontSize: 11 }}
              tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
            />
            <Tooltip
              formatter={formatPayoffTooltip}
              contentStyle={{
                background: chartTheme.tooltipBackground,
                border: `1px solid ${chartTheme.tooltipBorder}`,
                borderRadius: "14px"
              }}
            />
            <ReferenceLine y={0} stroke={chartTheme.grid} strokeDasharray="4 4" />
            <ReferenceLine x={row.stockPrice} stroke={chartTheme.scenarioLineSky} strokeDasharray="4 4" />
            {row.put?.strike != null ? (
              <ReferenceLine x={row.put.strike} stroke="#fb7185" strokeDasharray="3 3" />
            ) : null}
            {row.call?.strike != null ? (
              <ReferenceLine x={row.call.strike} stroke="#34d399" strokeDasharray="3 3" />
            ) : null}
            <Line
              type="monotone"
              dataKey="pnl"
              stroke={chartTheme.strategyLineStroke}
              strokeWidth={2.6}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </article>
  );
}

export default function CoveredIncomeScannerWorkspace({
  strategyDefinition,
  paperPortfolio = null,
  onCreatePaperOrder = null,
  onConfirmPaperExecution = null,
  onOpenPaperTrading = null,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const detailRef = useRef(null);
  const hasNormalizedInitialColumnsRef = useRef(false);
  const [filters, setFilters] = useState(() => buildInitialFilters());
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [sortState, setSortState] = useState([{ key: "finalStrategyScore", direction: "desc" }]);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperExecutionRoute, setPaperExecutionRoute] = useState("tws-paper");
  const [paperIbkrOrderType, setPaperIbkrOrderType] = useState("LMT");
  const [paperIbkrLimitPrice, setPaperIbkrLimitPrice] = useState("");
  const [paperIbkrTif, setPaperIbkrTif] = useState("DAY");
  const [paperIbkrOutsideRth, setPaperIbkrOutsideRth] = useState(false);
  const [paperIbkrSmartEnabled, setPaperIbkrSmartEnabled] = useState(false);
  const [twsStatus, setTwsStatus] = useState(() => paperPortfolio?.brokerStatus?.tws ?? null);
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(
    () => buildInitialFilters().visibleColumnKeys ?? getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport())
  );

  async function loadScan(force = false, nextFilters = filters) {
    const nextRefreshing = payload != null;
    if (nextRefreshing) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError("");
    setFeedback("");

    try {
      const response = await fetch("/api/strategies/strategy-5/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ...buildRequestPayload(nextFilters),
          force
        })
      });
      const json = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(json?.error || "Unable to load covered income scanner");
      }

      setPayload(json);
      setSelectedRowId((current) => current || json.rows?.[0]?.id || null);
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadScan(false, filters);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hasNormalizedInitialColumnsRef.current) {
      return;
    }

    if (!payload) {
      return;
    }

    hasNormalizedInitialColumnsRef.current = true;
    const requiredVisibleKeys = ["ivRank", "evPerBuyingPower"];
    setVisibleColumnKeys((current) => {
      if (current.length === columns.length) {
        return ensureCoveredIncomeColumnsVisible(
          getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport()),
          requiredVisibleKeys
        );
      }

      return ensureCoveredIncomeColumnsVisible(current, requiredVisibleKeys);
    });
  }, [payload, visibleColumnKeys.length]);

  const sortedRows = useMemo(() => {
    const rows = [...(payload?.rows ?? [])];
    return rows.sort((left, right) => {
      for (const descriptor of sortState) {
        const comparison = compareRows(left, right, descriptor.key, descriptor.direction);
        if (comparison !== 0) {
          return comparison;
        }
      }
      return 0;
    });
  }, [payload?.rows, sortState]);

  const visibleColumns = useMemo(() => {
    const nextColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
    return nextColumns.length ? nextColumns : [columns[0]];
  }, [visibleColumnKeys]);
  const coveredIncomeTableMinWidth = useMemo(
    () => `${Math.max(visibleColumns.length * 140, 280)}px`,
    [visibleColumns.length]
  );

  const selectedRow = useMemo(() => {
    return sortedRows.find((row) => row.id === selectedRowId) ?? sortedRows[0] ?? null;
  }, [selectedRowId, sortedRows]);

  const selectedLegRows = useMemo(() => {
    if (!selectedRow) {
      return [];
    }

    const rows = [];
    if ((selectedRow.sharesRequired ?? 0) > 0) {
      rows.push({
        id: `${selectedRow.id}:stock`,
        action: "LONG",
        quantity: selectedRow.sharesRequired,
        strikeLabel: "Stock",
        bid: null,
        ask: null,
        mark: selectedRow.stockPrice,
        volume: null,
        openInterest: null,
        spreadPct: null,
        referenceLabel: `${selectedRow.symbol} shares`,
        referenceMeta: `Coverage for ${formatStrategyType(selectedRow.strategyType)}`
      });
    }

    if (selectedRow.put) {
      rows.push({
        id: `${selectedRow.id}:put`,
        action: "SHORT",
        quantity: selectedRow.contracts,
        strikeLabel: `${formatNumber(selectedRow.put.strike, 2)}P`,
        bid: selectedRow.put.bid,
        ask: selectedRow.put.ask,
        mark: selectedRow.put.mid,
        volume: selectedRow.put.volume,
        openInterest: selectedRow.put.openInterest,
        spreadPct: calculateSpreadPercent(selectedRow.put.bid, selectedRow.put.ask),
        referenceLabel: selectedRow.put.contractSymbol || `${selectedRow.symbol} put`,
        referenceMeta: `${selectedRow.put.assignmentRisk} assignment risk`
      });
    }

    if (selectedRow.call) {
      rows.push({
        id: `${selectedRow.id}:call`,
        action: "SHORT",
        quantity: selectedRow.contracts,
        strikeLabel: `${formatNumber(selectedRow.call.strike, 2)}C`,
        bid: selectedRow.call.bid,
        ask: selectedRow.call.ask,
        mark: selectedRow.call.mid,
        volume: selectedRow.call.volume,
        openInterest: selectedRow.call.openInterest,
        spreadPct: calculateSpreadPercent(selectedRow.call.bid, selectedRow.call.ask),
        referenceLabel: selectedRow.call.contractSymbol || `${selectedRow.symbol} call`,
        referenceMeta: `${selectedRow.call.assignmentRisk} assignment risk`
      });
    }

    return rows;
  }, [selectedRow]);

  const assignmentScenarios = useMemo(() => {
    if (!selectedRow) {
      return [];
    }

    if (selectedRow.strategyType === "cash_secured_put") {
      return [
        `Below ${formatCurrency(selectedRow.put?.strike)}: you keep the premium and may be assigned shares near support.`,
        `Above ${formatCurrency(selectedRow.put?.strike)}: the put expires worthless and premium is fully retained.`
      ];
    }

    if (selectedRow.strategyType === "covered_call") {
      return [
        `Below ${formatCurrency(selectedRow.call?.strike)}: you keep the shares and the call premium.`,
        `Above ${formatCurrency(selectedRow.call?.strike)}: shares can be called away and upside is capped near ${formatCurrency(selectedRow.breakevens?.calledAwayPrice)}.`
      ];
    }

    return [
      `Below ${formatCurrency(selectedRow.put?.strike)}: you keep the call premium and can be assigned additional shares on the short put.`,
      `Between ${formatCurrency(selectedRow.put?.strike)} and ${formatCurrency(selectedRow.call?.strike)}: both options can expire worthless and the credit is retained.`,
      `Above ${formatCurrency(selectedRow.call?.strike)}: existing shares can be called away while the short put expires worthless.`
    ];
  }, [selectedRow]);
  const selectedScenarioOrder = useMemo(
    () => buildScenarioOrderFromCoveredIncomeRow(selectedRow, payload?.generatedAt),
    [payload?.generatedAt, selectedRow]
  );
  const optionLegsForOrder = useMemo(
    () => (selectedScenarioOrder?.legs ?? []).filter((leg) => leg?.kind === "option"),
    [selectedScenarioOrder?.legs]
  );
  const ibkrSuggestedLimitPrice = useMemo(
    () => calculateIbkrNetLimitPrice(optionLegsForOrder),
    [optionLegsForOrder]
  );
  const twsLimitPriceWindow = useMemo(
    () => buildTwsLimitPriceWindow(ibkrSuggestedLimitPrice, paperIbkrLimitPrice),
    [ibkrSuggestedLimitPrice, paperIbkrLimitPrice]
  );
  const ibkrStatus = paperPortfolio?.brokerStatus?.ibkr ?? null;
  const ibkrReady = isIbkrReady(ibkrStatus);
  const ibkrReloginNeeded = isIbkrReloginNeeded(ibkrStatus);
  const ibkrLoginUrl = getIbkrGatewayLoginUrl();
  const twsReady = isTwsReady(twsStatus);

  useEffect(() => {
    if (!onMarketTimerContextChange) {
      return;
    }

    if (!selectedRow) {
      onMarketTimerContextChange(null);
      return;
    }

    onMarketTimerContextChange(
      createMarketTimerContext({
        source: "covered-income-scanner",
        label: selectedRow.symbol,
        optionSymbol: selectedRow.symbol,
        underlyingSymbol: selectedRow.symbol,
        referenceSymbol: "",
        optionExpiries: [selectedRow.expiryDate]
      })
    );

    return () => {
      onMarketTimerContextChange(null);
    };
  }, [onMarketTimerContextChange, selectedRow]);

  useEffect(() => {
    if (paperPortfolio?.brokerStatus?.tws) {
      setTwsStatus(paperPortfolio.brokerStatus.tws);
    }
  }, [paperPortfolio?.brokerStatus?.tws]);

  useEffect(() => {
    if (paperExecutionRoute !== "tws-paper") {
      return;
    }

    let cancelled = false;

    async function refreshTwsStatus() {
      try {
        const response = await fetch("/api/brokers/tws/status");
        const nextPayload = await response.json().catch(() => null);
        if (!cancelled && response.ok) {
          setTwsStatus(nextPayload?.tws ?? null);
        }
      } catch (_error) {
        // ignore status refresh failures here
      }
    }

    void refreshTwsStatus();
    return () => {
      cancelled = true;
    };
  }, [paperExecutionRoute]);

  useEffect(() => {
    if (paperIbkrOrderType === "LMT" && !paperIbkrLimitPrice && ibkrSuggestedLimitPrice != null) {
      setPaperIbkrLimitPrice(String(Number(ibkrSuggestedLimitPrice.toFixed(2))));
    }
  }, [ibkrSuggestedLimitPrice, paperIbkrLimitPrice, paperIbkrOrderType]);

  useEffect(() => {
    if (paperIbkrOrderType !== "LMT" && paperIbkrSmartEnabled) {
      setPaperIbkrSmartEnabled(false);
    }
  }, [paperIbkrOrderType, paperIbkrSmartEnabled]);

  async function handleCreatePaperTrade() {
    if (!selectedRow || !selectedScenarioOrder || !onCreatePaperOrder) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      if (paperExecutionRoute === "ibkr-paper") {
        if (!ibkrReady) {
          throw new Error(
            ibkrStatus?.error || "IBKR paper gateway is not ready. Check the connection on the paper-trading page."
          );
        }

        if (!optionLegsForOrder.length) {
          throw new Error("This setup does not have any option legs to route to IBKR.");
        }

        if (paperIbkrOrderType === "LMT") {
          if (paperIbkrLimitPrice === "") {
            throw new Error("Enter an IBKR limit price before routing this order.");
          }

          const parsedLimitPrice = Number(paperIbkrLimitPrice);
          const allowsSignedNet = optionLegsForOrder.length > 1;
          if (!Number.isFinite(parsedLimitPrice) || (!allowsSignedNet && parsedLimitPrice < 0)) {
            throw new Error(
              allowsSignedNet
                ? "Enter a valid IBKR net limit price before routing this order."
                : "Enter a valid (non-negative) IBKR limit price before routing this order."
            );
          }
        }
      }

      if (paperExecutionRoute === "tws-paper") {
        if (!twsReady) {
          throw new Error(twsStatus?.error || "TWS is not ready. Connect it from the left sidebar first.");
        }

        if (!optionLegsForOrder.length) {
          throw new Error("This setup does not have any option legs to route to TWS.");
        }

        if (paperIbkrOrderType === "LMT") {
          if (paperIbkrLimitPrice === "") {
            throw new Error("Enter a TWS limit price before routing this order.");
          }

          const parsedLimitPrice = Number(paperIbkrLimitPrice);
          const allowsSignedNet = optionLegsForOrder.length > 1;
          if (!Number.isFinite(parsedLimitPrice) || (!allowsSignedNet && parsedLimitPrice < 0)) {
            throw new Error(
              allowsSignedNet
                ? "Enter a valid TWS net limit price before routing this order."
                : "Enter a valid (non-negative) TWS limit price before routing this order."
            );
          }
        }
      }

      const execution =
        paperExecutionRoute === "ibkr-paper"
          ? {
              route: "ibkr-paper",
              orderType: paperIbkrOrderType,
              tif: paperIbkrTif,
              outsideRth: paperIbkrOutsideRth,
              limitPrice: paperIbkrOrderType === "LMT" ? Number(paperIbkrLimitPrice) : null,
              accountId: ibkrStatus?.selectedAccount ?? "",
              smart: {
                enabled: paperIbkrOrderType === "LMT" && paperIbkrSmartEnabled
              }
            }
          : paperExecutionRoute === "tws-paper"
            ? {
                route: "tws-paper",
                orderType: paperIbkrOrderType,
                tif: paperIbkrTif,
                outsideRth: paperIbkrOutsideRth,
                limitPrice: paperIbkrOrderType === "LMT" ? Number(paperIbkrLimitPrice) : null,
                accountId: twsStatus?.selectedAccount ?? ""
              }
            : {
                route: "local-paper"
              };

      const createResponse = await onCreatePaperOrder(
        buildCoveredIncomePaperOrderPayload({
          order: selectedScenarioOrder,
          row: selectedRow,
          strategyDefinition,
          purchaseDate: paperTradeDate || selectedScenarioOrder.purchaseDate || new Date().toISOString().slice(0, 10),
          execution
        })
      );
      const pendingConfirmation = getPendingConfirmation(createResponse?.order);

      setPaperOrderState({
        tone:
          (paperExecutionRoute === "ibkr-paper" || paperExecutionRoute === "tws-paper") &&
          createResponse?.message?.toLowerCase().includes("failed")
            ? "warning"
            : pendingConfirmation
              ? "warning"
              : "success",
        message:
          createResponse?.message ||
          (paperExecutionRoute === "ibkr-paper"
            ? "IBKR paper order submitted. You can monitor it from the paper-trading page."
            : paperExecutionRoute === "tws-paper"
              ? "TWS paper order submitted. You can monitor it from the paper-trading page."
              : "Order saved to paper trading."),
        confirmation: pendingConfirmation
      });
    } catch (createError) {
      setPaperOrderState({
        tone: "error",
        message: createError.message,
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
      const nextPayload = await onConfirmPaperExecution(pendingConfirmation.orderId, {
        confirmed
      });
      const nextConfirmation = getPendingConfirmation(nextPayload?.order);

      setPaperOrderState({
        tone:
          confirmed !== true
            ? "warning"
            : nextConfirmation
              ? "warning"
              : "success",
        message:
          nextPayload?.message ??
          (confirmed === true ? "Broker confirmation sent." : "Broker confirmation declined."),
        confirmation: nextConfirmation
      });
    } catch (confirmError) {
      setPaperOrderState((current) => ({
        tone: "error",
        message: confirmError.message,
        confirmation: current?.confirmation ?? null
      }));
    } finally {
      setPaperOrderSaving(false);
    }
  }

  function handleFilterChange(key, value) {
    setFilters((current) => ({
      ...current,
      [key]: value
    }));
  }

  function handleStrategyModeToggle(mode) {
    setFilters((current) => ({
      ...current,
      strategyModes: toggleArrayValue(current.strategyModes, mode)
    }));
  }

  function handleDteToggle(dte) {
    setFilters((current) => ({
      ...current,
      targetDte: toggleNumericValue(current.targetDte, dte)
    }));
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
    setVisibleColumnKeys(
      ensureCoveredIncomeColumnsVisible(getDefaultCoveredIncomeVisibleColumnKeys(true), [
        "ivRank",
        "evPerBuyingPower"
      ])
    );
  }

  function handleRowSelect(rowId) {
    setSelectedRowId(rowId);

    window.requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    });
  }

  function handleSort(key, { additive = false } = {}) {
    setSortState((current) => {
      const existingIndex = current.findIndex((descriptor) => descriptor.key === key);
      const existing = existingIndex >= 0 ? current[existingIndex] : null;
      const nextDirection = existing?.direction === "desc" ? "asc" : "desc";

      if (!additive) {
        return [{ key, direction: nextDirection }];
      }

      const nextState = current.filter((descriptor) => descriptor.key !== key);
      nextState.unshift({ key, direction: nextDirection });
      return nextState.slice(0, MAX_SORT_PRIORITIES);
    });
  }

  function saveFilters() {
    const saved = persistSavedFilters(COVERED_INCOME_FILTERS_STORAGE_KEY, {
      ...filters,
      visibleColumnKeys
    });
    setFeedback(saved ? "Scanner filters saved locally." : "Unable to save filters locally.");
  }

  function resetFilters() {
    setFilters(defaultFilters);
    setVisibleColumnKeys(
      ensureCoveredIncomeColumnsVisible(
        getDefaultCoveredIncomeVisibleColumnKeys(matchesCoveredIncomeCompactViewport()),
        ["ivRank", "evPerBuyingPower"]
      )
    );
    setFeedback("Scanner filters reset to defaults.");
  }

  if (loading) {
    return <div className="app-state">Loading covered income scanner…</div>;
  }

  if (error) {
    return <div className="app-state">{error}</div>;
  }

  return (
    <main className="workspace workspace--screening-v2 workspace--covered-income">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Covered Income Scanner</span>
          <h2>{strategyDefinition?.name ?? "Covered income scanner"}</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">{payload?.summary?.candidateCount ?? 0} candidates</span>
            <span className="pill pill--ghost">{payload?.summary?.capitalWarnings ?? 0} capital flags</span>
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

      {payload?.marketRegime ? (
        <section className="selection-banner tv-finder__selection-banner">
          <div className="selection-banner__title">
            <span className="brand__eyebrow">Current market regime</span>
            <strong>
              {payload.marketRegime.volatilityRegime} / {payload.marketRegime.trendRegime} / {payload.marketRegime.marketRegime}
            </strong>
          </div>
          <div className="selection-banner__actions">
            <div className="detail-badges">
              {(payload.marketRegime.recommended ?? []).map((item) => (
                <span key={`covered-income:recommended:${item}`} className="pill pill--live">{item}</span>
              ))}
              {(payload.marketRegime.avoid ?? []).slice(0, 2).map((item) => (
                <span key={`covered-income:avoid:${item}`} className="pill pill--ghost">Avoid: {item}</span>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {feedback ? (
        <div className="screening-v2__notice screening-v2__notice--info">
          <span>{feedback}</span>
        </div>
      ) : null}

      <section className="screening-v2__summary-grid">
        <article className="insight-card screening-v2__summary-card">
          <span>Symbols scanned</span>
          <strong>{payload?.summary?.symbolsScanned ?? 0}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg allocated return</span>
          <strong>{formatPercent(payload?.summary?.averageReturnOnAllocatedCashPct)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg annualized return</span>
          <strong>{formatPercent(payload?.summary?.averageAnnualizedReturnOnAllocatedCashPct)}</strong>
        </article>
        <article className="insight-card screening-v2__summary-card">
          <span>Avg final score</span>
          <strong>{formatNumber(payload?.summary?.averageFinalScore, 1)}</strong>
        </article>
      </section>

      <article className="insight-card screening-v2__filters covered-income__filters-card">
        <div className="covered-income__filter-toolbar">
          <span className="brand__eyebrow covered-income__filter-title">Scanner filters</span>

          <label className="covered-income__filter-control covered-income__filter-control--symbols">
            <span className="covered-income__filter-label">Symbols</span>
            <input
              className="covered-income__filter-input"
              value={filters.symbols}
              onChange={(event) => handleFilterChange("symbols", event.target.value.toUpperCase())}
              placeholder="TSLA, AAPL, NVDA, SPY"
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Cash</span>
            <input
              className="covered-income__filter-input"
              value={filters.maxAllocatedCash}
              onChange={(event) => handleFilterChange("maxAllocatedCash", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Min vol</span>
            <input
              className="covered-income__filter-input"
              value={filters.minOptionVolume}
              onChange={(event) => handleFilterChange("minOptionVolume", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Min OI</span>
            <input
              className="covered-income__filter-input"
              value={filters.minOpenInterest}
              onChange={(event) => handleFilterChange("minOpenInterest", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control">
            <span className="covered-income__filter-label">Spread %</span>
            <input
              className="covered-income__filter-input"
              value={filters.maxBidAskSpreadPct}
              onChange={(event) => handleFilterChange("maxBidAskSpreadPct", event.target.value)}
            />
          </label>

          <label className="covered-income__filter-control covered-income__filter-control--range">
            <span className="covered-income__filter-label">Put Δ</span>
            <div className="covered-income__filter-range">
              <input
                className="covered-income__filter-input"
                value={filters.putDeltaMin}
                onChange={(event) => handleFilterChange("putDeltaMin", event.target.value)}
              />
              <span className="covered-income__filter-separator">to</span>
              <input
                className="covered-income__filter-input"
                value={filters.putDeltaMax}
                onChange={(event) => handleFilterChange("putDeltaMax", event.target.value)}
              />
            </div>
          </label>

          <label className="covered-income__filter-control covered-income__filter-control--range">
            <span className="covered-income__filter-label">Call Δ</span>
            <div className="covered-income__filter-range">
              <input
                className="covered-income__filter-input"
                value={filters.callDeltaMin}
                onChange={(event) => handleFilterChange("callDeltaMin", event.target.value)}
              />
              <span className="covered-income__filter-separator">to</span>
              <input
                className="covered-income__filter-input"
                value={filters.callDeltaMax}
                onChange={(event) => handleFilterChange("callDeltaMax", event.target.value)}
              />
            </div>
          </label>

          <div className="covered-income__filter-chip-group">
            {Object.entries(strategyModeLabels).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={`finder-action ${filters.strategyModes.includes(mode) ? "tv-finder__filter-control--active" : ""}`}
                onClick={() => handleStrategyModeToggle(mode)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="covered-income__filter-chip-group">
            {[7, 15, 21, 30].map((dte) => (
              <button
                key={dte}
                type="button"
                className={`finder-action ${filters.targetDte.includes(dte) ? "tv-finder__filter-control--active" : ""}`}
                onClick={() => handleDteToggle(dte)}
              >
                {dte}D
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`finder-action ${filters.excludeEarningsBeforeExpiry ? "tv-finder__filter-control--active" : ""}`}
            onClick={() =>
              handleFilterChange("excludeEarningsBeforeExpiry", !filters.excludeEarningsBeforeExpiry)
            }
          >
            Earnings off
          </button>

          <button type="button" className="finder-action" onClick={() => loadScan(false, filters)}>
            Scan
          </button>
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
              <span className="brand__eyebrow">Scanner table</span>
              <h3>Ranked option income setups</h3>
            </div>
            <p className="card-copy">
              The main grid stays focused on decision metrics only: expectancy, regime fit, liquidity, and portfolio concentration.
            </p>
          </div>

          <div className="covered-income__color-guide" role="note" aria-label="Color guide for scanner columns">
            <span className="covered-income__color-guide-title">Color guide</span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--good">Green</span>
              Score / confidence &gt;= 70, alloc ann &gt;= 24%, full-exp ann &gt;= 16%
            </span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--caution">Yellow</span>
              Score / confidence 55-69, alloc ann 12%-23.99%, full-exp ann 8%-15.99%
            </span>
            <span className="covered-income__color-guide-item">
              <span className="covered-income__heat-badge covered-income__heat-badge--risk">Red</span>
              Score / confidence &lt; 55, alloc ann &lt; 12%, full-exp ann &lt; 8%, or hard risk flags
            </span>
          </div>

          <div className="screening-v2__table-wrap">
            <table className="screening-v2__table" style={{ minWidth: coveredIncomeTableMinWidth }}>
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
                          const index = sortState.findIndex((descriptor) => descriptor.key === column.key);
                          if (index < 0) {
                            return null;
                          }
                          const descriptor = sortState[index];
                          return (
                            <span className="finder-sort__indicator" aria-hidden="true">
                              <span className="finder-sort__priority">{index + 1}</span>
                              <span className="finder-sort__direction">{descriptor.direction === "asc" ? "↑" : "↓"}</span>
                            </span>
                          );
                        })()}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.length ? (
                  sortedRows.map((row) => (
                    <tr
                      key={row.id}
                      className={row.id === selectedRow?.id ? "screening-v2__table-row--active" : ""}
                      onClick={() => handleRowSelect(row.id)}
                    >
                      {visibleColumns.map((column) => (
                        <td key={column.key}>
                          {column.key === "symbol" ? (
                            <div className="finder-cell-stack">
                              <strong>{row.symbol}</strong>
                              <span className="screening-v2__subtle">{row.companyName}</span>
                            </div>
                          ) : (
                            renderHeatCell(row, column.key)
                          )}
                        </td>
                      ))}
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={visibleColumns.length} className="finder-empty">
                      No candidates matched the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      {selectedRow ? (
        <>
          <section ref={detailRef} className="selection-banner tv-finder__selection-banner">
            <div className="selection-banner__title">
              <span className="brand__eyebrow">Selected setup</span>
              <strong>
                {selectedRow.symbol} · {formatStrategyType(selectedRow.strategyType)} · {selectedRow.expiryDate}
              </strong>
            </div>
            <div className="selection-banner__actions">
              <div className="detail-badges">
                <span className="pill pill--live">Score {formatNumber(selectedRow.score?.finalStrategyScore, 0)}</span>
                <span className="pill pill--ghost">{formatWholeNumber(selectedRow.contracts)} contracts</span>
                <span className="pill pill--ghost">{formatWholeNumber(selectedRow.dte)} DTE</span>
                <span className={getRiskToneClassName(selectedRow.intelligence?.portfolioImpact?.correlationOverlap === "high")}>
                  {selectedRow.intelligence?.portfolioImpact?.correlationCluster ?? "portfolio impact"}
                </span>
              </div>
            </div>
          </section>

          <div className="detail-panels covered-income__detail-panels">
            <div className="detail-panel">
              <h4>Strategy overview</h4>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Overview</span>
                <dl>
                  <div><dt>Underlying price</dt><dd>{formatCurrency(selectedRow.stockPrice)}</dd></div>
                  <div><dt>Strategy type</dt><dd>{formatStrategyType(selectedRow.strategyType)}</dd></div>
                  <div><dt>Expiry</dt><dd>{selectedRow.expiryDate}</dd></div>
                  <div><dt>Days to expiry</dt><dd>{formatWholeNumber(selectedRow.dte)}</dd></div>
                  <div><dt>Support</dt><dd>{formatCurrency(selectedRow.priceZones?.supportPrice)}</dd></div>
                  <div><dt>Resistance</dt><dd>{formatCurrency(selectedRow.priceZones?.resistancePrice)}</dd></div>
                  <div><dt>Expected move</dt><dd>{formatCurrency(selectedRow.priceZones?.expectedMove)}</dd></div>
                  <div><dt>ATM IV</dt><dd>{formatPercent((selectedRow.priceZones?.atmIv ?? 0) * 100)}</dd></div>
                  <div><dt>Historical vol</dt><dd>{formatPercent((selectedRow.marketData?.historicalVolatility ?? 0) * 100)}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Returns and capital</span>
                <dl>
                  <div><dt>Total premium</dt><dd>{formatCurrency(selectedRow.premium?.totalPremium)}</dd></div>
                  <div><dt>Return on allocated cash</dt><dd>{formatPercent(selectedRow.returns?.returnOnAllocatedCashPct)}</dd></div>
                  <div><dt>Annualized allocated return</dt><dd>{formatPercent(selectedRow.returns?.annualizedReturnOnAllocatedCashPct)}</dd></div>
                  <div><dt>EV annualized</dt><dd>{formatPercent(selectedRow.intelligence?.ev?.evAnnualized)}</dd></div>
                  <div><dt>Return on full exposure</dt><dd>{formatPercent(selectedRow.returns?.returnOnFullExposurePct)}</dd></div>
                  <div><dt>Annualized full exposure return</dt><dd>{formatPercent(selectedRow.returns?.annualizedReturnOnFullExposurePct)}</dd></div>
                  <div><dt>Allocated cash used</dt><dd>{formatCurrency(selectedRow.capital?.allocatedCashUsed)}</dd></div>
                  <div><dt>Full exposure</dt><dd>{formatCurrency(selectedRow.capital?.fullCashSecuredExposure)}</dd></div>
                  <div><dt>Shares required</dt><dd>{formatWholeNumber(selectedRow.sharesRequired)}</dd></div>
                </dl>
              </div>
            </div>

            <div className="detail-panel detail-panel--contracts">
              <h4>Contract details</h4>
              <div className="detail-badges">
                {selectedRow.put ? (
                  <span className="pill pill--ghost">
                    Put {formatCurrency(selectedRow.put.strike)} · {selectedRow.put.assignmentRisk}
                  </span>
                ) : null}
                {selectedRow.call ? (
                  <span className="pill pill--ghost">
                    Call {formatCurrency(selectedRow.call.strike)} · {selectedRow.call.assignmentRisk}
                  </span>
                ) : null}
                <span className={getRiskToneClassName(selectedRow.risk?.liquidityWarning)}>
                  {selectedRow.risk?.liquidityWarning ? "Liquidity warning" : "Liquidity OK"}
                </span>
              </div>
              <div className="legs-table">
                <div className="legs-table__head">
                  <span>Action</span>
                  <span>Qty</span>
                  <span>Strike</span>
                  <span>Bid</span>
                  <span>Ask</span>
                  <span>Mark</span>
                  <span>Vol</span>
                  <span>OI</span>
                  <span>Spread</span>
                  <span>Code / note</span>
                </div>
                {selectedLegRows.map((leg) => (
                  <div key={leg.id} className="legs-table__row">
                    <span className={`legs-action legs-action--${leg.action.toLowerCase()}`}>{leg.action}</span>
                    <span>{formatWholeNumber(leg.quantity)}</span>
                    <span>{leg.strikeLabel}</span>
                    <span>{leg.bid != null ? formatCurrency(leg.bid) : "—"}</span>
                    <span>{leg.ask != null ? formatCurrency(leg.ask) : "—"}</span>
                    <span>{leg.mark != null ? formatCurrency(leg.mark) : "—"}</span>
                    <span>{leg.volume != null ? formatWholeNumber(leg.volume) : ""}</span>
                    <span>{leg.openInterest != null ? formatWholeNumber(leg.openInterest) : ""}</span>
                    <span>{leg.spreadPct != null ? `${formatNumber(leg.spreadPct, 2)}%` : ""}</span>
                    <span className="leg-reference">
                      <span>{leg.referenceLabel}</span>
                      <small>{leg.referenceMeta}</small>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="detail-panel detail-panel--controls">
              <h4>Trade context</h4>
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
                      {selectedRow.symbol} · {formatStrategyType(selectedRow.strategyType)}
                    </strong>
                  </div>
                  <div className="paper-order-ticket__status">
                    <span className={`pill ${paperExecutionRoute === "local-paper" ? "pill--ghost" : "pill--live"}`}>
                      {paperExecutionRoute === "ibkr-paper"
                        ? "IBKR paper"
                        : paperExecutionRoute === "tws-paper"
                          ? "TWS paper"
                          : "Local paper"}
                    </span>
                    {paperExecutionRoute === "ibkr-paper" ? (
                      <span className={`pill ${ibkrReady ? "pill--long" : "pill--warning"}`}>
                        {ibkrReady ? "IBKR ready" : "IBKR offline"}
                      </span>
                    ) : paperExecutionRoute === "tws-paper" ? (
                      <span className={`pill ${twsReady ? "pill--long" : "pill--warning"}`}>
                        {twsReady ? "TWS ready" : "TWS offline"}
                      </span>
                    ) : null}
                    {ibkrSuggestedLimitPrice != null ? (
                      <span className="pill pill--ghost">
                        Suggested {formatCurrency(Math.abs(ibkrSuggestedLimitPrice))}
                        {optionLegsForOrder.length > 1 ? " net" : ""}
                      </span>
                    ) : null}
                  </div>
                  <p className="detail-chart__copy">
                    Send the selected covered income structure into the same paper-routing flow used by the TradingView finder.
                  </p>
                </div>

                <div className="paper-order-ticket__controls">
                  {paperExecutionRoute === "ibkr-paper" && !ibkrReady ? (
                    <div className="screening-v2__notice screening-v2__notice--warning">
                      <span>
                        {ibkrStatus?.error || "IBKR paper gateway is not ready for order submission."}
                      </span>
                      {ibkrReloginNeeded ? (
                        <a href={ibkrLoginUrl} target="_blank" rel="noreferrer" className="chart-toggle">
                          Open IBKR login
                        </a>
                      ) : null}
                    </div>
                  ) : null}
                  {paperExecutionRoute === "tws-paper" && !twsReady ? (
                    <div className="screening-v2__notice screening-v2__notice--warning">
                      <span>{twsStatus?.error || "TWS is not ready for paper-order submission."}</span>
                    </div>
                  ) : null}
                  <label>
                    <span>Entry date</span>
                    <input
                      type="date"
                      value={paperTradeDate}
                      onChange={(event) => setPaperTradeDate(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Route</span>
                    <select
                      value={paperExecutionRoute}
                      onChange={(event) => setPaperExecutionRoute(event.target.value)}
                    >
                      <option value="tws-paper">TWS paper</option>
                      <option value="ibkr-paper">IBKR paper</option>
                      <option value="local-paper">Local paper</option>
                    </select>
                  </label>
                  {paperExecutionRoute === "ibkr-paper" || paperExecutionRoute === "tws-paper" ? (
                    <label>
                      <span>Order type</span>
                      <select
                        value={paperIbkrOrderType}
                        onChange={(event) => setPaperIbkrOrderType(event.target.value)}
                      >
                        <option value="LMT">Limit</option>
                        <option value="MKT">Market</option>
                      </select>
                    </label>
                  ) : null}
                  {paperExecutionRoute === "ibkr-paper" && paperIbkrOrderType === "LMT" ? (
                    <label>
                      <span>IBKR limit</span>
                      <input
                        type="number"
                        step="0.01"
                        value={paperIbkrLimitPrice}
                        onChange={(event) => setPaperIbkrLimitPrice(event.target.value)}
                      />
                    </label>
                  ) : null}
                  {paperExecutionRoute === "tws-paper" && paperIbkrOrderType === "LMT" ? (
                    <>
                      <label>
                        <span>TWS limit</span>
                        <input
                          type="number"
                          step="0.01"
                          list="tws-limit-window-covered-income"
                          value={paperIbkrLimitPrice}
                          onChange={(event) => setPaperIbkrLimitPrice(event.target.value)}
                        />
                      </label>
                      <datalist id="tws-limit-window-covered-income">
                        {twsLimitPriceWindow.map((option) => (
                          <option key={`tws-limit-covered-income:${option}`} value={option} />
                        ))}
                      </datalist>
                    </>
                  ) : null}
                  {paperExecutionRoute === "ibkr-paper" || paperExecutionRoute === "tws-paper" ? (
                    <label>
                      <span>TIF</span>
                      <select value={paperIbkrTif} onChange={(event) => setPaperIbkrTif(event.target.value)}>
                        <option value="DAY">DAY</option>
                        <option value="GTC">GTC</option>
                      </select>
                    </label>
                  ) : null}
                  {paperExecutionRoute === "ibkr-paper" || paperExecutionRoute === "tws-paper" ? (
                    <label className="paper-order-ticket__toggle">
                      <span>Outside RTH</span>
                      <span className="paper-order-ticket__toggle-control">
                        <input
                          type="checkbox"
                          checked={paperIbkrOutsideRth}
                          onChange={(event) => setPaperIbkrOutsideRth(event.target.checked)}
                        />
                      </span>
                    </label>
                  ) : null}
                  {paperExecutionRoute === "ibkr-paper" && paperIbkrOrderType === "LMT" ? (
                    <label className="paper-order-ticket__toggle">
                      <span>Smart entry</span>
                      <span className="paper-order-ticket__toggle-control">
                        <input
                          type="checkbox"
                          checked={paperIbkrSmartEnabled}
                          onChange={(event) => setPaperIbkrSmartEnabled(event.target.checked)}
                        />
                      </span>
                    </label>
                  ) : null}
                  <button
                    type="button"
                    className={`finder-action ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                    onClick={handleCreatePaperTrade}
                    disabled={
                      !onCreatePaperOrder ||
                      paperOrderSaving ||
                      (paperExecutionRoute === "ibkr-paper" && !ibkrReady) ||
                      (paperExecutionRoute === "tws-paper" && !twsReady)
                    }
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
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Risk analysis</span>
                <dl>
                  <div><dt>Downside breakeven</dt><dd>{formatCurrency(selectedRow.breakevens?.downsideBreakeven)}</dd></div>
                  <div><dt>Upside breakeven</dt><dd>{selectedRow.breakevens?.upsideBreakeven != null ? formatCurrency(selectedRow.breakevens.upsideBreakeven) : "—"}</dd></div>
                  <div><dt>Called-away price</dt><dd>{selectedRow.breakevens?.calledAwayPrice != null ? formatCurrency(selectedRow.breakevens.calledAwayPrice) : "—"}</dd></div>
                  <div><dt>IV rank</dt><dd>{formatPercent(selectedRow.intelligence?.volatility?.ivRank52w)}</dd></div>
                  <div><dt>IV-HV spread</dt><dd>{formatPercent((selectedRow.intelligence?.volatility?.ivHvSpread ?? 0) * 100)}</dd></div>
                  <div><dt>Earnings before expiry</dt><dd>{selectedRow.risk?.earningsBeforeExpiry ? "Yes" : "No"}</dd></div>
                  <div><dt>Put inside expected move</dt><dd>{selectedRow.risk?.putInsideExpectedMove ? "Yes" : "No"}</dd></div>
                  <div><dt>Call inside expected move</dt><dd>{selectedRow.risk?.callInsideExpectedMove ? "Yes" : "No"}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Explainability</span>
                <dl>
                  <div><dt>Final score</dt><dd>{formatWholeNumber(selectedRow.score?.finalStrategyScore)}</dd></div>
                  <div><dt>EV score</dt><dd>{formatWholeNumber(selectedRow.intelligence?.explanationData?.scoreBreakdown?.ev_score)}</dd></div>
                  <div><dt>IV regime score</dt><dd>{formatWholeNumber(selectedRow.intelligence?.explanationData?.scoreBreakdown?.iv_regime_score)}</dd></div>
                  <div><dt>Liquidity score</dt><dd>{formatWholeNumber(selectedRow.intelligence?.explanationData?.scoreBreakdown?.liquidity_score)}</dd></div>
                  <div><dt>Yield score</dt><dd>{formatWholeNumber(selectedRow.score?.yieldScore)}</dd></div>
                  <div><dt>Diversification score</dt><dd>{formatWholeNumber(selectedRow.intelligence?.explanationData?.scoreBreakdown?.diversification_score)}</dd></div>
                  <div><dt>Historical expectancy</dt><dd>{formatWholeNumber(selectedRow.intelligence?.explanationData?.scoreBreakdown?.historical_expectancy_score)}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Portfolio impact</span>
                <dl>
                  <div><dt>Sector</dt><dd>{selectedRow.intelligence?.sector ?? "n/a"}</dd></div>
                  <div><dt>Beta</dt><dd>{formatNumber(selectedRow.intelligence?.beta, 2)}</dd></div>
                  <div><dt>Sector overlap</dt><dd>{selectedRow.intelligence?.portfolioImpact?.sectorOverlap ?? "n/a"}</dd></div>
                  <div><dt>Correlation overlap</dt><dd>{selectedRow.intelligence?.portfolioImpact?.correlationOverlap ?? "n/a"}</dd></div>
                  <div><dt>Correlation cluster</dt><dd>{selectedRow.intelligence?.portfolioImpact?.correlationCluster ?? "n/a"}</dd></div>
                  <div><dt>Net vega impact</dt><dd>{formatNumber(selectedRow.intelligence?.portfolioImpact?.netVegaChange, 0)}</dd></div>
                </dl>
              </div>
              <div className="detail-panel__section">
                <span className="detail-panel__section-heading">Assignment scenarios</span>
                <div className="covered-income__warning-list">
                  {assignmentScenarios.map((scenario) => (
                    <p key={scenario}>{scenario}</p>
                  ))}
                  {(selectedRow.intelligence?.riskFlags ?? []).map((flag) => (
                    <p key={flag}>{flag.replaceAll("_", " ")}</p>
                  ))}
                  {(selectedRow.risk?.warningMessages ?? []).map((warning) => (
                    <p key={warning}>{warning}</p>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <PayoffChart row={selectedRow} theme={theme} />

          {selectedScenarioOrder ? (
            <PaperTradeScenarioPanel
              order={selectedScenarioOrder}
              lastUpdated={payload?.generatedAt}
              className="paper-scenario-card--screening"
              defaultOpen={true}
              theme={theme}
            />
          ) : null}

          <section className="screening-v2__selected-layout covered-income__selected-layout">
            <article className="insight-card screening-v2__table-card">
              <div className="strategy-settings__page-head">
                <div>
                  <span className="brand__eyebrow">Scenario table</span>
                  <h3>Expiry P&amp;L checkpoints</h3>
                </div>
                <p className="card-copy">
                  These checkpoints are there to make assignment and capped-upside tradeoffs obvious before you choose a
                  combination manually.
                </p>
              </div>

              <div className="screening-v2__contract-table-wrap">
                <table className="screening-v2__contract-table">
                  <thead>
                    <tr>
                      <th>Underlying at expiry</th>
                      <th>Expiry P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(selectedRow.detail?.scenarioPoints ?? []).map((point) => (
                      <tr key={`${selectedRow.id}:${point.spot}`}>
                        <td>{formatCurrency(point.spot)}</td>
                        <td>{formatCurrency(point.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}
