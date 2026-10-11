import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import OptionMicrostructurePanel from "./OptionMicrostructurePanel.jsx";
import ScenarioHeatmap, { buildScenarioHeatmapSnapshot } from "./ScenarioHeatmap.jsx";
import { createMarketTimerContext } from "../marketTimers.js";
import { getChartPalette } from "../theme.js";
import { buildOptionChainCallColumns, buildOptionChainSideColumns } from "../optionChainColumns.js";
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
import { loadSavedFilters, persistSavedFilters } from "../savedFilters.js";

const OPTION_CHAIN_SIDE_COLUMNS = buildOptionChainSideColumns();
const OPTION_CHAIN_CALL_COLUMNS = buildOptionChainCallColumns();
const LIVE_OPTION_QUOTES_POLL_MS = 5000;
const MAX_OPTION_CHAIN_CACHE_ENTRIES = 8;
const MAX_FINDER_DETAIL_CACHE_ENTRIES = 1;

function writeBoundedCacheRecord(current, key, value, maxEntries) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return current && typeof current === "object" ? { ...current } : {};
  }

  const entries = Object.entries(current ?? {}).filter(([entryKey]) => entryKey !== normalizedKey);
  entries.push([normalizedKey, value]);

  return Object.fromEntries(entries.slice(-Math.max(Number(maxEntries) || 0, 0)));
}

function retainCacheEntries(current, keys) {
  const allowedKeys = new Set((keys ?? []).map((key) => String(key ?? "").trim()).filter(Boolean));
  if (!allowedKeys.size) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(current ?? {}).filter(([entryKey]) => allowedKeys.has(String(entryKey ?? "").trim()))
  );
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

function normalCdf(x) {
  const scaledX = x / Math.SQRT2;
  const sign = scaledX >= 0 ? 1 : -1;
  const absX = Math.abs(scaledX);
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

function formatQuotePrice(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  const digits = Math.abs(numericValue) < 1 ? 4 : 2;
  return numericValue.toFixed(digits);
}

function formatShortTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
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
    numericBidSize < 0 ||
    !Number.isFinite(numericAskSize) ||
    numericAskSize < 0
  ) {
    return null;
  }

  return `${formatWholeNumber(numericBidSize)}/${formatWholeNumber(numericAskSize)}`;
}

function getEntrySideQuoteSize(leg) {
  return String(leg?.action ?? "LONG").trim().toUpperCase() === "SHORT"
    ? Number(leg?.bidSize)
    : Number(leg?.askSize);
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

function formatExactCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0
  }).format(numericValue);
}

function formatCompactUsd(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: numericValue >= 1000 ? 1 : 0
  }).format(numericValue);
}

function formatExactUsd(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return "n/a";
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(numericValue);
}

function buildOptionLiquidityMeta(leg) {
  if (leg?.kind === "binary") {
    return leg?.volume != null && Number.isFinite(Number(leg.volume))
      ? `Market volume ${formatExactUsd(leg.volume)}`
      : "";
  }

  const liquidityParts = [];
  const entryQuoteSize = getEntrySideQuoteSize(leg);
  const quoteSizePair = formatQuoteSizePair(leg?.bidSize, leg?.askSize);

  if (Number.isFinite(entryQuoteSize) && entryQuoteSize >= 0) {
    liquidityParts.push(`Entry size ${formatExactCount(entryQuoteSize)}`);
  }

  if (quoteSizePair) {
    liquidityParts.push(`B/A size ${quoteSizePair}`);
  }

  if (leg?.volume != null && Number.isFinite(Number(leg.volume))) {
    liquidityParts.push(`Vol ${formatExactCount(leg.volume)}`);
  }

  if (leg?.openInterest != null && Number.isFinite(Number(leg.openInterest))) {
    liquidityParts.push(`OI ${formatExactCount(leg.openInterest)}`);
  }

  return liquidityParts.join(" · ");
}

function getFinderMidPrice(row) {
  const bid = Number(row?.bid);
  const ask = Number(row?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }

  return (bid + ask) / 2;
}

function getFinderMidMinusTheo(row) {
  const averagePrice = getFinderMidPrice(row);
  const theoreticalPrice = Number(row?.theoPrice);
  if (!Number.isFinite(averagePrice) || !Number.isFinite(theoreticalPrice)) {
    return null;
  }

  return averagePrice - theoreticalPrice;
}

