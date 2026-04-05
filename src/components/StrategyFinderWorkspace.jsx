import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import ScenarioHeatmap, { buildScenarioHeatmapSnapshot } from "./ScenarioHeatmap.jsx";
import { getIbkrGatewayLoginUrl, isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";
import { getChartPalette } from "../theme.js";
import {
  buildTradingDateColumns,
  buildTradingDateRange,
  coerceToTradingDate,
  countTradingDaysBetween,
  tradingDaysToYears
} from "../tradingCalendar.js";
import {
  evaluatePolymarketSignalHit,
  projectPolymarketTargetProxySpot,
  resolvePolymarketSignal
} from "../../shared/polymarketSignals.js";

function normalCdf(x) {
  const sign = x >= 0 ? 1 : -1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y =
    1 -
    (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));

  return 0.5 * (1 + sign * y);
}

function blackScholesPrice({ type, spot, strike, timeYears, volatility, riskFreeRate }) {
  if (timeYears <= 0) {
    return type === "put" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeYears);

  if (type === "put") {
    return discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1);
  }

  return spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
}

function binaryCallPrice({ spot, strike, timeYears, volatility, riskFreeRate }) {
  if (timeYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return spot >= strike ? 1 : 0;
  }

  const sqrtT = Math.sqrt(timeYears);
  const d2 =
    (Math.log(spot / strike) + (riskFreeRate - 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);

  return Math.exp(-riskFreeRate * timeYears) * normalCdf(d2);
}

function binaryPutPrice({ spot, strike, timeYears, volatility, riskFreeRate }) {
  if (timeYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return spot <= strike ? 1 : 0;
  }

  const sqrtT = Math.sqrt(timeYears);
  const d2 =
    (Math.log(spot / strike) + (riskFreeRate - 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);

  return Math.exp(-riskFreeRate * timeYears) * normalCdf(-d2);
}

function clampProbability(value) {
  return clamp(value, 0.001, 0.999);
}

function logit(value) {
  return Math.log(value / (1 - value));
}

function logistic(value) {
  return 1 / (1 + Math.exp(-value));
}

function resolveFinderPolymarketSignal(question, marketContext = {}) {
  return resolvePolymarketSignal({
    question,
    targetValue: Number(marketContext?.targetUnderlyingValue ?? 0) || null,
    direction: marketContext?.polymarketDirection,
    triggerType: marketContext?.polymarketTriggerType
  });
}

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

function gcd(left, right) {
  const a = Math.abs(Math.round(left));
  const b = Math.abs(Math.round(right));

  if (!a) {
    return b;
  }

  if (!b) {
    return a;
  }

  let currentLeft = a;
  let currentRight = b;
  while (currentRight) {
    const remainder = currentLeft % currentRight;
    currentLeft = currentRight;
    currentRight = remainder;
  }

  return currentLeft;
}

function calculateIbkrNetLimitPrice(optionLegs) {
  const normalizedLegs = (optionLegs ?? []).filter((leg) => Number(leg?.quantity ?? 0) > 0);
  if (!normalizedLegs.length) {
    return null;
  }

  if (normalizedLegs.length === 1) {
    return Number(normalizedLegs[0].entryPrice ?? 0) || 0;
  }

  const comboQuantity = normalizedLegs.reduce(
    (current, leg) => gcd(current, Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0)),
    0
  );
  const normalizedComboQuantity = comboQuantity || 1;

  return normalizedLegs.reduce((sum, leg) => {
    const ratio = Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0) / normalizedComboQuantity || 1;
    const signedPrice =
      leg.action === "SHORT" ? -(Number(leg.entryPrice ?? 0) || 0) : Number(leg.entryPrice ?? 0) || 0;
    return sum + (signedPrice * ratio);
  }, 0);
}

function formatWholeNumber(value) {
  if (value == null || Number.isNaN(value)) {
    return null;
  }

  return String(Math.round(Number(value)));
}

function formatQuoteSizePair(bidSize, askSize) {
  const numericBidSize = Number(bidSize);
  const numericAskSize = Number(askSize);

  if (
    !Number.isFinite(numericBidSize) ||
    numericBidSize <= 0 ||
    !Number.isFinite(numericAskSize) ||
    numericAskSize <= 0
  ) {
    return null;
  }

  return `${formatWholeNumber(numericBidSize)}/${formatWholeNumber(numericAskSize)}`;
}

function compareValues(left, right, direction) {
  if (left == null && right == null) {
    return 0;
  }
  if (left == null) {
    return 1;
  }
  if (right == null) {
    return -1;
  }

  if (typeof left === "number" && typeof right === "number") {
    return direction === "asc" ? left - right : right - left;
  }

  const leftValue = Array.isArray(left)
    ? left.map((item) => (typeof item === "object" ? item.label : item)).join("/")
    : String(left);
  const rightValue = Array.isArray(right)
    ? right.map((item) => (typeof item === "object" ? item.label : item)).join("/")
    : String(right);

  return direction === "asc"
    ? leftValue.localeCompare(rightValue)
    : rightValue.localeCompare(leftValue);
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

function buildPolymarketReferenceLine({ marketId, marketSlug, eventSlug, url, source }) {
  const parts = [];
  const derivedEventSlug = eventSlug || derivePolymarketEventSlug(url);

  if (marketId) {
    parts.push(`ID ${marketId}`);
  }

  if (marketSlug) {
    parts.push(`slug ${marketSlug}`);
  }

  if (derivedEventSlug) {
    parts.push(`event ${derivedEventSlug}`);
  }

  if (parts.length) {
    return parts.join(" · ");
  }

  return source === "seed" ? "Seed fallback market · no live slug/event yet" : "";
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function differenceInDays(startValue, endValue) {
  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);

  if (!start || !end) {
    return 0;
  }

  return Math.round((end.getTime() - start.getTime()) / (24 * 60 * 60 * 1000));
}

function addDays(dateValue, days) {
  const date = parseIsoDate(dateValue);
  if (!date) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function minIsoDate(values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] ?? "";
}

function clampIsoDate(value, min, max) {
  if (!value) {
    return min || max || "";
  }

  if (min && value < min) {
    return min;
  }

  if (max && value > max) {
    return max;
  }

  return value;
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

function formatCompactDate(value) {
  return value ? value.replaceAll("-", "") : "";
}

function formatShortDate(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "n/a";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short"
  }).format(date);
}

function formatUnderlyingLabel(symbol, fallback = "Underlying") {
  const explicitLabels = {
    "BTC-USD": "Bitcoin",
    "ETH-USD": "Ethereum",
    "SPX-INDEX": "SPX index",
    "XAU-USD": "Gold",
    "WTI-USD": "WTI"
  };

  if (explicitLabels[symbol]) {
    return explicitLabels[symbol];
  }

  if (!symbol) {
    return fallback;
  }

  if (symbol.endsWith("-USD")) {
    return symbol.replace("-USD", "");
  }

  if (symbol.endsWith("-INDEX")) {
    return `${symbol.replace("-INDEX", "")} index`;
  }

  return symbol;
}

function determineStepFromRange(min, max) {
  const range = Math.max(max - min, 0);

  if (range > 10000) {
    return 100;
  }

  if (range > 1000) {
    return 10;
  }

  if (range > 100) {
    return 1;
  }

  if (range > 25) {
    return 0.1;
  }

  return 0.01;
}

function normalizeQuantityInput(value, fallback = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }

  return Math.max(0, Math.round(numericValue));
}

function toIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function endOfMonth(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "";
  }

  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return toIsoDate(date);
}

function startOfNextMonth(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "";
  }

  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return toIsoDate(date);
}

function endOfNextMonth(value) {
  const start = startOfNextMonth(value);
  return start ? endOfMonth(start) : "";
}

function startOfNextQuarter(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "";
  }

  const nextQuarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 3;
  date.setUTCMonth(nextQuarterMonth, 1);
  return toIsoDate(date);
}

function endOfNextQuarter(value) {
  const start = parseIsoDate(startOfNextQuarter(value));
  if (!start) {
    return "";
  }

  start.setUTCMonth(start.getUTCMonth() + 3, 0);
  return toIsoDate(start);
}

function buildDatePresets(baseDate) {
  if (!baseDate) {
    return [];
  }

  return [
    { id: "this-month", label: "This month", from: baseDate, to: endOfMonth(baseDate) },
    { id: "next-30", label: "Next 30 days", from: baseDate, to: addDays(baseDate, 30) },
    { id: "next-45", label: "Next 45 days", from: baseDate, to: addDays(baseDate, 45) },
    { id: "next-90", label: "Next 90 days", from: baseDate, to: addDays(baseDate, 90) },
    { id: "next-month", label: "Next month", from: startOfNextMonth(baseDate), to: endOfNextMonth(baseDate) },
    {
      id: "next-quarter",
      label: "Next quarter",
      from: startOfNextQuarter(baseDate),
      to: endOfNextQuarter(baseDate)
    }
  ].filter((preset) => preset.from && preset.to);
}

function buildDefaultDateRange(baseDate) {
  const fallbackFrom = baseDate || new Date().toISOString().slice(0, 10);
  return {
    from: fallbackFrom,
    to: addDays(fallbackFrom, 30) || fallbackFrom
  };
}

function normalizeDateRange(range, baseDate = "") {
  const defaultRange = buildDefaultDateRange(baseDate);
  const from = String(range?.from ?? "").trim() || defaultRange.from;
  const requestedTo = String(range?.to ?? "").trim();

  if (!requestedTo) {
    return {
      from,
      to: defaultRange.to >= from ? defaultRange.to : from
    };
  }

  return {
    from,
    to: requestedTo < from ? from : requestedTo
  };
}

function resolveDateRangeForRows(range, rows = []) {
  if (!rows.length) {
    return range;
  }

  const hasRowsInRange = rows.some((row) => {
    const expiration = String(row?.expiration ?? "").trim();
    return expiration && (!range.from || expiration >= range.from) && (!range.to || expiration <= range.to);
  });

  if (hasRowsInRange) {
    return range;
  }

  const sortedExpiries = rows
    .map((row) => String(row?.expiration ?? "").trim())
    .filter(Boolean)
    .sort();
  const nextAvailableExpiry =
    sortedExpiries.find((expiration) => !range.from || expiration >= range.from) ?? sortedExpiries[0] ?? "";

  if (!nextAvailableExpiry) {
    return range;
  }

  return {
    from: range.from,
    to: nextAvailableExpiry < range.from ? range.from : nextAvailableExpiry
  };
}

function buildSelectionSummary(selectedItems, allItems, fallbackLabel) {
  if (!allItems.length || selectedItems.length === allItems.length) {
    return fallbackLabel;
  }

  if (selectedItems.length === 1) {
    return selectedItems[0];
  }

  return `${selectedItems[0]} +${selectedItems.length - 1}`;
}

function parseOptionalNumber(value) {
  if (value === "" || value == null) {
    return null;
  }

  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function formatFilterThreshold(value) {
  const numericValue = parseOptionalNumber(value);
  if (numericValue == null) {
    return null;
  }

  return new Intl.NumberFormat("en-GB", {
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    signDisplay: numericValue > 0 ? "always" : "auto"
  }).format(numericValue);
}

function buildPnlFilterSummary({ maxProfitMin, maxProfitMax, maxLossMin, maxLossMax }) {
  const activeFilters = [
    maxLossMin != null ? `Max loss >= ${formatFilterThreshold(maxLossMin)}` : null,
    maxLossMax != null ? `Max loss <= ${formatFilterThreshold(maxLossMax)}` : null,
    maxProfitMin != null ? `Max profit >= ${formatFilterThreshold(maxProfitMin)}` : null,
    maxProfitMax != null ? `Max profit <= ${formatFilterThreshold(maxProfitMax)}` : null
  ].filter(Boolean);

  if (!activeFilters.length) {
    return "P&L filters";
  }

  return activeFilters.length === 1 ? activeFilters[0] : `P&L filters (${activeFilters.length})`;
}

function buildQuoteSizeFilterSummary(threshold, quoteSizeDataAvailable = true) {
  if (!quoteSizeDataAvailable) {
    return "Bid/ask size unavailable";
  }

  const thresholdLabel = formatWholeNumber(threshold);
  return thresholdLabel ? `Bid/ask size > ${thresholdLabel}` : "Bid/ask size";
}

function buildSourceFilterSummary(sourceFilter) {
  if (sourceFilter === "live") {
    return "Live only";
  }

  if (sourceFilter === "seed") {
    return "Seed only";
  }

  return "Sources";
}

const DEFAULT_MAX_LOSS_FLOOR = "-3000";

function calculateSpreadPercent(bid, ask) {
  const numericBid = Number(bid);
  const numericAsk = Number(ask);

  if (!Number.isFinite(numericBid) || !Number.isFinite(numericAsk)) {
    return null;
  }

  return (Math.abs(numericAsk - numericBid) / Math.max(Math.abs((numericAsk + numericBid) / 2), 0.01)) * 100;
}

function approximateBreakevens(curve) {
  const values = [];

  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1];
    const current = curve[index];
    if (previous.totalPnL == null || current.totalPnL == null) {
      continue;
    }

    if ((previous.totalPnL <= 0 && current.totalPnL >= 0) || (previous.totalPnL >= 0 && current.totalPnL <= 0)) {
      const slope = current.totalPnL - previous.totalPnL;
      const ratio = slope === 0 ? 0 : (0 - previous.totalPnL) / slope;
      const spot = previous.spot + (current.spot - previous.spot) * ratio;
      values.push(formatNumber(spot, 2));
    }
  }

  return values.filter((value, index, array) => value != null && array.indexOf(value) === index);
}

function buildChainKey(symbol, expiration, optionType) {
  return `${symbol}|${expiration}|${optionType}`;
}

function buildSpotEvaluationGrid({ start, end, targetThreshold, optionLegs }) {
  const denseSteps = 48;
  const epsilon = Math.max((end - start) / 400, 0.01);
  const denseGrid = Array.from(
    { length: denseSteps },
    (_, index) => start + ((end - start) / (denseSteps - 1)) * index
  );
  const criticalSpots = [
    targetThreshold - epsilon,
    targetThreshold,
    targetThreshold + epsilon,
    ...optionLegs.flatMap((leg) => [Number(leg.strike) - epsilon, Number(leg.strike), Number(leg.strike) + epsilon])
  ];

  return [...denseGrid, ...criticalSpots]
    .filter((spot) => Number.isFinite(spot) && spot >= start && spot <= end)
    .map((spot) => Number(spot.toFixed(4)))
    .filter((spot, index, array) => array.indexOf(spot) === index)
    .sort((left, right) => left - right);
}

function buildPayoffEvaluationRange({ currentSpot, targetThreshold, optionLegs }) {
  const optionStrikes = optionLegs
    .map((leg) => Number(leg.strike))
    .filter((value) => Number.isFinite(value) && value >= 0);
  const referenceHigh = Math.max(currentSpot, targetThreshold, ...optionStrikes, 1);

  return {
    start: 0,
    end: Math.max(referenceHigh * 1.75, referenceHigh + 10, 25)
  };
}

function calculateHighSpotSlope(optionLegs) {
  return optionLegs.reduce((sum, leg) => {
    if (leg.optionType !== "call") {
      return sum;
    }

    const quantity = Number(leg.contractUnits ?? leg.quantity ?? 0);
    const multiplier = Number(leg.contractMultiplier ?? (leg.contractUnits ? 1 : 100));
    const effectiveUnits = leg.contractUnits != null ? quantity : quantity * multiplier;

    return sum + (leg.action === "LONG" ? 1 : -1) * effectiveUnits;
  }, 0);
}

function evaluatePayoffExtremes(curve, optionLegs) {
  const values = curve.map((point) => Number(point.totalPnL)).filter(Number.isFinite);
  const highSpotSlope = calculateHighSpotSlope(optionLegs);

  return {
    maxProfit: values.length && highSpotSlope <= 0 ? Math.max(...values) : highSpotSlope > 0 ? null : null,
    maxLoss: values.length && highSpotSlope >= 0 ? Math.min(...values) : highSpotSlope < 0 ? null : null,
    maxProfitUnbounded: highSpotSlope > 0,
    maxLossUnbounded: highSpotSlope < 0
  };
}

function formatExtrema(value, { unbounded = false, kind = "profit" } = {}) {
  if (unbounded) {
    return kind === "loss" ? "Unlimited loss" : "Unlimited";
  }

  return formatCurrency(value);
}

function formatAbsoluteCurrency(value, currency = "USD", digits = 2) {
  return formatCurrency(Math.abs(Number(value) || 0), currency, digits);
}

function formatQuoteSourceLabel(leg) {
  if (leg?.kind === "binary") {
    return "Polymarket";
  }

  const quoteSizePair = formatQuoteSizePair(leg?.bidSize, leg?.askSize);

  if (leg?.isLive === true || leg?.quoteSource === "polygon" || leg?.quoteSource === "Polygon.io") {
    return quoteSizePair ? `Polygon.io · size ${quoteSizePair}` : "Polygon.io";
  }

  if (
    leg?.quoteSource === "modeled" ||
    leg?.quoteSource === "Modeled chain" ||
    leg?.quoteSource === "Synthetic chain"
  ) {
    return "Synthetic chain";
  }

  return leg?.quoteSource || "Seeded";
}

function formatOptionReferenceLabel(leg) {
  if (leg?.isLive === true && leg?.contractSymbol) {
    return leg.contractSymbol;
  }

  if (!leg?.strike) {
    return "Synthetic contract";
  }

  return `Synthetic ${formatNumber(leg.strike, 1)}${leg.optionType === "put" ? "P" : "C"} · ${leg.expiry}`;
}

function formatContractChoiceLabel(contract) {
  const bidLabel = formatNumber(contract?.bid, 2) ?? "n/a";
  const askLabel = formatNumber(contract?.ask, 2) ?? "n/a";
  const quoteSizePair = formatQuoteSizePair(contract?.bidSize, contract?.askSize);
  const sizeSuffix = quoteSizePair ? ` · size ${quoteSizePair}` : "";

  if (contract?.isLive === true && contract?.contractSymbol) {
    return `${contract.contractSymbol} · bid ${bidLabel} · ask ${askLabel}${sizeSuffix}`;
  }

  return `Synthetic ${formatNumber(contract?.strike, 1)}${contract?.optionType === "put" ? "P" : "C"} · ${
    contract?.expiration
  } · bid ${bidLabel} · ask ${askLabel}${sizeSuffix}`;
}

function binaryPriceFromYes(outcome, yesPrice) {
  return outcome === "NO" ? 1 - yesPrice : yesPrice;
}

function binaryPnL({ action, entryPrice, markPrice, quantity }) {
  return (action === "LONG" ? markPrice - entryPrice : entryPrice - markPrice) * quantity;
}

function estimatePolymarketYesPrice({
  spot,
  strike,
  timeYears,
  volatility,
  riskFreeRate,
  marketReferenceYesPrice,
  currentSpot,
  currentTimeYears,
  signalDirection = "up"
}) {
  if (timeYears < 0) {
    return signalDirection === "down" ? (spot <= strike ? 1 : 0) : (spot >= strike ? 1 : 0);
  }

  const effectiveTimeYears = Math.max(timeYears, 1 / 252);
  const effectiveCurrentTimeYears = Math.max(currentTimeYears, 1 / 252);
  const binaryPriceFunction = signalDirection === "down" ? binaryPutPrice : binaryCallPrice;

  const rawEstimatedYesPrice =
    strike > 0 && spot > 0
      ? binaryPriceFunction({
          spot,
          strike,
          timeYears: effectiveTimeYears,
          volatility,
          riskFreeRate
        })
      : marketReferenceYesPrice;
  const currentModeledYesPrice =
    strike > 0 && currentSpot > 0
      ? binaryPriceFunction({
          spot: currentSpot,
          strike,
          timeYears: effectiveCurrentTimeYears,
          volatility,
          riskFreeRate
        })
      : marketReferenceYesPrice;

  if (
    !(marketReferenceYesPrice > 0 && currentModeledYesPrice > 0 && effectiveCurrentTimeYears > 0)
  ) {
    return clamp(rawEstimatedYesPrice, 0.001, 0.999);
  }

  const modelCalibration =
    logit(clampProbability(marketReferenceYesPrice)) -
    logit(clampProbability(currentModeledYesPrice));
  const calibrationWeight = clamp(effectiveTimeYears / effectiveCurrentTimeYears, 0, 1);

  return clamp(
    logistic(logit(clampProbability(rawEstimatedYesPrice)) + modelCalibration * calibrationWeight),
    0.001,
    0.999
  );
}

const HEATMAP_RANGE_OPTIONS = [1, 2, 3];
const HEATMAP_COMPARISON_ROW_COUNT = 13;
const HEATMAP_COMPARISON_COLUMN_COUNT = 10;

function buildHeatmapDateColumns(startDate, endDate, columnCount = HEATMAP_COMPARISON_COLUMN_COUNT) {
  return buildTradingDateColumns(startDate, endDate, columnCount);
}

function buildHeatmapPriceRows({
  centerPrice,
  volatility,
  totalDays,
  rangeMultiplier,
  rowCount = HEATMAP_COMPARISON_ROW_COUNT
}) {
  const halfSteps = Math.floor(rowCount / 2);
  const timeYears = Math.max(tradingDaysToYears(totalDays), 1 / 252);
  const sigmaMove = Math.max(centerPrice * volatility * Math.sqrt(timeYears), Math.max(centerPrice * 0.04, 1));

  return Array.from({ length: rowCount }, (_value, index) => {
    const relativePosition = halfSteps === 0 ? 0 : (halfSteps - index) / halfSteps;
    return Math.max(centerPrice + relativePosition * rangeMultiplier * sigmaMove, 0.01);
  });
}

function calculateScenarioHeatmapPointPnL({
  spot,
  date,
  optionLegs,
  polymarketLegs,
  impliedVolatility,
  riskFreeRate,
  converterRatio,
  targetUnderlyingValue,
  polymarketSignal,
  polymarketResolutionDate,
  marketReferenceYesPrice,
  currentUnderlyingSpot,
  equivalentUnderlyingSpot,
  currentTimeToMarketResolutionYears
}) {
  const optionPnL = optionLegs.reduce((sum, leg) => {
    const remainingDays = countTradingDaysBetween(date, leg.expiry, {
      includeStart: false,
      includeEnd: true
    });
    const optionMarkPrice =
      remainingDays > 0
        ? blackScholesPrice({
            type: leg.optionType,
            spot,
            strike: Number(leg.strike),
            timeYears: tradingDaysToYears(remainingDays),
            volatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
            riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
          })
        : leg.optionType === "put"
          ? Math.max(Number(leg.strike) - spot, 0)
          : Math.max(spot - Number(leg.strike), 0);
    const pnlPerUnit = leg.action === "LONG" ? optionMarkPrice - leg.entryPrice : leg.entryPrice - optionMarkPrice;

    return sum + pnlPerUnit * leg.contractUnits;
  }, 0);

  const settleUnderlying = converterRatio > 0 ? spot / converterRatio : spot;
  const remainingPolymarketDays = countTradingDaysBetween(date, polymarketResolutionDate, {
    includeStart: false,
    includeEnd: true
  });
  const yesPrice =
    remainingPolymarketDays > 0
      ? estimatePolymarketYesPrice({
          spot: settleUnderlying,
          strike: targetUnderlyingValue,
          timeYears: tradingDaysToYears(remainingPolymarketDays),
          volatility: impliedVolatility,
          riskFreeRate,
          marketReferenceYesPrice,
          currentSpot: currentUnderlyingSpot || equivalentUnderlyingSpot,
          currentTimeYears: currentTimeToMarketResolutionYears,
          signalDirection: polymarketSignal?.direction
        })
      : targetUnderlyingValue > 0
        ? evaluatePolymarketSignalHit(settleUnderlying, polymarketSignal)
          ? 1
          : 0
        : marketReferenceYesPrice;
  const binaryPnLAtDate = polymarketLegs.reduce(
    (sum, leg) =>
      sum +
      binaryPnL({
        action: leg.action,
        entryPrice: leg.entryPrice,
        markPrice: binaryPriceFromYes(leg.outcome, yesPrice),
        quantity: leg.quantity
      }),
    0
  );

  return optionPnL + binaryPnLAtDate;
}

function calculateHeatmapExtremaForRow(row, currentDate) {
  const optionLegs = (row.legs ?? []).filter((leg) => leg.kind === "option");
  const polymarketLegs = (row.legs ?? []).filter((leg) => leg.kind === "binary");
  const currentProxySpot = Number(row.marketContext?.currentProxySpot ?? row.quickOverview?.underlyingPrice ?? 0);

  if (!(currentProxySpot > 0) || (!optionLegs.length && !polymarketLegs.length)) {
    return {
      maxProfitRangeTag: null,
      maxLossRangeTag: null
    };
  }

  const polymarketResolutionDate = row.polymarketResolutionDate ?? row.expiration ?? "";
  const strategyCloseDate =
    minIsoDate([polymarketResolutionDate, ...optionLegs.map((leg) => leg.expiry)]) ||
    row.strategyCloseDate ||
    row.expiration ||
    polymarketResolutionDate ||
    currentDate;
  const valuationMinBaseDate =
    currentDate && (!strategyCloseDate || currentDate <= strategyCloseDate) ? currentDate : strategyCloseDate ?? currentDate;
  const valuationDateOptions = buildTradingDateRange(valuationMinBaseDate, strategyCloseDate);
  const valuationMinDate = valuationDateOptions[0] ?? valuationMinBaseDate;

  if (!valuationMinDate || !strategyCloseDate) {
    return {
      maxProfitRangeTag: null,
      maxLossRangeTag: null
    };
  }

  const currentUnderlyingSpot = Number(row.marketContext?.currentUnderlyingSpot ?? 0);
  const converterRatio =
    Number(row.marketContext?.conversionRatio ?? 0) ||
    (currentUnderlyingSpot > 0 && currentProxySpot > 0 ? currentProxySpot / currentUnderlyingSpot : 0);
  const polymarketSignal = resolveFinderPolymarketSignal(row.polymarketQuestion, row.marketContext);
  const targetUnderlyingValue =
    polymarketSignal?.targetValue ||
    Number(row.marketContext?.targetUnderlyingValue ?? 0) ||
    0;
  const impliedVolatility =
    Number(optionLegs[0]?.impliedVolatility ?? row.marketContext?.impliedVolatility ?? 0) || 0.24;
  const riskFreeRate =
    Number(optionLegs[0]?.riskFreeRate ?? row.marketContext?.riskFreeRate ?? 0.0425) || 0.0425;
  const equivalentUnderlyingSpot = converterRatio > 0 ? currentProxySpot / converterRatio : currentProxySpot;
  const currentDaysToMarketResolution = countTradingDaysBetween(
    currentDate || valuationMinDate,
    polymarketResolutionDate,
    {
      includeStart: false,
      includeEnd: true
    }
  );
  const currentTimeToMarketResolutionYears = tradingDaysToYears(currentDaysToMarketResolution);
  const referenceYesLeg = polymarketLegs.find((leg) => leg.outcome === "YES") ?? null;
  const referenceNoLeg = polymarketLegs.find((leg) => leg.outcome === "NO") ?? null;
  const marketReferenceYesPrice = Number(
    referenceYesLeg?.entryPrice ??
      (referenceNoLeg ? 1 - Number(referenceNoLeg.entryPrice ?? 0) : row.polymarketPrice ?? 0.5)
  );
  const heatmapOptionLegs = optionLegs.map((leg) => ({
    ...leg,
    entryPrice: Number(leg.entryPrice ?? 0),
    contractUnits: Number(leg.quantity ?? 0) * Number(leg.contractMultiplier ?? 100),
    impliedVolatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
    riskFreeRate: Number(leg.riskFreeRate ?? riskFreeRate) || riskFreeRate
  }));
  const heatmapPolymarketLegs = polymarketLegs.map((leg) => ({
    ...leg,
    entryPrice: Number(leg.entryPrice ?? 0),
    quantity: Number(leg.quantity ?? 0)
  }));
  const dateColumns = buildHeatmapDateColumns(valuationMinDate, strategyCloseDate, HEATMAP_COMPARISON_COLUMN_COUNT);
  const totalDays = countTradingDaysBetween(valuationMinDate, strategyCloseDate, {
    includeStart: false,
    includeEnd: true
  });

  let maxProfitValue = null;
  let maxLossValue = null;
  let maxProfitRangeTag = null;
  let maxLossRangeTag = null;

  HEATMAP_RANGE_OPTIONS.forEach((rangeMultiplier) => {
    const priceRows = buildHeatmapPriceRows({
      centerPrice: currentProxySpot,
      volatility: impliedVolatility,
      totalDays,
      rangeMultiplier,
      rowCount: HEATMAP_COMPARISON_ROW_COUNT
    });

    priceRows.forEach((spot) => {
      dateColumns.forEach(({ date }) => {
        const pnl = calculateScenarioHeatmapPointPnL({
          spot,
          date,
          optionLegs: heatmapOptionLegs,
          polymarketLegs: heatmapPolymarketLegs,
          impliedVolatility,
          riskFreeRate,
          converterRatio,
          targetUnderlyingValue,
          polymarketSignal,
          polymarketResolutionDate,
          marketReferenceYesPrice,
          currentUnderlyingSpot,
          equivalentUnderlyingSpot,
          currentTimeToMarketResolutionYears
        });

        if (!Number.isFinite(pnl)) {
          return;
        }

        if (maxProfitValue == null || pnl > maxProfitValue) {
          maxProfitValue = pnl;
          maxProfitRangeTag = `${rangeMultiplier}x`;
        }

        if (maxLossValue == null || pnl < maxLossValue) {
          maxLossValue = pnl;
          maxLossRangeTag = `${rangeMultiplier}x`;
        }
      });
    });
  });

  if (maxProfitValue == null || maxLossValue == null) {
    return {
      maxProfitRangeTag: null,
      maxLossRangeTag: null
    };
  }

  return {
    maxProfit: Number(maxProfitValue.toFixed(2)),
    maxLoss: Number(maxLossValue.toFixed(2)),
    maxProfitUnbounded: false,
    maxLossUnbounded: false,
    maxProfitRangeTag,
    maxLossRangeTag
  };
}

const columns = [
  { key: "expiration", label: "Expiration" },
  { key: "days", label: "Days" },
  { key: "assetLabel", label: "Asset" },
  { key: "strategyType", label: "Strategy type" },
  { key: "marketBias", label: "Tag" },
  { key: "formula", label: "Formula" },
  { key: "polymarketPrice", label: "Poly price" },
  { key: "maxProfit", label: "Max profit" },
  { key: "maxLoss", label: "Max loss" },
  { key: "rewardRisk", label: "Reward/Risk" },
  { key: "breakevens", label: "Breakeven(s)" },
  { key: "theoPrice", label: "Theo price" },
  { key: "bid", label: "Bid" },
  { key: "ask", label: "Ask" },
  { key: "bidAskSpread", label: "Bid-ask spread" },
  { key: "expPayoff", label: "Exp payoff" }
];

const BIAS_FILTER_ORDER = ["Bull", "Bear", "Range-bound", "Breakout", "Neutral"];
const SOURCE_FILTER_OPTIONS = [
  { id: "all", label: "All sources" },
  { id: "live", label: "Live only" },
  { id: "seed", label: "Seed only" }
];