function getFinderMidMinusTheoTone(row) {
  const averagePrice = getFinderMidPrice(row);
  const theoreticalPrice = Number(row?.theoPrice);
  if (!Number.isFinite(averagePrice) || !Number.isFinite(theoreticalPrice)) {
    return "";
  }

  const bothPositive = averagePrice > 0 && theoreticalPrice > 0;
  const bothNegative = averagePrice < 0 && theoreticalPrice < 0;

  if (bothPositive) {
    return theoreticalPrice < averagePrice ? "negative" : "positive";
  }

  if (bothNegative) {
    return theoreticalPrice > averagePrice ? "positive" : "negative";
  }

  return theoreticalPrice >= averagePrice ? "positive" : "negative";
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

function buildWeeklyExpiryTabs(anchorIso, { pastWeeks = 4, futureWeeks = 12 } = {}) {
  if (!anchorIso) {
    return [];
  }

  const anchor = parseIsoDate(anchorIso);
  if (!anchor) {
    return [];
  }

  const dates = new Set();
  for (let weekOffset = -pastWeeks; weekOffset <= futureWeeks; weekOffset += 1) {
    const next = addDays(anchorIso, weekOffset * 7);
    if (next) {
      dates.add(next);
    }
  }

  return Array.from(dates).sort();
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

function normalizeComboQuantityInput(value, fallback = 1) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return fallback;
  }

  return Math.max(Math.round(numericValue), 1);
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
  if (!allItems.length) {
    return fallbackLabel;
  }

  if (selectedItems.length === 0) {
    return `${fallbackLabel} (none)`;
  }

  if (selectedItems.length === allItems.length) {
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

function formatSignedPercentLabel(value, digits = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return `${numericValue > 0 ? "+" : ""}${numericValue.toFixed(digits)}%`;
}

function formatFilterPercent(value, digits = 1) {
  if (value == null) {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  return `${numericValue.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits
  })}%`;
}

function formatFilterNumber(value, digits = 2) {
  if (value == null) {
    return null;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return null;
  }

  return numericValue.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatFilterCount(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < 0) {
    return null;
  }

  return formatCompactCount(numericValue);
}

function buildMetricRangeSummary({ label, min, max, formatValue }) {
  if (min == null && max == null) {
    return label;
  }

  const minLabel = min != null ? formatValue(min) : null;
  const maxLabel = max != null ? formatValue(max) : null;

  if (minLabel && maxLabel) {
    return `${label} ${minLabel} - ${maxLabel}`;
  }

  if (minLabel) {
    return `${label} ≥ ${minLabel}`;
  }

  if (maxLabel) {
    return `${label} ≤ ${maxLabel}`;
  }

  return label;
}

function buildQuoteSizeFilterSummary(threshold, quoteSizeDataAvailable = true) {
  if (!quoteSizeDataAvailable) {
    return "Bid/ask size unavailable";
  }

  const thresholdLabel = formatWholeNumber(threshold);
  return thresholdLabel ? `Bid/ask size > ${thresholdLabel}` : "Bid/ask size";
}

function calculateExpectedMovePercent(row) {
  const explicitExpectedMove = Number(row?.expectedMovePercent ?? NaN);
  if (Number.isFinite(explicitExpectedMove)) {
    return explicitExpectedMove;
  }

  const currentUnderlyingSpot = Number(row?.marketContext?.currentUnderlyingSpot ?? NaN);
  const targetUnderlyingValue = Number(row?.marketContext?.targetUnderlyingValue ?? NaN);

  if (!(currentUnderlyingSpot > 0) || !(targetUnderlyingValue > 0)) {
    return null;
  }

  return ((targetUnderlyingValue / currentUnderlyingSpot) - 1) * 100;
}

const DEFAULT_MAX_LOSS_FLOOR = "-3000";
const STRATEGY_FINDER_FILTERS_STORAGE_KEY = "hedgehub:filters:strategy-finder";

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

  if (leg?.isLive === true || leg?.quoteSource === "live") {
    return "Live";
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
  const strikeLabel = formatNumber(contract?.strike, 1);
  const typeLabel = contract?.optionType === "put" ? "P" : "C";
  const bidLabel = formatNumber(contract?.bid, 2);
  const askLabel = formatNumber(contract?.ask, 2);
  const quoteSizePair = formatQuoteSizePair(contract?.bidSize, contract?.askSize);
  const sizeSuffix = quoteSizePair ? ` · size ${quoteSizePair}` : "";
  const volumeSuffix =
    contract?.volume != null && Number.isFinite(Number(contract.volume))
      ? ` · vol ${formatCompactCount(contract.volume)}`
      : "";
  const openInterestSuffix =
    contract?.openInterest != null && Number.isFinite(Number(contract.openInterest))
      ? ` · oi ${formatCompactCount(contract.openInterest)}`
      : "";

  return `${strikeLabel}${typeLabel} · bid ${bidLabel} · ask ${askLabel}${sizeSuffix}${volumeSuffix}${openInterestSuffix}`;
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
  { key: "expiration", label: "Expiration", width: "112px" },
  { key: "days", label: "Days", width: "72px" },
  { key: "assetLabel", label: "Asset", width: "156px" },
  { key: "strategyType", label: "Strategy type", width: "156px" },
  { key: "marketBias", label: "Tag", width: "110px" },
  { key: "formula", label: "Formula", width: "168px" },
  { key: "polymarketPrice", label: "Poly price", width: "98px" },
  { key: "normalizedOptionVolume", label: "Opt vol (norm)", width: "122px" },
  { key: "midMinusTheo", label: "Avg B/A - Theo", width: "124px" },
  { key: "polymarketVolume", label: "Poly volume", width: "120px" },
  { key: "maxProfit", label: "Max profit", width: "138px" },
  { key: "maxLoss", label: "Max loss", width: "138px" },
  { key: "rewardRisk", label: "Reward/Risk", width: "110px" },
  { key: "breakevens", label: "Breakeven(s)", width: "136px" },
  { key: "theoPrice", label: "Theo price", width: "100px" },
  { key: "bid", label: "Bid", width: "88px" },
  { key: "ask", label: "Ask", width: "88px" },
  { key: "bidAskSpread", label: "Bid-ask spread", width: "122px" },
  { key: "expPayoff", label: "Exp payoff", width: "120px" }
];

const FINDER_COMPACT_MEDIA_QUERY = "(max-width: 1240px)";
const FINDER_COMPACT_COLUMN_KEYS = [
  "expiration",
  "assetLabel",
  "normalizedOptionVolume",
  "midMinusTheo",
  "polymarketVolume",
  "maxProfit",
  "maxLoss",
  "bid",
  "bidAskSpread"
];

function matchesFinderCompactViewport() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(FINDER_COMPACT_MEDIA_QUERY).matches;
}

function getDefaultVisibleFinderColumnKeys(isCompactViewport = false) {
  if (isCompactViewport) {
    return FINDER_COMPACT_COLUMN_KEYS.filter((key) => columns.some((column) => column.key === key));
  }

  return columns.map((column) => column.key);
}

const MAX_SORT_PRIORITIES = 4;

const BIAS_FILTER_ORDER = ["Bull", "Bear", "Range-bound", "Breakout", "Neutral"];
const BID_ASK_SPREAD_PRESETS = [
  { label: "Below 1%", description: "Tight", max: 1 },
  { label: "1% to 3%", description: "Medium", min: 1, max: 3 },
  { label: "Above 3%", description: "Wide", min: 3 }
];
const EXPECTED_PRICE_RANGE_PRESETS = [
  { label: "-20% to +20%", description: "Wide", min: -20, max: 20 },
  { label: "-20% to -10%", description: "Bearish", min: -20, max: -10 },
  { label: "-10% to -5%", description: "Slightly bearish", min: -10, max: -5 },
  { label: "-5% to +5%", description: "Neutral", min: -5, max: 5 },
  { label: "+5% to +10%", description: "Slightly bullish", min: 5, max: 10 },
  { label: "+10% to +20%", description: "Bullish", min: 10, max: 20 }
];

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

export default function StrategyFinderWorkspace({
  strategyPayload,
  strategyDefinition = null,
  setupWatchlist = [],
  onUpsertSetupWatchlistItem = null,
  onDeleteSetupWatchlistItem = null,
  autoOpenRowId = "",
  onAutoOpenRowHandled = null,
  onManualRefresh = null,
  refreshing = false,
  refreshNotice = null,
  paperPortfolio = null,
  onCreatePaperOrder = null,
  onConfirmPaperExecution = null,
  onOpenPaperTrading = null,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const chartTheme = getChartPalette(theme);
  const finder = strategyPayload?.primaryStrategy?.finder;
  const currentDate =
    strategyPayload?.lastUpdated?.slice(0, 10) ??
    finder?.filters?.dateRange?.from ??
    new Date().toISOString().slice(0, 10);
  const rawRows = finder?.rows ?? [];
  const rows = useMemo(
    () =>
      rawRows.map((row) => {
        const midMinusTheo = getFinderMidMinusTheo(row);
        const bidAskSpread =
          row.bidAskSpread != null ? row.bidAskSpread : calculateSpreadPercent(row.bid, row.ask);

        return {
          ...row,
          midMinusTheo,
          bidAskSpread
        };
      }),
    [rawRows]
  );
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
  const liveTheoRowIdRef = useRef(null);
  const filterMenuRefs = useRef({});
  const saveFiltersFeedbackTimeoutRef = useRef(null);
  const hasHydratedFiltersRef = useRef(false);
  const hasAutoRevealedHiddenDataRef = useRef(false);
  const [sortState, setSortState] = useState([{ key: "rewardRisk", direction: "desc" }]);
  const [isCompactFinderViewport, setIsCompactFinderViewport] = useState(() => matchesFinderCompactViewport());
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(() =>
    getDefaultVisibleFinderColumnKeys(matchesFinderCompactViewport())
  );
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [liveTheoPrice, setLiveTheoPrice] = useState(null);
  const [liveOptionLegQuotes, setLiveOptionLegQuotes] = useState({});
  const [liveOptionLegQuotesUpdatedAt, setLiveOptionLegQuotesUpdatedAt] = useState(null);
  const [liveOptionLegQuotesError, setLiveOptionLegQuotesError] = useState("");
  const liveOptionQuoteRowIdRef = useRef(null);
  const [strategyEditorOpen, setStrategyEditorOpen] = useState(false);
  const [activeLegId, setActiveLegId] = useState("");
  const [chainShowAll, setChainShowAll] = useState(false);
  const [chartMode, setChartMode] = useState("date");
  const [chartExpanded, setChartExpanded] = useState(false);
  const [heatmapRangeMultiplier, setHeatmapRangeMultiplier] = useState(1);
  const [heatmapRowCount, setHeatmapRowCount] = useState(13);
  const [strategyDirection, setStrategyDirection] = useState("LONG");
  const [dateFrom, setDateFrom] = useState(defaultDateRange.from);
  const [dateTo, setDateTo] = useState(defaultDateRange.to);
  const [activeAssets, setActiveAssets] = useState(availableAssets);
  const [activeStrategyTypes, setActiveStrategyTypes] = useState(availableStrategyTypes);
  const [activeBiasTags, setActiveBiasTags] = useState(availableBiasTags);
  const [showSyntheticChain, setShowSyntheticChain] = useState(false);
  const [showSeedData, setShowSeedData] = useState(false);
  const [targetOptionQuoteSizeThreshold, setTargetOptionQuoteSizeThreshold] = useState(defaultQuoteSizeThreshold);
  const [maxProfitMin, setMaxProfitMin] = useState("");
  const [maxProfitMax, setMaxProfitMax] = useState("");
  const [maxLossMin, setMaxLossMin] = useState(DEFAULT_MAX_LOSS_FLOOR);
  const [maxLossMax, setMaxLossMax] = useState("");
  const [bidAskSpreadMin, setBidAskSpreadMin] = useState("");
  const [bidAskSpreadMax, setBidAskSpreadMax] = useState("");
  const [expectedMoveMin, setExpectedMoveMin] = useState("-20");
  const [expectedMoveMax, setExpectedMoveMax] = useState("20");
  const [normalizedOptionVolumeMin, setNormalizedOptionVolumeMin] = useState("");
  const [normalizedOptionVolumeMax, setNormalizedOptionVolumeMax] = useState("");
  const [midMinusTheoMin, setMidMinusTheoMin] = useState("");
  const [midMinusTheoMax, setMidMinusTheoMax] = useState("");
  const [saveFiltersState, setSaveFiltersState] = useState("idle");
  const [controls, setControls] = useState(null);
  const [optionChains, setOptionChains] = useState({});
  const [optionChainStatus, setOptionChainStatus] = useState({});
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [watchlistSaving, setWatchlistSaving] = useState(false);
  const [watchlistNotice, setWatchlistNotice] = useState("");
  const [paperComboQuantity, setPaperComboQuantity] = useState(1);
  const [paperComboQuantityInput, setPaperComboQuantityInput] = useState("1");
  const [optionPriceRefreshing, setOptionPriceRefreshing] = useState(false);
  const [optionPriceRefreshState, setOptionPriceRefreshState] = useState(null);
  const [finderRowDetails, setFinderRowDetails] = useState({});
  const [finderDetailLoadingId, setFinderDetailLoadingId] = useState("");
  const [finderDetailErrors, setFinderDetailErrors] = useState({});
  const minProfitThreshold = parseOptionalNumber(maxProfitMin);
  const maxProfitThreshold = parseOptionalNumber(maxProfitMax);
  const minLossThreshold = parseOptionalNumber(maxLossMin);
  const maxLossThreshold = parseOptionalNumber(maxLossMax);
  const bidAskSpreadMinThreshold = parseOptionalNumber(bidAskSpreadMin);
  const bidAskSpreadMaxThreshold = parseOptionalNumber(bidAskSpreadMax);
  const expectedMoveMinThreshold = parseOptionalNumber(expectedMoveMin);
  const expectedMoveMaxThreshold = parseOptionalNumber(expectedMoveMax);
  const normalizedOptionVolumeMinThreshold = parseOptionalNumber(normalizedOptionVolumeMin);
  const normalizedOptionVolumeMaxThreshold = parseOptionalNumber(normalizedOptionVolumeMax);
  const midMinusTheoMinThreshold = parseOptionalNumber(midMinusTheoMin);
  const midMinusTheoMaxThreshold = parseOptionalNumber(midMinusTheoMax);

  useEffect(() => {
    setFinderRowDetails({});
    setFinderDetailLoadingId("");
    setFinderDetailErrors({});
  }, [finder?.rows]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }

    const mediaQuery = window.matchMedia(FINDER_COMPACT_MEDIA_QUERY);

    function handleViewportChange(event) {
      setIsCompactFinderViewport(event.matches);
    }

    handleViewportChange(mediaQuery);

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", handleViewportChange);
      return () => {
        mediaQuery.removeEventListener("change", handleViewportChange);
      };
    }

    mediaQuery.addListener(handleViewportChange);
    return () => {
      mediaQuery.removeListener(handleViewportChange);
    };
  }, []);

  useEffect(() => {
    if (!finder) {
      return;
    }

    if (!hasHydratedFiltersRef.current) {
      setControls(finder.calculatorDefaults ?? null);
      const savedFilters = loadSavedFilters(STRATEGY_FINDER_FILTERS_STORAGE_KEY);

      if (savedFilters) {
        const nextDateFrom = typeof savedFilters.dateFrom === "string" ? savedFilters.dateFrom : defaultDateRange.from;
        const nextDateTo = typeof savedFilters.dateTo === "string" ? savedFilters.dateTo : defaultDateRange.to;
        const normalizedDateFrom = nextDateFrom || defaultDateRange.from;
        const normalizedDateTo = nextDateTo || defaultDateRange.to;
        setDateFrom(normalizedDateFrom);
        setDateTo(
          normalizedDateTo && normalizedDateFrom && normalizedDateTo < normalizedDateFrom
            ? normalizedDateFrom
            : normalizedDateTo
        );

        if (Array.isArray(savedFilters.activeAssets)) {
          if (savedFilters.activeAssets.length === 0) {
            setActiveAssets([]);
          } else {
            const nextAssets = savedFilters.activeAssets.filter((asset) => availableAssets.includes(asset));
            setActiveAssets(nextAssets.length ? nextAssets : availableAssets);
          }
        } else {
          setActiveAssets(availableAssets);
        }

        if (Array.isArray(savedFilters.activeStrategyTypes)) {
          if (savedFilters.activeStrategyTypes.length === 0) {
            setActiveStrategyTypes([]);
          } else {
            const nextTypes = savedFilters.activeStrategyTypes.filter((strategyType) =>
              availableStrategyTypes.includes(strategyType)
            );
            setActiveStrategyTypes(nextTypes.length ? nextTypes : availableStrategyTypes);
          }
        } else {
          setActiveStrategyTypes(availableStrategyTypes);
        }

        if (Array.isArray(savedFilters.activeBiasTags)) {
          if (savedFilters.activeBiasTags.length === 0) {
            setActiveBiasTags([]);
          } else {
            const nextTags = savedFilters.activeBiasTags.filter((marketBias) => availableBiasTags.includes(marketBias));
            setActiveBiasTags(nextTags.length ? nextTags : availableBiasTags);
          }
        } else {
          setActiveBiasTags(availableBiasTags);
        }

        setShowSyntheticChain(savedFilters.showSyntheticChain === true);
        setShowSeedData(savedFilters.showSeedData === true);

        const savedQuoteSizeThreshold = Number(savedFilters.targetOptionQuoteSizeThreshold);
        setTargetOptionQuoteSizeThreshold(
          Number.isFinite(savedQuoteSizeThreshold) && quoteSizeThresholdOptions.includes(savedQuoteSizeThreshold)
            ? savedQuoteSizeThreshold
            : defaultQuoteSizeThreshold
        );

        setMaxProfitMin(typeof savedFilters.maxProfitMin === "string" ? savedFilters.maxProfitMin : "");
        setMaxProfitMax(typeof savedFilters.maxProfitMax === "string" ? savedFilters.maxProfitMax : "");
        setMaxLossMin(typeof savedFilters.maxLossMin === "string" ? savedFilters.maxLossMin : DEFAULT_MAX_LOSS_FLOOR);
        setMaxLossMax(typeof savedFilters.maxLossMax === "string" ? savedFilters.maxLossMax : "");
        setBidAskSpreadMin(typeof savedFilters.bidAskSpreadMin === "string" ? savedFilters.bidAskSpreadMin : "");
        setBidAskSpreadMax(typeof savedFilters.bidAskSpreadMax === "string" ? savedFilters.bidAskSpreadMax : "");
        setExpectedMoveMin(typeof savedFilters.expectedMoveMin === "string" ? savedFilters.expectedMoveMin : "-20");
        setExpectedMoveMax(typeof savedFilters.expectedMoveMax === "string" ? savedFilters.expectedMoveMax : "20");
        setNormalizedOptionVolumeMin(
          typeof savedFilters.normalizedOptionVolumeMin === "string" ? savedFilters.normalizedOptionVolumeMin : ""
        );
        setNormalizedOptionVolumeMax(
          typeof savedFilters.normalizedOptionVolumeMax === "string" ? savedFilters.normalizedOptionVolumeMax : ""
        );
        setMidMinusTheoMin(typeof savedFilters.midMinusTheoMin === "string" ? savedFilters.midMinusTheoMin : "");
        setMidMinusTheoMax(typeof savedFilters.midMinusTheoMax === "string" ? savedFilters.midMinusTheoMax : "");
        if (Array.isArray(savedFilters.visibleColumnKeys)) {
          const nextVisibleColumnKeys = columns
            .map((column) => column.key)
            .filter((key) => savedFilters.visibleColumnKeys.includes(key));
          setVisibleColumnKeys(
            nextVisibleColumnKeys.length
              ? nextVisibleColumnKeys
              : getDefaultVisibleFinderColumnKeys(matchesFinderCompactViewport())
          );
        } else {
          setVisibleColumnKeys(getDefaultVisibleFinderColumnKeys(matchesFinderCompactViewport()));
        }
      } else {
        setDateFrom(defaultDateRange.from);
        setDateTo(defaultDateRange.to);
        setActiveAssets(availableAssets);
        setActiveStrategyTypes(availableStrategyTypes);
        setActiveBiasTags(availableBiasTags);
        setShowSyntheticChain(false);
        setShowSeedData(false);
        setTargetOptionQuoteSizeThreshold(defaultQuoteSizeThreshold);
        setMaxProfitMin("");
        setMaxProfitMax("");
        setMaxLossMin(DEFAULT_MAX_LOSS_FLOOR);
        setMaxLossMax("");
        setBidAskSpreadMin("");
        setBidAskSpreadMax("");
        setExpectedMoveMin("-20");
        setExpectedMoveMax("20");
        setNormalizedOptionVolumeMin("");
        setNormalizedOptionVolumeMax("");
        setMidMinusTheoMin("");
        setMidMinusTheoMax("");
        setVisibleColumnKeys(getDefaultVisibleFinderColumnKeys(matchesFinderCompactViewport()));
      }
      hasHydratedFiltersRef.current = true;
      return;
    }

    setActiveAssets((current) => {
      if (current.length === 0) {
        return current;
      }

      const next = current.filter((asset) => availableAssets.includes(asset));
      if (next.length === current.length && next.every((asset, index) => asset === current[index])) {
        return current;
      }

      return next.length ? next : availableAssets;
    });
    setActiveStrategyTypes((current) => {
      if (current.length === 0) {
        return current;
      }

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
      if (current.length === 0) {
        return current;
      }

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

  useEffect(() => {
    return () => {
      if (saveFiltersFeedbackTimeoutRef.current) {
        window.clearTimeout(saveFiltersFeedbackTimeoutRef.current);
      }
    };
  }, []);

  const baseFilteredRows = useMemo(
    () =>
      rows.filter((row) => {
        const withinFrom = !dateFrom || row.expiration >= dateFrom;
        const withinTo = !dateTo || row.expiration <= dateTo;
        const assetMatch = activeAssets.includes(row.assetLabel);
        const strategyMatch = activeStrategyTypes.includes(row.strategyType);
        const biasMatch = activeBiasTags.includes(row.marketBias ?? "Neutral");
        const numericTargetOptionQuoteSize = Number(row.targetOptionQuoteSize);
        const numericMaxProfit = Number(row.maxProfit);
        const numericMaxLoss = Number(row.maxLoss);
        const numericBidAskSpread = row.bidAskSpread == null ? null : Number(row.bidAskSpread);
        const numericNormalizedOptionVolume =
          row.normalizedOptionVolume == null ? null : Number(row.normalizedOptionVolume);
        const numericMidMinusTheo = row.midMinusTheo == null ? null : Number(row.midMinusTheo);
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
        const bidAskSpreadMatch =
          (bidAskSpreadMinThreshold == null ||
            (Number.isFinite(numericBidAskSpread) && numericBidAskSpread >= bidAskSpreadMinThreshold)) &&
          (bidAskSpreadMaxThreshold == null ||
            (Number.isFinite(numericBidAskSpread) && numericBidAskSpread <= bidAskSpreadMaxThreshold));
        const normalizedOptionVolumeMatch =
          (normalizedOptionVolumeMinThreshold == null ||
            (Number.isFinite(numericNormalizedOptionVolume) &&
              numericNormalizedOptionVolume >= normalizedOptionVolumeMinThreshold)) &&
          (normalizedOptionVolumeMaxThreshold == null ||
            (Number.isFinite(numericNormalizedOptionVolume) &&
              numericNormalizedOptionVolume <= normalizedOptionVolumeMaxThreshold));
        const midMinusTheoMatch =
          (midMinusTheoMinThreshold == null ||
            (Number.isFinite(numericMidMinusTheo) && numericMidMinusTheo >= midMinusTheoMinThreshold)) &&
          (midMinusTheoMaxThreshold == null ||
            (Number.isFinite(numericMidMinusTheo) && numericMidMinusTheo <= midMinusTheoMaxThreshold));
        const expectedMovePercent = calculateExpectedMovePercent(row);
        const expectedMoveMatch =
          (expectedMoveMinThreshold == null ||
            (Number.isFinite(expectedMovePercent) && expectedMovePercent >= expectedMoveMinThreshold)) &&
          (expectedMoveMaxThreshold == null ||
            (Number.isFinite(expectedMovePercent) && expectedMovePercent <= expectedMoveMaxThreshold));

        return (
          withinFrom &&
          withinTo &&
          assetMatch &&
          strategyMatch &&
          biasMatch &&
          quoteSizeMatch &&
          expectedMoveMatch &&
          bidAskSpreadMatch &&
          normalizedOptionVolumeMatch &&
          maxProfitMatch &&
          maxLossMatch &&
          midMinusTheoMatch
        );
      }),
    [
      activeAssets,
      activeBiasTags,
      activeStrategyTypes,
      bidAskSpreadMaxThreshold,
      bidAskSpreadMinThreshold,
      dateFrom,
      dateTo,
      expectedMoveMaxThreshold,
      expectedMoveMinThreshold,
      maxLossThreshold,
      maxProfitThreshold,
      midMinusTheoMaxThreshold,
      midMinusTheoMinThreshold,
      minLossThreshold,
      minProfitThreshold,
      normalizedOptionVolumeMaxThreshold,
      normalizedOptionVolumeMinThreshold,
      quoteSizeDataAvailable,
      rows,
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

  useEffect(() => {
    if (hasAutoRevealedHiddenDataRef.current) {
      return;
    }

    if (filteredRows.length > 0 || baseFilteredRows.length === 0) {
      return;
    }

    let didReveal = false;

    if (!showSyntheticChain && syntheticHiddenCount > 0) {
      setShowSyntheticChain(true);
      didReveal = true;
    }

    if (!showSeedData && seedHiddenCount > 0) {
      setShowSeedData(true);
      didReveal = true;
    }

    if (didReveal) {
      hasAutoRevealedHiddenDataRef.current = true;
    }
  }, [
    baseFilteredRows.length,
    filteredRows.length,
    seedHiddenCount,
    showSeedData,
    showSyntheticChain,
    syntheticHiddenCount
  ]);

  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((left, right) => {
        for (const sortDescriptor of sortState) {
          if (!sortDescriptor?.key) {
            continue;
          }

          const direction = sortDescriptor.direction === "asc" ? "asc" : "desc";
          const comparedValue = compareValues(left[sortDescriptor.key], right[sortDescriptor.key], direction);
          if (comparedValue !== 0) {
            return comparedValue;
          }
        }

        return compareValues(left.id ?? "", right.id ?? "", "asc");
      }),
    [filteredRows, sortState]
  );
  const visibleColumns = useMemo(() => {
    const orderedColumns = columns.filter((column) => visibleColumnKeys.includes(column.key));
    return orderedColumns.length ? orderedColumns : columns.filter((column) => column.key === "expiration");
  }, [visibleColumnKeys]);
  const visibleFinderColumnKeys = useMemo(() => visibleColumns.map((column) => column.key), [visibleColumns]);
  const finderGridTemplateColumns = useMemo(
    () => visibleColumns.map((column) => column.width ?? "minmax(100px, 1fr)").join(" "),
    [visibleColumns]
  );
  const selectedRowSummary = useMemo(
    () => sortedRows.find((row) => row.id === selectedRowId) ?? null,
    [selectedRowId, sortedRows]
  );
  const selectedRow = selectedRowSummary ? finderRowDetails[selectedRowSummary.id] ?? null : null;
  const setupWatchlistItems = Array.isArray(setupWatchlist) ? setupWatchlist : [];
  const selectedSetupWatchlistId = selectedRow ? `finder:${selectedRow.id}` : "";
  const selectedSetupWatchlistEntry = selectedSetupWatchlistId
    ? setupWatchlistItems.find((entry) => entry.id === selectedSetupWatchlistId) ?? null
    : null;
  const isSelectedInSetupWatchlist = Boolean(selectedSetupWatchlistEntry);
  const canMutateSetupWatchlist =
    typeof onUpsertSetupWatchlistItem === "function" && typeof onDeleteSetupWatchlistItem === "function";
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
  const marketTimerContext = useMemo(() => {
    const row = selectedRow ?? selectedRowSummary;

    if (!row) {
      return null;
    }

    const optionExpiries = [
      row.optionExpiry,
      ...((selectedRow?.legs ?? [])
        .filter((leg) => leg.kind === "option")
        .map((leg) => leg.expiry ?? leg.expiration))
    ];

    return createMarketTimerContext({
      source: "strategy-finder",
      label: row.assetLabel,
      optionSymbol: row.marketContext?.proxySymbol ?? "",
      underlyingSymbol: row.marketContext?.underlyingSymbol ?? "",
      referenceSymbol: row.optionReference ?? "",
      optionExpiries
    });
  }, [selectedRow, selectedRowSummary]);

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
    const desiredRowId = String(autoOpenRowId ?? "").trim();
    if (!desiredRowId) {
      return;
    }

    const row = rows.find((candidate) => candidate.id === desiredRowId) ?? rawRows.find((candidate) => candidate.id === desiredRowId) ?? null;
    if (row?.usesSyntheticChain === true) {
      setShowSyntheticChain(true);
    }

    if (String(row?.polymarketSource ?? "").toLowerCase() === "seed") {
      setShowSeedData(true);
    }

    setSelectedRowId(desiredRowId);
    setDetailOpen(true);
    setDetailCollapsed(false);

    if (typeof onAutoOpenRowHandled === "function") {
      onAutoOpenRowHandled();
    }
  }, [autoOpenRowId, onAutoOpenRowHandled, rawRows, rows]);

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

        setFinderRowDetails((current) =>
          writeBoundedCacheRecord(current, rowId, payload?.row ?? null, MAX_FINDER_DETAIL_CACHE_ENTRIES)
        );
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
    if (!detailOpen || detailCollapsed || !selectedRowSummary?.id) {
      setLiveTheoPrice(null);
      liveTheoRowIdRef.current = null;
      return;
    }

    const rowId = selectedRowSummary.id;
    if (liveTheoRowIdRef.current !== rowId) {
      liveTheoRowIdRef.current = rowId;
      setLiveTheoPrice(null);
    }
    let cancelled = false;
    let controller = null;
    let inFlight = false;

    async function refreshLiveTheoPrice() {
      if (inFlight) {
        return;
      }

      inFlight = true;
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await fetch(`/api/strategies/finder/${encodeURIComponent(rowId)}/theo`, {
          signal: controller.signal,
          cache: "no-store"
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || "Unable to load live theo price");
        }

        const nextTheoPrice = Number(payload?.theoPrice ?? NaN);

        if (!cancelled) {
          setLiveTheoPrice(Number.isFinite(nextTheoPrice) ? nextTheoPrice : null);
        }
      } catch (_error) {
        // Keep last live theo visible if the lightweight poll fails.
      } finally {
        inFlight = false;
      }
    }

    void refreshLiveTheoPrice();
    const interval = window.setInterval(() => {
      void refreshLiveTheoPrice();
    }, 15_000);

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [detailCollapsed, detailOpen, selectedRowSummary?.id]);

  useEffect(() => {
    if (!selectedRow) {
      return;
    }

    const defaultCloseDate = selectedRow.strategyCloseDate ?? selectedRow.expiration;
    const baseVolatility =
      (selectedRow.legs.find((leg) => leg.kind === "option")?.impliedVolatility ?? 0.24) * 100;
    setControls({
      valuationDate: defaultCloseDate,
      underlyingPrice:
        selectedRow.payoffCurve[Math.round(selectedRow.payoffCurve.length * 0.6)]?.spot ??
        selectedRow.quickOverview.underlyingPrice,
      impliedVolatility:
        baseVolatility,
      ivPut: baseVolatility * 1.2,
      ivCall: baseVolatility * 0.9,
      polymarketYesPrice: "",
      manualOptionLegs: [],
      removedLegIds: [],
      legConfigs: Object.fromEntries(
        selectedRow.legs
          .filter((leg) => leg.kind === "option" || leg.kind === "binary")
          .map((leg) => {
            if (leg.kind === "binary") {
              return [
                leg.id,
                {
                  action: leg.action,
                  outcome: leg.outcome
                }
              ];
            }

            return [
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
                volume: leg.volume != null ? Number(leg.volume) : null,
                openInterest: leg.openInterest != null ? Number(leg.openInterest) : null,
                contractSymbol: leg.contractSymbol ?? "",
                impliedVolatility: Number(leg.impliedVolatility ?? 0) || 0.24,
                quoteSource: leg.quoteSource ?? "seed",
                isLive: leg.isLive === true,
                hasRealBidAsk: leg.hasRealBidAsk === true
              }
            ];
          })
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
    setActiveLegId("");
    setChainShowAll(false);
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

  function toggleSort(columnKey, options = {}) {
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

      const nextSortState = currentSortState.length >= MAX_SORT_PRIORITIES
        ? currentSortState.slice(0, MAX_SORT_PRIORITIES - 1)
        : currentSortState;

      return [...nextSortState, { key: columnKey, direction: "desc" }];
    });
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

  function toggleVisibleColumn(columnKey) {
    setVisibleColumnKeys((current) => {
      if (current.includes(columnKey)) {
        if (current.length <= 1) {
          return current;
        }

        return current.filter((key) => key !== columnKey);
      }

      return columns.map((column) => column.key).filter((key) => key === columnKey || current.includes(key));
    });
  }

  function resetVisibleColumns() {
    setVisibleColumnKeys(columns.map((column) => column.key));
  }

  function applyCompactVisibleColumns() {
    setVisibleColumnKeys(getDefaultVisibleFinderColumnKeys(true));
  }

  function renderFinderCell(row, columnKey) {
    switch (columnKey) {
      case "expiration":
        return <span>{row.expiration}</span>;
      case "days":
        return <span>{row.days}</span>;
      case "assetLabel":
        return (
          <span className="finder-asset-cell">
            <span>{row.assetLabel}</span>
            {String(row.polymarketSource ?? "").toLowerCase() === "seed" ? (
              <span className="source-pill source-pill--seed">Seed</span>
            ) : null}
          </span>
        );
      case "strategyType":
        return <span>{row.strategyType}</span>;
      case "marketBias":
        return (
          <span>
            <span className={`bias-pill bias-pill--${row.marketBiasTone ?? "neutral"}`}>
              {row.marketBias ?? "Neutral"}
            </span>
          </span>
        );
      case "formula":
        return (
          <span className="formula-cell">
            {row.formula.map((item) => (
              <span key={`${row.id}-${item.label}`} className={`formula-pill formula-pill--${item.tone}`}>
                {item.label}
              </span>
            ))}
          </span>
        );
      case "polymarketPrice":
        return <span>{`${row.polymarketPriceSide === "NO" ? "N" : "Y"} ${formatNumber(row.polymarketPrice, 2)}`}</span>;
      case "normalizedOptionVolume":
        return <span>{formatCompactCount(row.normalizedOptionVolume)}</span>;
      case "midMinusTheo":
        return <span className={getFinderMidMinusTheoTone(row)}>{formatNumber(row.midMinusTheo, 2)}</span>;
      case "polymarketVolume":
        return <span>{formatCompactUsd(row.polymarketVolume)}</span>;
      case "maxProfit":
        return (
          <span className="finder-metric-cell">
            <span
              className={row.maxProfitUnbounded === true ? "" : Number(row.maxProfit) >= 0 ? "positive" : "negative"}
            >
              {formatExtrema(row.maxProfit, {
                unbounded: row.maxProfitUnbounded === true,
                kind: "profit"
              })}
            </span>
            {row.maxProfitRangeTag ? <span className="finder-range-tag">{row.maxProfitRangeTag}</span> : null}
          </span>
        );
      case "maxLoss":
        return (
          <span className="finder-metric-cell">
            <span
              className={row.maxLossUnbounded === true ? "" : Number(row.maxLoss) >= 0 ? "positive" : "negative"}
            >
              {formatExtrema(row.maxLoss, {
                unbounded: row.maxLossUnbounded === true,
                kind: "loss"
              })}
            </span>
            {row.maxLossRangeTag ? <span className="finder-range-tag">{row.maxLossRangeTag}</span> : null}
          </span>
        );
      case "rewardRisk":
        return <span>{formatNumber(row.rewardRisk, 2)}</span>;
      case "breakevens":
        return <span>{row.breakevens.join("/") || "n/a"}</span>;
      case "theoPrice":
        return <span>{formatNumber(row.theoPrice, 2)}</span>;
      case "bid":
        return <span>{formatNumber(row.bid, 2)}</span>;
      case "ask":
        return <span>{formatNumber(row.ask, 2)}</span>;
      case "bidAskSpread":
        return <span className="negative">{row.bidAskSpread != null ? `${formatNumber(row.bidAskSpread, 2)}%` : ""}</span>;
      case "expPayoff":
        return <span>{formatCurrency(row.expPayoff)}</span>;
      default:
        return <span />;
    }
  }

  function saveFilters() {
    const saved = persistSavedFilters(STRATEGY_FINDER_FILTERS_STORAGE_KEY, {
      dateFrom,
      dateTo,
      activeAssets,
      activeStrategyTypes,
      activeBiasTags,
      showSyntheticChain,
      showSeedData,
      targetOptionQuoteSizeThreshold,
      maxProfitMin,
      maxProfitMax,
      maxLossMin,
      maxLossMax,
      bidAskSpreadMin,
      bidAskSpreadMax,
      expectedMoveMin,
      expectedMoveMax,
      normalizedOptionVolumeMin,
      normalizedOptionVolumeMax,
      midMinusTheoMin,
      midMinusTheoMax,
      visibleColumnKeys
    });

    setSaveFiltersState(saved ? "saved" : "error");
    if (saveFiltersFeedbackTimeoutRef.current) {
      window.clearTimeout(saveFiltersFeedbackTimeoutRef.current);
    }
    saveFiltersFeedbackTimeoutRef.current = window.setTimeout(() => {
      setSaveFiltersState("idle");
      saveFiltersFeedbackTimeoutRef.current = null;
    }, 2200);
  }

  function resetFilters() {
    setDateFrom(defaultDateRange.from);
    setDateTo(defaultDateRange.to);
    setActiveAssets(availableAssets);
    setActiveStrategyTypes(availableStrategyTypes);
    setActiveBiasTags(availableBiasTags);
    setShowSyntheticChain(false);
    setShowSeedData(false);
    setTargetOptionQuoteSizeThreshold(defaultQuoteSizeThreshold);
    setMaxProfitMin("");
    setMaxProfitMax("");
    setMaxLossMin(DEFAULT_MAX_LOSS_FLOOR);
    setMaxLossMax("");
    setBidAskSpreadMin("");
    setBidAskSpreadMax("");
    setExpectedMoveMin("-20");
    setExpectedMoveMax("20");
    setNormalizedOptionVolumeMin("");
    setNormalizedOptionVolumeMax("");
    setMidMinusTheoMin("");
    setMidMinusTheoMax("");
    setVisibleColumnKeys(getDefaultVisibleFinderColumnKeys(isCompactFinderViewport));
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

  const removedLegIds = new Set((controls?.removedLegIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
  const manualOptionLegs = controls?.manualOptionLegs ?? [];
  const optionLegs = [
    ...((selectedRow?.legs ?? []).filter((leg) => leg.kind === "option") ?? []),
    ...(manualOptionLegs ?? [])
  ].filter((leg) => leg?.kind === "option" && !removedLegIds.has(String(leg?.id ?? "")));
  const polymarketSeedLegs = (selectedRow?.legs ?? []).filter((leg) => leg.kind === "binary");
  const polymarketLegs = polymarketSeedLegs.filter((leg) => !removedLegIds.has(String(leg?.id ?? "")));
  const removedPolymarketLeg = polymarketSeedLegs.find((leg) => removedLegIds.has(String(leg?.id ?? ""))) ?? null;
  const optionRootSymbol =
    selectedRow?.marketContext?.proxySymbol ?? optionLegs[0]?.label?.split(" ")?.[0] ?? "";
  const polymarketResolutionDate =
    selectedRow?.polymarketResolutionDate ?? selectedRow?.expiration ?? "";
  const rawUnderlyingPrice = Number(
    controls?.underlyingPrice ?? selectedRow?.quickOverview?.underlyingPrice ?? 0
  );
  const impliedVolatility = Number(controls?.impliedVolatility ?? 24) / 100;
  const putVolatility = Number(controls?.ivPut ?? Number(controls?.impliedVolatility ?? 24) * 1.2) / 100;
  const callVolatility = Number(controls?.ivCall ?? Number(controls?.impliedVolatility ?? 24) * 0.9) / 100;
  const riskFreeRate = 0.0425;

  useEffect(() => {
    setPaperTradeDate(currentDate || new Date().toISOString().slice(0, 10));
    setPaperOrderState(null);
    setPaperOrderSaving(false);
    setOptionPriceRefreshing(false);
    setOptionPriceRefreshState(null);
  }, [currentDate, selectedRow?.id]);

  function handleStrategyDirectionChange(nextDirection) {
    const normalizedNextDirection = normalizeStrategyDirection(nextDirection);
    const normalizedCurrentDirection = normalizeStrategyDirection(strategyDirection);
    if (normalizedNextDirection === normalizedCurrentDirection) {
      return;
    }

    setStrategyDirection(normalizedNextDirection);

    setControls((current) => {
      if (!current) {
        return current;
      }

      const currentLegConfigs = current.legConfigs ?? {};
      const nextLegConfigs = { ...currentLegConfigs };
      Object.entries(currentLegConfigs).forEach(([legId, config]) => {
        if (!config || typeof config !== "object") {
          return;
        }

        nextLegConfigs[legId] = {
          ...config,
          action: invertPositionAction(config.action)
        };
      });

      return {
        ...current,
        legConfigs: nextLegConfigs
      };
    });
  }

  const liveOptionQuoteSpot = Number(
    selectedRow?.marketContext?.currentProxySpot ?? selectedRow?.quickOverview?.underlyingPrice ?? 0
  );
  const optionLegQuoteSignature = optionLegs
    .map((leg) => {
      const config = controls?.legConfigs?.[leg.id] ?? {};
      const contractSymbol = String(config.contractSymbol ?? leg.contractSymbol ?? "").trim();
      const expiry = String(config.expiry ?? leg.expiry ?? "").trim();
      const optionType = String(config.optionType ?? leg.optionType ?? "").trim();
      const strike = config.strike ?? leg.strike;
      return `${leg.id}:${contractSymbol}:${expiry}:${optionType}:${strike}:${config.action ?? leg.action}:${config.quantity ?? leg.quantity}`;
    })
    .join("|");

  useEffect(() => {
    if (!detailOpen || detailCollapsed || !selectedRow || !optionRootSymbol) {
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
      setLiveOptionLegQuotesError("");
      liveOptionQuoteRowIdRef.current = null;
      return;
    }

    const rowId = selectedRow.id ?? null;
    if (rowId && liveOptionQuoteRowIdRef.current !== rowId) {
      liveOptionQuoteRowIdRef.current = rowId;
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
      setLiveOptionLegQuotesError("");
    }

    const requestedLegs = optionLegs
      .map((leg) => {
        const config = controls?.legConfigs?.[leg.id] ?? {};
        const strike = Number(config.strike ?? leg.strike ?? NaN);
        const expiry = String(config.expiry ?? leg.expiry ?? "").trim();
        const optionType = String(config.optionType ?? leg.optionType ?? "call").trim().toLowerCase() === "put"
          ? "put"
          : "call";
        const action = String(config.action ?? leg.action ?? "LONG").trim().toUpperCase() === "SHORT"
          ? "SHORT"
          : "LONG";
        const contractSymbol = String(config.contractSymbol ?? leg.contractSymbol ?? "").trim();

        return {
          id: leg.id,
          strike,
          expiry,
          optionType,
          action,
          contractSymbol
        };
      })
      .filter((leg) => leg.expiry && Number.isFinite(leg.strike) && leg.strike > 0);

    if (!requestedLegs.length) {
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
      setLiveOptionLegQuotesError("");
      return;
    }

    const groupLegs = new Map();
    requestedLegs.forEach((leg) => {
      const key = buildChainKey(optionRootSymbol, leg.expiry, leg.optionType);
      const current = groupLegs.get(key) ?? {
        expiration: leg.expiry,
        optionType: leg.optionType,
        strikes: []
      };
      current.strikes.push(leg.strike);
      groupLegs.set(key, current);
    });

    let cancelled = false;
    let controller = null;
    let inFlight = false;

    async function refreshLiveOptionQuotes() {
      if (inFlight) {
        return;
      }

      inFlight = true;
      controller?.abort();
      controller = new AbortController();

      try {
        const requests = [...groupLegs.entries()].map(async ([key, group]) => {
          const strikes = group.strikes.filter((value) => Number.isFinite(value) && value > 0);
          if (!strikes.length) {
            return [key, []];
          }

          const minStrike = Math.min(...strikes);
          const maxStrike = Math.max(...strikes);
          const padding = Math.max((maxStrike - minStrike) * 0.15, liveOptionQuoteSpot > 200 ? 5 : 1);
          const strikeMin = Math.max(minStrike - padding, 0.01);
          const strikeMax = Math.max(maxStrike + padding, strikeMin);
          const limit = Math.max(strikes.length * 12, 60);

          const url = `/api/options/chain?symbol=${encodeURIComponent(optionRootSymbol)}&expiration=${encodeURIComponent(
            group.expiration
          )}&optionType=${encodeURIComponent(group.optionType)}&strikeMin=${encodeURIComponent(
            strikeMin
          )}&strikeMax=${encodeURIComponent(strikeMax)}&limit=${encodeURIComponent(limit)}`;

          const response = await fetch(url, {
            signal: controller.signal,
            cache: "no-store"
          });
          const payload = await response.json().catch(() => null);

          if (!response.ok) {
            throw new Error(payload?.error || "Unable to load live option quotes");
          }

          return [key, Array.isArray(payload?.contracts) ? payload.contracts : []];
        });

        const results = await Promise.allSettled(requests);
        if (controller.signal.aborted) {
          return;
        }

        const fulfilledResults = results.filter((result) => result.status === "fulfilled");
        if (!fulfilledResults.length) {
          const firstError = results.find((result) => result.status === "rejected")?.reason;
          setLiveOptionLegQuotesError(
            firstError?.message ? String(firstError.message) : "Unable to refresh live option quotes."
          );
          return;
        }

        const contractsByGroup = new Map();
        fulfilledResults.forEach((result) => {
          if (result.status !== "fulfilled") {
            return;
          }

          const [key, contracts] = result.value ?? [];
          if (key) {
            contractsByGroup.set(key, Array.isArray(contracts) ? contracts : []);
          }
        });

        if (cancelled) {
          return;
        }

        setLiveOptionLegQuotes((current) => {
          const next = {};

          requestedLegs.forEach((leg) => {
            const key = buildChainKey(optionRootSymbol, leg.expiry, leg.optionType);
            const contracts = contractsByGroup.get(key) ?? [];
            const targetContractSymbol = String(leg.contractSymbol ?? "").trim();
            const matched =
              (targetContractSymbol
                ? contracts.find(
                    (contract) => String(contract?.contractSymbol ?? "").trim() === targetContractSymbol
                  )
                : null) ??
              contracts.find((contract) => {
                const contractStrike = Number(contract?.strike ?? NaN);
                return Number.isFinite(contractStrike) && Math.abs(contractStrike - leg.strike) < 0.01;
              }) ??
              null;

            if (matched) {
              next[leg.id] = {
                bid: matched.bid ?? null,
                ask: matched.ask ?? null,
                bidSize: matched.bidSize ?? null,
                askSize: matched.askSize ?? null,
                volume: matched.volume ?? null,
                openInterest: matched.openInterest ?? null,
                mark: matched.mark ?? null,
                sourceLabel: matched.sourceLabel ?? matched.source ?? null,
                isLive: matched.isLive === true,
                hasRealBidAsk: matched.hasRealBidAsk === true
              };
              return;
            }

            if (current?.[leg.id]) {
              next[leg.id] = current[leg.id];
            }
          });

          return next;
        });
        setLiveOptionLegQuotesError("");
        setLiveOptionLegQuotesUpdatedAt(new Date().toISOString());
      } catch (_error) {
        // Keep the last known live quotes visible if the lightweight poll fails.
      } finally {
        inFlight = false;
      }
    }

    void refreshLiveOptionQuotes();
    const interval = window.setInterval(() => {
      void refreshLiveOptionQuotes();
    }, LIVE_OPTION_QUOTES_POLL_MS);

    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(interval);
    };
  }, [detailCollapsed, detailOpen, liveOptionQuoteSpot, optionLegQuoteSignature, optionRootSymbol, selectedRow?.id]);

  const datePresets = buildDatePresets(currentDate || finder?.filters?.dateRange?.from || "");
  const activeDatePreset =
    datePresets.find((preset) => preset.from === dateFrom && preset.to === dateTo) ?? null;
  const dateSummary =
    activeDatePreset?.label ??
    (dateFrom && dateTo ? `${formatShortDate(dateFrom)} - ${formatShortDate(dateTo)}` : "Prediction period");
  const productSummary = buildSelectionSummary(activeAssets, availableAssets, "Products");
  const strategySummary = buildSelectionSummary(activeStrategyTypes, availableStrategyTypes, "Strategy types");
  const biasSummary = buildSelectionSummary(activeBiasTags, availableBiasTags, "Tags");
  const quoteSizeSummary = buildQuoteSizeFilterSummary(targetOptionQuoteSizeThreshold, quoteSizeDataAvailable);
  const hiddenDataLabels = [
    !showSyntheticChain && syntheticHiddenCount ? `synthetic chain (${syntheticHiddenCount})` : null,
    !showSeedData && seedHiddenCount ? `seed data (${seedHiddenCount})` : null
  ].filter(Boolean);
  const emptyStateMessage = hiddenDataLabels.length
    ? `No matched hedge combinations for the selected filters. ${hiddenDataLabels.join(" and ")} are hidden by default.`
    : "No matched hedge combinations for the selected products, date range, strategy types, and bid/ask size filter.";
  const activeBidAskSpreadPreset =
    BID_ASK_SPREAD_PRESETS.find(
      (preset) =>
        (preset.min ?? null) === bidAskSpreadMinThreshold &&
        (preset.max ?? null) === bidAskSpreadMaxThreshold
    ) ?? null;
  const bidAskSpreadSummary =
    activeBidAskSpreadPreset?.label ??
    buildMetricRangeSummary({
      label: "Bid-ask spread",
      min: bidAskSpreadMinThreshold,
      max: bidAskSpreadMaxThreshold,
      formatValue: (value) => formatFilterPercent(value, 1)
    });
  const activeExpectedMovePreset =
    EXPECTED_PRICE_RANGE_PRESETS.find(
      (preset) => preset.min === expectedMoveMinThreshold && preset.max === expectedMoveMaxThreshold
    ) ?? null;
  const expectedMoveSummary =
    activeExpectedMovePreset?.label ??
    buildMetricRangeSummary({
      label: "Expected move",
      min: expectedMoveMinThreshold,
      max: expectedMoveMaxThreshold,
      formatValue: (value) => formatSignedPercentLabel(value, 0)
    });
  const normalizedOptionVolumeSummary = buildMetricRangeSummary({
    label: "Opt vol (norm)",
    min: normalizedOptionVolumeMinThreshold,
    max: normalizedOptionVolumeMaxThreshold,
    formatValue: formatFilterCount
  });
  const maxLossSummary = buildMetricRangeSummary({
    label: "Max loss",
    min: minLossThreshold,
    max: maxLossThreshold,
    formatValue: formatFilterThreshold
  });
  const midMinusTheoSummary = buildMetricRangeSummary({
    label: "Avg B/A - Theo",
    min: midMinusTheoMinThreshold,
    max: midMinusTheoMaxThreshold,
    formatValue: (value) => formatFilterNumber(value, 2)
  });
  const maxProfitSummary = buildMetricRangeSummary({
    label: "Max profit",
    min: minProfitThreshold,
    max: maxProfitThreshold,
    formatValue: formatFilterThreshold
  });
  const currentProxySpot = Number(
    selectedRow?.marketContext?.currentProxySpot ?? selectedRow?.quickOverview?.underlyingPrice ?? 0
  );
  const currentUnderlyingSpot = Number(selectedRow?.marketContext?.currentUnderlyingSpot ?? 0);
  const converterRatio =
    Number(selectedRow?.marketContext?.conversionRatio ?? 0) ||
    (currentUnderlyingSpot > 0 && currentProxySpot > 0 ? currentProxySpot / currentUnderlyingSpot : 0);
  const strategyTypeLabel = formatStrategyTypeForDirection(selectedRow?.strategyType, strategyDirection);
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
    const volume = config.volume ?? leg.volume ?? null;
    const openInterest = config.openInterest ?? leg.openInterest ?? null;

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
      volume: volume != null ? Number(volume) : null,
      openInterest: openInterest != null ? Number(openInterest) : null,
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
  const microstructureContracts = useMemo(
    () =>
      effectiveOptionLegs
        .filter((leg) => String(leg?.contractSymbol ?? "").trim())
        .map((leg, index) => ({
          contractSymbol: String(leg.contractSymbol).trim(),
          label:
            leg.referenceLabel ||
            `${selectedRow?.assetLabel || selectedRow?.marketContext?.proxySymbol || "Option"} ${index + 1} · ${formatNumber(
              leg.strike,
              1
            )}${leg.optionType === "put" ? "P" : "C"} · ${leg.expiry || "n/a"}`
        })),
    [effectiveOptionLegs, selectedRow?.assetLabel, selectedRow?.marketContext?.proxySymbol]
  );
  const strategyCloseDate =
    minIsoDate([polymarketResolutionDate, ...effectiveOptionLegs.map((leg) => leg.expiry)]) ||
    selectedRow?.strategyCloseDate ||
    selectedRow?.expiration ||
    polymarketResolutionDate;
  const activeOptionLeg =
    effectiveOptionLegs.find((leg) => leg.id === activeLegId) ?? effectiveOptionLegs[effectiveOptionLegs.length - 1] ?? null;
  const activeChainExpiration = activeOptionLeg?.expiry ?? strategyCloseDate ?? "";
  const activeExpiryTabs = useMemo(
    () => {
      if (!activeChainExpiration) {
        return [];
      }

      const tabs = buildWeeklyExpiryTabs(activeChainExpiration);
      const minIso = currentDate || new Date().toISOString().slice(0, 10);
      return tabs.filter((value) => value >= minIso);
    },
    [activeChainExpiration, currentDate]
  );
  const activeCallChainKey =
    optionRootSymbol && activeChainExpiration ? buildChainKey(optionRootSymbol, activeChainExpiration, "call") : "";
  const activePutChainKey =
    optionRootSymbol && activeChainExpiration ? buildChainKey(optionRootSymbol, activeChainExpiration, "put") : "";
  const activeCallChain = activeCallChainKey ? optionChains[activeCallChainKey] ?? null : null;
  const activePutChain = activePutChainKey ? optionChains[activePutChainKey] ?? null : null;
  const activeCallChainStatus = activeCallChainKey ? optionChainStatus[activeCallChainKey] ?? null : null;
  const activePutChainStatus = activePutChainKey ? optionChainStatus[activePutChainKey] ?? null : null;
  const activeChainRows = useMemo(() => {
    const contractsByStrike = new Map();

    (activeCallChain?.contracts ?? []).forEach((contract) => {
      const strike = Number(contract?.strike ?? NaN);
      if (!Number.isFinite(strike)) {
        return;
      }

      const row = contractsByStrike.get(strike) ?? { strike, call: null, put: null };
      row.call = contract;
      contractsByStrike.set(strike, row);
    });

    (activePutChain?.contracts ?? []).forEach((contract) => {
      const strike = Number(contract?.strike ?? NaN);
      if (!Number.isFinite(strike)) {
        return;
      }

      const row = contractsByStrike.get(strike) ?? { strike, call: null, put: null };
      row.put = contract;
      contractsByStrike.set(strike, row);
    });

    const strikes = Array.from(contractsByStrike.keys()).sort((left, right) => left - right);
    if (!strikes.length) {
      return [];
    }

    const spot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
    if (chainShowAll) {
      return strikes.map((strike) => contractsByStrike.get(strike));
    }

    const strikeWindow = 30;
    const windowedStrikes =
      Number.isFinite(spot) && spot > 0
        ? [...strikes]
            .sort((left, right) => {
              const leftDistance = Math.abs(left - spot);
              const rightDistance = Math.abs(right - spot);
              return leftDistance === rightDistance ? left - right : leftDistance - rightDistance;
            })
            .slice(0, strikeWindow)
            .sort((left, right) => left - right)
        : strikes.slice(0, strikeWindow);

    return windowedStrikes.map((strike) => contractsByStrike.get(strike));
  }, [activeCallChain?.contracts, activePutChain?.contracts, chainShowAll, currentProxySpot, rawUnderlyingPrice]);
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

  const marketReferenceYesPrice = (() => {
    const polymarketPriceSide = String(selectedRow?.polymarketPriceSide ?? "").trim().toUpperCase();
    const rowPrice = Number(selectedRow?.polymarketPrice ?? Number.NaN);

    if (Number.isFinite(rowPrice)) {
      const inferredYesPrice = polymarketPriceSide === "NO" ? 1 - rowPrice : rowPrice;
      return clampProbability(inferredYesPrice);
    }

    const fallbackLeg = polymarketLegs[0] ?? null;
    const fallbackOutcome = String(fallbackLeg?.outcome ?? "").trim().toUpperCase();
    const fallbackPrice = Number(fallbackLeg?.entryPrice ?? Number.NaN);

    if (Number.isFinite(fallbackPrice)) {
      const inferredYesPrice = fallbackOutcome === "NO" ? 1 - fallbackPrice : fallbackPrice;
      return clampProbability(inferredYesPrice);
    }

    return clampProbability(0.5);
  })();
  const marketReferenceNoPrice = clampProbability(1 - marketReferenceYesPrice);
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
  const polymarketYesPriceInput = String(controls?.polymarketYesPrice ?? "").trim();
  const polymarketYesPriceManual = polymarketYesPriceInput ? Number(polymarketYesPriceInput) : null;
  const polymarketYesPrice = clamp(
    Number.isFinite(polymarketYesPriceManual) ? polymarketYesPriceManual : estimatedYesPrice,
    0,
    1
  );
  const repricedPolymarketLegs = polymarketLegs.map((leg) => {
    const editedLeg = controls?.legEdits?.[leg.id] ?? {};
    const config = controls?.legConfigs?.[leg.id] ?? {};
    const action = normalizeStrategyDirection(config.action ?? leg.action);
    const outcome = String(config.outcome ?? leg.outcome).trim().toUpperCase() === "NO" ? "NO" : "YES";
    const fallbackEntryPrice = outcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice;
    const entryPrice = Number(editedLeg.entryPrice ?? fallbackEntryPrice);
    const quantity = normalizeQuantityInput(editedLeg.quantity ?? leg.quantity, normalizeQuantityInput(leg.quantity, 0));
    const modelPrice = binaryPriceFromYes(outcome, polymarketYesPrice);
    const pnl = binaryPnL({
      action,
      entryPrice,
      markPrice: modelPrice,
      quantity
    });
    const markValue = (action === "LONG" ? 1 : -1) * modelPrice * quantity;
    const entryValue = (action === "LONG" ? 1 : -1) * entryPrice * quantity;

    return {
      ...leg,
      action,
      outcome,
      label: `PM ${outcome}`,
      entryPrice,
      quantity,
      bid: outcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice,
      ask: outcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice,
      spread: 0,
      modelPrice,
      pnl,
      markValue,
      entryValue
    };
  });
  useEffect(() => {
    setPaperComboQuantity(1);
    setPaperComboQuantityInput("1");
    setStrategyDirection(inferStrategyDirection(selectedRowSummary?.strategyType ?? selectedRow?.strategyType));
    setFinderRowDetails((current) => retainCacheEntries(current, [selectedRowId]));
    setFinderDetailErrors((current) => retainCacheEntries(current, [selectedRowId]));
    setFinderDetailLoadingId((current) => {
      const normalizedSelectedRowId = String(selectedRowId ?? "").trim();
      return current === normalizedSelectedRowId ? current : "";
    });
    setLiveOptionLegQuotes({});
    setLiveOptionLegQuotesUpdatedAt(null);
    setLiveOptionLegQuotesError("");
    setOptionChains({});
    setOptionChainStatus({});
    setChainShowAll(false);
    setStrategyEditorOpen(false);
    setActiveLegId("");
  }, [selectedRowId]);

  function applyPaperComboQuantity(nextComboQuantity, { syncInput = true } = {}) {
    if (!repricedOptionLegs.length) {
      return;
    }

    const normalizedComboQuantity = normalizeComboQuantityInput(nextComboQuantity, paperComboQuantity);
    setPaperComboQuantity(normalizedComboQuantity);
    if (syncInput) {
      setPaperComboQuantityInput(String(normalizedComboQuantity));
    }

    const baseQuantity =
      repricedOptionLegs.reduce((current, leg) => {
        const quantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
        return quantity ? gcd(current, quantity) : current;
      }, 0) || 1;

    const ratioByLegId = new Map();
    repricedOptionLegs.forEach((leg) => {
      const quantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
      ratioByLegId.set(String(leg?.id ?? ""), quantity > 0 ? quantity / baseQuantity : 1);
    });

    setControls((current) => {
      if (!current) {
        return current;
      }

      const nextLegEdits = {
        ...(current.legEdits ?? {})
      };

      repricedOptionLegs.forEach((leg) => {
        const legId = String(leg?.id ?? "");
        if (!legId) {
          return;
        }

        const ratio = ratioByLegId.get(legId) ?? 1;
        const nextQuantity = Math.max(Math.round(ratio * normalizedComboQuantity), 1);
        nextLegEdits[legId] = {
          ...(nextLegEdits[legId] ?? {}),
          quantity: String(normalizeQuantityInput(nextQuantity, 0))
        };
      });

      return {
        ...current,
        legEdits: nextLegEdits
      };
    });
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

  function buildSetupWatchlistPayload() {
    if (!selectedRow) {
      return null;
    }

    return {
      strategyId: strategyDefinition?.id ?? "strategy-1",
      strategyName: strategyDefinition?.name ?? "Strategy",
      combinationId: selectedRow.id,
      combinationLabel: `${selectedRow.assetLabel} · ${strategyTypeLabel} · ${strategyCloseDate}`,
      assetLabel: selectedRow.assetLabel,
      strategyType: strategyTypeLabel,
      marketBias: selectedRow.marketBias,
      marketBiasTone: selectedRow.marketBiasTone,
      maxProfit: selectedRow.maxProfit,
      maxLoss: selectedRow.maxLoss,
      maxProfitUnbounded: selectedRow.maxProfitUnbounded,
      maxLossUnbounded: selectedRow.maxLossUnbounded,
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
          bid: leg.bid ?? null,
          ask: leg.ask ?? null,
          bidSize: leg.bidSize ?? null,
          askSize: leg.askSize ?? null,
          volume: leg.volume ?? null,
          openInterest: leg.openInterest ?? null,
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
          marketVolume: leg.volume ?? selectedRow.polymarketVolume ?? null,
          marketLiquidity: leg.liquidity ?? selectedRow.polymarketLiquidity ?? null,
          quoteSource: "Polymarket",
          isLive: true
        }))
      ],
      execution: {
        route: "local-paper"
      }
    };
  }

  async function handleToggleSetupWatchlist() {
    if (!selectedRow || !selectedSetupWatchlistId || !canMutateSetupWatchlist) {
      return;
    }

    if (watchlistSaving) {
      return;
    }

    setWatchlistNotice("");
    setWatchlistSaving(true);

    try {
      if (isSelectedInSetupWatchlist) {
        await onDeleteSetupWatchlistItem(selectedSetupWatchlistId);
        return;
      }

      const payload = buildSetupWatchlistPayload();
      if (!payload) {
        return;
      }

      await onUpsertSetupWatchlistItem({
        id: selectedSetupWatchlistId,
        source: "finder",
        strategyId: String(strategyDefinition?.id ?? payload.strategyId ?? "strategy-1"),
        combinationId: String(payload.combinationId ?? selectedRow.id),
        title: String(payload.combinationLabel ?? `${selectedRow.assetLabel} · ${strategyTypeLabel}`).trim(),
        payload
      });
    } catch (error) {
      setWatchlistNotice(error?.message || "Watchlist update failed");
    } finally {
      setWatchlistSaving(false);
    }
  }

  async function handleCreatePaperTrade() {
    if (!selectedRow || !onCreatePaperOrder) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      const baseOrderPayload = {
        strategyId: strategyDefinition?.id ?? "strategy-1",
        strategyName: strategyDefinition?.name ?? "Strategy",
        strategySource: "Strategy Finder",
        combinationId: selectedRow.id,
        combinationLabel: `${selectedRow.assetLabel} · ${strategyTypeLabel} · ${strategyCloseDate}`,
        assetLabel: selectedRow.assetLabel,
        strategyType: strategyTypeLabel,
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
            bid: leg.bid ?? null,
            ask: leg.ask ?? null,
            bidSize: leg.bidSize ?? null,
            askSize: leg.askSize ?? null,
            volume: leg.volume ?? null,
            openInterest: leg.openInterest ?? null,
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
            marketVolume: leg.volume ?? selectedRow.polymarketVolume ?? null,
            marketLiquidity: leg.liquidity ?? selectedRow.polymarketLiquidity ?? null,
            quoteSource: "Polymarket",
            isLive: true
          }))
        ],
        execution: {
          route: "local-paper"
        }
      };
      const heatmapSnapshot = buildScenarioHeatmapSnapshot({
        startDate: valuationMinDate,
        endDate: valuationMaxDate,
        currentPrice: currentProxySpot || underlyingPrice,
        volatility: impliedVolatility,
        ivAtm: impliedVolatility,
        ivPut: putVolatility,
        ivCall: callVolatility,
        spotLabel: proxySpotLabel,
        priceDigits: proxySpotDigits,
        secondarySpotLabel: converterRatio > 0 ? actualSpotLabel : "",
        secondaryPriceDigits: actualSpotDigits,
        getSecondarySpot: converterRatio > 0 ? (spot) => spot / converterRatio : null,
        rowCount: heatmapRowCount,
        getCellPnL: calculateHeatmapPnL,
        rangeMultiplier: heatmapRangeMultiplier
      });
      const controlsSnapshot = {
        valuationDate,
        underlyingPrice: String(underlyingPrice),
        impliedVolatility: String(
          controls?.impliedVolatility ?? Number((impliedVolatility * 100).toFixed(2))
        ),
        ivPut: String(controls?.ivPut ?? Number((putVolatility * 100).toFixed(2))),
        ivCall: String(controls?.ivCall ?? Number((callVolatility * 100).toFixed(2))),
        polymarketYesPrice: String(controls?.polymarketYesPrice ?? "")
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
      const pendingConfirmation = getPendingConfirmation(createResponse?.order);

      setPaperOrderState({
        tone: pendingConfirmation ? "warning" : "success",
        message:
          createResponse?.message ?? "Paper order saved. You can review or edit it from the paper-trading page.",
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
  const liveOptionComboQuote = (() => {
    if (!repricedOptionLegs.length) {
      return null;
    }

    const gcd = (left, right) => {
      let a = Math.abs(Math.round(Number(left) || 0));
      let b = Math.abs(Math.round(Number(right) || 0));

      while (b) {
        const next = a % b;
        a = b;
        b = next;
      }

      return a;
    };

    const lotCount = repricedOptionLegs.reduce((current, leg) => {
      const quantity = Math.max(Math.round(Number(leg.quantity ?? 0) || 0), 0);
      if (!(quantity > 0)) {
        return current;
      }
      if (current == null) {
        return quantity;
      }
      return gcd(current, quantity);
    }, null);

    if (!(lotCount > 0)) {
      return null;
    }

    let ready = true;
    let bid = 0;
    let ask = 0;

    repricedOptionLegs.forEach((leg) => {
      const quote = liveOptionLegQuotes?.[leg.id] ?? null;
      const legBid = Number(quote?.bid ?? NaN);
      const legAsk = Number(quote?.ask ?? NaN);

      if (!(legBid > 0) || !(legAsk > 0) || legAsk < legBid) {
        ready = false;
        return;
      }

      const ratio = Math.max(Number(leg.quantity ?? 0), 0) / lotCount;
      const direction = String(leg.action ?? "LONG").trim().toUpperCase() === "SHORT" ? -1 : 1;
      const isShort = direction < 0;

      bid += direction * (isShort ? legAsk : legBid) * ratio;
      ask += direction * (isShort ? legBid : legAsk) * ratio;
    });

    if (!ready) {
      return {
        ready: false,
        bid: null,
        ask: null,
        mid: null
      };
    }

    return {
      ready: true,
      bid: Number(bid.toFixed(2)),
      ask: Number(ask.toFixed(2)),
      mid: Number(((bid + ask) / 2).toFixed(2))
    };
  })();
  const displayedNetBid = liveOptionComboQuote?.ready ? liveOptionComboQuote.bid : effectiveNetBid;
  const displayedNetAsk = liveOptionComboQuote?.ready ? liveOptionComboQuote.ask : effectiveNetAsk;
  const displayedNetMark =
    liveOptionComboQuote?.ready
      ? liveOptionComboQuote.mid
      : (() => {
          const bid = Number(effectiveNetBid);
          const ask = Number(effectiveNetAsk);
          return Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : null;
        })();
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
        }) || "Polymarket",
      liquidityMeta: buildOptionLiquidityMeta(leg)
    })),
    ...repricedOptionLegs.map((leg) => ({
      ...leg,
      referenceLabel: formatOptionReferenceLabel(leg),
      referenceMeta: formatQuoteSourceLabel(leg),
      liquidityMeta: buildOptionLiquidityMeta(leg)
    }))
  ];

  async function loadOptionChain({ expiration, optionType, strikeHint = 0, limit = 30, force = false }) {
    if (!optionRootSymbol || !expiration) {
      return null;
    }

    const requestKey = buildChainKey(optionRootSymbol, expiration, optionType);
    const cached = optionChains[requestKey] ?? null;
    const cachedLimit = Number(cached?.requestedLimit ?? NaN);
    const cachedIsAll = cached && Number.isFinite(cachedLimit) && cachedLimit <= 0;
    const normalizedLimit = Number(limit ?? 30);
    const wantsAll = Number.isFinite(normalizedLimit) && normalizedLimit <= 0;
    const hasSufficientCache = cached && (!wantsAll || cachedIsAll);

    if (!force && (hasSufficientCache || optionChainStatus[requestKey]?.loading)) {
      return cached;
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
        )}&optionType=${encodeURIComponent(optionType)}&strikeHint=${encodeURIComponent(
          strikeHint
        )}&limit=${encodeURIComponent(limit)}`
      );

      if (!response.ok) {
        throw new Error(`Chain request failed with ${response.status}`);
      }

      const payload = await response.json();
      const enrichedPayload = {
        ...payload,
        requestedLimit: Number.isFinite(normalizedLimit) ? normalizedLimit : 30
      };
      setOptionChains((current) =>
        writeBoundedCacheRecord(current, requestKey, enrichedPayload, MAX_OPTION_CHAIN_CACHE_ENTRIES)
      );
      setOptionChainStatus((current) =>
        writeBoundedCacheRecord(current, requestKey, {
          loading: false,
          error: null
        }, MAX_OPTION_CHAIN_CACHE_ENTRIES)
      );
      return enrichedPayload;
    } catch (error) {
      setOptionChainStatus((current) =>
        writeBoundedCacheRecord(current, requestKey, {
          loading: false,
          error: error.message
        }, MAX_OPTION_CHAIN_CACHE_ENTRIES)
      );
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
          volume: contract.volume ?? null,
          openInterest: contract.openInterest ?? null,
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
    if (optionRootSymbol && activeChainExpiration) {
      const spot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
      const resolvedStrikeHint =
        Number.isFinite(spot) && spot > 0 ? spot : Number(activeOptionLeg?.strike ?? 0) || 0;
      const requestLimit = chainShowAll ? 0 : 30;

      loadOptionChain({
        expiration: activeChainExpiration,
        optionType: "call",
        strikeHint: resolvedStrikeHint,
        limit: requestLimit,
        force: true
      });
      loadOptionChain({
        expiration: activeChainExpiration,
        optionType: "put",
        strikeHint: resolvedStrikeHint,
        limit: requestLimit,
        force: true
      });
    }

    effectiveOptionLegs.forEach((leg) => {
      loadOptionChain({
        expiration: leg.expiry,
        optionType: leg.optionType,
        strikeHint: leg.strike,
        force: true
      });
    });
  }

  function buildManualOptionLeg() {
    const anchorLeg = effectiveOptionLegs[effectiveOptionLegs.length - 1] ?? optionLegs[optionLegs.length - 1] ?? null;
    const spot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
    const strikeHint = Number.isFinite(spot) && spot > 0 ? Math.round(spot) : Number(anchorLeg?.strike ?? 0) || 0;
    const seed =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const legId = `${selectedRow?.id ?? "finder"}:option:manual:${seed}`;
    const expiry = anchorLeg?.expiry ?? strategyCloseDate ?? polymarketResolutionDate ?? currentDate ?? "";
    const optionType = anchorLeg?.optionType ?? "call";

    return {
      id: legId,
      kind: "option",
      label: `LONG ${String(optionType).toUpperCase()} ${strikeHint}`,
      action: "LONG",
      quantity: 1,
      entryPrice: 0,
      contractMultiplier: Number(anchorLeg?.contractMultiplier ?? 100) || 100,
      optionType,
      expiry,
      strike: strikeHint,
      contractSymbol: "",
      bid: null,
      ask: null,
      bidSize: null,
      askSize: null,
      volume: null,
      openInterest: null,
      impliedVolatility: Number(anchorLeg?.impliedVolatility ?? impliedVolatility) || impliedVolatility,
      quoteSource: "Manual",
      isLive: false,
      hasRealBidAsk: false
    };
  }

  function handleAddManualLeg() {
    if (!selectedRow) {
      return;
    }

    const nextLeg = buildManualOptionLeg();
    setActiveLegId(nextLeg.id);
    setControls((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        manualOptionLegs: [...(current.manualOptionLegs ?? []), nextLeg],
        legConfigs: {
          ...(current.legConfigs ?? {}),
          [nextLeg.id]: {
            action: nextLeg.action,
            optionType: nextLeg.optionType,
            expiry: nextLeg.expiry,
            strike: Number(nextLeg.strike),
            bid: 0,
            ask: 0,
            bidSize: null,
            askSize: null,
            volume: null,
            openInterest: null,
            contractSymbol: "",
            impliedVolatility: Number(nextLeg.impliedVolatility ?? impliedVolatility) || impliedVolatility,
            quoteSource: "Manual",
            isLive: false,
            hasRealBidAsk: false
          }
        },
        legEdits: {
          ...(current.legEdits ?? {}),
          [nextLeg.id]: {
            quantity: String(normalizeQuantityInput(nextLeg.quantity, 0)),
            entryPrice: nextLeg.entryPrice
          }
        }
      };
    });
  }

  function handleAddPolymarketLeg() {
    if (!removedPolymarketLeg) {
      return;
    }

    const config = controls?.legConfigs?.[removedPolymarketLeg.id] ?? {};
    const configuredOutcome =
      String(config.outcome ?? removedPolymarketLeg.outcome).trim().toUpperCase() === "NO" ? "NO" : "YES";
    handleSelectPolymarketLegOutcome(removedPolymarketLeg.id, configuredOutcome);
  }

  function handleRemoveOptionLeg(legId) {
    setActiveLegId((current) => (current === legId ? "" : current));

    setControls((current) => {
      if (!current) {
        return current;
      }

      const manualLegs = current.manualOptionLegs ?? [];
      const isManual = manualLegs.some((leg) => leg?.id === legId);
      if (isManual) {
        const nextManualLegs = manualLegs.filter((leg) => leg?.id !== legId);
        const nextLegConfigs = { ...(current.legConfigs ?? {}) };
        const nextLegEdits = { ...(current.legEdits ?? {}) };
        delete nextLegConfigs[legId];
        delete nextLegEdits[legId];

        return {
          ...current,
          manualOptionLegs: nextManualLegs,
          legConfigs: nextLegConfigs,
          legEdits: nextLegEdits
        };
      }

      const nextRemoved = new Set((current.removedLegIds ?? []).map((id) => String(id ?? "")).filter(Boolean));
      nextRemoved.add(String(legId ?? ""));

      return {
        ...current,
        removedLegIds: Array.from(nextRemoved)
      };
    });
  }

  function handleSelectPolymarketLegOutcome(legId, nextOutcome) {
    if (!selectedRow || !legId) {
      return;
    }

    const normalizedOutcome = String(nextOutcome ?? "").trim().toUpperCase() === "NO" ? "NO" : "YES";
    const entryPrice = normalizedOutcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice;
    const seedLeg = (selectedRow?.legs ?? []).find(
      (leg) => leg.kind === "binary" && String(leg.id ?? "") === String(legId)
    );

    if (!seedLeg || !Number.isFinite(entryPrice)) {
      return;
    }

    setControls((current) => {
      if (!current) {
        return current;
      }

      const currentEdits = current.legEdits?.[seedLeg.id] ?? {};
      const currentConfig = current.legConfigs?.[seedLeg.id] ?? {};
      const currentOutcome =
        String(currentConfig.outcome ?? seedLeg.outcome).trim().toUpperCase() === "NO" ? "NO" : "YES";
      const currentEntryPrice = Number(
        currentEdits.entryPrice ?? (currentOutcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice)
      );
      const currentQuantity = normalizeQuantityInput(
        currentEdits.quantity ?? seedLeg.quantity,
        normalizeQuantityInput(seedLeg.quantity, 0)
      );
      const impliedBudget = Number.isFinite(currentEntryPrice) ? currentQuantity * currentEntryPrice : 0;
      const nextQuantity =
        impliedBudget > 0 && entryPrice > 0
          ? normalizeQuantityInput(impliedBudget / entryPrice, currentQuantity)
          : currentQuantity;

      const nextRemoved = new Set(
        (current.removedLegIds ?? []).map((id) => String(id ?? "")).filter(Boolean)
      );
      nextRemoved.delete(String(seedLeg.id));

      return {
        ...current,
        removedLegIds: Array.from(nextRemoved),
        legConfigs: {
          ...(current.legConfigs ?? {}),
          [seedLeg.id]: {
            ...currentConfig,
            outcome: normalizedOutcome
          }
        },
        legEdits: {
          ...(current.legEdits ?? {}),
          [seedLeg.id]: {
            ...currentEdits,
            entryPrice,
            quantity: String(nextQuantity)
          }
        }
      };
    });
  }

  function handleToggleShowAllStrikes() {
    if (chainShowAll) {
      setChainShowAll(false);
      return;
    }

    setChainShowAll(true);
  }

  function handleChainExpirationChange(nextExpiration) {
    if (!activeOptionLeg || !nextExpiration) {
      return;
    }

    updateLegConfig(activeOptionLeg.id, {
      expiry: nextExpiration,
      contractSymbol: "",
      bidSize: null,
      askSize: null,
      volume: null,
      openInterest: null,
      hasRealBidAsk: false
    });

    const spot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
    const resolvedStrikeHint =
      Number.isFinite(spot) && spot > 0 ? spot : Number(activeOptionLeg?.strike ?? 0) || 0;
    const requestLimit = chainShowAll ? 0 : 30;

    loadOptionChain({
      expiration: nextExpiration,
      optionType: "call",
      strikeHint: resolvedStrikeHint,
      limit: requestLimit,
      force: true
    });
    loadOptionChain({
      expiration: nextExpiration,
      optionType: "put",
      strikeHint: resolvedStrikeHint,
      limit: requestLimit,
      force: true
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

  useEffect(() => {
    if (!strategyEditorOpen) {
      return;
    }

    const optionLegIds = effectiveOptionLegs.map((leg) => String(leg?.id ?? "")).filter(Boolean);
    if (!optionLegIds.length) {
      setActiveLegId("");
      return;
    }

    setActiveLegId((current) =>
      current && optionLegIds.includes(current) ? current : optionLegIds[optionLegIds.length - 1]
    );
  }, [strategyEditorOpen, effectiveOptionLegs.map((leg) => String(leg?.id ?? "")).join("|")]);

  useEffect(() => {
    if (!strategyEditorOpen || !optionRootSymbol || !activeChainExpiration) {
      return;
    }

    const spot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
    const resolvedStrikeHint =
      Number.isFinite(spot) && spot > 0 ? spot : Number(activeOptionLeg?.strike ?? 0) || 0;
    const requestLimit = chainShowAll ? 0 : 30;

    loadOptionChain({
      expiration: activeChainExpiration,
      optionType: "call",
      strikeHint: resolvedStrikeHint,
      limit: requestLimit
    });
    loadOptionChain({
      expiration: activeChainExpiration,
      optionType: "put",
      strikeHint: resolvedStrikeHint,
      limit: requestLimit
    });
  }, [
    activeChainExpiration,
    activeOptionLeg?.strike,
    chainShowAll,
    currentProxySpot,
    optionRootSymbol,
    rawUnderlyingPrice,
    strategyEditorOpen
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

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("expectedMove", node)}
          onToggle={() => handleFilterMenuToggle("expectedMove")}
        >
          <summary className="finder-control">
            <span>{expectedMoveSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Expected move</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setExpectedMoveMin("-20");
                  setExpectedMoveMax("20");
                }}
              >
                Reset
              </button>
            </div>

            <div className="finder-menu__list">
              {EXPECTED_PRICE_RANGE_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`finder-menu__option ${
                    activeExpectedMovePreset?.label === preset.label ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => {
                    setExpectedMoveMin(String(preset.min));
                    setExpectedMoveMax(String(preset.max));
                  }}
                >
                  <span className="tv-finder__menu-title">{preset.label}</span>
                  <span className="tv-finder__menu-copy">{preset.description}</span>
                </button>
              ))}
            </div>

            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min %</span>
                <input
                  type="number"
                  step="0.5"
                  value={expectedMoveMin}
                  onChange={(event) => setExpectedMoveMin(event.target.value)}
                  placeholder="-5"
                />
              </label>
              <label>
                <span>Max %</span>
                <input
                  type="number"
                  step="0.5"
                  value={expectedMoveMax}
                  onChange={(event) => setExpectedMoveMax(event.target.value)}
                  placeholder="5"
                />
              </label>
            </div>

            <div className="finder-menu__notice">
              Use negative values for bearish ranges (for example -10 to -5).
            </div>
          </div>
        </details>

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
              <div className="finder-menu__header-actions">
                <button type="button" className="finder-menu__reset" onClick={() => setActiveAssets(availableAssets)}>
                  All
                </button>
                <button type="button" className="finder-menu__reset" onClick={() => setActiveAssets([])}>
                  Clear all
                </button>
              </div>
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
              <div className="finder-menu__header-actions">
                <button
                  type="button"
                  className="finder-menu__reset"
                  onClick={() => setActiveStrategyTypes(availableStrategyTypes)}
                >
                  All
                </button>
                <button type="button" className="finder-menu__reset" onClick={() => setActiveStrategyTypes([])}>
                  Clear all
                </button>
              </div>
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
          ref={(node) => setFilterMenuRef("bidAskSpread", node)}
          onToggle={() => handleFilterMenuToggle("bidAskSpread")}
        >
          <summary className="finder-control">
            <span>{bidAskSpreadSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Bid-ask spread</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setBidAskSpreadMin("");
                  setBidAskSpreadMax("");
                }}
              >
                Reset
              </button>
            </div>

            <div className="finder-menu__list">
              {BID_ASK_SPREAD_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  className={`finder-menu__option ${
                    activeBidAskSpreadPreset?.label === preset.label ? "finder-menu__option--active" : ""
                  }`}
                  onClick={() => {
                    setBidAskSpreadMin(preset.min != null ? String(preset.min) : "");
                    setBidAskSpreadMax(preset.max != null ? String(preset.max) : "");
                  }}
                >
                  <span className="tv-finder__menu-title">{preset.label}</span>
                  <span className="tv-finder__menu-copy">{preset.description}</span>
                </button>
              ))}
            </div>

            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min %</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={bidAskSpreadMin}
                  onChange={(event) => setBidAskSpreadMin(event.target.value)}
                  placeholder="1.0"
                />
              </label>
              <label>
                <span>Max %</span>
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  value={bidAskSpreadMax}
                  onChange={(event) => setBidAskSpreadMax(event.target.value)}
                  placeholder="3.0"
                />
              </label>
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("normalizedOptionVolume", node)}
          onToggle={() => handleFilterMenuToggle("normalizedOptionVolume")}
        >
          <summary className="finder-control">
            <span>{normalizedOptionVolumeSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Opt vol (norm)</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setNormalizedOptionVolumeMin("");
                  setNormalizedOptionVolumeMax("");
                }}
              >
                Reset
              </button>
            </div>
            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={normalizedOptionVolumeMin}
                  onChange={(event) => setNormalizedOptionVolumeMin(event.target.value)}
                  placeholder="0"
                />
              </label>
              <label>
                <span>Max</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={normalizedOptionVolumeMax}
                  onChange={(event) => setNormalizedOptionVolumeMax(event.target.value)}
                  placeholder="Any"
                />
              </label>
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("maxLoss", node)}
          onToggle={() => handleFilterMenuToggle("maxLoss")}
        >
          <summary className="finder-control">
            <span>{maxLossSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Max loss</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setMaxLossMin(DEFAULT_MAX_LOSS_FLOOR);
                  setMaxLossMax("");
                }}
              >
                Reset
              </button>
            </div>
            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min</span>
                <input
                  type="number"
                  step="100"
                  value={maxLossMin}
                  onChange={(event) => setMaxLossMin(event.target.value)}
                  placeholder="-3000"
                />
              </label>
              <label>
                <span>Max</span>
                <input
                  type="number"
                  step="100"
                  value={maxLossMax}
                  onChange={(event) => setMaxLossMax(event.target.value)}
                  placeholder="No cap"
                />
              </label>
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("midMinusTheo", node)}
          onToggle={() => handleFilterMenuToggle("midMinusTheo")}
        >
          <summary className="finder-control">
            <span>{midMinusTheoSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Avg B/A - Theo</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setMidMinusTheoMin("");
                  setMidMinusTheoMax("");
                }}
              >
                Reset
              </button>
            </div>
            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min</span>
                <input
                  type="number"
                  step="0.01"
                  value={midMinusTheoMin}
                  onChange={(event) => setMidMinusTheoMin(event.target.value)}
                  placeholder="-1.00"
                />
              </label>
              <label>
                <span>Max</span>
                <input
                  type="number"
                  step="0.01"
                  value={midMinusTheoMax}
                  onChange={(event) => setMidMinusTheoMax(event.target.value)}
                  placeholder="1.00"
                />
              </label>
            </div>
          </div>
        </details>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("maxProfit", node)}
          onToggle={() => handleFilterMenuToggle("maxProfit")}
        >
          <summary className="finder-control">
            <span>{maxProfitSummary}</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Max profit</strong>
              <button
                type="button"
                className="finder-menu__reset"
                onClick={() => {
                  setMaxProfitMin("");
                  setMaxProfitMax("");
                }}
              >
                Reset
              </button>
            </div>
            <div className="finder-menu__custom finder-menu__custom--metrics">
              <label>
                <span>Min</span>
                <input
                  type="number"
                  step="100"
                  value={maxProfitMin}
                  onChange={(event) => setMaxProfitMin(event.target.value)}
                  placeholder="No floor"
                />
              </label>
              <label>
                <span>Max</span>
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
              <div className="finder-menu__header-actions">
                <button
                  type="button"
                  className="finder-menu__reset"
                  onClick={() => setActiveBiasTags(availableBiasTags)}
                >
                  All
                </button>
                <button type="button" className="finder-menu__reset" onClick={() => setActiveBiasTags([])}>
                  Clear all
                </button>
              </div>
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

        <button
          type="button"
          className={`chart-toggle chart-toggle--compact finder-action ${
            saveFiltersState === "saved"
              ? "finder-action--success"
              : saveFiltersState === "error"
                ? "finder-action--error"
                : ""
          }`}
          onClick={saveFilters}
          aria-live="polite"
        >
          {saveFiltersState === "saved"
            ? "Saved"
            : saveFiltersState === "error"
              ? "Save failed"
              : "Save filters"}
        </button>

        <details
          className="finder-menu"
          ref={(node) => setFilterMenuRef("columns", node)}
          onToggle={() => handleFilterMenuToggle("columns")}
        >
          <summary className="finder-control">
            <span>Columns</span>
          </summary>
          <div className="finder-menu__panel">
            <div className="finder-menu__header">
              <strong>Visible columns</strong>
              <div className="finder-menu__header-actions">
                <button type="button" className="finder-menu__reset" onClick={resetVisibleColumns}>
                  All
                </button>
                <button type="button" className="finder-menu__reset" onClick={applyCompactVisibleColumns}>
                  Compact
                </button>
              </div>
            </div>
            <div className="finder-menu__list">
              {columns.map((column) => {
                const isActive = visibleFinderColumnKeys.includes(column.key);
                const isOnlyVisibleColumn = isActive && visibleFinderColumnKeys.length === 1;

                return (
                  <button
                    key={column.key}
                    type="button"
                    className={`finder-menu__option ${isActive ? "finder-menu__option--active" : ""}`}
                    onClick={() => toggleVisibleColumn(column.key)}
                    disabled={isOnlyVisibleColumn}
                    aria-pressed={isActive}
                  >
                    {column.label}
                  </button>
                );
              })}
            </div>
            <p className="finder-menu__notice">
              Smaller screens start in compact mode. Turn columns on here when you need the full table.
            </p>
          </div>
        </details>
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
	                {liveOptionComboQuote ? (
	                  <span
	                    className="pill pill--ghost"
	                    title={
	                      liveOptionComboQuote.ready
	                        ? `Bid ${formatQuotePrice(liveOptionComboQuote.bid)} · Ask ${formatQuotePrice(liveOptionComboQuote.ask)}`
	                        : "Waiting for live option bid/ask quotes..."
	                    }
	                  >
	                    Live mark {formatQuotePrice(liveOptionComboQuote.mid)}
	                  </span>
	                ) : null}
	                {liveOptionLegQuotesUpdatedAt ? (
	                  <span className="pill pill--ghost">Updated {formatShortTime(liveOptionLegQuotesUpdatedAt)}</span>
	                ) : null}
	                <span className="pill pill--ghost">
	                  Live theo {formatNumber(liveTheoPrice ?? selectedRow?.theoPrice ?? selectedRowSummary?.theoPrice, 2)}
	                </span>
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
                      <h3>{strategyTypeLabel}</h3>
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
                        {strategyEditorOpen ? "Close builder" : "Add to strategy builder"}
                      </button>
                      <button
                        type="button"
                        className={`chart-toggle ${isSelectedInSetupWatchlist ? "chart-toggle--active" : ""}`}
                        onClick={handleToggleSetupWatchlist}
                        disabled={!selectedRow || watchlistSaving || !canMutateSetupWatchlist}
                      >
                        {watchlistSaving
                          ? isSelectedInSetupWatchlist
                            ? "Removing..."
                            : "Adding..."
                          : isSelectedInSetupWatchlist
                            ? "Remove from watchlist"
                            : "Add to watchlist"}
                      </button>
                      {selectedPolymarketEventUrl ? (
                        <a href={selectedPolymarketEventUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                          Open Polymarket
                        </a>
                      ) : null}
                    </div>
                  </div>

                  {watchlistNotice ? (
                    <div className="refresh-feedback refresh-feedback--error">
                      <span>{watchlistNotice}</span>
                    </div>
                  ) : null}

                  {strategyEditorOpen ? (
                    <section className="strategy-editor">
                      <div className="strategy-editor__header">
                        <div>
                          <span className="brand__eyebrow">Strategy builder</span>
                          <p className="detail-chart__copy">
                            Change each option leg to long or short and replace it from the option chain.
                          </p>
                        </div>
                        <div className="detail-badges">
                          <span className={`pill ${editorHasLiveQuotes ? "pill--live" : "pill--ghost"}`}>
                            {editorHasLiveQuotes ? "Live chain" : "Synthetic chain"}
                          </span>
                          <button
                            type="button"
                            className="chart-toggle chart-toggle--compact"
                            onClick={handleAddManualLeg}
                            disabled={!selectedRow}
                          >
                            Add Option Leg
                          </button>
                          {polymarketSeedLegs.length ? (
                            <button
                              type="button"
                              className="chart-toggle chart-toggle--compact"
                              onClick={handleAddPolymarketLeg}
                              disabled={!removedPolymarketLeg}
                              title={
                                removedPolymarketLeg
                                  ? "Restore the Polymarket leg for this setup"
                                  : "Polymarket leg already included"
                              }
                            >
                              Add Polymarket Leg
                            </button>
                          ) : null}
                          <button type="button" className="chart-toggle" onClick={refreshVisibleOptionChains}>
                            Refresh chain
                          </button>
                        </div>
                      </div>

                      <div className="strategy-editor__chain">
                        <div className="strategy-editor__chain-head">
                          <div className="strategy-editor__chain-title">
                            <span className="brand__eyebrow">Option chain</span>
                            <strong>
                              {optionRootSymbol || selectedRow?.assetLabel || "Chain"}
                              {activeChainExpiration ? ` · ${activeChainExpiration}` : ""}
                            </strong>
                          </div>
                          <div className="strategy-editor__chain-actions">
                            <button
                              type="button"
                              className={`chart-toggle chart-toggle--compact ${chainShowAll ? "chart-toggle--active" : ""}`}
                              onClick={handleToggleShowAllStrikes}
                              disabled={!optionRootSymbol || !activeChainExpiration}
                            >
                              {chainShowAll ? "Show 30 strikes" : "Show all strikes"}
                            </button>
                          </div>
                        </div>

                        {activeExpiryTabs.length ? (
                          <div className="strategy-editor__expiry-tabs">
                            {activeExpiryTabs.map((expiry) => {
                              const dte = differenceInDays(currentDate || "", expiry);
                              const dteLabel = `${dte >= 0 ? dte : `-${Math.abs(dte)}`}D`;

                              return (
                                <button
                                  key={`expiry-tab:${expiry}`}
                                  type="button"
                                  className={`expiry-tab ${expiry === activeChainExpiration ? "expiry-tab--active" : ""}`}
                                  onClick={() => handleChainExpirationChange(expiry)}
                                  disabled={!activeOptionLeg}
                                >
                                  <span className="expiry-tab__date">{formatShortDate(expiry)}</span>
                                  <span className="expiry-tab__dte">{dteLabel}</span>
                                </button>
                              );
                            })}
                          </div>
                        ) : null}

                        <div className="strategy-editor__chain-status">
                          <span>
                            Spot:{" "}
                            {Number.isFinite(currentProxySpot) && currentProxySpot > 0
                              ? formatCurrency(currentProxySpot)
                              : formatCurrency(rawUnderlyingPrice)}
                          </span>
                          <span>
                            Chain:{" "}
                            {activeCallChainStatus?.loading || activePutChainStatus?.loading
                              ? "Loading..."
                              : activeCallChainStatus?.error || activePutChainStatus?.error
                                ? activeCallChainStatus?.error || activePutChainStatus?.error
                                : activeCallChain?.warning ||
                                  activePutChain?.warning ||
                                  (activeCallChain?.isLive || activePutChain?.isLive
                                    ? "Live quotes"
                                    : "Synthetic quotes")}
                          </span>
                        </div>

                        {activeChainRows.length ? (
                          <div className="strategy-editor__chain-table-wrap">
                            <table className="strategy-editor__chain-table">
                              <thead>
                                <tr>
                                  <th colSpan={OPTION_CHAIN_SIDE_COLUMNS.length} className="chain-group chain-group--call">
                                    Calls
                                  </th>
                                  <th rowSpan={2} className="chain-strike-head">
                                    Strike
                                  </th>
                                  <th colSpan={OPTION_CHAIN_SIDE_COLUMNS.length} className="chain-group chain-group--put">
                                    Puts
                                  </th>
                                </tr>
                                <tr>
                                  {OPTION_CHAIN_CALL_COLUMNS.map((column) => (
                                    <th key={`call:${column.key}`}>{column.label}</th>
                                  ))}
                                  {OPTION_CHAIN_SIDE_COLUMNS.map((column) => (
                                    <th key={`put:${column.key}`}>{column.label}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {(() => {
                                  const chainSpot = Number(currentProxySpot ?? rawUnderlyingPrice ?? 0);
                                  const spotSeparatorLabel =
                                    chainSpot > 0 ? `Spot ${formatNumber(chainSpot, proxySpotDigits)}` : "";
                                  let spotSeparatorInserted = false;
                                  const activeStrike = Number(activeOptionLeg?.strike ?? NaN);
                                  const activeType = String(activeOptionLeg?.optionType ?? "").toLowerCase();
                                  const activeContractSymbol = String(activeOptionLeg?.contractSymbol ?? "");
                                  const chainColumnSpan = OPTION_CHAIN_SIDE_COLUMNS.length * 2 + 1;

                                  const formatPercentLabel = (value, digits = 2) => {
                                    const numericValue = Number(value);
                                    if (!Number.isFinite(numericValue)) {
                                      return "—";
                                    }

                                    return `${numericValue.toFixed(digits)}%`;
                                  };

                                  const formatSignedPercentLabel = (value, digits = 2) => {
                                    const numericValue = Number(value);
                                    if (!Number.isFinite(numericValue)) {
                                      return "—";
                                    }

                                    return `${numericValue > 0 ? "+" : ""}${numericValue.toFixed(digits)}%`;
                                  };

                                  const formatMetric = (contract, column) => {
                                    if (!contract) {
                                      return "—";
                                    }

                                    const rawValue = contract[column.key];
                                    if (rawValue == null) {
                                      return "—";
                                    }

                                    const numericValue = Number(rawValue);
                                    if (!Number.isFinite(numericValue)) {
                                      return "—";
                                    }

                                    if (column.kind === "count") {
                                      return formatCompactCount(numericValue);
                                    }

                                    if (column.kind === "price") {
                                      return formatNumber(numericValue, 2);
                                    }

                                    if (column.kind === "number") {
                                      return formatNumber(numericValue, column.digits ?? 3);
                                    }

                                    if (column.kind === "percent") {
                                      const scaledValue = numericValue * (column.scale ?? 1);
                                      if (!Number.isFinite(scaledValue)) {
                                        return "—";
                                      }

                                      if (column.key === "impliedVolatility") {
                                        return formatPercentLabel(scaledValue, column.digits ?? 2);
                                      }

                                      return formatSignedPercentLabel(scaledValue, column.digits ?? 2);
                                    }

                                    return String(rawValue);
                                  };

                                  const renderSideCells = (side, contract, isActiveStrike, columns) =>
                                    columns.map((column) => {
                                      if (column.kind === "select") {
                                        const markValue = Number(contract?.mark ?? contract?.mid ?? NaN);
                                        const markLabel = Number.isFinite(markValue) ? formatNumber(markValue, 2) : "—";
                                        const contractSymbol = String(contract?.contractSymbol ?? "");
                                        const isSelected =
                                          (activeContractSymbol &&
                                            contractSymbol &&
                                            contractSymbol === activeContractSymbol) ||
                                          (!activeContractSymbol && isActiveStrike && activeType === side);

                                        return (
                                          <td key={`${side}:${column.key}`} className="chain-metric">
                                            <button
                                              type="button"
                                              className={`chain-quote chain-quote--${side} ${
                                                isSelected ? "chain-quote--active" : ""
                                              }`}
                                              onClick={() =>
                                                activeOptionLeg?.id ? applyChainContractToLeg(activeOptionLeg.id, contract) : null
                                              }
                                              disabled={!contract || !activeOptionLeg?.id}
                                            >
                                              {markLabel}
                                            </button>
                                          </td>
                                        );
                                      }

                                      const changeValue =
                                        column.key === "changePercent" ? Number(contract?.changePercent ?? NaN) : NaN;
                                      const volumeValue = column.key === "volume" ? Number(contract?.volume ?? NaN) : NaN;
                                      const volumeStrength =
                                        Number.isFinite(volumeValue) && volumeValue > 500
                                          ? Math.min(Math.max((volumeValue - 500) / (10000 - 500), 0), 1)
                                          : 0;
                                      const metricLabel = formatMetric(contract, column);
                                      const metricToneClass =
                                        column.key === "changePercent" && Number.isFinite(changeValue)
                                          ? changeValue > 0
                                            ? "chain-metric__value--pos"
                                            : changeValue < 0
                                              ? "chain-metric__value--neg"
                                              : ""
                                          : "";
                                      const isVolumeHot = column.key === "volume" && volumeStrength > 0;

                                      return (
                                        <td key={`${side}:${column.key}`} className="chain-metric">
                                          {column.key === "volume" ? (
                                            <span
                                              className={`chain-volume ${isVolumeHot ? "chain-volume--hot" : ""}`}
                                              style={
                                                isVolumeHot ? { "--volume-strength": volumeStrength.toFixed(3) } : undefined
                                              }
                                            >
                                              {metricLabel}
                                            </span>
                                          ) : (
                                            <span className={`chain-metric__value ${metricToneClass}`}>{metricLabel}</span>
                                          )}
                                        </td>
                                      );
                                    });

                                  return [
                                    ...activeChainRows.flatMap((row) => {
                                      const strike = Number(row?.strike ?? NaN);
                                      const isActiveStrike =
                                        Number.isFinite(activeStrike) &&
                                        Number.isFinite(strike) &&
                                        Math.abs(activeStrike - strike) < 0.001;
                                      const shouldInsertSpotSeparator =
                                        !spotSeparatorInserted &&
                                        spotSeparatorLabel &&
                                        Number.isFinite(strike) &&
                                        strike >= chainSpot;

                                      if (shouldInsertSpotSeparator) {
                                        spotSeparatorInserted = true;
                                      }

                                      return [
                                        shouldInsertSpotSeparator ? (
                                          <tr key={`spot:${activeChainExpiration}`} className="chain-spot-row">
                                            <td colSpan={chainColumnSpan}>{spotSeparatorLabel}</td>
                                          </tr>
                                        ) : null,
                                        <tr
                                          key={`strike:${strike}`}
                                          className={isActiveStrike ? "chain-row chain-row--active" : "chain-row"}
                                        >
                                          {renderSideCells("call", row.call, isActiveStrike, OPTION_CHAIN_CALL_COLUMNS)}
                                          <td className="chain-strike">{formatNumber(strike, 1)}</td>
                                          {renderSideCells("put", row.put, isActiveStrike, OPTION_CHAIN_SIDE_COLUMNS)}
                                        </tr>
                                      ].filter(Boolean);
                                    }),
                                    spotSeparatorLabel && activeChainRows.length && !spotSeparatorInserted ? (
                                      <tr key={`spot:${activeChainExpiration}:tail`} className="chain-spot-row">
                                        <td colSpan={chainColumnSpan}>{spotSeparatorLabel}</td>
                                      </tr>
                                    ) : null
                                  ].filter(Boolean);
                                })()}
                              </tbody>
                            </table>
                          </div>
                        ) : (
                          <div className="strategy-editor__chain-empty">
                            {activeCallChainStatus?.loading || activePutChainStatus?.loading
                              ? "Loading option chain..."
                              : activeCallChainStatus?.error || activePutChainStatus?.error
                                ? activeCallChainStatus?.error || activePutChainStatus?.error
                                : "No option contracts returned for this expiry."}
                          </div>
                        )}
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
                          const selectedChainContract = selectedContractValue
                            ? chainContracts.find((contract) => contract.contractSymbol === selectedContractValue) ?? null
                            : null;
                          const chainBid = selectedChainContract?.bid ?? leg.bid;
                          const chainAsk = selectedChainContract?.ask ?? leg.ask;
                          const chainQuoteSize = formatQuoteSizePair(
                            selectedChainContract?.bidSize ?? leg.bidSize,
                            selectedChainContract?.askSize ?? leg.askSize
                          );
                          const chainSpot = currentProxySpot > 0 ? currentProxySpot : 0;
                          const spotSeparatorLabel =
                            chainSpot > 0
                              ? `---------- Spot ${formatNumber(chainSpot, proxySpotDigits)} ----------`
                              : "";
                          let spotSeparatorInserted = false;

                          return (
                            <article
                              key={leg.id}
                              className={`strategy-editor__card ${
                                leg.id === activeLegId ? "strategy-editor__card--active" : ""
                              }`}
                              onClick={() => setActiveLegId(leg.id)}
                              onFocusCapture={() => setActiveLegId(leg.id)}
                            >
                              <div className="strategy-editor__card-head">
                                <strong>Leg {index + 1}</strong>
                                <div className="strategy-editor__card-actions">
                                  <span className="pill pill--ghost">
                                    {leg.quoteSource === "live" ? "Live" : chainPayload?.sourceLabel ?? "Seeded"}
                                  </span>
                                  <button
                                    type="button"
                                    className="chart-toggle chart-toggle--compact"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      handleRemoveOptionLeg(leg.id);
                                    }}
                                  >
                                    Remove
                                  </button>
                                </div>
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
                                        volume: null,
                                        openInterest: null,
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
                                        volume: null,
                                        openInterest: null,
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
                                    {chainContracts.map((contract) => {
                                      const contractStrike = Number(contract?.strike ?? 0);
                                      const shouldInsertSpotSeparator =
                                        !spotSeparatorInserted &&
                                        spotSeparatorLabel &&
                                        Number.isFinite(contractStrike) &&
                                        contractStrike >= chainSpot;

                                      if (shouldInsertSpotSeparator) {
                                        spotSeparatorInserted = true;
                                      }

                                      return [
                                        shouldInsertSpotSeparator ? (
                                          <option key={`spot:${requestKey}`} value="__spot__" disabled>
                                            {spotSeparatorLabel}
                                          </option>
                                        ) : null,
                                        <option key={contract.contractSymbol} value={contract.contractSymbol}>
                                          {formatContractChoiceLabel(contract)}
                                        </option>
                                      ];
                                    })}
                                    {spotSeparatorLabel && chainContracts.length && !spotSeparatorInserted ? (
                                      <option key={`spot:${requestKey}`} value="__spot__" disabled>
                                        {spotSeparatorLabel}
                                      </option>
                                    ) : null}
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
                                  {leg.optionType === "put" ? "P" : "C"} · {formatNumber(chainBid, 2)} /{" "}
                                  {formatNumber(chainAsk, 2)}
                                  {chainQuoteSize ? ` · size ${chainQuoteSize}` : ""}
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
	                          <div><dt>Bid</dt><dd>{formatQuotePrice(displayedNetBid)}</dd></div>
	                          <div><dt>Ask</dt><dd>{formatQuotePrice(displayedNetAsk)}</dd></div>
	                          <div><dt>Mark</dt><dd>{formatQuotePrice(displayedNetMark)}</dd></div>
	                          <div><dt>Opt vol (norm)</dt><dd>{formatExactCount(selectedRow?.normalizedOptionVolume)}</dd></div>
	                          <div><dt>Poly volume</dt><dd>{formatExactUsd(selectedRow?.polymarketVolume)}</dd></div>
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
	                      {liveOptionLegQuotesUpdatedAt || liveOptionLegQuotesError ? (
	                        <div className="detail-badges">
	                          {liveOptionLegQuotesUpdatedAt ? (
	                            <span className="pill pill--ghost">
	                              Updated {formatShortTime(liveOptionLegQuotesUpdatedAt)}
	                            </span>
	                          ) : null}
	                          {liveOptionLegQuotesError ? (
	                            <span className="pill pill--warning" title={liveOptionLegQuotesError}>
	                              Live quotes stalled
	                            </span>
	                          ) : null}
	                        </div>
	                      ) : null}
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
	                          <span>Code / Link</span>
	                        </div>
	                        {detailLegRows.map((leg) => {
	                          const liveQuote = leg.kind === "option" ? liveOptionLegQuotes?.[leg.id] ?? null : null;
	                          const bid = liveQuote?.bid ?? leg.bid;
	                          const ask = liveQuote?.ask ?? leg.ask;
	                          const mark =
	                            liveQuote?.mark ??
	                            (() => {
	                              const bidValue = Number(bid);
	                              const askValue = Number(ask);
	                              return Number.isFinite(bidValue) && Number.isFinite(askValue)
	                                ? (bidValue + askValue) / 2
	                                : null;
	                            })();
	                          const volume = liveQuote?.volume ?? leg.volume;
	                          const openInterest = liveQuote?.openInterest ?? leg.openInterest;
	                          const spread =
	                            leg.kind === "option" ? calculateSpreadPercent(bid, ask) : leg.spread;

	                          return (
	                            <div key={leg.id} className="legs-table__row">
	                              <span className={`legs-action legs-action--${leg.action.toLowerCase()}`}>{leg.action}</span>
	                              <span>{formatNumber(leg.quantity, 0)}</span>
	                              <span>
	                                {typeof leg.strike === "string"
	                                  ? leg.strike
	                                  : `${formatNumber(leg.strike, 1)}${leg.optionType === "put" ? "P" : "C"}`}
	                              </span>
	                              <span>{formatQuotePrice(bid)}</span>
	                              <span>{formatQuotePrice(ask)}</span>
	                              <span>{formatQuotePrice(mark)}</span>
	                              <span>{leg.kind === "option" ? formatCompactCount(volume) : ""}</span>
	                              <span>{leg.kind === "option" ? formatCompactCount(openInterest) : ""}</span>
	                              <span>{spread != null ? `${formatNumber(spread, 2)}%` : ""}</span>
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
	                                <small>{liveQuote?.sourceLabel ?? leg.referenceMeta}</small>
	                                {leg.liquidityMeta ? <small>{leg.liquidityMeta}</small> : null}
	                              </span>
	                            </div>
	                          );
	                        })}
	                      </div>
	                    </div>

                      <OptionMicrostructurePanel contracts={microstructureContracts} />

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

                        <div className="detail-mini-slider">
                          <div className="detail-mini-slider__header">
                            <span>Put IV</span>
                            <strong>{formatNumber(putVolatility * 100, 2)}%</strong>
                          </div>
                          <input
                            className="detail-mini-slider__range"
                            type="range"
                            min="5"
                            max="150"
                            step="0.5"
                            value={clamp(Number(controls?.ivPut ?? 30), 5, 150)}
                            onChange={(event) =>
                              setControls((current) => ({ ...current, ivPut: event.target.value }))
                            }
                          />
                          <div className="detail-mini-slider__scale">
                            <span>5%</span>
                            <span>150%</span>
                          </div>
                        </div>

	                        <div className="detail-mini-slider">
	                          <div className="detail-mini-slider__header">
	                            <span>Call IV</span>
	                            <strong>{formatNumber(callVolatility * 100, 2)}%</strong>
	                          </div>
	                          <input
	                            className="detail-mini-slider__range"
	                            type="range"
	                            min="5"
	                            max="150"
	                            step="0.5"
	                            value={clamp(Number(controls?.ivCall ?? 20), 5, 150)}
	                            onChange={(event) =>
	                              setControls((current) => ({ ...current, ivCall: event.target.value }))
	                            }
	                          />
	                          <div className="detail-mini-slider__scale">
	                            <span>5%</span>
	                            <span>150%</span>
	                          </div>
	                        </div>

                          {polymarketLegs.length ? (
                            <div className="detail-mini-slider">
                              <div className="detail-mini-slider__header">
                                <span>Polymarket YES</span>
                                <strong>{formatNumber(polymarketYesPrice, 2)}</strong>
                              </div>
                              <input
                                className="detail-mini-slider__range"
                                type="range"
                                min="0"
                                max="1"
                                step="0.01"
                                value={clamp(polymarketYesPrice, 0, 1)}
                                onChange={(event) =>
                                  setControls((current) => ({ ...current, polymarketYesPrice: event.target.value }))
                                }
                              />
                              <div className="detail-mini-slider__scale">
                                <span>Auto {formatNumber(estimatedYesPrice, 2)}</span>
                                <span>1</span>
                              </div>
                            </div>
                          ) : null}
	                      </div>
	                    </div>

                  </div>
                </article>
              </section>

		              <section className="calculator-section">
		                <div className="section-heading">
		                  <span>Multi-leg calculator</span>
		                  <span className="pill pill--ghost">Slide date, market spot, and vol; YES auto-prices</span>
		                </div>

			                <div className="calculator-studio">
                    <div className="paper-order-ticket">
                      <div className="paper-order-ticket__copy">
                        <div className="paper-order-ticket__headline">
                          <span className="brand__eyebrow">Trade this setup</span>
                          <strong className="paper-order-ticket__title">
                            {selectedRow.assetLabel} · {strategyTypeLabel}
                          </strong>
                        </div>
                        <div className="paper-order-ticket__status">
                          <span className="pill pill--ghost">Local route</span>
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
                                disabled={!repricedOptionLegs.length}
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
                          onClick={handleCreatePaperTrade}
                          disabled={paperOrderSaving || !onCreatePaperOrder}
                        >
                          {paperOrderSaving ? "Saving..." : "Start new order"}
                        </button>
                        <button
                          type="button"
                          className={`chart-toggle ${strategyEditorOpen ? "chart-toggle--active" : ""}`}
                          onClick={() => setStrategyEditorOpen((current) => !current)}
                        >
                          {strategyEditorOpen ? "Close builder" : "Add to strategy builder"}
                        </button>
                        <button
                          type="button"
                          className={`chart-toggle ${isSelectedInSetupWatchlist ? "chart-toggle--active" : ""}`}
                          onClick={handleToggleSetupWatchlist}
                          disabled={!selectedRow || watchlistSaving || !canMutateSetupWatchlist}
                        >
                          {watchlistSaving
                            ? isSelectedInSetupWatchlist
                              ? "Removing..."
                              : "Adding..."
                            : isSelectedInSetupWatchlist
                              ? "Remove from watchlist"
                              : "Add to watchlist"}
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
                              Market {formatNumber(leg.outcome === "YES" ? marketReferenceYesPrice : marketReferenceNoPrice, 2)}
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
                            <span>Polymarket leg</span>
                            <select
                              value={leg.outcome}
                              onChange={(event) => handleSelectPolymarketLegOutcome(leg.id, event.target.value)}
                            >
                              <optgroup label={polymarketResolutionDate || "Resolution"}>
                                <option value="YES">
                                  YES · Strike {formatCurrency(targetUnderlyingValue)} · YES {formatNumber(marketReferenceYesPrice, 2)} · NO{" "}
                                  {formatNumber(marketReferenceNoPrice, 2)}
                                </option>
                                <option value="NO">
                                  NO · Strike {formatCurrency(targetUnderlyingValue)} · YES {formatNumber(marketReferenceYesPrice, 2)} · NO{" "}
                                  {formatNumber(marketReferenceNoPrice, 2)}
                                </option>
                              </optgroup>
                            </select>
                            <button
                              type="button"
                              className="chart-toggle chart-toggle--compact"
                              onClick={() => handleRemoveOptionLeg(leg.id)}
                            >
                              Remove
                            </button>
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

                    {!repricedPolymarketLegs.length
                      ? ((selectedRow?.legs ?? []).find((leg) => leg.kind === "binary") ? (
                          <div className="calculator-line calculator-line--market">
                            <div className="calculator-line__body">
                              <p>Polymarket leg removed</p>
                              <div className="calculator-line__meta">
                                <span>
                                  Strike {formatCurrency(targetUnderlyingValue)} · YES {formatNumber(marketReferenceYesPrice, 2)} · NO{" "}
                                  {formatNumber(marketReferenceNoPrice, 2)}
                                </span>
                                <span>{polymarketResolutionDate || "Resolution date"}</span>
                              </div>
                            </div>
                            <div className="calculator-line__editor">
                              <label>
                                <span>Add Polymarket leg</span>
                                <select
                                  value=""
                                  onChange={(event) =>
                                    handleSelectPolymarketLegOutcome(
                                      (selectedRow?.legs ?? []).find((leg) => leg.kind === "binary")?.id ?? "",
                                      event.target.value
                                    )
                                  }
                                >
                                  <option value="" disabled>
                                    Select YES / NO
                                  </option>
                                  <optgroup label={polymarketResolutionDate || "Resolution"}>
                                    <option value="YES">
                                      YES · Strike {formatCurrency(targetUnderlyingValue)} · YES {formatNumber(marketReferenceYesPrice, 2)} · NO{" "}
                                      {formatNumber(marketReferenceNoPrice, 2)}
                                    </option>
                                    <option value="NO">
                                      NO · Strike {formatCurrency(targetUnderlyingValue)} · YES {formatNumber(marketReferenceYesPrice, 2)} · NO{" "}
                                      {formatNumber(marketReferenceNoPrice, 2)}
                                    </option>
                                  </optgroup>
                                </select>
                              </label>
                              <div className="calculator-line__value">
                                <span>Contracts</span>
                                <strong>0</strong>
                              </div>
                              <div className="calculator-line__value">
                                <span>Entry cost</span>
                                <strong>{formatCurrency(0)}</strong>
                              </div>
                              <div className="calculator-line__value">
                                <span>Marked value</span>
                                <strong>{formatCurrency(0)}</strong>
                              </div>
                            </div>
                          </div>
                        ) : null)
                      : null}
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

			                  <div className="calculator-slider-stack" style={{ display: "none" }}>
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
                          <span>Put IV (below spot)</span>
                          <strong>{formatNumber(putVolatility * 100, 2)}%</strong>
                        </div>
                        <input
                          className="calculator-slider__number"
                          type="number"
                          min="5"
                          max="150"
                          step="0.5"
                          value={controls?.ivPut ?? ""}
                          onChange={(event) =>
                            setControls((current) => ({ ...current, ivPut: event.target.value }))
                          }
                        />
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min="5"
                        max="150"
                        step="0.5"
                        value={clamp(Number(controls?.ivPut ?? 30), 5, 150)}
                        onChange={(event) =>
                          setControls((current) => ({ ...current, ivPut: event.target.value }))
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
                          <span>Call IV (above spot)</span>
                          <strong>{formatNumber(callVolatility * 100, 2)}%</strong>
                        </div>
                        <input
                          className="calculator-slider__number"
                          type="number"
                          min="5"
                          max="150"
                          step="0.5"
                          value={controls?.ivCall ?? ""}
                          onChange={(event) =>
                            setControls((current) => ({ ...current, ivCall: event.target.value }))
                          }
                        />
                      </div>
                      <input
                        className="calculator-slider__range"
                        type="range"
                        min="5"
                        max="150"
                        step="0.5"
                        value={clamp(Number(controls?.ivCall ?? 20), 5, 150)}
                        onChange={(event) =>
                          setControls((current) => ({ ...current, ivCall: event.target.value }))
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

                      {polymarketLegs.length ? (
                        <div className="calculator-slider">
                          <div className="calculator-slider__header">
                            <div>
                              <span>Polymarket YES estimate</span>
                              <strong>{formatNumber(polymarketYesPrice, 2)}</strong>
                            </div>
                            <input
                              className="calculator-slider__number"
                              type="number"
                              min="0"
                              max="1"
                              step="0.01"
                              value={controls?.polymarketYesPrice ?? ""}
                              placeholder={formatNumber(estimatedYesPrice, 2)}
                              onChange={(event) =>
                                setControls((current) => ({ ...current, polymarketYesPrice: event.target.value }))
                              }
                            />
                          </div>
                          <input
                            className="calculator-slider__range"
                            type="range"
                            min="0"
                            max="1"
                            step="0.01"
                            value={clamp(polymarketYesPrice, 0, 1)}
                            onChange={(event) =>
                              setControls((current) => ({ ...current, polymarketYesPrice: event.target.value }))
                            }
                          />
                          <div className="calculator-slider__scale">
                            <span>0</span>
                            <span>1</span>
                          </div>
                        </div>
                      ) : null}
	                  </div>
		                </div>
	              </section>

                  <ScenarioHeatmap
                    className="calculator-section"
                    title="Time series heat map"
                    description="P/L across dates and proxy price levels, centered on the current proxy spot. The default view shows a 1x implied-vol range, with quick 2x and 3x range filters available."
                    startDate={valuationMinDate}
                    endDate={valuationMaxDate}
                    currentPrice={currentProxySpot || underlyingPrice}
                    volatility={impliedVolatility}
                    ivAtm={impliedVolatility}
                    ivPut={putVolatility}
                    ivCall={callVolatility}
                    spotLabel={proxySpotLabel}
                    priceDigits={proxySpotDigits}
                    secondarySpotLabel={converterRatio > 0 ? actualSpotLabel : ""}
                    secondaryPriceDigits={actualSpotDigits}
                    getSecondarySpot={converterRatio > 0 ? (spot) => spot / converterRatio : null}
                    rowCount={heatmapRowCount}
                    onRowCountChange={setHeatmapRowCount}
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
              </>
            ) : null
          ) : null}
        </>
      ) : null}

      <section className="finder-table-card">
        <div className="finder-table" style={{ "--finder-grid-columns": finderGridTemplateColumns }}>
          <div className="finder-table__head">
            {visibleColumns.map((column) => (
              <button
                key={column.key}
                type="button"
                className="finder-sort"
                title="Click to sort. Shift-click (or Ctrl/⌘-click) to add up to 4 sort priorities."
                onClick={(event) =>
                  toggleSort(column.key, {
                    additive: event.shiftKey || event.metaKey || event.ctrlKey
                  })
                }
              >
                <span className="finder-sort__label">{column.label}</span>
                {(() => {
                  const sortIndex = sortState.findIndex((sortDescriptor) => sortDescriptor?.key === column.key);
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
                {visibleColumns.map((column) => (
                  <Fragment key={`${row.id}:${column.key}`}>{renderFinderCell(row, column.key)}</Fragment>
                ))}
              </button>
            ))
          )}
        </div>
      </section>

    </main>
  );
}