export default function StrategyFinderWorkspace({
  strategyPayload,
  strategyDefinition = null,
  onManualRefresh = null,
  refreshing = false,
  refreshNotice = null,
  paperPortfolio = null,
  onCreatePaperOrder = null,
  onOpenPaperTrading = null,
  theme = "dark"
}) {
  const chartTheme = getChartPalette(theme);
  const finder = strategyPayload?.primaryStrategy?.finder;
  const currentDate =
    strategyPayload?.lastUpdated?.slice(0, 10) ??
    finder?.filters?.dateRange?.from ??
    new Date().toISOString().slice(0, 10);
  const rows = finder?.rows ?? [];
  const defaultDateRange = resolveDateRangeForRows(
    normalizeDateRange(finder?.filters?.dateRange, currentDate),
    rows
  );
  const availableStrategyTypes = finder?.filters?.strategyTypes ?? [];
  const availableAssets = useMemo(
    () => [...new Set(rows.map((row) => row.assetLabel))],
    [rows]
  );
  const availableBiasTags = useMemo(
    () =>
      BIAS_FILTER_ORDER.filter((tag) =>
        rows.some((row) => (row.marketBias ?? "Neutral") === tag)
      ),
    [rows]
  );
  const quoteSizeThresholdOptions = finder?.filters?.targetOptionQuoteSizeThresholds ?? [10, 25, 50];
  const quoteSizeDataAvailable = finder?.filters?.quoteSizeDataAvailable !== false;
  const defaultQuoteSizeThreshold =
    Number(finder?.filters?.defaultTargetOptionQuoteSizeThreshold ?? quoteSizeThresholdOptions[0]) || 10;
  const availableStrategyTypesKey = availableStrategyTypes.join("|");
  const availableAssetsKey = availableAssets.join("|");
  const availableBiasTagsKey = availableBiasTags.join("|");
  const quoteSizeThresholdOptionsKey = quoteSizeThresholdOptions.join("|");
  const detailRef = useRef(null);
  const filterMenuRefs = useRef({});
  const hasHydratedFiltersRef = useRef(false);
  const [sortKey, setSortKey] = useState("rewardRisk");
  const [sortDirection, setSortDirection] = useState("desc");
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [strategyEditorOpen, setStrategyEditorOpen] = useState(false);
  const [chartMode, setChartMode] = useState("date");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [heatmapRangeMultiplier, setHeatmapRangeMultiplier] = useState(1);
  const [dateFrom, setDateFrom] = useState(defaultDateRange.from);
  const [dateTo, setDateTo] = useState(defaultDateRange.to);
  const [activeAssets, setActiveAssets] = useState(availableAssets);
  const [activeStrategyTypes, setActiveStrategyTypes] = useState(availableStrategyTypes);
  const [activeBiasTags, setActiveBiasTags] = useState(availableBiasTags);
  const [sourceFilter, setSourceFilter] = useState("all");
  const [showSyntheticChain, setShowSyntheticChain] = useState(false);
  const [showSeedData, setShowSeedData] = useState(false);
  const [targetOptionQuoteSizeThreshold, setTargetOptionQuoteSizeThreshold] = useState(defaultQuoteSizeThreshold);
  const [maxProfitMin, setMaxProfitMin] = useState("");
  const [maxProfitMax, setMaxProfitMax] = useState("");
  const [maxLossMin, setMaxLossMin] = useState(DEFAULT_MAX_LOSS_FLOOR);
  const [maxLossMax, setMaxLossMax] = useState("");
  const [controls, setControls] = useState(null);
  const [optionChains, setOptionChains] = useState({});
  const [optionChainStatus, setOptionChainStatus] = useState({});
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperExecutionRoute, setPaperExecutionRoute] = useState("local-paper");
  const [paperIbkrOrderType, setPaperIbkrOrderType] = useState("LMT");
  const [paperIbkrLimitPrice, setPaperIbkrLimitPrice] = useState("");
  const [paperIbkrTif, setPaperIbkrTif] = useState("DAY");
  const [paperIbkrOutsideRth, setPaperIbkrOutsideRth] = useState(false);
  const [optionPriceRefreshing, setOptionPriceRefreshing] = useState(false);
  const [optionPriceRefreshState, setOptionPriceRefreshState] = useState(null);
  const [finderRowDetails, setFinderRowDetails] = useState({});
  const [finderDetailLoadingId, setFinderDetailLoadingId] = useState("");
  const [finderDetailErrors, setFinderDetailErrors] = useState({});
  const ibkrStatus = paperPortfolio?.brokerStatus?.ibkr ?? null;
  const ibkrReady = isIbkrReady(ibkrStatus);
  const ibkrReloginNeeded = isIbkrReloginNeeded(ibkrStatus);
  const ibkrLoginUrl = getIbkrGatewayLoginUrl();
  const minProfitThreshold = parseOptionalNumber(maxProfitMin);
  const maxProfitThreshold = parseOptionalNumber(maxProfitMax);
  const minLossThreshold = parseOptionalNumber(maxLossMin);
  const maxLossThreshold = parseOptionalNumber(maxLossMax);

  useEffect(() => {
    setFinderRowDetails({});
    setFinderDetailLoadingId("");
    setFinderDetailErrors({});
  }, [finder?.rows]);

  useEffect(() => {
    if (!finder) {
      return;
    }

    if (!hasHydratedFiltersRef.current) {
      setDateFrom(defaultDateRange.from);
      setDateTo(defaultDateRange.to);
      setActiveAssets(availableAssets);
      setActiveStrategyTypes(availableStrategyTypes);
      setActiveBiasTags(availableBiasTags);
      setTargetOptionQuoteSizeThreshold(defaultQuoteSizeThreshold);
      setControls(finder.calculatorDefaults ?? null);
      hasHydratedFiltersRef.current = true;
      return;
    }

    setActiveAssets((current) => {
      const next = current.filter((asset) => availableAssets.includes(asset));
      if (next.length === current.length && next.every((asset, index) => asset === current[index])) {
        return current;
      }

      return next.length ? next : availableAssets;
    });
    setActiveStrategyTypes((current) => {
      const next = current.filter((strategyType) => availableStrategyTypes.includes(strategyType));
      if (
        next.length === current.length &&
        next.every((strategyType, index) => strategyType === current[index])
      ) {
        return current;
      }

      return next.length ? next : availableStrategyTypes;
    });
    setActiveBiasTags((current) => {
      const next = current.filter((marketBias) => availableBiasTags.includes(marketBias));
      if (
        next.length === current.length &&
        next.every((marketBias, index) => marketBias === current[index])
      ) {
        return current;
      }

      return next.length ? next : availableBiasTags;
    });
    setTargetOptionQuoteSizeThreshold((current) =>
      quoteSizeThresholdOptions.includes(current) ? current : defaultQuoteSizeThreshold
    );
  }, [
    availableAssetsKey,
    availableStrategyTypesKey,
    availableBiasTagsKey,
    defaultDateRange.from,
    defaultDateRange.to,
    defaultQuoteSizeThreshold,
    finder,
    quoteSizeThresholdOptionsKey
  ]);

  const baseFilteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const withinFrom = !dateFrom || row.expiration >= dateFrom;
        const withinTo = !dateTo || row.expiration <= dateTo;
        const assetMatch = activeAssets.includes(row.assetLabel);
        const strategyMatch = activeStrategyTypes.includes(row.strategyType);
        const biasMatch = activeBiasTags.includes(row.marketBias ?? "Neutral");
        const sourceMatch =
          sourceFilter === "all"
            ? true
            : sourceFilter === "seed"
              ? String(row.polymarketSource ?? "").toLowerCase() === "seed"
              : String(row.polymarketSource ?? "").toLowerCase() !== "seed";
        const numericTargetOptionQuoteSize = Number(row.targetOptionQuoteSize);
        const numericMaxProfit = Number(row.maxProfit);
        const numericMaxLoss = Number(row.maxLoss);
        const rowHasQuoteSizeData =
          Number.isFinite(numericTargetOptionQuoteSize) && numericTargetOptionQuoteSize > 0;
        const quoteSizeMatch =
          !quoteSizeDataAvailable ||
          !rowHasQuoteSizeData ||
          numericTargetOptionQuoteSize > targetOptionQuoteSizeThreshold;
        const maxProfitMatch =
          (minProfitThreshold == null ||
            row.maxProfitUnbounded === true ||
            (Number.isFinite(numericMaxProfit) && numericMaxProfit >= minProfitThreshold)) &&
          (maxProfitThreshold == null ||
            (row.maxProfitUnbounded !== true &&
              Number.isFinite(numericMaxProfit) &&
              numericMaxProfit <= maxProfitThreshold));
        const maxLossMatch =
          (minLossThreshold == null ||
            (row.maxLossUnbounded !== true &&
              Number.isFinite(numericMaxLoss) &&
              numericMaxLoss >= minLossThreshold)) &&
          (maxLossThreshold == null ||
            (row.maxLossUnbounded !== true &&
              Number.isFinite(numericMaxLoss) &&
              numericMaxLoss <= maxLossThreshold));

        return (
          withinFrom &&
          withinTo &&
          assetMatch &&
          strategyMatch &&
          biasMatch &&
          sourceMatch &&
          quoteSizeMatch &&
          maxProfitMatch &&
          maxLossMatch
        );
      }),
    [
      activeAssets,
      activeBiasTags,
      activeStrategyTypes,
      dateFrom,
      dateTo,
      maxLossThreshold,
      maxProfitThreshold,
      minLossThreshold,
      minProfitThreshold,
      quoteSizeDataAvailable,
      rows,
      sourceFilter,
      targetOptionQuoteSizeThreshold
    ]
  );
  const syntheticHiddenCount = useMemo(
    () => baseFilteredRows.filter((row) => row.usesSyntheticChain === true).length,
    [baseFilteredRows]
  );
  const seedHiddenCount = useMemo(
    () => baseFilteredRows.filter((row) => String(row.polymarketSource ?? "").toLowerCase() === "seed").length,
    [baseFilteredRows]
  );
  const filteredRows = useMemo(
    () =>
      baseFilteredRows.filter((row) => {
        const syntheticChainMatch = showSyntheticChain || row.usesSyntheticChain !== true;
        const seedDataMatch = showSeedData || String(row.polymarketSource ?? "").toLowerCase() !== "seed";
        return syntheticChainMatch && seedDataMatch;
      }),
    [baseFilteredRows, showSeedData, showSyntheticChain]
  );
  const sortedRows = useMemo(
    () => [...filteredRows].sort((left, right) => compareValues(left[sortKey], right[sortKey], sortDirection)),
    [filteredRows, sortDirection, sortKey]
  );
  const selectedRowSummary = useMemo(
    () => sortedRows.find((row) => row.id === selectedRowId) ?? null,
    [selectedRowId, sortedRows]
  );
  const selectedRow = selectedRowSummary ? finderRowDetails[selectedRowSummary.id] ?? null : null;
  const selectedRowDetailLoading =
    Boolean(selectedRowSummary?.id) &&
    !selectedRow &&
    finderDetailLoadingId === selectedRowSummary.id;
  const selectedRowDetailError = selectedRowSummary ? finderDetailErrors[selectedRowSummary.id] ?? "" : "";
  const selectedRowDisplayCloseDate =
    selectedRow?.strategyCloseDate ??
    selectedRowSummary?.strategyCloseDate ??
    selectedRowSummary?.expiration ??
    "";
  const selectedRowDisplaySource =
    selectedRow?.polymarketSource ??
    selectedRowSummary?.polymarketSource ??
    "";

  useEffect(() => {
    if (!selectedRowId) {
      return;
    }

    const rowStillVisible = sortedRows.some((row) => row.id === selectedRowId);
    if (!rowStillVisible) {
      setSelectedRowId(null);
      setDetailOpen(false);
      setDetailCollapsed(false);
      setControls(finder?.calculatorDefaults ?? null);
    }
  }, [finder?.calculatorDefaults, selectedRowId, sortedRows]);

  useEffect(() => {
    if (!detailOpen || !selectedRowSummary?.id || finderRowDetails[selectedRowSummary.id]) {
      return;
    }

    const controller = new AbortController();
    const rowId = selectedRowSummary.id;

    async function loadFinderRowDetail() {
      setFinderDetailLoadingId(rowId);
      setFinderDetailErrors((current) => {
        const next = { ...current };
        delete next[rowId];
        return next;
      });

      try {
        const response = await fetch(`/api/strategies/finder/${encodeURIComponent(rowId)}`, {
          signal: controller.signal
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || "Unable to load strategy detail");
        }

        if (controller.signal.aborted) {
          return;
        }

        setFinderRowDetails((current) => ({
          ...current,
          [rowId]: payload?.row ?? null
        }));
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }

        setFinderDetailErrors((current) => ({
          ...current,
          [rowId]: error.message
        }));
      } finally {
        if (!controller.signal.aborted) {
          setFinderDetailLoadingId((current) => (current === rowId ? "" : current));
        }
      }
    }

    void loadFinderRowDetail();

    return () => {
      controller.abort();
    };
  }, [detailOpen, finderRowDetails, selectedRowSummary]);

  useEffect(() => {
    if (!selectedRow) {
      return;
    }

    const defaultCloseDate = selectedRow.strategyCloseDate ?? selectedRow.expiration;
    setControls({
      valuationDate: defaultCloseDate,
      underlyingPrice:
        selectedRow.payoffCurve[Math.round(selectedRow.payoffCurve.length * 0.6)]?.spot ??
        selectedRow.quickOverview.underlyingPrice,
      impliedVolatility:
        (selectedRow.legs.find((leg) => leg.kind === "option")?.impliedVolatility ?? 0.24) * 100,
      legConfigs: Object.fromEntries(
        selectedRow.legs
          .filter((leg) => leg.kind === "option")
          .map((leg) => [
            leg.id,
            {
              action: leg.action,
              optionType: leg.optionType,
              expiry: leg.expiry,
              strike: Number(leg.strike),
              bid: Number(leg.bid ?? 0),
              ask: Number(leg.ask ?? 0),
              bidSize: leg.bidSize != null ? Number(leg.bidSize) : null,
              askSize: leg.askSize != null ? Number(leg.askSize) : null,
              contractSymbol: leg.contractSymbol ?? "",
              impliedVolatility: Number(leg.impliedVolatility ?? 0) || 0.24,
              quoteSource: leg.quoteSource ?? "seed",
              isLive: leg.isLive === true,
              hasRealBidAsk: leg.hasRealBidAsk === true
            }
          ])
      ),
      legEdits: Object.fromEntries(
        selectedRow.legs.map((leg) => [
          leg.id,
          {
            quantity: normalizeQuantityInput(leg.quantity, 0),
            entryPrice: leg.entryPrice
          }
        ])
      )
    });
    setStrategyEditorOpen(false);
  }, [selectedRow?.id]);

  useEffect(() => {
    if (!detailOpen || !selectedRow || detailCollapsed) {
      return;
    }

    detailRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }, [detailCollapsed, detailOpen, selectedRow?.id]);

  useEffect(() => {
    function closeFilterMenus() {
      Object.values(filterMenuRefs.current).forEach((node) => {
        node?.removeAttribute("open");
      });
    }

    function handlePointerDown(event) {
      const clickedInsideMenu = Object.values(filterMenuRefs.current).some((node) =>
        node?.contains(event.target)
      );

      if (!clickedInsideMenu) {
        closeFilterMenus();
      }
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        closeFilterMenus();
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  function toggleSort(columnKey) {
    if (sortKey === columnKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(columnKey);
    setSortDirection("desc");
  }

  function toggleStrategyType(strategyType) {
    setActiveStrategyTypes((current) => {
      if (current.includes(strategyType)) {
        return current.length === 1 ? current : current.filter((item) => item !== strategyType);
      }

      return [...current, strategyType];
    });
  }

  function toggleAsset(assetLabel) {
    setActiveAssets((current) => {
      if (current.includes(assetLabel)) {
        return current.length === 1 ? current : current.filter((item) => item !== assetLabel);
      }

      return [...current, assetLabel];
    });
  }

  function toggleBiasTag(marketBias) {
    setActiveBiasTags((current) => {
      if (current.includes(marketBias)) {
        return current.length === 1 ? current : current.filter((item) => item !== marketBias);
      }

      return [...current, marketBias];
    });
  }

  function handleRowSelect(rowId) {
    setSelectedRowId(rowId);
    setDetailOpen(true);
    setDetailCollapsed(false);
  }

  function setFilterMenuRef(key, node) {
    if (!node) {
      delete filterMenuRefs.current[key];
      return;
    }

    filterMenuRefs.current[key] = node;
  }

  function handleFilterMenuToggle(activeKey) {
    const activeNode = filterMenuRefs.current[activeKey];
    if (!activeNode?.open) {
      return;
    }

    Object.entries(filterMenuRefs.current).forEach(([key, node]) => {
      if (key !== activeKey) {
        node?.removeAttribute("open");
      }
    });
  }

  function resetFilters() {
    setDateFrom(defaultDateRange.from);
    setDateTo(defaultDateRange.to);
    setActiveAssets(availableAssets);
    setActiveStrategyTypes(availableStrategyTypes);
    setActiveBiasTags(availableBiasTags);
    setSourceFilter("all");
    setShowSyntheticChain(false);
    setShowSeedData(false);
    setTargetOptionQuoteSizeThreshold(defaultQuoteSizeThreshold);
    setMaxProfitMin("");
    setMaxProfitMax("");
    setMaxLossMin(DEFAULT_MAX_LOSS_FLOOR);
    setMaxLossMax("");
  }

  function handleDateFromChange(nextFrom) {
    setDateFrom(nextFrom);

    if (nextFrom && dateTo && dateTo < nextFrom) {
      setDateTo(nextFrom);
    }
  }

  function handleDateToChange(nextTo) {
    if (nextTo && dateFrom && nextTo < dateFrom) {
      setDateTo(dateFrom);
      return;
    }

    setDateTo(nextTo);
  }

  function updateLegEdit(legId, field, value) {
    setControls((current) => ({
      ...(current ?? {}),
      legEdits: {
        ...(current?.legEdits ?? {}),
        [legId]: {
          ...(current?.legEdits?.[legId] ?? {}),
          [field]:
            field === "quantity"
              ? String(normalizeQuantityInput(value, normalizeQuantityInput(current?.legEdits?.[legId]?.quantity ?? 0, 0)))
              : value
        }
      }
    }));
  }

  function updateLegConfig(legId, patch) {
    setControls((current) => ({
      ...(current ?? {}),
      legConfigs: {
        ...(current?.legConfigs ?? {}),
        [legId]: {
          ...(current?.legConfigs?.[legId] ?? {}),
          ...patch
        }
      }
    }));
  }

  const optionLegs = selectedRow?.legs?.filter((leg) => leg.kind === "option") ?? [];
  const polymarketLegs = selectedRow?.legs?.filter((leg) => leg.kind === "binary") ?? [];
  const optionRootSymbol =
    selectedRow?.marketContext?.proxySymbol ?? optionLegs[0]?.label?.split(" ")?.[0] ?? "";
  const polymarketResolutionDate =
    selectedRow?.polymarketResolutionDate ?? selectedRow?.expiration ?? "";
  const rawUnderlyingPrice = Number(
    controls?.underlyingPrice ?? selectedRow?.quickOverview?.underlyingPrice ?? 0
  );
  const impliedVolatility = Number(controls?.impliedVolatility ?? 24) / 100;
  const riskFreeRate = 0.0425;

  useEffect(() => {
    setPaperTradeDate(currentDate || new Date().toISOString().slice(0, 10));
    setPaperOrderState(null);
    setPaperOrderSaving(false);
    setOptionPriceRefreshing(false);
    setOptionPriceRefreshState(null);
  }, [currentDate, selectedRow?.id]);

  const datePresets = buildDatePresets(currentDate || finder?.filters?.dateRange?.from || "");
  const activeDatePreset =
    datePresets.find((preset) => preset.from === dateFrom && preset.to === dateTo) ?? null;
  const dateSummary =
    activeDatePreset?.label ??
    (dateFrom && dateTo ? `${formatShortDate(dateFrom)} - ${formatShortDate(dateTo)}` : "Prediction period");
  const productSummary = buildSelectionSummary(activeAssets, availableAssets, "Products");
  const strategySummary = buildSelectionSummary(activeStrategyTypes, availableStrategyTypes, "Strategy types");
  const biasSummary = buildSelectionSummary(activeBiasTags, availableBiasTags, "Tags");
  const sourceSummary = buildSourceFilterSummary(sourceFilter);
  const quoteSizeSummary = buildQuoteSizeFilterSummary(targetOptionQuoteSizeThreshold, quoteSizeDataAvailable);
  const hiddenDataLabels = [
    !showSyntheticChain ? "synthetic chain" : null,
    !showSeedData ? "seed data" : null
  ].filter(Boolean);
  const emptyStateMessage = hiddenDataLabels.length
    ? `No matched hedge combinations for the selected filters. ${hiddenDataLabels.join(" and ")} are hidden by default.`
    : "No matched hedge combinations for the selected products, date range, strategy types, and bid/ask size filter.";
  const pnlSummary = buildPnlFilterSummary({
    maxProfitMin: minProfitThreshold,
    maxProfitMax: maxProfitThreshold,
    maxLossMin: minLossThreshold,
    maxLossMax: maxLossThreshold
  });
  const currentProxySpot = Number(
    selectedRow?.marketContext?.currentProxySpot ?? selectedRow?.quickOverview?.underlyingPrice ?? 0
  );
  const currentUnderlyingSpot = Number(selectedRow?.marketContext?.currentUnderlyingSpot ?? 0);
  const converterRatio =
    Number(selectedRow?.marketContext?.conversionRatio ?? 0) ||
    (currentUnderlyingSpot > 0 && currentProxySpot > 0 ? currentProxySpot / currentUnderlyingSpot : 0);
  const polymarketSignal = resolveFinderPolymarketSignal(selectedRow?.polymarketQuestion, selectedRow?.marketContext);
  const targetUnderlyingValue =
    polymarketSignal?.targetValue ||
    Number(selectedRow?.marketContext?.targetUnderlyingValue ?? 0) ||
    0;
  const selectedPolymarketEventUrl = getPolymarketEventUrl(selectedRow?.polymarketUrl);
  const polymarketReferenceLine = buildPolymarketReferenceLine({
    marketId: selectedRow?.polymarketMarketId,
    marketSlug: selectedRow?.polymarketMarketSlug,
    eventSlug: selectedRow?.polymarketEventSlug,
    url: selectedRow?.polymarketUrl,
    source: selectedRow?.polymarketSource
  });
  const proxySpotLabel = selectedRow?.marketContext?.proxySymbol ?? selectedRow?.assetLabel ?? "Proxy";
  const actualSpotLabel = formatUnderlyingLabel(
    selectedRow?.marketContext?.underlyingSymbol,
    selectedRow?.assetLabel ?? "Underlying"
  );
  const effectiveOptionLegs = optionLegs.map((leg) => {
    const config = controls?.legConfigs?.[leg.id] ?? {};
    const strike = Number(config.strike ?? leg.strike);
    const bid = Number(config.bid ?? leg.bid);
    const ask = Number(config.ask ?? leg.ask);
    const bidSize = config.bidSize ?? leg.bidSize ?? null;
    const askSize = config.askSize ?? leg.askSize ?? null;

    return {
      ...leg,
      action: config.action ?? leg.action,
      optionType: config.optionType ?? leg.optionType,
      expiry: config.expiry ?? leg.expiry,
      strike: Number.isFinite(strike) ? strike : Number(leg.strike),
      bid: Number.isFinite(bid) ? bid : null,
      ask: Number.isFinite(ask) ? ask : null,
      bidSize: bidSize != null ? Number(bidSize) : null,
      askSize: askSize != null ? Number(askSize) : null,
      hasRealBidAsk: config.hasRealBidAsk === true || leg.hasRealBidAsk === true,
      spread:
        config.hasRealBidAsk === true || leg.hasRealBidAsk === true
          ? calculateSpreadPercent(config.bid ?? leg.bid, config.ask ?? leg.ask)
          : null,
      contractSymbol: config.contractSymbol ?? leg.contractSymbol ?? "",
      impliedVolatility:
        Number(config.impliedVolatility ?? leg.impliedVolatility ?? 0) ||
        Number(leg.impliedVolatility ?? 0) ||
        impliedVolatility,
      quoteSource: config.quoteSource ?? leg.quoteSource ?? "seed",
      isLive: config.isLive === true || leg.isLive === true
    };
  });
  const strategyCloseDate =
    minIsoDate([polymarketResolutionDate, ...effectiveOptionLegs.map((leg) => leg.expiry)]) ||
    selectedRow?.strategyCloseDate ||
    selectedRow?.expiration ||
    polymarketResolutionDate;
  const strategyCloseDays = countTradingDaysBetween(currentDate || strategyCloseDate, strategyCloseDate, {
    includeStart: false,
    includeEnd: true
  });
  const valuationMinBaseDate =
    selectedRow && currentDate <= strategyCloseDate ? currentDate : strategyCloseDate ?? "";
  const valuationDateOptions = buildTradingDateRange(valuationMinBaseDate, strategyCloseDate);
  const valuationMinDate = valuationDateOptions[0] ?? valuationMinBaseDate;
  const valuationMaxDate = valuationDateOptions[valuationDateOptions.length - 1] ?? strategyCloseDate;
  const valuationDateCandidates =
    valuationDateOptions.length ? valuationDateOptions : [valuationMaxDate].filter(Boolean);
  const valuationDate = coerceToTradingDate(
    clampIsoDate(controls?.valuationDate ?? valuationMaxDate, valuationMinDate, valuationMaxDate),
    valuationDateCandidates,
    "previous"
  );
  const maxDateOffset = Math.max(valuationDateOptions.length - 1, 0);
  const currentDateOffset = Math.max(valuationDateOptions.indexOf(valuationDate), 0);
  const daysToMarketResolution = countTradingDaysBetween(valuationDate, polymarketResolutionDate, {
    includeStart: false,
    includeEnd: true
  });
  const currentDaysToMarketResolution = countTradingDaysBetween(
    currentDate || valuationDate,
    polymarketResolutionDate,
    {
      includeStart: false,
      includeEnd: true
    }
  );
  const timeToMarketResolutionYears = tradingDaysToYears(daysToMarketResolution);
  const currentTimeToMarketResolutionYears = tradingDaysToYears(currentDaysToMarketResolution);
  const payoffTargetProxy = projectPolymarketTargetProxySpot({
    targetValue: targetUnderlyingValue,
    direction: polymarketSignal?.direction,
    conversionRatio: converterRatio,
    currentProxySpot: currentProxySpot || rawUnderlyingPrice
  });
  const payoffRange = buildPayoffEvaluationRange({
    currentSpot: currentProxySpot || rawUnderlyingPrice,
    targetThreshold: payoffTargetProxy,
    optionLegs: effectiveOptionLegs
  });
  const spotFloor = payoffRange.start;
  const spotCeiling = payoffRange.end;
  const spotMin = Math.max(Number(spotFloor.toFixed(2)), 0.01);
  const spotMax = Math.max(Number(spotCeiling.toFixed(2)), spotMin + 1);
  const spotStep = spotMax - spotMin > 250 ? 1 : 0.1;
  const proxySpotDigits = spotStep >= 1 ? 0 : 2;
  const underlyingPrice = clamp(
    Number.isFinite(rawUnderlyingPrice) ? rawUnderlyingPrice : currentProxySpot || spotMin,
    spotMin,
    spotMax
  );
  const equivalentUnderlyingSpot = converterRatio > 0 ? underlyingPrice / converterRatio : underlyingPrice;
  const actualSpotMin =
    converterRatio > 0 ? Math.max(Number((spotMin / converterRatio).toFixed(2)), 0.01) : spotMin;
  const actualSpotMax =
    converterRatio > 0
      ? Math.max(Number((spotMax / converterRatio).toFixed(2)), actualSpotMin + 1)
      : spotMax;
  const actualSpotStep = determineStepFromRange(actualSpotMin, actualSpotMax);
  const actualSpotDigits = actualSpotStep >= 1 ? 0 : 2;

  useEffect(() => {
    if (!controls || !valuationDate || controls.valuationDate === valuationDate) {
      return;
    }

    setControls((current) => (current ? { ...current, valuationDate } : current));
  }, [controls, valuationDate]);

  useEffect(() => {
    setHeatmapRangeMultiplier(1);
  }, [selectedRowId]);

  function updateUnderlyingPriceControl(value) {
    const numericValue = Number(value);

    setControls((current) => ({
      ...current,
      underlyingPrice: Number.isFinite(numericValue) ? String(clamp(numericValue, spotMin, spotMax)) : ""
    }));
  }

  function updateLegEntryValue(leg, rawValue) {
    const numericValue = Math.abs(Number(rawValue));
    const contractMultiplier = Number(leg.contractMultiplier ?? 1);
    const unitEntryValue = Math.abs(Number(leg.entryPrice ?? 0)) * contractMultiplier;

    if (!Number.isFinite(numericValue) || numericValue < 0 || unitEntryValue <= 0) {
      return;
    }

    updateLegEdit(leg.id, "quantity", String(normalizeQuantityInput(numericValue / unitEntryValue, 0)));
  }

  const repricedOptionLegs = effectiveOptionLegs.map((leg) => {
    const editedLeg = controls?.legEdits?.[leg.id] ?? {};
    const quantity = normalizeQuantityInput(editedLeg.quantity ?? leg.quantity, normalizeQuantityInput(leg.quantity, 0));
    const entryPrice = Number(editedLeg.entryPrice ?? leg.entryPrice);
    const editedContractUnits = quantity * (leg.contractMultiplier ?? 100);
    const daysToExpiry = countTradingDaysBetween(valuationDate, leg.expiry, {
      includeStart: false,
      includeEnd: true
    });
    const timeYears = Math.max(tradingDaysToYears(daysToExpiry), 1 / 252);
    const modelPrice = blackScholesPrice({
      type: leg.optionType,
      spot: underlyingPrice,
      strike: Number(leg.strike),
      timeYears,
      volatility: impliedVolatility,
      riskFreeRate
    });
    const pnlPerUnit = leg.action === "LONG" ? modelPrice - entryPrice : entryPrice - modelPrice;
    const pnl = pnlPerUnit * editedContractUnits;
    const markValue = (leg.action === "LONG" ? 1 : -1) * modelPrice * editedContractUnits;
    const entryValue = (leg.action === "LONG" ? 1 : -1) * entryPrice * editedContractUnits;

    return {
      ...leg,
      quantity,
      contractUnits: editedContractUnits,
      entryPrice,
      modelPrice,
      daysToExpiry,
      pnl,
      markValue,
      entryValue
    };
  });

  const referenceYesLeg = polymarketLegs.find((leg) => leg.outcome === "YES") ?? null;
  const referenceNoLeg = polymarketLegs.find((leg) => leg.outcome === "NO") ?? null;
  const marketReferenceYesPrice = Number(
    referenceYesLeg?.entryPrice ?? (referenceNoLeg ? 1 - Number(referenceNoLeg.entryPrice) : selectedRow?.polymarketPrice ?? 0)
  );
  const estimatedYesPrice = estimatePolymarketYesPrice({
    spot: equivalentUnderlyingSpot,
    strike: targetUnderlyingValue,
    timeYears: timeToMarketResolutionYears,
    volatility: impliedVolatility,
    riskFreeRate,
    marketReferenceYesPrice,
    currentSpot: currentUnderlyingSpot,
    currentTimeYears: currentTimeToMarketResolutionYears,
    signalDirection: polymarketSignal?.direction
  });
  const repricedPolymarketLegs = polymarketLegs.map((leg) => {
    const editedLeg = controls?.legEdits?.[leg.id] ?? {};
    const entryPrice = Number(editedLeg.entryPrice ?? leg.entryPrice);
    const quantity = normalizeQuantityInput(editedLeg.quantity ?? leg.quantity, normalizeQuantityInput(leg.quantity, 0));
    const modelPrice = binaryPriceFromYes(leg.outcome, estimatedYesPrice);
    const pnl = binaryPnL({
      action: leg.action,
      entryPrice,
      markPrice: modelPrice,
      quantity
    });
    const markValue = (leg.action === "LONG" ? 1 : -1) * modelPrice * quantity;
    const entryValue = (leg.action === "LONG" ? 1 : -1) * entryPrice * quantity;

    return {
      ...leg,
      entryPrice,
      quantity,
      bid: Number(leg.bid ?? leg.entryPrice ?? 0),
      ask: Number(leg.ask ?? leg.entryPrice ?? 0),
      spread: leg.spread,
      modelPrice,
      pnl,
      markValue,
      entryValue
    };
  });
  const ibkrSuggestedLimitPrice = calculateIbkrNetLimitPrice(repricedOptionLegs);

  useEffect(() => {
    setPaperExecutionRoute("local-paper");
    setPaperIbkrOrderType("LMT");
    setPaperIbkrTif("DAY");
    setPaperIbkrOutsideRth(false);
    setPaperIbkrLimitPrice(
      ibkrSuggestedLimitPrice == null ? "" : String(Number(ibkrSuggestedLimitPrice.toFixed(2)))
    );
  }, [selectedRowId]);

  useEffect(() => {
    if (paperIbkrOrderType === "LMT" && !paperIbkrLimitPrice && ibkrSuggestedLimitPrice != null) {
      setPaperIbkrLimitPrice(String(Number(ibkrSuggestedLimitPrice.toFixed(2))));
    }
  }, [ibkrSuggestedLimitPrice, paperIbkrLimitPrice, paperIbkrOrderType]);

  async function handleCreatePaperTrade() {
    if (!selectedRow || !onCreatePaperOrder) {
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

        if (!repricedOptionLegs.length) {
          throw new Error("This setup does not have any option legs to route to IBKR.");
        }

        if (paperIbkrOrderType === "LMT" && paperIbkrLimitPrice === "") {
          throw new Error("Enter an IBKR limit price before routing this order.");
        }
      }

      const baseOrderPayload = {
        strategyId: strategyDefinition?.id ?? "strategy-1",
        strategyName: strategyDefinition?.name ?? "Strategy",
        combinationId: selectedRow.id,
        combinationLabel: `${selectedRow.assetLabel} · ${selectedRow.strategyType} · ${strategyCloseDate}`,
        assetLabel: selectedRow.assetLabel,
        strategyType: selectedRow.strategyType,
        marketBias: selectedRow.marketBias,
        marketBiasTone: selectedRow.marketBiasTone,
        maxProfit: selectedRow.maxProfit,
        maxLoss: selectedRow.maxLoss,
        maxProfitUnbounded: selectedRow.maxProfitUnbounded,
        maxLossUnbounded: selectedRow.maxLossUnbounded,
        purchaseDate: paperTradeDate || currentDate || new Date().toISOString().slice(0, 10),
        polymarketMarketId: selectedRow.polymarketMarketId,
        polymarketMarketSlug: selectedRow.polymarketMarketSlug,
        polymarketEventSlug: selectedRow.polymarketEventSlug,
        polymarketQuestion: selectedRow.polymarketQuestion,
        polymarketUrl: selectedRow.polymarketUrl,
        polymarketSource: selectedRow.polymarketSource,
        polymarketResolutionDate,
        strategyCloseDate,
        marketReferenceYesPrice,
        marketContext: {
          proxySymbol: optionRootSymbol || selectedRow?.marketContext?.proxySymbol || "",
          underlyingSymbol: selectedRow?.marketContext?.underlyingSymbol ?? "",
          currentProxySpot: currentProxySpot || underlyingPrice,
          currentUnderlyingSpot: currentUnderlyingSpot || equivalentUnderlyingSpot,
          conversionRatio: converterRatio,
          targetUnderlyingValue,
          polymarketDirection: polymarketSignal?.direction ?? "up",
          polymarketTriggerType: polymarketSignal?.triggerType ?? "touch",
          impliedVolatility,
          riskFreeRate
        },
        legs: [
          ...repricedOptionLegs.map((leg) => ({
            id: leg.id,
            label: leg.label,
            kind: "option",
            action: leg.action,
            quantity: leg.quantity,
            entryPrice: leg.entryPrice,
            contractMultiplier: leg.contractMultiplier ?? 100,
            optionType: leg.optionType,
            expiry: leg.expiry,
            strike: Number(leg.strike),
            contractSymbol: leg.contractSymbol ?? "",
            rootSymbol: optionRootSymbol,
            impliedVolatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
            riskFreeRate,
            quoteSource: leg.quoteSource ?? "seed",
            isLive: leg.isLive === true
          })),
          ...repricedPolymarketLegs.map((leg) => ({
            id: leg.id,
            label: leg.label,
            kind: "binary",
            action: leg.action,
            quantity: leg.quantity,
            entryPrice: leg.entryPrice,
            outcome: leg.outcome,
            polymarketMarketId: leg.polymarketMarketId ?? selectedRow.polymarketMarketId ?? "",
            quoteSource: "Polymarket",
            isLive: true
          }))
        ],
        execution:
          paperExecutionRoute === "ibkr-paper"
            ? {
                route: "ibkr-paper",
                orderType: paperIbkrOrderType,
                tif: paperIbkrTif,
                outsideRth: paperIbkrOutsideRth,
                limitPrice:
                  paperIbkrOrderType === "LMT"
                    ? Number(paperIbkrLimitPrice)
                    : null,
                accountId: ibkrStatus?.selectedAccount ?? ""
              }
            : {
                route: "local-paper"
              }
      };
      const heatmapSnapshot = buildScenarioHeatmapSnapshot({
        startDate: valuationMinDate,
        endDate: valuationMaxDate,
        currentPrice: currentProxySpot || underlyingPrice,
        volatility: impliedVolatility,
        spotLabel: proxySpotLabel,
        priceDigits: proxySpotDigits,
        secondarySpotLabel: converterRatio > 0 ? actualSpotLabel : "",
        secondaryPriceDigits: actualSpotDigits,
        getSecondarySpot: converterRatio > 0 ? (spot) => spot / converterRatio : null,
        getCellPnL: calculateHeatmapPnL,
        rangeMultiplier: heatmapRangeMultiplier
      });
      const controlsSnapshot = {
        valuationDate,
        underlyingPrice: String(underlyingPrice),
        impliedVolatility: String(
          controls?.impliedVolatility ?? Number((impliedVolatility * 100).toFixed(2))
        )
      };
      const orderSnapshot = {
        ...baseOrderPayload,
        id: null,
        status: "open",
        createdAt: null,
        closedAt: "",
        valuationContext: {
          proxySymbol: baseOrderPayload.marketContext.proxySymbol,
          underlyingSymbol: baseOrderPayload.marketContext.underlyingSymbol,
          currentProxySpot: baseOrderPayload.marketContext.currentProxySpot,
          currentUnderlyingSpot: baseOrderPayload.marketContext.currentUnderlyingSpot,
          conversionRatio: baseOrderPayload.marketContext.conversionRatio,
          targetUnderlyingValue: baseOrderPayload.marketContext.targetUnderlyingValue,
          currentYesPrice: estimatedYesPrice
        }
      };

      const createResponse = await onCreatePaperOrder({
        ...baseOrderPayload,
        initialCalculatorSnapshot: {
          snapshotName: "Order placed",
          payload: {
            savedFromCombinationId: selectedRow.id,
            snapshotKind: "order-entry",
            orderSnapshot,
            controls: controlsSnapshot,
            heatmapSnapshot
          }
        }
      });

      setPaperOrderState({
        tone:
          paperExecutionRoute === "ibkr-paper" && createResponse?.message?.toLowerCase().includes("failed")
            ? "warning"
            : "success",
        message:
          createResponse?.message ??
          (paperExecutionRoute === "ibkr-paper"
            ? "IBKR paper order submitted. You can monitor it from the paper-trading page."
            : "Paper order saved. You can review or edit it from the paper-trading page.")
      });
    } catch (error) {
      setPaperOrderState({
        tone: "error",
        message: error.message
      });
    } finally {
      setPaperOrderSaving(false);
    }
  }

  const optionsPnL = repricedOptionLegs.reduce((sum, leg) => sum + leg.pnl, 0);
  const polymarketPnL = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.pnl, 0);
  const optionsMarkedValue = repricedOptionLegs.reduce((sum, leg) => sum + leg.markValue, 0);
  const optionsEntryValue = repricedOptionLegs.reduce((sum, leg) => sum + leg.entryValue, 0);
  const polymarketMarkedValue = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.markValue, 0);
  const polymarketEntryValue = repricedPolymarketLegs.reduce((sum, leg) => sum + leg.entryValue, 0);
  const initialInvestment = optionsEntryValue + polymarketEntryValue;
  const currentMarkedValue = optionsMarkedValue + polymarketMarkedValue;
  const totalPnL = optionsPnL + polymarketPnL;
  const spotEvaluationGrid = buildSpotEvaluationGrid({
    start: payoffRange.start,
    end: spotMax,
    targetThreshold: payoffTargetProxy,
    optionLegs: repricedOptionLegs
  });
  const daysToMarketResolutionAtClose = countTradingDaysBetween(strategyCloseDate, polymarketResolutionDate, {
    includeStart: false,
    includeEnd: true
  });
  const spotPayoffSeries = spotEvaluationGrid.map((spot) => {
    const optionPnL = repricedOptionLegs.reduce((sum, leg) => {
      const remainingOptionDaysAtClose = countTradingDaysBetween(strategyCloseDate, leg.expiry, {
        includeStart: false,
        includeEnd: true
      });
      const optionMarkPrice =
        remainingOptionDaysAtClose > 0
          ? blackScholesPrice({
              type: leg.optionType,
              spot,
              strike: Number(leg.strike),
              timeYears: Math.max(tradingDaysToYears(remainingOptionDaysAtClose), 1 / 252),
              volatility: Number(leg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
              riskFreeRate
            })
          : leg.optionType === "put"
            ? Math.max(Number(leg.strike) - spot, 0)
            : Math.max(spot - Number(leg.strike), 0);
      const pnlPerUnit = leg.action === "LONG" ? optionMarkPrice - leg.entryPrice : leg.entryPrice - optionMarkPrice;

      return sum + pnlPerUnit * leg.contractUnits;
    }, 0);
    const settleUnderlying = converterRatio > 0 ? spot / converterRatio : spot;
    const binaryPnLAtSpot = repricedPolymarketLegs.reduce((sum, leg) => {
      const signalHit =
        targetUnderlyingValue > 0 ? evaluatePolymarketSignalHit(settleUnderlying, polymarketSignal) : false;
      const settlePrice =
        leg.outcome === "NO"
          ? signalHit
            ? 0
            : 1
          : signalHit
            ? 1
            : 0;
      const markPrice =
        daysToMarketResolutionAtClose > 0
          ? binaryPriceFromYes(
              leg.outcome,
              estimatePolymarketYesPrice({
                spot: settleUnderlying,
                strike: targetUnderlyingValue,
                timeYears: tradingDaysToYears(daysToMarketResolutionAtClose),
                volatility: impliedVolatility,
                riskFreeRate,
                marketReferenceYesPrice,
                currentSpot: currentUnderlyingSpot,
                currentTimeYears: currentTimeToMarketResolutionYears,
                signalDirection: polymarketSignal?.direction
              })
            )
          : settlePrice;

      return sum + binaryPnL({ action: leg.action, entryPrice: leg.entryPrice, markPrice, quantity: leg.quantity });
    }, 0);

    return {
      spot: formatNumber(spot, 2),
      totalPnL: formatNumber(optionPnL + binaryPnLAtSpot, 2)
    };
  });
  const payoffValues = spotPayoffSeries.map((point) => Number(point.totalPnL)).filter(Number.isFinite);
  const {
    maxProfit: effectiveMaxProfit,
    maxLoss: effectiveMaxLoss,
    maxProfitUnbounded: effectiveMaxProfitUnbounded,
    maxLossUnbounded: effectiveMaxLossUnbounded
  } = evaluatePayoffExtremes(spotPayoffSeries, repricedOptionLegs);
  const effectiveBreakevens = approximateBreakevens(spotPayoffSeries);
  const effectivePositivePoints = spotPayoffSeries.filter((point) => Number(point.totalPnL) > 0).length;
  const effectiveProbabilityOfProfit =
    spotPayoffSeries.length > 0 ? (effectivePositivePoints / spotPayoffSeries.length) * 100 : null;
  const effectiveExpPayoff =
    spotPayoffSeries.find((point) => Math.abs(Number(point.spot) - payoffTargetProxy) < 0.5)?.totalPnL ??
    spotPayoffSeries.reduce((closest, point) => {
      if (!closest) {
        return point;
      }

      return Math.abs(Number(point.spot) - payoffTargetProxy) < Math.abs(Number(closest.spot) - payoffTargetProxy)
        ? point
        : closest;
    }, null)?.totalPnL ??
    null;
  const effectiveTheoPrice = repricedOptionLegs.reduce(
    (sum, leg) => sum + (leg.action === "LONG" ? leg.modelPrice : -leg.modelPrice),
    0
  );
  const effectiveNetBid = repricedOptionLegs.reduce(
    (sum, leg) => sum + (leg.action === "LONG" ? Number(leg.bid ?? leg.entryPrice) : -Number(leg.bid ?? leg.entryPrice)),
    0
  );
  const effectiveNetAsk = repricedOptionLegs.reduce(
    (sum, leg) => sum + (leg.action === "LONG" ? Number(leg.ask ?? leg.entryPrice) : -Number(leg.ask ?? leg.entryPrice)),
    0
  );
  const detailLegRows = [
    ...repricedPolymarketLegs.map((leg) => ({
      id: leg.id,
      action: leg.action,
      quantity: leg.quantity,
      strike: leg.outcome,
      bid: Number(leg.bid ?? leg.entryPrice ?? 0),
      ask: Number(leg.ask ?? leg.entryPrice ?? 0),
      spread: leg.spread ?? calculateSpreadPercent(leg.bid ?? leg.entryPrice, leg.ask ?? leg.entryPrice),
      kind: leg.kind,
      outcome: leg.outcome,
      referenceUrl: selectedPolymarketEventUrl,
      referenceLabel: selectedPolymarketEventUrl ? "Open Polymarket bet" : "Seed fallback market",
      referenceMeta:
        buildPolymarketReferenceLine({
          marketId: leg.polymarketMarketId ?? selectedRow?.polymarketMarketId,
          marketSlug: selectedRow?.polymarketMarketSlug,
          eventSlug: selectedRow?.polymarketEventSlug,
          url: selectedRow?.polymarketUrl,
          source: selectedRow?.polymarketSource
        }) || "Polymarket"
    })),
    ...repricedOptionLegs.map((leg) => ({
      ...leg,
      referenceLabel: formatOptionReferenceLabel(leg),
      referenceMeta: formatQuoteSourceLabel(leg)
    }))
  ];

  async function loadOptionChain({ expiration, optionType, strikeHint = 0, force = false }) {
    if (!optionRootSymbol || !expiration) {
      return null;
    }

    const requestKey = buildChainKey(optionRootSymbol, expiration, optionType);
    if (!force && (optionChains[requestKey] || optionChainStatus[requestKey]?.loading)) {
      return optionChains[requestKey] ?? null;
    }

    setOptionChainStatus((current) => ({
      ...current,
      [requestKey]: {
        loading: true,
        error: null
      }
    }));

    try {
      const response = await fetch(
        `/api/options/chain?symbol=${encodeURIComponent(optionRootSymbol)}&expiration=${encodeURIComponent(
          expiration
        )}&optionType=${encodeURIComponent(optionType)}&strikeHint=${encodeURIComponent(strikeHint)}`
      );

      if (!response.ok) {
        throw new Error(`Chain request failed with ${response.status}`);
      }

      const payload = await response.json();
      setOptionChains((current) => ({
        ...current,
        [requestKey]: payload
      }));
      setOptionChainStatus((current) => ({
        ...current,
        [requestKey]: {
          loading: false,
          error: null
        }
      }));
      return payload;
    } catch (error) {
      setOptionChainStatus((current) => ({
        ...current,
        [requestKey]: {
          loading: false,
          error: error.message
        }
      }));
      return null;
    }
  }

  function handleLegActionChange(legId, nextAction) {
    const leg = effectiveOptionLegs.find((item) => item.id === legId);
    const nextEntryPrice =
      nextAction === "SHORT" ? Number(leg?.bid ?? leg?.entryPrice ?? 0) : Number(leg?.ask ?? leg?.entryPrice ?? 0);

    setControls((current) => ({
      ...(current ?? {}),
      legConfigs: {
        ...(current?.legConfigs ?? {}),
        [legId]: {
          ...(current?.legConfigs?.[legId] ?? {}),
          action: nextAction
        }
      },
      legEdits: {
        ...(current?.legEdits ?? {}),
        [legId]: {
          ...(current?.legEdits?.[legId] ?? {}),
          entryPrice: nextEntryPrice
        }
      }
    }));
  }

  function applyChainContractToLeg(legId, contract) {
    if (!contract) {
      return;
    }

    const currentAction =
      controls?.legConfigs?.[legId]?.action ??
      effectiveOptionLegs.find((item) => item.id === legId)?.action ??
      "LONG";
    const nextEntryPrice =
      currentAction === "SHORT"
        ? Number(contract.bid ?? contract.mark ?? contract.lastPrice ?? 0)
        : Number(contract.ask ?? contract.mark ?? contract.lastPrice ?? 0);

    setControls((current) => ({
      ...(current ?? {}),
      legConfigs: {
        ...(current?.legConfigs ?? {}),
        [legId]: {
          ...(current?.legConfigs?.[legId] ?? {}),
          action: currentAction,
          optionType: contract.optionType,
          expiry: contract.expiration,
          strike: contract.strike,
          bid: contract.bid,
          ask: contract.ask,
          bidSize: contract.bidSize ?? null,
          askSize: contract.askSize ?? null,
          contractSymbol: contract.contractSymbol,
          impliedVolatility:
            Number(contract.impliedVolatility ?? 0) ||
            Number(current?.legConfigs?.[legId]?.impliedVolatility ?? 0) ||
            0.24,
          quoteSource: contract.sourceLabel ?? contract.source ?? "chain",
          isLive: contract.isLive === true,
          hasRealBidAsk: contract.hasRealBidAsk === true
        }
      },
      legEdits: {
        ...(current?.legEdits ?? {}),
        [legId]: {
          ...(current?.legEdits?.[legId] ?? {}),
          entryPrice: nextEntryPrice
        }
      }
    }));
  }

  function refreshVisibleOptionChains() {
    effectiveOptionLegs.forEach((leg) => {
      loadOptionChain({
        expiration: leg.expiry,
        optionType: leg.optionType,
        strikeHint: leg.strike,
        force: true
      });
    });
  }

  function selectRefreshContractForLeg(leg, contracts) {
    if (!Array.isArray(contracts) || !contracts.length) {
      return null;
    }

    if (leg.contractSymbol) {
      const exactMatch = contracts.find((contract) => contract.contractSymbol === leg.contractSymbol);
      if (exactMatch) {
        return exactMatch;
      }
    }

    const targetStrike = Number(leg.strike ?? 0);
    return [...contracts]
      .filter(
        (contract) =>
          String(contract.optionType ?? "") === String(leg.optionType ?? "") &&
          String(contract.expiration ?? "") === String(leg.expiry ?? "")
      )
      .sort((left, right) => {
        const leftDistance = Math.abs(Number(left.strike ?? 0) - targetStrike);
        const rightDistance = Math.abs(Number(right.strike ?? 0) - targetStrike);

        return (
          leftDistance - rightDistance ||
          Number(right.hasRealBidAsk === true) - Number(left.hasRealBidAsk === true)
        );
      })[0] ?? null;
  }

  async function refreshCalculatorOptionPrices() {
    if (!effectiveOptionLegs.length || !optionRootSymbol) {
      return;
    }

    setOptionPriceRefreshing(true);
    setOptionPriceRefreshState(null);

    try {
      const uniqueRequests = Array.from(
        new Map(
          effectiveOptionLegs.map((leg) => [
            buildChainKey(optionRootSymbol, leg.expiry, leg.optionType),
            {
              expiration: leg.expiry,
              optionType: leg.optionType,
              strikeHint: leg.strike,
              force: true
            }
          ])
        ).values()
      );

      const refreshedChains = await Promise.all(
        uniqueRequests.map(async (request) => [
          buildChainKey(optionRootSymbol, request.expiration, request.optionType),
          await loadOptionChain(request)
        ])
      );
      const refreshedChainMap = new Map(refreshedChains);
      let updatedCount = 0;

      effectiveOptionLegs.forEach((leg) => {
        const requestKey = buildChainKey(optionRootSymbol, leg.expiry, leg.optionType);
        const chainPayload = refreshedChainMap.get(requestKey) ?? optionChains[requestKey] ?? null;
        const contract = selectRefreshContractForLeg(leg, chainPayload?.contracts ?? []);

        if (!contract) {
          return;
        }

        applyChainContractToLeg(leg.id, contract);
        updatedCount += 1;
      });

      setOptionPriceRefreshState({
        tone: updatedCount === effectiveOptionLegs.length ? "success" : "warning",
        message:
          updatedCount === 0
            ? "No updated option prices were returned for the visible legs."
            : updatedCount === effectiveOptionLegs.length
              ? `Refreshed ${updatedCount} option leg${updatedCount === 1 ? "" : "s"}.`
              : `Refreshed ${updatedCount} of ${effectiveOptionLegs.length} option legs.`
      });
    } catch (error) {
      setOptionPriceRefreshState({
        tone: "error",
        message: error.message || "Unable to refresh option prices."
      });
    } finally {
      setOptionPriceRefreshing(false);
    }
  }

  const editorChainRequests = Array.from(
    new Map(
      effectiveOptionLegs.map((leg) => [
        buildChainKey(optionRootSymbol, leg.expiry, leg.optionType),
        {
          expiration: leg.expiry,
          optionType: leg.optionType,
          strikeHint: leg.strike
        }
      ])
    ).values()
  );
  const editorHasLiveQuotes = editorChainRequests.some(({ expiration, optionType }) => {
    const requestKey = buildChainKey(optionRootSymbol, expiration, optionType);
    return optionChains[requestKey]?.isLive === true;
  });

  useEffect(() => {
    if (!strategyEditorOpen || !optionRootSymbol) {
      return;
    }

    editorChainRequests.forEach((request) => {
      loadOptionChain(request);
    });
  }, [
    strategyEditorOpen,
    optionRootSymbol,
    editorChainRequests.map((request) => `${request.expiration}:${request.optionType}`).join("|")
  ]);

  const chartHeight = chartExpanded ? 1000 : 250;
  function calculateHeatmapPnL({ spot, date }) {
    const optionPnL = repricedOptionLegs.reduce((sum, leg) => {
      const remainingDays = countTradingDaysBetween(date, leg.expiry, {
        includeStart: false,
        includeEnd: true
      });
      const optionMarkPrice =
        remainingDays > 0
          ? blackScholesPrice({
              type: leg.optionType,
              spot,
              strike: Number(leg.strike),
              timeYears: tradingDaysToYears(remainingDays),
              volatility: impliedVolatility,
              riskFreeRate
            })
          : leg.optionType === "put"
            ? Math.max(Number(leg.strike) - spot, 0)
            : Math.max(spot - Number(leg.strike), 0);
      const pnlPerUnit = leg.action === "LONG" ? optionMarkPrice - leg.entryPrice : leg.entryPrice - optionMarkPrice;

      return sum + pnlPerUnit * leg.contractUnits;
    }, 0);
    const settleUnderlying = converterRatio > 0 ? spot / converterRatio : spot;
    const remainingPolymarketDays = countTradingDaysBetween(date, polymarketResolutionDate, {
      includeStart: false,
      includeEnd: true
    });
    const yesPrice =
      remainingPolymarketDays > 0
        ? estimatePolymarketYesPrice({
            spot: settleUnderlying,
            strike: targetUnderlyingValue,
            timeYears: tradingDaysToYears(remainingPolymarketDays),
            volatility: impliedVolatility,
            riskFreeRate,
            marketReferenceYesPrice,
            currentSpot: currentUnderlyingSpot || equivalentUnderlyingSpot,
            currentTimeYears: currentTimeToMarketResolutionYears,
            signalDirection: polymarketSignal?.direction
          })
        : targetUnderlyingValue > 0
          ? evaluatePolymarketSignalHit(settleUnderlying, polymarketSignal)
            ? 1
            : 0
          : marketReferenceYesPrice;
    const binaryPnLAtDate = repricedPolymarketLegs.reduce(
      (sum, leg) =>
        sum +
        binaryPnL({
          action: leg.action,
          entryPrice: leg.entryPrice,
          markPrice: binaryPriceFromYes(leg.outcome, yesPrice),
          quantity: leg.quantity
        }),
      0
    );

    return optionPnL + binaryPnLAtDate;
  }
  const dateProfitSeries = [];

  if (selectedRow && valuationMinDate && strategyCloseDate) {
    valuationDateCandidates.forEach((dateIso) => {
      const optionsValue = repricedOptionLegs.reduce((sum, leg) => {
        const optionRemainingDays = countTradingDaysBetween(dateIso, leg.expiry, {
          includeStart: false,
          includeEnd: true
        });
        const modelPrice = blackScholesPrice({
          type: leg.optionType,
          spot: underlyingPrice,
          strike: Number(leg.strike),
          timeYears: Math.max(tradingDaysToYears(optionRemainingDays), 1 / 252),
          volatility: impliedVolatility,
          riskFreeRate
        });
        const pnlPerUnit =
          leg.action === "LONG" ? modelPrice - leg.entryPrice : leg.entryPrice - modelPrice;

        return sum + pnlPerUnit * leg.contractUnits;
      }, 0);

      const remainingPolymarketDays = countTradingDaysBetween(dateIso, polymarketResolutionDate, {
        includeStart: false,
        includeEnd: true
      });
      const timelineYesPrice = estimatePolymarketYesPrice({
        spot: equivalentUnderlyingSpot,
        strike: targetUnderlyingValue,
        timeYears: tradingDaysToYears(remainingPolymarketDays),
        volatility: impliedVolatility,
        riskFreeRate,
        marketReferenceYesPrice,
        currentSpot: currentUnderlyingSpot,
        currentTimeYears: currentTimeToMarketResolutionYears,
        signalDirection: polymarketSignal?.direction
      });
      const timelineBinaryPnL = repricedPolymarketLegs.reduce((sum, leg) => {
        const timelineMarkPrice = binaryPriceFromYes(leg.outcome, timelineYesPrice);
        return sum + binaryPnL({
          action: leg.action,
          entryPrice: leg.entryPrice,
          markPrice: timelineMarkPrice,
          quantity: leg.quantity
        });
      }, 0);

      dateProfitSeries.push({
        date: dateIso,
        dateLabel: formatShortDate(dateIso),
        totalPnL: formatNumber(optionsValue + timelineBinaryPnL, 2),
        optionsPnL: formatNumber(optionsValue, 2),
        polymarketPnL: formatNumber(timelineBinaryPnL, 2),
        yesPrice: formatNumber(timelineYesPrice, 4),
        isSelectedDate: dateIso === valuationDate
      });
    });
  }
  const chartData = chartMode === "date" ? dateProfitSeries : spotPayoffSeries;
  const chartXAxisKey = chartMode === "date" ? "dateLabel" : "spot";
  const chartValues = chartData
    .map((point) => Number(point?.totalPnL))
    .filter((value) => Number.isFinite(value));
  const chartMin = chartValues.length ? Math.min(...chartValues) : -1;
  const chartMax = chartValues.length ? Math.max(...chartValues) : 1;
  const chartRange = Math.max(chartMax - chartMin, 1);
  const chartPadding = chartExpanded ? Math.max(chartRange * 0.12, 40) : Math.max(chartRange * 0.08, 20);
  const chartDomain = [chartMin - chartPadding, chartMax + chartPadding];
  const chartTickCount = chartExpanded ? 12 : 6;

  if (!finder) {
    return <div className="app-state">No strategy finder data yet.</div>;
  }

  return (
    <main className="workspace workspace--strategy-finder">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">Strategy finder</span>
          <h2>Matched hedge combinations</h2>
        </div>
        <div className="status-block">
          <div className="status-block__actions">
            <span className="pill pill--live">Polymarket + options</span>
            {onManualRefresh ? (
              <button
                type="button"
                className={`chart-toggle ${refreshing ? "chart-toggle--active" : ""}`}
                onClick={onManualRefresh}
                disabled={refreshing}
              >
                {refreshing ? "Refreshing..." : "Refresh now"}
              </button>
            ) : null}
          </div>
          <span className="timestamp">
            {strategyPayload?.lastUpdated
              ? `Updated ${new Date(strategyPayload.lastUpdated).toLocaleString("en-GB")}`
              : "Waiting for refresh"}
          </span>
        </div>
      </header>

      {refreshNotice ? (
        <div className={`refresh-feedback refresh-feedback--${refreshNotice.tone ?? "info"}`}>
          <span>{refreshNotice.message}</span>
        </div>
      ) : null}

      <section className="finder-toolbar">
        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("date", node)}
          onToggle={() => handleFilterMenuToggle("date")}
        >
          <summary className="finder-control">
            <span>{dateSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Prediction period</strong>
              <button type="button" className="finder-menu__reset" onClick={resetFilters}>
                Reset
              </button>
            </div>
            <div className="finder-menu__list">
              {datePresets.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`finder-menu__option ${
                    activeDatePreset?.id === preset.id ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => {
                    setDateFrom(preset.from);
                    setDateTo(preset.to);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="finder-menu__custom">
              <label>
                <span>From</span>
                <input type="date" value={dateFrom} onChange={(event) => handleDateFromChange(event.target.value)} />
              </label>
              <label>
                <span>To</span>
                <input type="date" value={dateTo} onChange={(event) => handleDateToChange(event.target.value)} />
              </label>
            </div>
          </div>
        </details>

        <button type="button" className="finder-control finder-control--static">
          Expected price range {finder.filters.priceRange}
        </button>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("products", node)}
          onToggle={() => handleFilterMenuToggle("products")}
        >
          <summary className="finder-control">
            <span>{productSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Products</strong>
              <button type="button" className="finder-menu__reset" onClick={() => setActiveAssets(availableAssets)}>
                All
              </button>
            </div>
            <div className="finder-menu__list">
              {availableAssets.map((assetLabel) => (
                <button
                  key={assetLabel}
                  type="button"
                  className={`finder-menu__option ${
                    activeAssets.includes(assetLabel) ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => toggleAsset(assetLabel)}
                >
                  {assetLabel}
                </button>
              ))}
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("strategyTypes", node)}
          onToggle={() => handleFilterMenuToggle("strategyTypes")}
        >
          <summary className="finder-control">
            <span>{strategySummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Strategy types</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => setActiveStrategyTypes(availableStrategyTypes)}
              >
                All
              </button>
            </div>
            <div className="finder-menu__list">
              {availableStrategyTypes.map((strategyType) => (
                <button
                  key={strategyType}
                  type="button"
                  className={`finder-menu__option ${
                    activeStrategyTypes.includes(strategyType) ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => toggleStrategyType(strategyType)}
                >
                  {strategyType}
                </button>
              ))}
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("quoteSize", node)}
          onToggle={() => handleFilterMenuToggle("quoteSize")}
        >
          <summary className="finder-control">
            <span>{quoteSizeSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Target option size</strong>
              {quoteSizeDataAvailable ? (
                <button
                  type="button"
                  className="finder-menu__reset"
                  onClick={() => setTargetOptionQuoteSizeThreshold(defaultQuoteSizeThreshold)}
                >
                  Default
                </button>
              ) : null}
            </div>
            {quoteSizeDataAvailable ? (
              <div className="finder-menu__list">
                {quoteSizeThresholdOptions.map((threshold) => (
                  <button
                    key={threshold}
                    type="button"
                    className={`finder-menu__option ${
                      targetOptionQuoteSizeThreshold === threshold ? "finder-menu__option--active" : ""
                    }`}
                    onClick={() => setTargetOptionQuoteSizeThreshold(threshold)}
                  >
                    {`>${threshold}`}
                  </button>
                ))}
              </div>
            ) : (
              <div className="finder-menu__notice">
                Live option quote sizes are unavailable right now, so this filter is temporarily paused.
              </div>
            )}
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("pnl", node)}
          onToggle={() => handleFilterMenuToggle("pnl")}
        >
          <summary className="finder-control">
            <span>{pnlSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>P&amp;L filters</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setMaxProfitMin("");
                  setMaxProfitMax("");
                  setMaxLossMin(DEFAULT_MAX_LOSS_FLOOR);
                  setMaxLossMax("");
                }}
              >
                Reset
              </button>
            </div>
            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Max loss min</span>
                <input
                  type="number"
                  step="100"
                  value={maxLossMin}
                  onChange={(event) => setMaxLossMin(event.target.value)}
                  placeholder="-3000"
                />
              </label>
              <label>
                <span>Max loss max</span>
                <input
                  type="number"
                  step="100"
                  value={maxLossMax}
                  onChange={(event) => setMaxLossMax(event.target.value)}
                  placeholder="No cap"
                />
              </label>
              <label>
                <span>Max profit min</span>
                <input
                  type="number"
                  step="100"
                  value={maxProfitMin}
                  onChange={(event) => setMaxProfitMin(event.target.value)}
                  placeholder="No floor"
                />
              </label>
              <label>
                <span>Max profit max</span>
                <input
                  type="number"
                  step="100"
                  value={maxProfitMax}
                  onChange={(event) => setMaxProfitMax(event.target.value)}
                  placeholder="No cap"
                />
              </label>
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("tags", node)}
          onToggle={() => handleFilterMenuToggle("tags")}
        >
          <summary className="finder-control">
            <span>{biasSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Tags</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => setActiveBiasTags(availableBiasTags)}
              >
                All
              </button>
            </div>
            <div className="finder-menu__list">
              {availableBiasTags.map((marketBias) => (
                <button
                  key={marketBias}
                  type="button"
                  className={`finder-menu__option ${
                    activeBiasTags.includes(marketBias) ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => toggleBiasTag(marketBias)}
                >
                  {marketBias}
                </button>
              ))}
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("source", node)}
          onToggle={() => handleFilterMenuToggle("source")}
        >
          <summary className="finder-control">
            <span>{sourceSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Polymarket source</strong>
              <button type="button" className="finder-menu__reset" onClick={() => setSourceFilter("all")}>
                All
              </button>
            </div>
            <div className="finder-menu__list">
              {SOURCE_FILTER_OPTIONS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`finder-menu__option ${
                    sourceFilter === option.id ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => setSourceFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </details>

        <button
          type="button"
          className={`chart-toggle chart-toggle--compact ${showSyntheticChain ? "chart-toggle--active" : ""}`}
          aria-pressed={showSyntheticChain}
          onClick={() => setShowSyntheticChain((current) => !current)}
        >
          {showSyntheticChain
            ? "Synthetic chain shown"
            : `Show synthetic chain${syntheticHiddenCount ? ` (${syntheticHiddenCount})` : ""}`}
        </button>

        <button
          type="button"
          className={`chart-toggle chart-toggle--compact ${showSeedData ? "chart-toggle--active" : ""}`}
          aria-pressed={showSeedData}
          onClick={() => setShowSeedData((current) => !current)}
        >
          {showSeedData ? "Seed data shown" : `Show seed data${seedHiddenCount ? ` (${seedHiddenCount})` : ""}`}
        </button>
      </section>

      {selectedRowSummary && detailOpen ? (
        <>
          <section ref={detailRef} className="selection-banner">
            <div className="selection-banner__title">
              <span className="brand__eyebrow">Selected combination</span>
              <strong>
                {selectedRowSummary.assetLabel} · {selectedRowSummary.strategyType} · {selectedRowDisplayCloseDate}
              </strong>
            </div>
            <div className="selection-banner__actions">
              <div className="detail-badges">
                {selectedRow ? <span className="pill pill--ghost">{strategyCloseDays} DTE</span> : null}
                <span className="pill pill--live">{selectedRowDisplaySource}</span>
              </div>
              <button
                type="button"
                className={`chart-toggle ${!detailCollapsed ? "chart-toggle--active" : ""}`}
                aria-expanded={!detailCollapsed}
                onClick={() => setDetailCollapsed((current) => !current)}
              >
                {detailCollapsed ? "Expand details" : "Collapse details"}
              </button>
            </div>
          </section>

          {!detailCollapsed ? (
            selectedRowDetailLoading ? (
              <article className="insight-card">
                <p className="card-copy">Loading strategy detail...</p>
              </article>
            ) : selectedRowDetailError ? (
              <article className="insight-card">
                <p className="card-copy">{selectedRowDetailError}</p>
              </article>
            ) : selectedRow ? (
              <>
              <section className="strategy-detail-grid">
                <article className="detail-card">
                  <div className="detail-card__title">
                    <div>
                      <h3>{selectedRow.strategyType}</h3>
                      <div className="detail-badges">
                        <span className="pill pill--ghost">{selectedRow.assetLabel}</span>
                        <span className="pill pill--ghost">{strategyCloseDate}</span>
                        <span className="pill pill--live">{selectedRow.polymarketSource}</span>
                      </div>
                    </div>
                    <div className="detail-card__actions">
                      <button
                        type="button"
                        className={`chart-toggle ${strategyEditorOpen ? "chart-toggle--active" : ""}`}
                        onClick={() => setStrategyEditorOpen((current) => !current)}
                      >
                        {strategyEditorOpen ? "Close editor" : "Edit strategy"}
                      </button>
                      {selectedPolymarketEventUrl ? (
                        <a href={selectedPolymarketEventUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                          Open Polymarket
                        </a>
                      ) : null}
                    </div>
                  </div>

                  {strategyEditorOpen ? (
                    <section className="strategy-editor">
                      <div className="strategy-editor__header">
                        <div>
                          <span className="brand__eyebrow">Strategy editor</span>
                          <p className="detail-chart__copy">
                            Change each option leg to long or short and replace it from the option chain.
                          </p>
                        </div>
                        <div className="detail-badges">
                          <span className={`pill ${editorHasLiveQuotes ? "pill--live" : "pill--ghost"}`}>
                            {editorHasLiveQuotes ? "Live chain" : "Synthetic chain"}
                          </span>
                          <button type="button" className="chart-toggle" onClick={refreshVisibleOptionChains}>
                            Refresh chain
                          </button>
                        </div>
                      </div>

                      <div className="strategy-editor__grid">
                        {effectiveOptionLegs.map((leg, index) => {
                          const requestKey = buildChainKey(optionRootSymbol, leg.expiry, leg.optionType);
                          const chainPayload = optionChains[requestKey];
                          const chainContracts = chainPayload?.contracts ?? [];
                          const chainState = optionChainStatus[requestKey];
                          const selectedContractValue = chainContracts.some(
                            (contract) => contract.contractSymbol === leg.contractSymbol
                          )
                            ? leg.contractSymbol
                            : "";

                          return (
                            <article key={leg.id} className="strategy-editor__card">
                              <div className="strategy-editor__card-head">
                                <strong>Leg {index + 1}</strong>
                                <span className="pill pill--ghost">
                                  {leg.quoteSource === "polygon" ? "Polygon.io" : chainPayload?.sourceLabel ?? "Seeded"}
                                </span>
                              </div>

                              <div className="strategy-editor__row">
                                <label>
                                  <span>Action</span>
                                  <select
                                    value={leg.action}
                                    onChange={(event) => handleLegActionChange(leg.id, event.target.value)}
                                  >
                                    <option value="LONG">Long</option>
                                    <option value="SHORT">Short</option>
                                  </select>
                                </label>

                                <label>
                                  <span>Type</span>
                                  <select
                                    value={leg.optionType}
                                    onChange={(event) =>
                                      updateLegConfig(leg.id, {
                                        optionType: event.target.value,
                                        contractSymbol: "",
                                        bidSize: null,
                                        askSize: null,
                                        hasRealBidAsk: false
                                      })
                                    }
                                  >
                                    <option value="call">Call</option>
                                    <option value="put">Put</option>
                                  </select>
                                </label>

                                <label>
                                  <span>Expiry</span>
                                  <input
                                    type="date"
                                    value={leg.expiry}
                                    onChange={(event) =>
                                      updateLegConfig(leg.id, {
                                        expiry: event.target.value,
                                        contractSymbol: "",
                                        bidSize: null,
                                        askSize: null,
                                        hasRealBidAsk: false
                                      })
                                    }
                                  />
                                </label>

                                <label className="strategy-editor__contract-picker">
                                  <span>Option chain</span>
                                  <select
                                    value={selectedContractValue}
                                    onChange={(event) => {
                                      const contract = chainContracts.find(
                                        (item) => item.contractSymbol === event.target.value
                                      );
                                      applyChainContractToLeg(leg.id, contract);
                                    }}
                                  >
                                    <option value="">Select contract</option>
                                    {chainContracts.map((contract) => (
                                      <option key={contract.contractSymbol} value={contract.contractSymbol}>
                                        {formatContractChoiceLabel(contract)}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </div>

                              <div className="strategy-editor__quotes">
                                <span>
                                  Chain status:{" "}
                                  {chainState?.loading
                                      ? "Loading..."
                                      : chainState?.error
                                        ? chainState.error
                                        : chainPayload?.warning ??
                                          (chainPayload?.isLive ? "Live quotes" : "Synthetic quotes")}
                                </span>
                                <strong>
                                  {formatNumber(leg.strike, 1)}
                                  {leg.optionType === "put" ? "P" : "C"} · {formatNumber(leg.bid, 2)} / {formatNumber(leg.ask, 2)}
                                </strong>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}

                  <div className="detail-panels">
                    <div className="detail-panel">
                      <h4>Strategy overview</h4>
                      <div className="detail-panel__section">
                        <span className="detail-panel__section-heading">Overview</span>
                        <dl>
                          <div><dt>Underlying price</dt><dd>{formatCurrency(underlyingPrice)}</dd></div>
                          <div><dt>Theo price</dt><dd>{formatNumber(effectiveTheoPrice, 2)}</dd></div>
                          <div><dt>Bid</dt><dd>{formatNumber(effectiveNetBid, 2)}</dd></div>
                          <div><dt>Ask</dt><dd>{formatNumber(effectiveNetAsk, 2)}</dd></div>
                          <div><dt>Breakevens</dt><dd>{effectiveBreakevens.join("/") || "n/a"}</dd></div>
                          <div><dt>Prob. of profit</dt><dd>{formatNumber(effectiveProbabilityOfProfit, 2)}%</dd></div>
                        </dl>
                      </div>
                      <div className="detail-panel__section">
                        <span className="detail-panel__section-heading">Risk analysis</span>
                        <dl>
                          <div><dt>Exp payoff</dt><dd>{formatCurrency(effectiveExpPayoff)}</dd></div>
                          <div>
                            <dt>Max profit</dt>
                            <dd>
                              {formatExtrema(effectiveMaxProfit, {
                                unbounded: effectiveMaxProfitUnbounded,
                                kind: "profit"
                              })}
                            </dd>
                          </div>
                          <div>
                            <dt>Max loss</dt>
                            <dd>
                              {formatExtrema(effectiveMaxLoss, {
                                unbounded: effectiveMaxLossUnbounded,
                                kind: "loss"
                              })}
                            </dd>
                          </div>
                          <div>
                            <dt>Reward/Risk</dt>
                            <dd>{formatNumber(effectiveMaxLoss < 0 ? effectiveMaxProfit / Math.abs(effectiveMaxLoss) : null, 2)}</dd>
                          </div>
                        </dl>
                      </div>
                    </div>

                    <div className="detail-panel detail-panel--contracts">
                      <h4>Contract details</h4>
                      <div className="legs-table">
                        <div className="legs-table__head">
                          <span>Action</span>
                          <span>Qty</span>
                          <span>Strike</span>
                          <span>Bid</span>
                          <span>Ask</span>
                          <span>Spread</span>
                          <span>Code / Link</span>
                        </div>
                        {detailLegRows.map((leg) => (
                          <div key={leg.id} className="legs-table__row">
                            <span className={`legs-action legs-action--${leg.action.toLowerCase()}`}>{leg.action}</span>
                            <span>{formatNumber(leg.quantity, 0)}</span>
                            <span>
                              {typeof leg.strike === "string"
                                ? leg.strike
                                : `${formatNumber(leg.strike, 1)}${leg.optionType === "put" ? "P" : "C"}`}
                            </span>
                            <span>{formatNumber(leg.bid, 2)}</span>
                            <span>{formatNumber(leg.ask, 2)}</span>
                            <span>{leg.spread != null ? `${formatNumber(leg.spread, 2)}%` : ""}</span>
                            <span className="leg-reference">
                              {leg.kind === "binary" && leg.referenceUrl ? (
                                <a href={leg.referenceUrl} target="_blank" rel="noreferrer">
                                  {leg.referenceLabel}
                                </a>
                              ) : leg.kind === "binary" ? (
                                <span>{leg.referenceLabel}</span>
                              ) : leg.isLive === true ? (
                                <code>{leg.referenceLabel}</code>
                              ) : (
                                <span>{leg.referenceLabel}</span>
                              )}
                              <small>{leg.referenceMeta}</small>
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="detail-panel detail-panel--controls">
                      <h4>Scenario controls</h4>
                      <div className="detail-mini-controls">
                        <div className="detail-mini-slider">
                          <div className="detail-mini-slider__header">
                            <span>Date</span>
                            <strong>{formatShortDate(valuationDate)}</strong>
                          </div>
                          <input
                            className="detail-mini-slider__range"
                            type="range"
                            min="0"
                            max={maxDateOffset}
                            step="1"
                            value={currentDateOffset}
                            onChange={(event) =>
                              setControls((current) => ({
                                ...current,
                                valuationDate:
                                  valuationDateOptions[Number(event.target.value)] ??
                                  valuationDateOptions[0] ??
                                  valuationMinDate
                              }))
                            }
                          />
                          <div className="detail-mini-slider__scale">
                            <span>{formatShortDate(valuationMinDate)}</span>
                            <span>{formatShortDate(valuationMaxDate)}</span>
                          </div>
                        </div>

                        <div className="detail-mini-slider">
                          <div className="detail-mini-slider__header detail-mini-slider__header--market">
                            <span>Market spot</span>
                            <div className="detail-mini-slider__markets">
                              <div className="detail-mini-slider__market-pair">
                                <span>{proxySpotLabel}:</span>
                                <strong>{formatCurrency(underlyingPrice, "USD", proxySpotDigits)}</strong>
                                <span>{actualSpotLabel}</span>
                                <strong>{formatCurrency(equivalentUnderlyingSpot, "USD", actualSpotDigits)}</strong>
                              </div>
                            </div>
                          </div>
                          <input
                            className="detail-mini-slider__range"
                            type="range"
                            min={spotMin}
                            max={spotMax}
                            step={spotStep}
                            value={clamp(underlyingPrice, spotMin, spotMax)}
                            onChange={(event) => updateUnderlyingPriceControl(event.target.value)}
                          />
                          <div className="detail-mini-slider__scale">
                            <span>
                              {proxySpotLabel} {formatCurrency(spotMin, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                              {formatCurrency(actualSpotMin, "USD", actualSpotDigits)}
                            </span>
                            <span>
                              {proxySpotLabel} {formatCurrency(spotMax, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                              {formatCurrency(actualSpotMax, "USD", actualSpotDigits)}
                            </span>
                          </div>
                        </div>

                        <div className="detail-mini-slider">
                          <div className="detail-mini-slider__header">
                            <span>Volatility</span>
                            <strong>{formatNumber(impliedVolatility * 100, 2)}%</strong>
                          </div>
                          <input
                            className="detail-mini-slider__range"
                            type="range"
                            min="5"
                            max="150"
                            step="0.5"
                            value={clamp(Number(controls?.impliedVolatility ?? 24), 5, 150)}
                            onChange={(event) =>
                              setControls((current) => ({ ...current, impliedVolatility: event.target.value }))
                            }
                          />
                          <div className="detail-mini-slider__scale">
                            <span>5%</span>
                            <span>150%</span>
                          </div>
                        </div>
                      </div>
                    </div>

                  </div>
                </article>
              </section>

                  <ScenarioHeatmap
                    className="calculator-section"
                    title="Time series heat map"
                    description="P/L across dates and proxy price levels, centered on the current proxy spot. The default view shows a 1x implied-vol range, with quick 2x and 3x range filters available."
                    startDate={valuationMinDate}
                    endDate={valuationMaxDate}
                    currentPrice={currentProxySpot || underlyingPrice}
                    volatility={impliedVolatility}
                    spotLabel={proxySpotLabel}
                    priceDigits={proxySpotDigits}
                    secondarySpotLabel={converterRatio > 0 ? actualSpotLabel : ""}
                    secondaryPriceDigits={actualSpotDigits}
                    getSecondarySpot={converterRatio > 0 ? (spot) => spot / converterRatio : null}
                    getCellPnL={calculateHeatmapPnL}
                    rangeMultiplier={heatmapRangeMultiplier}
                    onRangeMultiplierChange={setHeatmapRangeMultiplier}
                    theme={theme}
                  />

                  <section className="detail-chart calculator-section">
                    <div className="detail-chart__header">
                      <div>
                        <span className="brand__eyebrow">Strategy chart</span>
                        <p className="detail-chart__copy">
                          {chartMode === "date"
                            ? "Date P&L holds the current proxy spot and volatility constant while repricing time decay."
                            : "Expiry payoff shows how P&L changes across proxy spot levels at resolution."}
                        </p>
                      </div>
                      <div className="chart-toggle-group">
                        <button
                          type="button"
                          className={`chart-toggle ${chartExpanded ? "chart-toggle--active" : ""}`}
                          onClick={() => setChartExpanded((current) => !current)}
                        >
                          {chartExpanded ? "Normal size" : "Expand 4x"}
                        </button>
                        <button
                          type="button"
                          className={`chart-toggle ${chartMode === "date" ? "chart-toggle--active" : ""}`}
                          onClick={() => setChartMode("date")}
                        >
                          Date P&amp;L
                        </button>
                        <button
                          type="button"
                          className={`chart-toggle ${chartMode === "spot" ? "chart-toggle--active" : ""}`}
                          onClick={() => setChartMode("spot")}
                        >
                          Expiry payoff
                        </button>
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={chartHeight}>
                      <ComposedChart data={chartData}>
                        <CartesianGrid stroke={chartTheme.grid} />
                        <XAxis dataKey={chartXAxisKey} tick={{ fill: chartTheme.axis, fontSize: 11 }} />
                        <YAxis
                          domain={chartDomain}
                          tickCount={chartTickCount}
                          tick={{ fill: chartTheme.axis, fontSize: 11 }}
                        />
                        <Tooltip
                          formatter={(value) => formatCurrency(value)}
                          labelFormatter={(label, payload) =>
                            chartMode === "date"
                              ? payload?.[0]?.payload?.date
                                ? formatDateLabel(payload[0].payload.date)
                                : label
                              : `Proxy spot ${label}`
                          }
                          contentStyle={{
                            background: chartTheme.tooltipBackground,
                            border: `1px solid ${chartTheme.tooltipBorder}`,
                            borderRadius: "14px"
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="totalPnL"
                          stroke={chartTheme.strategyAreaStroke}
                          fill={chartTheme.strategyAreaFill}
                          strokeWidth={2.2}
                        />
                        <Line
                          type="monotone"
                          dataKey="totalPnL"
                          stroke={chartTheme.strategyLineStroke}
                          dot={false}
                          strokeWidth={1.5}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  </section>

		              <section className="calculator-section">
		                <div className="section-heading">
		                  <span>Multi-leg calculator</span>
		                  <span className="pill pill--ghost">Slide date, market spot, and vol; YES auto-prices</span>
		                </div>

			                <div className="calculator-studio">
                    <div className="paper-order-ticket">
                      <div>
                        <span className="brand__eyebrow">Paper-trade this setup</span>
                        <strong className="paper-order-ticket__title">
                          {selectedRow.assetLabel} · {selectedRow.strategyType}
                        </strong>
                        <p className="card-copy">
                          Save the current edited leg prices and contract amounts as a new paper order, or route the
                          option legs to your IBKR paper account.
                        </p>
                        <div className="paper-order-ticket__status">
                          <span className={`pill ${paperExecutionRoute === "ibkr-paper" ? "pill--live" : "pill--ghost"}`}>
                            {paperExecutionRoute === "ibkr-paper" ? "IBKR paper route" : "Local paper route"}
                          </span>
                          {paperExecutionRoute === "ibkr-paper" ? (
                            <span className={`pill ${ibkrReady ? "pill--long" : "pill--warning"}`}>
                              {ibkrReady
                                ? `Gateway ready${ibkrStatus?.selectedAccount ? ` · ${ibkrStatus.selectedAccount}` : ""}`
                                : "Gateway not ready"}
                            </span>
                          ) : null}
                        </div>
                        {paperExecutionRoute === "ibkr-paper" ? (
                          <p className="paper-order-ticket__note">
                            {ibkrReady
                              ? "HedgeHub will submit the option legs to the connected IBKR paper session and keep the local portfolio synced to broker status."
                              : ibkrReloginNeeded
                                ? (
                                    <>
                                      IBKR session expired or was signed out. Re-login at{" "}
                                      <a href={ibkrLoginUrl} target="_blank" rel="noreferrer">
                                        {ibkrLoginUrl}
                                      </a>{" "}
                                      and wait a few seconds before routing this order.
                                    </>
                                  )
                                : ibkrStatus?.error || "Start the IBKR Client Portal Gateway in paper mode before routing this order."}
                          </p>
                        ) : null}
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
                          <span>Execution</span>
                          <select
                            value={paperExecutionRoute}
                            onChange={(event) => setPaperExecutionRoute(event.target.value)}
                          >
                            <option value="local-paper">Local paper</option>
                            <option value="ibkr-paper">IBKR paper</option>
                          </select>
                        </label>
                        {paperExecutionRoute === "ibkr-paper" ? (
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
                        {paperExecutionRoute === "ibkr-paper" ? (
                          <label>
                            <span>TIF</span>
                            <select value={paperIbkrTif} onChange={(event) => setPaperIbkrTif(event.target.value)}>
                              <option value="DAY">DAY</option>
                              <option value="GTC">GTC</option>
                            </select>
                          </label>
                        ) : null}
                        {paperExecutionRoute === "ibkr-paper" ? (
                          <label className="paper-order-ticket__toggle">
                            <span>Outside RTH</span>
                            <input
                              type="checkbox"
                              checked={paperIbkrOutsideRth}
                              onChange={(event) => setPaperIbkrOutsideRth(event.target.checked)}
                            />
                          </label>
                        ) : null}
                        <button
                          type="button"
                          className={`chart-toggle ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                          onClick={handleCreatePaperTrade}
                          disabled={
                            paperOrderSaving ||
                            !onCreatePaperOrder ||
                            (paperExecutionRoute === "ibkr-paper" && !ibkrReady)
                          }
                        >
                          {paperOrderSaving ? "Saving..." : "Start new order"}
                        </button>
                        {onOpenPaperTrading ? (
                          <button type="button" className="chart-toggle" onClick={onOpenPaperTrading}>
                            View holdings
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={`chart-toggle chart-toggle--compact ${optionPriceRefreshing ? "chart-toggle--active" : ""}`}
                          onClick={refreshCalculatorOptionPrices}
                          disabled={optionPriceRefreshing || !effectiveOptionLegs.length || !optionRootSymbol}
                          title="Refresh option prices"
                        >
                          {optionPriceRefreshing ? "Refreshing..." : "Refresh"}
                        </button>
                      </div>
                    </div>

                    {paperOrderState ? (
                      <div className={`refresh-feedback refresh-feedback--${paperOrderState.tone}`}>
                        <span>{paperOrderState.message}</span>
                      </div>
                    ) : null}
                    {optionPriceRefreshState ? (
                      <div className={`refresh-feedback refresh-feedback--${optionPriceRefreshState.tone}`}>
                        <span>{optionPriceRefreshState.message}</span>
                      </div>
                    ) : null}

			                  <div className="calculator-lines">
                    {repricedOptionLegs.map((leg) => (
                      <div key={leg.id} className="calculator-line">
                        <div className="calculator-line__body">
                          <p>
                            Option {leg.action} {leg.optionType.toUpperCase()} {formatNumber(leg.strike, 1)}{" "}
                            {formatCompactDate(leg.expiry)}
                          </p>
                          <div className="calculator-line__meta">
                            <span>{leg.action === "SHORT" ? "Sell" : "Buy"} {formatCurrency(leg.entryPrice)}</span>
                            <span>{leg.daysToExpiry} DTE</span>
                            <span className={leg.pnl >= 0 ? "positive" : "negative"}>
                              P&amp;L {formatCurrency(leg.pnl)}
                            </span>
                            <span className="calculator-line__calc">Calc price {formatCurrency(leg.modelPrice)}</span>
                          </div>
                          <div className="calculator-line__reference">
                            {leg.isLive === true ? (
                              <code>{leg.contractSymbol || "n/a"}</code>
                            ) : (
                              <span>{formatOptionReferenceLabel(leg)}</span>
                            )}
                            <span>{formatQuoteSourceLabel(leg)}</span>
                          </div>
                        </div>
                        <div className="calculator-line__editor">
                          <label>
                            <span>{leg.action === "SHORT" ? "Sell price" : "Buy price"}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={controls?.legEdits?.[leg.id]?.entryPrice ?? leg.entryPrice}
                              onChange={(event) => updateLegEdit(leg.id, "entryPrice", event.target.value)}
                            />
                          </label>
                          <label>
                            <span>Contracts</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={controls?.legEdits?.[leg.id]?.quantity ?? leg.quantity}
                              onChange={(event) => updateLegEdit(leg.id, "quantity", event.target.value)}
                            />
                          </label>
                          <label className="calculator-line__value">
                            <span>{leg.action === "SHORT" ? "Entry credit" : "Entry cost"}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={formatNumber(Math.abs(leg.entryValue), 2)}
                              disabled={Number(leg.entryPrice ?? 0) <= 0}
                              onChange={(event) => updateLegEntryValue(leg, event.target.value)}
                            />
                          </label>
                          <div className="calculator-line__value">
                            <span>{leg.action === "SHORT" ? "Current liability" : "Marked value"}</span>
                            <strong>{formatAbsoluteCurrency(leg.markValue)}</strong>
                          </div>
                        </div>
                      </div>
                    ))}

                    {repricedPolymarketLegs.map((leg) => (
                      <div key={leg.id} className="calculator-line calculator-line--market">
                        <div className="calculator-line__body">
                          <p>Polymarket {leg.label} {selectedRow.polymarketQuestion}</p>
                          <div className="calculator-line__meta">
                            <span>{leg.action === "SHORT" ? "Sell" : "Buy"} {formatNumber(leg.entryPrice, 2)}</span>
                            <span>
                              Market {formatNumber(leg.outcome === "YES" ? marketReferenceYesPrice : 1 - marketReferenceYesPrice, 2)}
                            </span>
                            <span>
                              {selectedRow.assetLabel} equiv {formatCurrency(equivalentUnderlyingSpot)}
                            </span>
                            <span>{daysToMarketResolution} DTE</span>
                            <span className={leg.pnl >= 0 ? "positive" : "negative"}>
                              P&amp;L {formatCurrency(leg.pnl)}
                            </span>
                            <span className="calculator-line__calc">Calc mark {formatNumber(leg.modelPrice, 2)}</span>
                          </div>
                          <div className="calculator-line__reference">
                            {selectedPolymarketEventUrl ? (
                              <a href={selectedPolymarketEventUrl} target="_blank" rel="noreferrer">
                                {selectedPolymarketEventUrl}
                              </a>
                            ) : (
                              <span>Seed fallback market</span>
                            )}
                            {polymarketReferenceLine ? <span>{polymarketReferenceLine}</span> : null}
                            <span>{selectedPolymarketEventUrl ? "Polymarket event URL" : "No live event URL yet"}</span>
                          </div>
                        </div>
                        <div className="calculator-line__editor">
                          <label>
                            <span>{leg.action === "SHORT" ? "Sell price" : "Buy price"}</span>
                            <input
                              type="number"
                              min="0"
                              max="1"
                              step="0.01"
                              value={controls?.legEdits?.[leg.id]?.entryPrice ?? leg.entryPrice}
                              onChange={(event) => updateLegEdit(leg.id, "entryPrice", event.target.value)}
                            />
                          </label>
                          <label>
                            <span>Contracts</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={controls?.legEdits?.[leg.id]?.quantity ?? leg.quantity}
                              onChange={(event) => updateLegEdit(leg.id, "quantity", event.target.value)}
                            />
                          </label>
                          <label className="calculator-line__value">
                            <span>{leg.action === "SHORT" ? "Entry credit" : "Entry cost"}</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={formatNumber(Math.abs(leg.entryValue), 2)}
                              disabled={Number(leg.entryPrice ?? 0) <= 0}
                              onChange={(event) => updateLegEntryValue(leg, event.target.value)}
                            />
                          </label>
                          <div className="calculator-line__value">
                            <span>{leg.action === "SHORT" ? "Current liability" : "Marked value"}</span>
                            <strong>{formatAbsoluteCurrency(leg.markValue)}</strong>
                          </div>
                        </div>
                      </div>
                    ))}
	                  </div>

			                  <div className="calculator-summary calculator-summary--studio">
	                    <article className="calculator-total">
	                      <span>{initialInvestment < 0 ? "Net initial credit" : "Net initial cost"}</span>
	                      <strong className={initialInvestment < 0 ? "positive" : ""}>
                          {formatAbsoluteCurrency(initialInvestment)}
                        </strong>
	                    </article>
	                    <article className="calculator-total">
	                      <span>Current marked value</span>
	                      <strong>{formatCurrency(currentMarkedValue)}</strong>
	                    </article>
	                    <article className="calculator-total">
	                      <span>Options P&amp;L</span>
	                      <strong className={optionsPnL >= 0 ? "positive" : "negative"}>
	                        {formatCurrency(optionsPnL)}
	                      </strong>
	                    </article>
	                    <article className="calculator-total">
	                      <span>Polymarket P&amp;L</span>
	                      <strong className={polymarketPnL >= 0 ? "positive" : "negative"}>
	                        {formatCurrency(polymarketPnL)}
	                      </strong>
	                    </article>
	                    <article className="calculator-total calculator-total--accent">
	                      <span>Total Profit/Loss</span>
	                      <strong className={totalPnL >= 0 ? "positive" : "negative"}>
	                        {formatCurrency(totalPnL)}
	                      </strong>
	                    </article>
	                  </div>

			                  <div className="calculator-slider-stack">
	                    <div className="calculator-slider">
                      <div className="calculator-slider__header">
                        <div>
                          <span>Valuation date</span>
                          <strong>{formatDateLabel(valuationDate)}</strong>
                        </div>
                        <input
                          className="calculator-slider__number calculator-slider__number--date"
                          type="date"
                          min={valuationMinDate}
                          max={valuationMaxDate}
                          value={valuationDate}
                          onChange={(event) =>
                            setControls((current) => ({
                              ...current,
                              valuationDate: coerceToTradingDate(event.target.value, valuationDateCandidates, "previous")
                            }))
                          }
                        />
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min="0"
                        max={maxDateOffset}
                        step="1"
                        value={currentDateOffset}
                        onChange={(event) =>
                          setControls((current) => ({
                            ...current,
                            valuationDate:
                              valuationDateOptions[Number(event.target.value)] ??
                              valuationDateOptions[0] ??
                              valuationMinDate
                          }))
                        }
                      />
                      <div className="calculator-slider__scale">
                        <span>{formatDateLabel(valuationMinDate)}</span>
                        <span>{formatDateLabel(valuationMaxDate)}</span>
                      </div>
                    </div>

                    <div className="calculator-slider">
                      <div className="calculator-slider__header calculator-slider__header--market">
                        <div className="calculator-slider__market-values">
                          <div className="calculator-slider__market-pair">
                            <span>{proxySpotLabel}:</span>
                            <strong>{formatCurrency(underlyingPrice, "USD", proxySpotDigits)}</strong>
                            <span>{actualSpotLabel}</span>
                            <strong>{formatCurrency(equivalentUnderlyingSpot, "USD", actualSpotDigits)}</strong>
                          </div>
                        </div>
                        <input
                          className="calculator-slider__number"
                          type="number"
                          min={spotMin}
                          max={spotMax}
                          step={spotStep}
                          value={formatNumber(underlyingPrice, proxySpotDigits)}
                          onChange={(event) => updateUnderlyingPriceControl(event.target.value)}
                        />
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min={spotMin}
                        max={spotMax}
                        step={spotStep}
                        value={clamp(underlyingPrice, spotMin, spotMax)}
                        onChange={(event) => updateUnderlyingPriceControl(event.target.value)}
                      />
                      <div className="calculator-slider__scale">
                        <span>
                          {proxySpotLabel} {formatCurrency(spotMin, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                          {formatCurrency(actualSpotMin, "USD", actualSpotDigits)}
                        </span>
                        <span>
                          {proxySpotLabel} {formatCurrency(spotMax, "USD", proxySpotDigits)} · {actualSpotLabel}{" "}
                          {formatCurrency(actualSpotMax, "USD", actualSpotDigits)}
                        </span>
                      </div>
                    </div>

                    <div className="calculator-slider">
                      <div className="calculator-slider__header">
                        <div>
                          <span>Presumed volatility</span>
                          <strong>{formatNumber(impliedVolatility * 100, 2)}%</strong>
                        </div>
                        <input
                          className="calculator-slider__number"
                          type="number"
                          min="5"
                          max="150"
                          step="0.5"
                          value={controls?.impliedVolatility ?? ""}
                          onChange={(event) =>
                            setControls((current) => ({ ...current, impliedVolatility: event.target.value }))
                          }
                        />
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min="5"
                        max="150"
                        step="0.5"
                        value={clamp(Number(controls?.impliedVolatility ?? 24), 5, 150)}
                        onChange={(event) =>
                          setControls((current) => ({ ...current, impliedVolatility: event.target.value }))
                        }
                      />
                      <div className="calculator-slider__scale">
                        <span>5%</span>
                        <span>150%</span>
                      </div>
                    </div>

                    <div className="calculator-slider">
                      <div className="calculator-slider__header">
                        <div>
                          <span>Estimated Poly YES</span>
                          <strong>{formatNumber(estimatedYesPrice, 2)}</strong>
                        </div>
                        <div className="calculator-slider__hint">BTCETFCalc-style ratio + time decay</div>
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min="0"
                        max="1"
                        step="0.01"
                        value={clamp(estimatedYesPrice, 0, 1)}
                        readOnly
                        disabled
                      />
                      <div className="calculator-slider__scale">
                        <span>Threshold {formatCurrency(targetUnderlyingValue)}</span>
                        <span>{polymarketResolutionDate}</span>
                      </div>
                    </div>
                  </div>
	                </div>
              </section>
              </>
            ) : null
          ) : null}
        </>
      ) : null}

      <section className="finder-table-card">
        <div className="finder-table">
          <div className="finder-table__head">
            {columns.map((column) => (
              <button
                key={column.key}
                type="button"
                className="finder-sort"
                onClick={() => toggleSort(column.key)}
              >
                {column.label}
                {sortKey === column.key ? (sortDirection === "asc" ? " ↑" : " ↓") : ""}
              </button>
            ))}
          </div>

          {sortedRows.length === 0 ? (
            <div className="finder-empty">
              {emptyStateMessage}
            </div>
          ) : (
            sortedRows.map((row) => (
              <button
                key={row.id}
                type="button"
                aria-expanded={selectedRowSummary?.id === row.id && detailOpen}
                className={`finder-row ${selectedRowSummary?.id === row.id ? "finder-row--active" : ""}`}
                onClick={() => handleRowSelect(row.id)}
              >
                <span>{row.expiration}</span>
                <span>{row.days}</span>
                <span className="finder-asset-cell">
                  <span>{row.assetLabel}</span>
                  {String(row.polymarketSource ?? "").toLowerCase() === "seed" ? (
                    <span className="source-pill source-pill--seed">Seed</span>
                  ) : null}
                </span>
                <span>{row.strategyType}</span>
                <span>
                  <span className={`bias-pill bias-pill--${row.marketBiasTone ?? "neutral"}`}>
                    {row.marketBias ?? "Neutral"}
                  </span>
                </span>
                <span className="formula-cell">
                  {row.formula.map((item) => (
                    <span key={`${row.id}-${item.label}`} className={`formula-pill formula-pill--${item.tone}`}>
                      {item.label}
                    </span>
                  ))}
                </span>
                <span>{`${row.polymarketPriceSide === "NO" ? "N" : "Y"} ${formatNumber(row.polymarketPrice, 2)}`}</span>
                <span className="finder-metric-cell">
                  <span
                    className={
                      row.maxProfitUnbounded === true ? "" : Number(row.maxProfit) >= 0 ? "positive" : "negative"
                    }
                  >
                    {formatExtrema(row.maxProfit, {
                      unbounded: row.maxProfitUnbounded === true,
                      kind: "profit"
                    })}
                  </span>
                  {row.maxProfitRangeTag ? <span className="finder-range-tag">{row.maxProfitRangeTag}</span> : null}
                </span>
                <span className="finder-metric-cell">
                  <span
                    className={
                      row.maxLossUnbounded === true ? "" : Number(row.maxLoss) >= 0 ? "positive" : "negative"
                    }
                  >
                    {formatExtrema(row.maxLoss, {
                      unbounded: row.maxLossUnbounded === true,
                      kind: "loss"
                    })}
                  </span>
                  {row.maxLossRangeTag ? <span className="finder-range-tag">{row.maxLossRangeTag}</span> : null}
                </span>
                <span>{formatNumber(row.rewardRisk, 2)}</span>
                <span>{row.breakevens.join("/") || "n/a"}</span>
                <span>{formatNumber(row.theoPrice, 2)}</span>
                <span>{formatNumber(row.bid, 2)}</span>
                <span>{formatNumber(row.ask, 2)}</span>
                <span className="negative">{row.bidAskSpread != null ? `${formatNumber(row.bidAskSpread, 2)}%` : ""}</span>
                <span>{formatCurrency(row.expPayoff)}</span>
              </button>
            ))
          )}
        </div>
      </section>

    </main>
  );
}
