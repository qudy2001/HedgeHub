import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createMarketTimerContext } from "../marketTimers.js";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";
import { loadSavedFilters, persistSavedFilters } from "../savedFilters.js";

const TRADING_VIEW_STRATEGY_TYPE_KEYS = [
  "long_call",
  "short_call",
  "long_put",
  "short_put",
  "bull_call_spread",
  "bear_call_spread",
  "bull_put_spread",
  "bear_put_spread",
  "long_straddle",
  "short_straddle",
  "long_strangle",
  "short_strangle",
  "long_iron_butterfly",
  "short_iron_butterfly",
  "long_calls_butterfly",
  "short_calls_butterfly",
  "long_puts_butterfly",
  "short_puts_butterfly",
  "long_iron_condor",
  "short_iron_condor",
  "jade_lizard",
  "reverse_jade_lizard",
  "strip",
  "strap"
];
const TRADING_VIEW_MONEYNESS_OPTIONS = [
  { key: "out_of_the_money", label: "OTM" },
  { key: "at_the_money", label: "ATM" },
  { key: "in_the_money", label: "ITM" }
];
const EXPECTED_PRICE_RANGE_PRESETS = [
  { label: "-20% to +20%", description: "Wide", min: -20, max: 20 },
  { label: "-20% to -10%", description: "Bearish", min: -20, max: -10 },
  { label: "-10% to -5%", description: "Slightly bearish", min: -10, max: -5 },
  { label: "-5% to +5%", description: "Neutral", min: -5, max: 5 },
  { label: "+5% to +10%", description: "Slightly bullish", min: 5, max: 10 },
  { label: "+10% to +20%", description: "Bullish", min: 10, max: 20 }
];
const VOLUME_PRESETS = [
  { label: "0 to 100", description: "Very low", min: 0, max: 100 },
  { label: "100 to 500", description: "Low", min: 100, max: 500 },
  { label: "500 to 2K", description: "Medium", min: 500, max: 2000 },
  { label: "2K to 10K", description: "High", min: 2000, max: 10000 },
  { label: "Above 10K", description: "Very high", min: 10000 }
];
const SPREAD_WIDTH_PRESETS = [
  { label: "1 to 5 strikes", description: "Narrow", min: 1, max: 5 },
  { label: "5 to 15 strikes", description: "Medium", min: 5, max: 15 },
  { label: "15 to 25 strikes", description: "Wide", min: 15, max: 25 }
];
const BID_ASK_SPREAD_PRESETS = [
  { label: "Below 1%", description: "Tight", max: 1 },
  { label: "1% to 3%", description: "Medium", min: 1, max: 3 },
  { label: "Above 3%", description: "Wide", min: 3 }
];
const SORT_DEFAULT_DIRECTIONS = {
  expiration: "asc",
  days: "asc",
  assetLabel: "asc",
  strategyType: "asc",
  marketBias: "asc",
  formula: "asc",
  normalizedOptionVolume: "desc",
  midMinusTheo: "asc",
  probabilityOfProfit: "desc",
  maxProfit: "desc",
  maxLoss: "desc",
  rewardRisk: "desc",
  breakevens: "asc",
  theoPrice: "desc",
  bid: "desc",
  ask: "desc",
  bidAskSpread: "asc"
};
const MAX_SORT_PRIORITIES = 4;
const LIVE_OPTION_QUOTES_POLL_MS = 5000;
const MAX_OPTION_CHAIN_CACHE_ENTRIES = 8;
const DEFAULT_EXPECTED_PRICE_RANGE = {
  min: -20,
  max: 20
};
const DEFAULT_TABLE_MAX_LOSS_MIN = "-3000";
const DEFAULT_TABLE_MAX_LOSS_MAX = "99999999";
const TRADING_VIEW_SAVED_TICKERS_STORAGE_KEY = "hedgehub:tradingview-saved-tickers";
const TRADING_VIEW_FILTERS_STORAGE_KEY = "hedgehub:filters:tradingview-strategy";
const MAX_TRADING_VIEW_SAVED_TICKERS = 20;
const TRADING_VIEW_TABLE_COLUMNS = [
  { key: "expiration", label: "Expiration", width: 120 },
  { key: "days", label: "Days", mobileHidden: true, width: 70 },
  { key: "assetLabel", label: "Asset", width: 110 },
  { key: "strategyType", label: "Strategy type", mobileHidden: true, width: 150 },
  { key: "marketBias", label: "Tag", mobileHidden: true, width: 110 },
  { key: "formula", label: "Formula", mobileHidden: true, width: 220 },
  { key: "normalizedOptionVolume", label: "Opt vol (norm)", width: 120 },
  { key: "midMinusTheo", label: "Avg B/A - Theo", width: 140 },
  { key: "probabilityOfProfit", label: "POP", width: 120 },
  { key: "maxProfit", label: "Max profit", width: 148 },
  { key: "maxLoss", label: "Max loss", width: 148 },
  { key: "rewardRisk", label: "Reward/Risk", mobileHidden: true, width: 110 },
  { key: "breakevens", label: "Breakeven(s)", mobileHidden: true, width: 140 },
  { key: "theoPrice", label: "Theo price", mobileHidden: true, width: 95 },
  { key: "bid", label: "Bid", width: 80 },
  { key: "ask", label: "Ask", mobileHidden: true, width: 80 },
  { key: "bidAskSpread", label: "Bid-ask spread", width: 120 }
];
const OPTION_CHAIN_SIDE_COLUMNS = [
  { key: "bid", label: "Bid", kind: "price" },
  { key: "ask", label: "Ask", kind: "price" },
  { key: "bidSize", label: "Bid x", kind: "count" },
  { key: "askSize", label: "Ask x", kind: "count" },
  { key: "mark", label: "Mark", kind: "select" },
  { key: "changePercent", label: "Chg%", kind: "percent" },
  { key: "volume", label: "Vol", kind: "count" },
  { key: "openInterest", label: "OI", kind: "count" },
  { key: "impliedVolatility", label: "IV", kind: "percent", scale: 100, digits: 2 },
  { key: "delta", label: "Δ", kind: "number", digits: 3 },
  { key: "gamma", label: "Γ", kind: "number", digits: 4 },
  { key: "theta", label: "Θ", kind: "number", digits: 3 },
  { key: "vega", label: "Vega", kind: "number", digits: 3 },
  { key: "rho", label: "Rho", kind: "number", digits: 3 },
  { key: "intrinsicValue", label: "Intrinsic", kind: "price" },
  { key: "timeValue", label: "Time", kind: "price" },
  { key: "premiumPercent", label: "Premium%", kind: "percent" },
  { key: "lastPrice", label: "Last", kind: "price" }
];
const OPTION_CHAIN_CALL_COLUMNS = [...OPTION_CHAIN_SIDE_COLUMNS].reverse();

function writeBoundedCacheRecord(current, key, value, maxEntries) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return current && typeof current === "object" ? { ...current } : {};
  }

  const entries = Object.entries(current ?? {}).filter(([entryKey]) => entryKey !== normalizedKey);
  entries.push([normalizedKey, value]);

  return Object.fromEntries(entries.slice(-Math.max(Number(maxEntries) || 0, 0)));
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

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfCurrentMonthIso() {
  const now = new Date();
  return toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

function endOfCurrentMonthIso() {
  const now = new Date();
  return toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
}

function todayIso() {
  return toIsoDate(new Date());
}

function addDaysIso(value, days) {
  const date = parseIsoDate(value);
  if (!date) {
    return value;
  }

  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function diffDaysIso(fromIso, toIso) {
  const from = parseIsoDate(fromIso);
  const to = parseIsoDate(toIso);
  if (!from || !to) {
    return null;
  }

  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function buildWeeklyExpiryTabs(anchorIso, { pastWeeks = 4, futureWeeks = 12 } = {}) {
  const anchor = parseIsoDate(anchorIso);
  if (!anchor) {
    return [];
  }

  const dates = new Set();
  for (let weekOffset = -pastWeeks; weekOffset <= futureWeeks; weekOffset += 1) {
    dates.add(addDaysIso(anchorIso, weekOffset * 7));
  }

  return Array.from(dates).filter(Boolean).sort();
}

function startOfNextMonthIso(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return value;
  }

  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  return toIsoDate(date);
}

function endOfMonthIso(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return value;
  }

  date.setUTCMonth(date.getUTCMonth() + 1, 0);
  return toIsoDate(date);
}

function endOfNextMonthIso(value) {
  return endOfMonthIso(startOfNextMonthIso(value));
}

function startOfNextQuarterIso(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return value;
  }

  const nextQuarterMonth = Math.floor(date.getUTCMonth() / 3) * 3 + 3;
  date.setUTCMonth(nextQuarterMonth, 1);
  return toIsoDate(date);
}

function endOfNextQuarterIso(value) {
  const start = parseIsoDate(startOfNextQuarterIso(value));
  if (!start) {
    return value;
  }

  start.setUTCMonth(start.getUTCMonth() + 3, 0);
  return toIsoDate(start);
}

function formatShortDate(value) {
  const date = parseIsoDate(value);
  if (!date) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short"
  }).format(date);
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

function formatCurrency(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `$${numericValue.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  })}`;
}

function formatSignedPercentLabel(value, digits = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${numericValue > 0 ? "+" : ""}${numericValue.toFixed(digits)}%`;
}

function formatPercent(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return `${numericValue.toFixed(digits)}%`;
}

function formatNumber(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  return numericValue.toFixed(digits);
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

function buildChainKey(symbol, expiration, optionType) {
  return `${String(symbol ?? "").trim().toUpperCase()}:${String(expiration ?? "").trim()}:${String(optionType ?? "")
    .trim()
    .toLowerCase()}`;
}

function formatChainContractChoiceLabel(contract) {
  const strikeLabel = formatNumber(contract?.strike, 1);
  const optionCode = contract?.optionType === "put" ? "P" : "C";
  const bidLabel = formatNumber(contract?.bid, 2);
  const askLabel = formatNumber(contract?.ask, 2);
  const volumeSuffix =
    contract?.volume != null && Number.isFinite(Number(contract.volume))
      ? ` · vol ${formatCompactCount(contract.volume)}`
      : "";
  const openInterestSuffix =
    contract?.openInterest != null && Number.isFinite(Number(contract.openInterest))
      ? ` · oi ${formatCompactCount(contract.openInterest)}`
      : "";

  return `${strikeLabel}${optionCode} · bid ${bidLabel} · ask ${askLabel}${volumeSuffix}${openInterestSuffix}`;
}

function formatSummaryCurrency(value, digits = 2) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "n/a";
  }

  const absoluteValue = Math.abs(numericValue);
  if (absoluteValue >= 1000) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1
    }).format(numericValue);
  }

  const absoluteLabel = absoluteValue.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
  return `${numericValue < 0 ? "-" : ""}$${absoluteLabel}`;
}

function formatCompactValue(value, digits = 0) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return "";
  }

  return numericValue.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function getTradingViewMidPrice(row) {
  const bid = Number(row?.bid);
  const ask = Number(row?.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
    return null;
  }

  return (bid + ask) / 2;
}

function getTradingViewAssetLabel(row) {
  const family = String(row?.underlyingFamily ?? "").trim();
  if (family) {
    return family;
  }

  const underlyingSymbol = String(row?.underlyingSymbol ?? "").trim();
  if (!underlyingSymbol) {
    return "";
  }

  return underlyingSymbol.includes(":") ? underlyingSymbol.split(":").slice(-1)[0] : underlyingSymbol;
}

function getTradingViewMidMinusTheo(row) {
  const averagePrice = getTradingViewMidPrice(row);
  const theoreticalPrice = Number(row?.theoreticalPrice);
  if (!Number.isFinite(averagePrice) || !Number.isFinite(theoreticalPrice)) {
    return null;
  }

  return averagePrice - theoreticalPrice;
}

function getTradingViewMidMinusTheoTone(row) {
  const averagePrice = getTradingViewMidPrice(row);
  const theoreticalPrice = Number(row?.theoreticalPrice);
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

function getTradingViewBidAskSpreadValue(row, type = "percent") {
  if (type === "value") {
    const bid = Number(row?.bid);
    const ask = Number(row?.ask);
    if (!Number.isFinite(bid) || !Number.isFinite(ask)) {
      return null;
    }

    return ask - bid;
  }

  return Number.isFinite(Number(row?.bidAskSpreadPercent)) ? Number(row.bidAskSpreadPercent) : null;
}

function parseOptionalNumberInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const numericValue = Number(raw);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeTradingViewTickerTag(value) {
  return String(value ?? "").trim().toUpperCase();
}

function normalizeTradingViewSymbolInput(value) {
  const raw = normalizeTradingViewTickerTag(value);
  if (!raw) {
    return "SPY";
  }

  return raw;
}

function sanitizeSavedTradingViewTickers(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set();

  return value
    .map((item) => normalizeTradingViewTickerTag(item))
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }

      seen.add(item);
      return true;
    })
    .slice(0, MAX_TRADING_VIEW_SAVED_TICKERS);
}

function readSavedTradingViewTickers() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const rawValue = window.localStorage.getItem(TRADING_VIEW_SAVED_TICKERS_STORAGE_KEY);
    if (!rawValue) {
      return [];
    }

    return sanitizeSavedTradingViewTickers(JSON.parse(rawValue));
  } catch (_error) {
    return [];
  }
}

function formatStrategyTypeLabel(strategyTypeKey) {
  return String(strategyTypeKey ?? "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const TRADING_VIEW_STRATEGY_TYPES = TRADING_VIEW_STRATEGY_TYPE_KEYS.map((key) => ({
  key,
  label: formatStrategyTypeLabel(key)
}));

function summarizeSelectedStrategyTypes(selectedStrategyTypeKeys) {
  const allSelected = selectedStrategyTypeKeys.length >= TRADING_VIEW_STRATEGY_TYPES.length;

  if (allSelected) {
    return "Strategy types";
  }

  const selectedLabels = TRADING_VIEW_STRATEGY_TYPES.filter((strategyType) =>
    selectedStrategyTypeKeys.includes(strategyType.key)
  ).map((strategyType) => strategyType.label);

  if (!selectedLabels.length) {
    return "Strategy types (none)";
  }

  if (selectedLabels.length === 1) {
    return selectedLabels[0];
  }

  return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function buildDatePresets(anchorDate) {
  const today = parseIsoDate(anchorDate) ?? new Date();
  const todayValue = toIsoDate(today);
  const currentMonthStart = startOfCurrentMonthIso(today);

  return [
    { id: "this-week", label: "This week", from: todayValue, to: addDaysIso(todayValue, 7) },
    { id: "this-month", label: "This month", from: currentMonthStart, to: endOfMonthIso(todayValue) },
    { id: "next-30", label: "Next 30 days", from: todayValue, to: addDaysIso(todayValue, 30) },
    { id: "next-45", label: "Next 45 days", from: todayValue, to: addDaysIso(todayValue, 45) },
    { id: "next-90", label: "Next 90 days", from: todayValue, to: addDaysIso(todayValue, 90) },
    {
      id: "next-month",
      label: "Next month",
      from: startOfNextMonthIso(todayValue),
      to: endOfNextMonthIso(todayValue)
    },
    {
      id: "next-quarter",
      label: "Next quarter",
      from: startOfNextQuarterIso(todayValue),
      to: endOfNextQuarterIso(todayValue)
    }
  ];
}

function matchesRange(left, right) {
  return left?.from === right?.from && left?.to === right?.to;
}

function findMatchingDatePreset(dateRange, presets) {
  return presets.find((preset) => matchesRange(dateRange, preset)) ?? null;
}

function summarizeDateRange(dateRange, presets) {
  const matchingPreset = findMatchingDatePreset(dateRange, presets);
  if (matchingPreset) {
    return matchingPreset.label;
  }

  return `${formatShortDate(dateRange.from)} to ${formatShortDate(dateRange.to)}`;
}

function findMatchingExpectedPricePreset(priceRange) {
  return (
    EXPECTED_PRICE_RANGE_PRESETS.find(
      (preset) => preset.min === priceRange.min && preset.max === priceRange.max
    ) ?? null
  );
}

function summarizeExpectedPriceRange(priceRange) {
  return `Expected price range ${formatSignedPercentLabel(priceRange.min)} to ${formatSignedPercentLabel(priceRange.max)}`;
}

function rangesMatch(left, right) {
  return left?.min === right?.min && left?.max === right?.max;
}

function findMatchingVolumePreset(volumeRange) {
  if (!volumeRange) {
    return null;
  }

  return (
    VOLUME_PRESETS.find(
      (preset) => preset.min === volumeRange.min && (preset.max ?? null) === (volumeRange.max ?? null)
    ) ?? null
  );
}

function findMatchingSpreadWidthPreset(spreadWidth) {
  if (!spreadWidth) {
    return null;
  }

  return SPREAD_WIDTH_PRESETS.find((preset) => rangesMatch(preset, spreadWidth)) ?? null;
}

function findMatchingBidAskSpreadPreset(optionSpreadRange) {
  if (!optionSpreadRange || optionSpreadRange.type !== "percent") {
    return null;
  }

  return (
    BID_ASK_SPREAD_PRESETS.find(
      (preset) =>
        (preset.min ?? null) === (optionSpreadRange.min ?? null) &&
        (preset.max ?? null) === (optionSpreadRange.max ?? null)
    ) ?? null
  );
}

function normalizeExpectedPriceRange(minInput, maxInput) {
  const minValue = parseOptionalNumberInput(minInput);
  const maxValue = parseOptionalNumberInput(maxInput);
  const min = minValue == null ? DEFAULT_EXPECTED_PRICE_RANGE.min : minValue;
  const max = maxValue == null ? DEFAULT_EXPECTED_PRICE_RANGE.max : maxValue;

  return {
    min: Math.min(min, max),
    max: Math.max(min, max),
    type: "percent"
  };
}

function compareNullableValues(left, right) {
  if (left == null && right == null) {
    return 0;
  }

  if (left == null) {
    return 1;
  }

  if (right == null) {
    return -1;
  }

  if (typeof left === "string" || typeof right === "string") {
    return String(left).localeCompare(String(right));
  }

  return left - right;
}

function getTradingViewSortValue(row, sortKey) {
  switch (sortKey) {
    case "expiration":
      return parseIsoDate(row.expiration)?.getTime() ?? null;
    case "days":
      return row.daysToExpiration ?? null;
    case "assetLabel":
      return getTradingViewAssetLabel(row) ?? "";
    case "strategyType":
      return row.strategyTypeLabel ?? "";
    case "marketBias":
      return inferTradingViewMarketBias(row.strategyTypeKey).label ?? "";
    case "formula":
      return Array.isArray(row.legs)
        ? row.legs.map((leg) => `${leg?.action ?? ""}${formatStrategyLegLabel(leg)}`).join("|")
        : "";
    case "normalizedOptionVolume":
      return row.normalizedOptionVolume ?? null;
    case "midMinusTheo":
      return getTradingViewMidMinusTheo(row);
    case "probabilityOfProfit":
      return row.probabilityOfProfit ?? null;
    case "maxProfit":
      return row.maxProfit ?? null;
    case "maxLoss":
      return row.maxLoss == null ? null : Math.abs(row.maxLoss);
    case "rewardRisk":
      return row.rewardRisk ?? null;
    case "breakevens":
      return Array.isArray(row.breakevens) && row.breakevens.length ? row.breakevens[0] : null;
    case "theoPrice":
      return row.theoreticalPrice ?? null;
    case "bid":
      return row.bid ?? null;
    case "ask":
      return row.ask ?? null;
    case "bidAskSpread":
      return row.bidAskSpreadPercent ?? null;
    default:
      return null;
  }
}

function sortTradingViewRows(rows, sortState) {
  const normalizedSortState = Array.isArray(sortState) ? sortState : [];

  return [...rows].sort((left, right) => {
    for (const sortDescriptor of normalizedSortState) {
      if (!sortDescriptor?.key) {
        continue;
      }

      const directionMultiplier = sortDescriptor.direction === "asc" ? 1 : -1;
      const comparedValue = compareNullableValues(
        getTradingViewSortValue(left, sortDescriptor.key),
        getTradingViewSortValue(right, sortDescriptor.key)
      );

      if (comparedValue !== 0) {
        return comparedValue * directionMultiplier;
      }
    }

    return compareNullableValues(left.id ?? "", right.id ?? "");
  });
}

function getMetricTone(value, options = {}) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue === 0) {
    return "";
  }

  if (options.kind === "cost") {
    return "negative";
  }

  if (options.kind === "threshold") {
    return numericValue >= Number(options.threshold ?? 0) ? "positive" : "negative";
  }

  return numericValue > 0 ? "positive" : "negative";
}

const BULLISH_TRADING_VIEW_STRATEGIES = new Set([
  "long_call",
  "short_put",
  "bull_call_spread",
  "bull_put_spread",
  "jade_lizard",
  "strap"
]);
const BEARISH_TRADING_VIEW_STRATEGIES = new Set([
  "long_put",
  "short_call",
  "bear_call_spread",
  "bear_put_spread",
  "reverse_jade_lizard",
  "strip"
]);

function inferTradingViewMarketBias(strategyTypeKey) {
  const normalizedKey = String(strategyTypeKey ?? "").trim().toLowerCase();
  if (!normalizedKey) {
    return { label: "Neutral", tone: "neutral" };
  }

  if (normalizedKey.startsWith("bull_") || BULLISH_TRADING_VIEW_STRATEGIES.has(normalizedKey)) {
    return { label: "Bull", tone: "bull" };
  }

  if (normalizedKey.startsWith("bear_") || BEARISH_TRADING_VIEW_STRATEGIES.has(normalizedKey)) {
    return { label: "Bear", tone: "bear" };
  }

  return { label: "Neutral", tone: "neutral" };
}

function buildOptionalVolumeRange(minInput, maxInput) {
  const minValue = parseOptionalNumberInput(minInput);
  const maxValue = parseOptionalNumberInput(maxInput);

  const min = minValue == null ? null : Math.max(0, Math.round(minValue));
  const max = maxValue == null ? null : Math.max(1, Math.round(maxValue));

  if (min == null && max == null) {
    return null;
  }

  if (min != null && max != null) {
    return {
      min: Math.min(min, max),
      max: Math.max(min, max)
    };
  }

  if (min != null) {
    return { min };
  }

  return {
    min: 0,
    max
  };
}

function buildOptionalSpreadWidthRange(minInput, maxInput) {
  const minValue = parseOptionalNumberInput(minInput);
  const maxValue = parseOptionalNumberInput(maxInput);

  const min = minValue == null ? null : Math.max(0, Math.round(minValue));
  const max = maxValue == null ? null : Math.max(1, Math.round(maxValue));

  if (min == null && max == null) {
    return null;
  }

  if (min != null && max != null) {
    return {
      min: Math.min(min, max),
      max: Math.max(min, max)
    };
  }

  if (min != null) {
    return {
      min,
      max: min + 1
    };
  }

  return {
    min: Math.max((max ?? 1) - 1, 0),
    max: max ?? 1
  };
}

function buildOptionalOptionSpreadRange(minInput, maxInput, type = "percent") {
  const minValue = parseOptionalNumberInput(minInput);
  const maxValue = parseOptionalNumberInput(maxInput);
  const min = minValue != null && minValue > 0 ? minValue : null;
  const max = maxValue != null && maxValue > 0 ? maxValue : null;

  if (min == null && max == null) {
    return null;
  }

  if (min != null && max != null) {
    return {
      min: Math.min(min, max),
      max: Math.max(min, max),
      type: type === "value" ? "value" : "percent"
    };
  }

  if (min != null) {
    return {
      min,
      type: type === "value" ? "value" : "percent"
    };
  }

  return {
    max,
    type: type === "value" ? "value" : "percent"
  };
}

function summarizeVolumeRange(volumeRange) {
  if (!volumeRange) {
    return "Volume";
  }

  if (volumeRange.min != null && volumeRange.max != null) {
    return `${formatCompactValue(volumeRange.min)} to ${formatCompactValue(volumeRange.max)}`;
  }

  return `Above ${formatCompactValue(volumeRange.min ?? 0)}`;
}

function summarizeSpreadWidth(spreadWidth) {
  if (!spreadWidth) {
    return "Spread width";
  }

  return `${formatCompactValue(spreadWidth.min)} to ${formatCompactValue(spreadWidth.max)} strikes`;
}

function summarizeMoneyness(selectedKeys) {
  const allSelected = selectedKeys.length >= TRADING_VIEW_MONEYNESS_OPTIONS.length;

  if (allSelected) {
    return "Moneyness";
  }

  const selectedLabels = TRADING_VIEW_MONEYNESS_OPTIONS.filter((option) =>
    selectedKeys.includes(option.key)
  ).map((option) => option.label);

  if (!selectedLabels.length) {
    return "Moneyness (none)";
  }

  if (selectedLabels.length === 1) {
    return selectedLabels[0];
  }

  return `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function summarizeOptionSpreadRange(optionSpreadRange) {
  if (!optionSpreadRange) {
    return "Bid-ask spread";
  }

  const digits = optionSpreadRange.type === "value" ? 2 : 1;
  const suffix = optionSpreadRange.type === "value" ? "" : "%";

  if (optionSpreadRange.min != null && optionSpreadRange.max != null) {
    return `${formatCompactValue(optionSpreadRange.min, digits)}${suffix} to ${formatCompactValue(optionSpreadRange.max, digits)}${suffix}`;
  }

  if (optionSpreadRange.min != null) {
    return `Above ${formatCompactValue(optionSpreadRange.min, digits)}${suffix}`;
  }

  return `Below ${formatCompactValue(optionSpreadRange.max, digits)}${suffix}`;
}

function buildOptionalMetricRange(minInput, maxInput, options = {}) {
  const minValue = parseOptionalNumberInput(minInput);
  const maxValue = parseOptionalNumberInput(maxInput);
  const minimum = options.minimum;
  const integerOnly = options.integer === true;

  let min = minValue;
  let max = maxValue;

  if (integerOnly) {
    min = min == null ? null : Math.round(min);
    max = max == null ? null : Math.round(max);
  }

  if (minimum != null) {
    min = min == null ? null : Math.max(min, minimum);
    max = max == null ? null : Math.max(max, minimum);
  }

  if (min == null && max == null) {
    return null;
  }

  if (min != null && max != null) {
    return {
      min: Math.min(min, max),
      max: Math.max(min, max)
    };
  }

  if (min != null) {
    return { min };
  }

  return { max };
}

function summarizeMetricRange(range, { label, formatValue }) {
  if (!range) {
    return label;
  }

  if (range.min != null && range.max != null) {
    return `${formatValue(range.min)} to ${formatValue(range.max)}`;
  }

  if (range.min != null) {
    return `>= ${formatValue(range.min)}`;
  }

  return `<= ${formatValue(range.max)}`;
}

function matchesMetricRange(value, range) {
  if (!range) {
    return true;
  }

  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return false;
  }

  if (range.min != null && numericValue < range.min) {
    return false;
  }

  if (range.max != null && numericValue > range.max) {
    return false;
  }

  return true;
}

function matchesTradingViewOptionSpreadRange(row, optionSpreadRange) {
  if (!optionSpreadRange) {
    return true;
  }

  const spreadValue = getTradingViewBidAskSpreadValue(row, optionSpreadRange.type);
  if (!Number.isFinite(spreadValue)) {
    return false;
  }

  if (optionSpreadRange.min != null && spreadValue < optionSpreadRange.min) {
    return false;
  }

  if (optionSpreadRange.max != null && spreadValue > optionSpreadRange.max) {
    return false;
  }

  return true;
}

function formatStrategyLegLabel(leg) {
  if (!leg) {
    return "";
  }

  const strike = Number(leg.strike ?? 0);
  const optionCode = leg.optionType === "put" ? "P" : "C";
  return `${Number.isFinite(strike) ? strike.toFixed(0) : "?"}${optionCode}`;
}

function buildTradingViewLegTitle(leg) {
  const strike = Number(leg?.strike ?? 0);
  const strikeLabel = Number.isFinite(strike) ? strike.toFixed(2) : "0.00";
  return `${leg?.action ?? "LONG"} ${String(leg?.optionType ?? "call").toUpperCase()} ${strikeLabel}`;
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

function scaleTradingViewOrderToComboQuantity(order, comboQuantity) {
  if (!order) {
    return order;
  }

  const normalizedComboQuantity = normalizeComboQuantityInput(comboQuantity, 1);
  const optionLegs = (order.legs ?? []).filter((leg) => leg?.kind === "option");
  if (!optionLegs.length) {
    return order;
  }

  const baseQuantity =
    optionLegs.reduce((current, leg) => {
      const quantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
      return quantity ? gcd(current, quantity) : current;
    }, 0) || 1;

  const ratioByLegId = new Map();
  optionLegs.forEach((leg) => {
    const quantity = Math.max(Math.round(Number(leg?.quantity ?? 0) || 0), 0);
    ratioByLegId.set(String(leg?.id ?? ""), quantity > 0 ? quantity / baseQuantity : 1);
  });

  return {
    ...order,
    legs: (order.legs ?? []).map((leg) => {
      if (leg?.kind !== "option") {
        return leg;
      }

      const ratio = ratioByLegId.get(String(leg?.id ?? "")) ?? 1;
      return {
        ...leg,
        quantity: Math.max(Math.round(ratio * normalizedComboQuantity), 1)
      };
    })
  };
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

function cloneTradingViewScenarioOrder(order) {
  if (!order) {
    return null;
  }

  return {
    ...order,
    valuationContext: {
      ...(order.valuationContext ?? {})
    },
    legs: (order.legs ?? []).map((leg) => ({
      ...leg
    }))
  };
}

function buildTradingViewPaperOrderPayload({
  order,
  row,
  strategyDefinition,
  purchaseDate,
  execution
}) {
  if (!order) {
    return null;
  }

  const optionLegs = (order.legs ?? []).map((leg, index) => ({
    id: leg.id ?? `${order.id}-leg-${index + 1}`,
    label: leg.label ?? buildTradingViewLegTitle(leg),
    kind: "option",
    action: leg.action,
    quantity: Number(leg.quantity ?? 0),
    entryPrice: Number(leg.entryPrice ?? 0),
    contractMultiplier: Number(leg.contractMultiplier ?? 100) || 100,
    optionType: leg.optionType ?? "call",
    expiry: leg.expiry ?? order.strategyCloseDate ?? "",
    strike: Number(leg.strike ?? 0),
    contractSymbol: leg.contractSymbol ?? "",
    rootSymbol: leg.rootSymbol ?? order.valuationContext?.underlyingSymbol ?? order.assetLabel ?? "",
    impliedVolatility: Number(leg.impliedVolatility ?? order.legs?.[0]?.impliedVolatility ?? 0.24) || 0.24,
    riskFreeRate: Number(leg.riskFreeRate ?? order.legs?.[0]?.riskFreeRate ?? 0.0425) || 0.0425,
    quoteSource: leg.quoteSource ?? "TradingView",
    isLive: leg.isLive === true
  }));

  return {
    strategyId: strategyDefinition?.id ?? "strategy-tv-finder",
    strategyName: strategyDefinition?.name ?? "TradingView Strategy Finder",
    combinationId: order.id,
    combinationLabel:
      order.combinationLabel ??
      `${order.assetLabel ?? row?.underlyingSymbol ?? "Underlying"} · ${order.strategyType ?? row?.strategyTypeLabel ?? "Strategy"} · ${order.strategyCloseDate ?? row?.expiration ?? ""}`,
    assetLabel: order.assetLabel ?? row?.underlyingSymbol ?? "",
    strategyType: order.strategyType ?? row?.strategyTypeLabel ?? "",
    marketBias: "",
    marketBiasTone: "",
    maxProfit: row?.maxProfit ?? null,
    maxLoss: row?.maxLoss ?? null,
    maxProfitUnbounded: false,
    maxLossUnbounded: false,
    purchaseDate: purchaseDate || new Date().toISOString().slice(0, 10),
    polymarketResolutionDate: order.polymarketResolutionDate || order.strategyCloseDate || row?.expiration || "",
    strategyCloseDate: order.strategyCloseDate || row?.expiration || "",
    marketReferenceYesPrice:
      Number(order.marketReferenceYesPrice ?? order.valuationContext?.currentYesPrice ?? 0.5) || 0.5,
    marketContext: {
      proxySymbol: order.valuationContext?.proxySymbol ?? row?.underlyingSymbol ?? "",
      underlyingSymbol: order.valuationContext?.underlyingSymbol ?? row?.underlyingSymbol ?? "",
      currentProxySpot:
        Number(order.valuationContext?.currentProxySpot ?? row?.underlyingPrice ?? 0) || 0,
      currentUnderlyingSpot:
        Number(order.valuationContext?.currentUnderlyingSpot ?? row?.underlyingPrice ?? 0) || 0,
      conversionRatio: Number(order.valuationContext?.conversionRatio ?? 1) || 1,
      targetUnderlyingValue:
        Number(order.valuationContext?.targetUnderlyingValue ?? row?.breakevens?.[0] ?? row?.underlyingPrice ?? 0) || 0,
      impliedVolatility:
        Number(order.legs?.[0]?.impliedVolatility ?? row?.annualizedVolatility ?? 0.24) || 0.24,
      riskFreeRate: Number(order.legs?.[0]?.riskFreeRate ?? 0.0425) || 0.0425
    },
    legs: optionLegs,
    execution:
      execution && typeof execution === "object"
        ? execution
        : {
            route: "local-paper"
          }
  };
}

function buildTradingViewScenarioOrder(row, generatedAt) {
  if (!row) {
    return null;
  }

  const purchaseDate = String(generatedAt ?? new Date().toISOString()).slice(0, 10);
  const currentSpot = Number(row.underlyingPrice ?? 0);
  const targetUnderlyingValue =
    Number(row.breakevens?.[0] ?? 0) ||
    (currentSpot > 0
      ? currentSpot * (1 + Number(row.requestPriceRange?.max ?? 10) / 100)
      : 0);

  return {
    id: row.id,
    combinationLabel: `${row.underlyingSymbol} · ${row.strategyTypeLabel} · ${row.expiration || purchaseDate}`,
    assetLabel: row.underlyingFamily || row.underlyingSymbol,
    createdAt: generatedAt ?? null,
    closedAt: "",
    legs: (row.legs ?? []).map((leg, index) => ({
      action: leg.action,
      ask: leg.ask ?? null,
      askSize: leg.askSize ?? null,
      bid: leg.bid ?? null,
      bidSize: leg.bidSize ?? null,
      contractMultiplier: Number(leg.contractMultiplier ?? 100),
      contractSymbol: leg.contractSymbol ?? "",
      entryPrice: Number(leg.entryPrice ?? 0),
      expiry: leg.expiration ?? row.expiration ?? purchaseDate,
      id: `${row.id}:option:${index}`,
      impliedVolatility: Number(leg.impliedVolatility ?? row.annualizedVolatility ?? 0.24) || 0.24,
      isLive: leg.isLive === true,
      kind: "option",
      label: `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}`,
      optionType: leg.optionType ?? "call",
      quantity: Number(leg.quantity ?? 0),
      quoteSource: leg.quoteSource ?? "TradingView",
      riskFreeRate: Number(leg.riskFreeRate ?? 0.0425) || 0.0425,
      rootSymbol: leg.rootSymbol ?? row.underlyingFamily ?? row.underlyingSymbol,
      strike: Number(leg.strike ?? 0),
      volume: leg.volume ?? null,
      openInterest: leg.openInterest ?? null,
      hasRealBidAsk: leg.hasRealBidAsk === true
    })),
    marketReferenceYesPrice: 0.5,
    polymarketMarketId: "",
    polymarketQuestion: "",
    polymarketResolutionDate: row.expiration || purchaseDate,
    polymarketUrl: "",
    purchaseDate,
    status: "open",
    strategyCloseDate: row.expiration || purchaseDate,
    strategyType: row.strategyTypeLabel,
    valuationContext: {
      conversionRatio: 1,
      currentProxySpot: currentSpot,
      currentUnderlyingSpot: currentSpot,
      currentYesPrice: 0.5,
      proxySymbol: row.underlyingFamily || row.underlyingSymbol,
      targetUnderlyingValue,
      underlyingSymbol: row.underlyingFamily || row.underlyingSymbol
    }
  };
}

export default function TradingViewStrategyWorkspace({
  strategyDefinition = null,
  paperPortfolio = null,
  onCreatePaperOrder = null,
  onConfirmPaperExecution = null,
  onOpenPaperTrading = null,
  onMarketTimerContextChange = null,
  theme = "dark"
}) {
  const tableColumnCount = TRADING_VIEW_TABLE_COLUMNS.length;
  const filterMenuRefs = useRef({});
  const savedFilters = useMemo(() => loadSavedFilters(TRADING_VIEW_FILTERS_STORAGE_KEY), []);
  const [symbolInput, setSymbolInput] = useState(() =>
    typeof savedFilters?.symbolInput === "string" ? savedFilters.symbolInput : "SPY"
  );
  const [savedTickers, setSavedTickers] = useState(() => readSavedTradingViewTickers());
  const [dateFrom, setDateFrom] = useState(() =>
    typeof savedFilters?.dateFrom === "string" ? savedFilters.dateFrom : startOfCurrentMonthIso()
  );
  const [dateTo, setDateTo] = useState(() =>
    typeof savedFilters?.dateTo === "string" ? savedFilters.dateTo : endOfCurrentMonthIso()
  );
  const [priceMin, setPriceMin] = useState(() =>
    typeof savedFilters?.priceMin === "string" ? savedFilters.priceMin : String(DEFAULT_EXPECTED_PRICE_RANGE.min)
  );
  const [priceMax, setPriceMax] = useState(() =>
    typeof savedFilters?.priceMax === "string" ? savedFilters.priceMax : String(DEFAULT_EXPECTED_PRICE_RANGE.max)
  );
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [selectedStrategyTypeKeys, setSelectedStrategyTypeKeys] = useState(() => {
    const savedKeys = savedFilters?.selectedStrategyTypeKeys;
    if (!Array.isArray(savedKeys)) {
      return TRADING_VIEW_STRATEGY_TYPE_KEYS.slice();
    }
    if (savedKeys.length === 0) {
      return [];
    }
    const next = savedKeys.filter((key) => TRADING_VIEW_STRATEGY_TYPE_KEYS.includes(key));
    return next.length ? next : TRADING_VIEW_STRATEGY_TYPE_KEYS.slice();
  });
  const [strategyTypeSearchInput, setStrategyTypeSearchInput] = useState("");
  const [moneynessSearchInput, setMoneynessSearchInput] = useState("");
  const [volumeMin, setVolumeMin] = useState(() => (typeof savedFilters?.volumeMin === "string" ? savedFilters.volumeMin : ""));
  const [volumeMax, setVolumeMax] = useState(() => (typeof savedFilters?.volumeMax === "string" ? savedFilters.volumeMax : ""));
  const [spreadWidthMin, setSpreadWidthMin] = useState(() =>
    typeof savedFilters?.spreadWidthMin === "string" ? savedFilters.spreadWidthMin : ""
  );
  const [spreadWidthMax, setSpreadWidthMax] = useState(() =>
    typeof savedFilters?.spreadWidthMax === "string" ? savedFilters.spreadWidthMax : ""
  );
  const [selectedMoneynessKeys, setSelectedMoneynessKeys] = useState(() => {
    const allKeys = TRADING_VIEW_MONEYNESS_OPTIONS.map((option) => option.key);
    const savedKeys = savedFilters?.selectedMoneynessKeys;
    if (!Array.isArray(savedKeys)) {
      return allKeys;
    }
    if (savedKeys.length === 0) {
      return [];
    }
    const next = savedKeys.filter((key) => allKeys.includes(key));
    return next.length ? next : allKeys;
  });
  const [symmetryOnly, setSymmetryOnly] = useState(savedFilters?.symmetryOnly === true);
  const [optionSpreadType, setOptionSpreadType] = useState(
    savedFilters?.optionSpreadType === "points" ? "points" : "percent"
  );
  const [optionSpreadMin, setOptionSpreadMin] = useState(() =>
    typeof savedFilters?.optionSpreadMin === "string" ? savedFilters.optionSpreadMin : ""
  );
  const [optionSpreadMax, setOptionSpreadMax] = useState(() =>
    typeof savedFilters?.optionSpreadMax === "string" ? savedFilters.optionSpreadMax : ""
  );
  const [normalizedVolumeMin, setNormalizedVolumeMin] = useState(() =>
    typeof savedFilters?.normalizedVolumeMin === "string" ? savedFilters.normalizedVolumeMin : ""
  );
  const [normalizedVolumeMax, setNormalizedVolumeMax] = useState(() =>
    typeof savedFilters?.normalizedVolumeMax === "string" ? savedFilters.normalizedVolumeMax : ""
  );
  const [tableMaxLossMin, setTableMaxLossMin] = useState(() =>
    typeof savedFilters?.tableMaxLossMin === "string" ? savedFilters.tableMaxLossMin : DEFAULT_TABLE_MAX_LOSS_MIN
  );
  const [tableMaxLossMax, setTableMaxLossMax] = useState(() =>
    typeof savedFilters?.tableMaxLossMax === "string" ? savedFilters.tableMaxLossMax : DEFAULT_TABLE_MAX_LOSS_MAX
  );
  const [midMinusTheoMin, setMidMinusTheoMin] = useState(() =>
    typeof savedFilters?.midMinusTheoMin === "string" ? savedFilters.midMinusTheoMin : ""
  );
  const [midMinusTheoMax, setMidMinusTheoMax] = useState(() =>
    typeof savedFilters?.midMinusTheoMax === "string" ? savedFilters.midMinusTheoMax : ""
  );
  const [sortState, setSortState] = useState([{ key: "rewardRisk", direction: "desc" }]);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [liveTheoPrice, setLiveTheoPrice] = useState(null);
  const liveTheoRowIdRef = useRef(null);
  const [liveOptionLegQuotes, setLiveOptionLegQuotes] = useState({});
  const [liveOptionLegQuotesUpdatedAt, setLiveOptionLegQuotesUpdatedAt] = useState(null);
  const liveOptionQuoteRowIdRef = useRef(null);
  const [strategyEditorOpen, setStrategyEditorOpen] = useState(false);
  const [scenarioOrderDraft, setScenarioOrderDraft] = useState(null);
  const [strategyDirection, setStrategyDirection] = useState("LONG");
  const [optionChains, setOptionChains] = useState({});
  const [optionChainStatus, setOptionChainStatus] = useState({});
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperComboQuantity, setPaperComboQuantity] = useState(1);
  const [paperComboQuantityInput, setPaperComboQuantityInput] = useState("1");
  const [activeLegId, setActiveLegId] = useState("");
  const [chainShowAll, setChainShowAll] = useState(false);
  const datePresets = useMemo(() => buildDatePresets(todayIso()), []);
  const dateRange = useMemo(
    () => ({
      from: dateFrom,
      to: dateTo
    }),
    [dateFrom, dateTo]
  );
  const priceRange = useMemo(
    () => normalizeExpectedPriceRange(priceMin, priceMax),
    [priceMax, priceMin]
  );
  const activeDatePreset = useMemo(
    () => findMatchingDatePreset(dateRange, datePresets),
    [datePresets, dateRange]
  );
  const dateRangeSummary = useMemo(
    () => summarizeDateRange(dateRange, datePresets),
    [datePresets, dateRange]
  );
  const activeExpectedPricePreset = useMemo(
    () => findMatchingExpectedPricePreset(priceRange),
    [priceRange]
  );
  const expectedPriceSummary = useMemo(
    () => summarizeExpectedPriceRange(priceRange),
    [priceRange]
  );
  const isDefaultExpectedPriceRange =
    priceRange.min === DEFAULT_EXPECTED_PRICE_RANGE.min &&
    priceRange.max === DEFAULT_EXPECTED_PRICE_RANGE.max;

  const allStrategyTypeKeys = useMemo(
    () => TRADING_VIEW_STRATEGY_TYPES.map((strategyType) => strategyType.key),
    []
  );
  const allStrategyTypesSelected = selectedStrategyTypeKeys.length >= allStrategyTypeKeys.length;
  const strategyTypeSummary = useMemo(
    () => summarizeSelectedStrategyTypes(selectedStrategyTypeKeys),
    [selectedStrategyTypeKeys]
  );
  const visibleStrategyTypes = useMemo(() => {
    const normalizedQuery = strategyTypeSearchInput.trim().toLowerCase();
    if (!normalizedQuery) {
      return TRADING_VIEW_STRATEGY_TYPES;
    }

    return TRADING_VIEW_STRATEGY_TYPES.filter((strategyType) =>
      strategyType.label.toLowerCase().includes(normalizedQuery)
    );
  }, [strategyTypeSearchInput]);
  const volumeRange = useMemo(
    () => buildOptionalVolumeRange(volumeMin, volumeMax),
    [volumeMin, volumeMax]
  );
  const spreadWidth = useMemo(
    () => buildOptionalSpreadWidthRange(spreadWidthMin, spreadWidthMax),
    [spreadWidthMin, spreadWidthMax]
  );
  const allMoneynessKeys = useMemo(() => TRADING_VIEW_MONEYNESS_OPTIONS.map((option) => option.key), []);
  const allMoneynessSelected = selectedMoneynessKeys.length >= allMoneynessKeys.length;
  const moneyness = useMemo(() => {
    if (allMoneynessSelected || selectedMoneynessKeys.length === 0) {
      return null;
    }

    return selectedMoneynessKeys.reduce((result, key) => {
      result[key] = true;
      return result;
    }, {});
  }, [allMoneynessSelected, selectedMoneynessKeys]);
  const optionSpreadRange = useMemo(
    () => buildOptionalOptionSpreadRange(optionSpreadMin, optionSpreadMax, optionSpreadType),
    [optionSpreadMin, optionSpreadMax, optionSpreadType]
  );
  const normalizedVolumeRange = useMemo(
    () => buildOptionalMetricRange(normalizedVolumeMin, normalizedVolumeMax, { integer: true, minimum: 0 }),
    [normalizedVolumeMax, normalizedVolumeMin]
  );
  const maxLossRange = useMemo(
    () => buildOptionalMetricRange(tableMaxLossMin, tableMaxLossMax),
    [tableMaxLossMax, tableMaxLossMin]
  );
  const midMinusTheoRange = useMemo(
    () => buildOptionalMetricRange(midMinusTheoMin, midMinusTheoMax),
    [midMinusTheoMax, midMinusTheoMin]
  );
  const activeVolumePreset = useMemo(() => findMatchingVolumePreset(volumeRange), [volumeRange]);
  const activeSpreadWidthPreset = useMemo(
    () => findMatchingSpreadWidthPreset(spreadWidth),
    [spreadWidth]
  );
  const activeBidAskSpreadPreset = useMemo(
    () => findMatchingBidAskSpreadPreset(optionSpreadRange),
    [optionSpreadRange]
  );
  const volumeSummary = useMemo(() => summarizeVolumeRange(volumeRange), [volumeRange]);
  const spreadWidthSummary = useMemo(() => summarizeSpreadWidth(spreadWidth), [spreadWidth]);
  const moneynessSummary = useMemo(
    () => summarizeMoneyness(selectedMoneynessKeys),
    [selectedMoneynessKeys]
  );
  const optionSpreadSummary = useMemo(
    () => summarizeOptionSpreadRange(optionSpreadRange),
    [optionSpreadRange]
  );
  const normalizedVolumeSummary = useMemo(
    () =>
      summarizeMetricRange(normalizedVolumeRange, {
        label: "Opt vol (norm)",
        formatValue: (value) => formatCompactCount(value)
      }),
    [normalizedVolumeRange]
  );
  const maxLossSummary = useMemo(
    () =>
      summarizeMetricRange(maxLossRange, {
        label: "Max loss",
        formatValue: (value) => formatSummaryCurrency(value)
      }),
    [maxLossRange]
  );
  const midMinusTheoSummary = useMemo(
    () =>
      summarizeMetricRange(midMinusTheoRange, {
        label: "Avg B/A - Theo",
        formatValue: (value) => formatSummaryCurrency(value)
      }),
    [midMinusTheoRange]
  );
  const visibleMoneynessOptions = useMemo(() => {
    const normalizedQuery = moneynessSearchInput.trim().toLowerCase();

    if (!normalizedQuery) {
      return TRADING_VIEW_MONEYNESS_OPTIONS;
    }

    return TRADING_VIEW_MONEYNESS_OPTIONS.filter((option) =>
      option.label.toLowerCase().includes(normalizedQuery)
    );
  }, [moneynessSearchInput]);
  const normalizedSymbolTag = useMemo(() => normalizeTradingViewTickerTag(symbolInput), [symbolInput]);

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

  async function loadStrategies() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/tradingview/strategy-finder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          dateRange,
          priceRange,
          ...(moneyness ? { moneyness } : {}),
          ...(optionSpreadRange ? { optionSpreadRange } : {}),
          ...(spreadWidth ? { spreadWidth } : {}),
          strategyTypes: allStrategyTypesSelected ? [] : selectedStrategyTypeKeys,
          ...(symmetryOnly ? { symmetry: true } : {}),
          ...(volumeRange ? { volumeRange } : {}),
          symbol: normalizeTradingViewSymbolInput(symbolInput)
        })
      });
      const nextPayload = await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(nextPayload?.error || "TradingView scan failed");
      }

      setPayload(nextPayload);
    } catch (scanError) {
      setPayload(null);
      setSelectedRowId(null);
      setError(scanError.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStrategies();
  }, []);

  const rows = payload?.rows ?? [];
  const filteredRows = useMemo(
    () => {
      if (!selectedStrategyTypeKeys.length || !selectedMoneynessKeys.length) {
        return [];
      }

      return rows.filter((row) => {
        const normalizedVolumeMatch = matchesMetricRange(row.normalizedOptionVolume, normalizedVolumeRange);
        const maxLossMatch = matchesMetricRange(row.maxLoss, maxLossRange);
        const bidAskSpreadMatch = matchesTradingViewOptionSpreadRange(row, optionSpreadRange);
        const midMinusTheoMatch = matchesMetricRange(getTradingViewMidMinusTheo(row), midMinusTheoRange);
        const strategyTypeMatch = selectedStrategyTypeKeys.includes(row.strategyTypeKey);

        return normalizedVolumeMatch && maxLossMatch && bidAskSpreadMatch && midMinusTheoMatch && strategyTypeMatch;
      });
    },
    [
      maxLossRange,
      midMinusTheoRange,
      normalizedVolumeRange,
      optionSpreadRange,
      rows,
      selectedMoneynessKeys,
      selectedStrategyTypeKeys
    ]
  );
  const sortedRows = useMemo(
    () => sortTradingViewRows(filteredRows, sortState),
    [filteredRows, sortState]
  );
  const visibleRowsCountLabel =
    filteredRows.length !== rows.length ? `${filteredRows.length}/${rows.length}` : String(filteredRows.length);
  const selectedRow = sortedRows.find((row) => row.id === selectedRowId) ?? null;
  const baseScenarioOrder = useMemo(
    () => buildTradingViewScenarioOrder(selectedRow, payload?.generatedAt),
    [payload?.generatedAt, selectedRow]
  );
  const selectedScenarioOrder = scenarioOrderDraft ?? baseScenarioOrder;
  const optionRootSymbol =
    selectedScenarioOrder?.valuationContext?.proxySymbol ??
    selectedScenarioOrder?.valuationContext?.underlyingSymbol ??
    (selectedScenarioOrder?.legs ?? []).find((leg) => leg?.kind === "option")?.rootSymbol ??
    selectedRow?.underlyingFamily ??
    selectedRow?.underlyingSymbol ??
    "";
  const chainSpot = Number(selectedScenarioOrder?.valuationContext?.currentProxySpot ?? selectedRow?.underlyingPrice ?? 0);
  const optionLegs = (selectedScenarioOrder?.legs ?? []).filter((leg) => leg?.kind === "option");
  const activeOptionLeg =
    optionLegs.find((leg) => leg.id === activeLegId) ?? optionLegs[optionLegs.length - 1] ?? null;
  const activeChainExpiration = activeOptionLeg?.expiry ?? selectedScenarioOrder?.strategyCloseDate ?? "";
  const activeExpiryTabs = useMemo(
    () => {
      if (!activeChainExpiration) {
        return [];
      }

      const tabs = buildWeeklyExpiryTabs(activeChainExpiration);
      const minIso = todayIso();
      return tabs.filter((value) => value >= minIso);
    },
    [activeChainExpiration]
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

    const normalizedSpot = Number(chainSpot ?? 0);
    if (chainShowAll) {
      return strikes.map((strike) => contractsByStrike.get(strike));
    }

    const strikeWindow = 30;
    const windowedStrikes =
      Number.isFinite(normalizedSpot) && normalizedSpot > 0
        ? [...strikes]
            .sort((left, right) => {
              const leftDistance = Math.abs(left - normalizedSpot);
              const rightDistance = Math.abs(right - normalizedSpot);
              return leftDistance === rightDistance ? left - right : leftDistance - rightDistance;
            })
            .slice(0, strikeWindow)
            .sort((left, right) => left - right)
        : strikes.slice(0, strikeWindow);

    return windowedStrikes.map((strike) => contractsByStrike.get(strike));
  }, [activeCallChain?.contracts, activePutChain?.contracts, chainShowAll, chainSpot]);
  const marketTimerContext = useMemo(() => {
    if (!selectedRow) {
      return null;
    }

    return createMarketTimerContext({
      source: "tradingview",
      label: selectedRow.underlyingFamily || selectedRow.underlyingSymbol,
      optionSymbol: selectedRow.legs?.[0]?.rootSymbol ?? selectedRow.underlyingFamily ?? selectedRow.underlyingSymbol,
      underlyingSymbol: selectedRow.underlyingSymbol,
      referenceSymbol: selectedRow.underlyingSymbol,
      optionExpiries: [
        selectedRow.expiration,
        ...(selectedRow.legs ?? []).map((leg) => leg.expiration)
      ],
      exerciseStyle: "american",
      settlementType: "physical"
    });
  }, [selectedRow]);

  const optionLegQuoteSignature = useMemo(() => {
    const optionLegs = (selectedScenarioOrder?.legs ?? []).filter((leg) => leg?.kind === "option");

    return optionLegs
      .map(
        (leg) =>
          `${leg.id}:${leg.contractSymbol}:${leg.expiry}:${leg.optionType}:${leg.strike}:${leg.quantity}:${leg.action}`
      )
      .join("|");
  }, [selectedScenarioOrder?.legs]);

  useEffect(() => {
    if (!selectedRow || detailCollapsed) {
      setLiveTheoPrice(null);
      liveTheoRowIdRef.current = null;
      return;
    }

    let cancelled = false;
    let controller = null;
    let inFlight = false;
    const rowId = selectedRow.id ?? null;
    if (rowId && liveTheoRowIdRef.current !== rowId) {
      liveTheoRowIdRef.current = rowId;
      setLiveTheoPrice(null);
    }
    const symbol = selectedRow.underlyingFamily || selectedRow.underlyingSymbol || "";
    const spotFallback = Number(selectedRow.underlyingPrice ?? NaN);
    const legs = Array.isArray(selectedRow.legs) ? selectedRow.legs : [];

    async function refreshLiveTheoPrice() {
      if (inFlight) {
        return;
      }

      inFlight = true;
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await fetch("/api/tradingview/theo-price", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          signal: controller.signal,
          cache: "no-store",
          body: JSON.stringify({
            symbol,
            spot: Number.isFinite(spotFallback) ? spotFallback : null,
            legs
          })
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok) {
          throw new Error(payload?.error || "Unable to load live theo price");
        }

        const nextTheo = Number(payload?.theoPrice ?? NaN);

        if (!cancelled) {
          setLiveTheoPrice(Number.isFinite(nextTheo) ? nextTheo : null);
        }
      } catch (_error) {
        // Keep the last known live theo visible if the lightweight poll fails.
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
  }, [detailCollapsed, payload?.generatedAt, selectedRow?.id]);

  const liveComboQuote = useMemo(() => {
    const optionLegs = (selectedScenarioOrder?.legs ?? []).filter(
      (leg) => leg?.kind === "option" && Number(leg?.quantity ?? 0) > 0
    );
    if (!optionLegs.length) {
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

    const lotCount = optionLegs.reduce((current, leg) => {
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

    optionLegs.forEach((leg) => {
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
  }, [liveOptionLegQuotes, selectedScenarioOrder?.legs]);

  useEffect(() => {
    if (!selectedScenarioOrder || detailCollapsed || !optionRootSymbol) {
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
      liveOptionQuoteRowIdRef.current = null;
      return;
    }

    const rowId = selectedScenarioOrder.id ?? selectedRow?.id ?? null;
    if (rowId && liveOptionQuoteRowIdRef.current !== rowId) {
      liveOptionQuoteRowIdRef.current = rowId;
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
    }

    const optionLegs = (selectedScenarioOrder.legs ?? []).filter(
      (leg) => leg?.kind === "option" && Number(leg?.quantity ?? 0) > 0
    );

    if (!optionLegs.length) {
      setLiveOptionLegQuotes({});
      setLiveOptionLegQuotesUpdatedAt(null);
      return;
    }

    const groupLegs = new Map();
    optionLegs.forEach((leg) => {
      const expiration = String(leg?.expiry ?? "").trim();
      if (!expiration) {
        return;
      }

      const optionType = String(leg?.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
      const strike = Number(leg?.strike ?? NaN);
      if (!Number.isFinite(strike) || strike <= 0) {
        return;
      }

      const key = buildChainKey(optionRootSymbol, expiration, optionType);
      const current = groupLegs.get(key) ?? {
        expiration,
        optionType,
        strikes: []
      };
      current.strikes.push(strike);
      groupLegs.set(key, current);
    });

    if (!groupLegs.size) {
      setLiveOptionLegQuotes({});
      return;
    }

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
          const padding = Math.max((maxStrike - minStrike) * 0.15, chainSpot > 200 ? 5 : 1);
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

        const contractsByGroup = new Map();
        results.forEach((result) => {
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
          optionLegs.forEach((leg) => {
            const expiration = String(leg?.expiry ?? "").trim();
            const optionType = String(leg?.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call";
            const key = buildChainKey(optionRootSymbol, expiration, optionType);
            const contracts = contractsByGroup.get(key) ?? [];

            const targetContractSymbol = String(leg?.contractSymbol ?? "").trim();
            const matched =
              (targetContractSymbol
                ? contracts.find(
                    (contract) => String(contract?.contractSymbol ?? "").trim() === targetContractSymbol
                  )
                : null) ??
              contracts.find((contract) => {
                const contractStrike = Number(contract?.strike ?? NaN);
                return Number.isFinite(contractStrike) && Math.abs(contractStrike - Number(leg.strike ?? 0)) < 0.01;
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
  }, [detailCollapsed, optionLegQuoteSignature, optionRootSymbol, selectedScenarioOrder, selectedRow?.id]);

  useEffect(() => {
    if (!sortedRows.length) {
      setSelectedRowId(null);
      return;
    }

    if (!selectedRowId) {
      return;
    }

    const selectionStillVisible = sortedRows.some((row) => row.id === selectedRowId);
    if (!selectionStillVisible) {
      setSelectedRowId(null);
      setDetailCollapsed(true);
    }
  }, [selectedRowId, sortedRows]);

  useEffect(() => {
    setScenarioOrderDraft(baseScenarioOrder ? cloneTradingViewScenarioOrder(baseScenarioOrder) : null);
    setStrategyDirection(inferStrategyDirection(baseScenarioOrder?.strategyType));
    setStrategyEditorOpen(false);
    setActiveLegId("");
    setChainShowAll(false);
    setOptionChains({});
    setOptionChainStatus({});
    setPaperOrderSaving(false);
    setPaperOrderState(null);
    setPaperTradeDate(baseScenarioOrder?.purchaseDate ?? new Date().toISOString().slice(0, 10));
    setPaperComboQuantity(1);
    setPaperComboQuantityInput("1");
  }, [baseScenarioOrder?.id]);

  function handleStrategyDirectionChange(nextDirection) {
    const normalizedNextDirection = normalizeStrategyDirection(nextDirection);
    const normalizedCurrentDirection = normalizeStrategyDirection(strategyDirection);
    if (normalizedNextDirection === normalizedCurrentDirection) {
      return;
    }

    setStrategyDirection(normalizedNextDirection);

    setScenarioOrderDraft((current) => {
      if (!current) {
        return current;
      }

      const nextStrategyType = formatStrategyTypeForDirection(current.strategyType, normalizedNextDirection);
      const labelSymbol =
        current?.valuationContext?.proxySymbol ??
        current?.valuationContext?.underlyingSymbol ??
        current?.assetLabel ??
        "";
      const closeDate = current.strategyCloseDate || current.purchaseDate || "";
      const nextCombinationLabel =
        labelSymbol && nextStrategyType && closeDate
          ? `${labelSymbol} · ${nextStrategyType} · ${closeDate}`
          : current.combinationLabel;

      return {
        ...current,
        strategyType: nextStrategyType,
        combinationLabel: nextCombinationLabel,
        legs: (current.legs ?? []).map((leg) => {
          if (!leg || typeof leg !== "object" || leg.kind !== "option") {
            return leg;
          }

          const nextLeg = {
            ...leg,
            action: invertPositionAction(leg.action)
          };

          return {
            ...nextLeg,
            label: buildTradingViewLegTitle(nextLeg)
          };
        })
      };
    });
  }

  function applyPaperComboQuantity(nextComboQuantity, { syncInput = true } = {}) {
    const normalizedComboQuantity = normalizeComboQuantityInput(nextComboQuantity, paperComboQuantity);
    setPaperComboQuantity(normalizedComboQuantity);
    if (syncInput) {
      setPaperComboQuantityInput(String(normalizedComboQuantity));
    }

    setScenarioOrderDraft((current) =>
      current ? scaleTradingViewOrderToComboQuantity(current, normalizedComboQuantity) : current
    );
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
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(
        TRADING_VIEW_SAVED_TICKERS_STORAGE_KEY,
        JSON.stringify(savedTickers)
      );
    } catch (_error) {
      // ignore storage failures
    }
  }, [savedTickers]);

  function toggleStrategyType(strategyTypeKey) {
    setSelectedStrategyTypeKeys((current) => {
      if (current.includes(strategyTypeKey)) {
        return current.filter((item) => item !== strategyTypeKey);
      }
      return [...current, strategyTypeKey];
    });
  }

  function isStrategyTypeSelected(strategyTypeKey) {
    return selectedStrategyTypeKeys.includes(strategyTypeKey);
  }

  function toggleMoneynessKey(moneynessKey) {
    setSelectedMoneynessKeys((current) => {
      if (current.includes(moneynessKey)) {
        return current.filter((key) => key !== moneynessKey);
      }
      return [...current, moneynessKey];
    });
  }

  function isMoneynessSelected(moneynessKey) {
    return selectedMoneynessKeys.includes(moneynessKey);
  }

  function handleSubmit(event) {
    event.preventDefault();
    void loadStrategies();
  }

  function handleRowSelect(rowId) {
    setSelectedRowId(rowId);
    setDetailCollapsed(false);
  }

  function handleSaveTickerTag() {
    if (!normalizedSymbolTag) {
      return;
    }

    setSavedTickers((current) =>
      [normalizedSymbolTag, ...current.filter((ticker) => ticker !== normalizedSymbolTag)].slice(
        0,
        MAX_TRADING_VIEW_SAVED_TICKERS
      )
    );
  }

  function handleSelectSavedTicker(ticker) {
    setSymbolInput(ticker);
  }

  function handleRemoveSavedTicker(ticker) {
    setSavedTickers((current) => current.filter((item) => item !== ticker));
  }

  function updateScenarioDraftLeg(legId, patch) {
    setScenarioOrderDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        legs: current.legs.map((leg) => {
          if (leg.id !== legId) {
            return leg;
          }

          const nextLeg = {
            ...leg,
            ...patch
          };

          return {
            ...nextLeg,
            label: buildTradingViewLegTitle(nextLeg)
          };
        })
      };
    });
  }

  function buildManualDraftLeg(order) {
    const anchorLeg = (order?.legs ?? [])[order.legs.length - 1] ?? null;
    const spot = Number(order?.valuationContext?.currentProxySpot ?? 0);
    const strikeHint = Number.isFinite(spot) && spot > 0 ? Math.round(spot) : Number(anchorLeg?.strike ?? 0) || 0;
    const nextLegId = (() => {
      const seed =
        typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      return `${order?.id ?? "order"}:option:manual:${seed}`;
    })();

    const draftLeg = {
      action: "LONG",
      contractMultiplier: Number(anchorLeg?.contractMultiplier ?? 100) || 100,
      contractSymbol: "",
      entryPrice: 0,
      expiry: anchorLeg?.expiry ?? order?.strategyCloseDate ?? order?.purchaseDate ?? "",
      id: nextLegId,
      impliedVolatility:
        Number(anchorLeg?.impliedVolatility ?? order?.legs?.[0]?.impliedVolatility ?? 0.24) || 0.24,
      isLive: false,
      kind: "option",
      optionType: anchorLeg?.optionType ?? "call",
      quantity: Math.max(Math.round(Number(paperComboQuantity ?? 1) || 1), 1),
      quoteSource: "Manual",
      riskFreeRate: Number(anchorLeg?.riskFreeRate ?? 0.0425) || 0.0425,
      rootSymbol: anchorLeg?.rootSymbol ?? order?.valuationContext?.underlyingSymbol ?? order?.assetLabel ?? "",
      strike: strikeHint,
      bid: null,
      ask: null
    };

    return {
      ...draftLeg,
      label: buildTradingViewLegTitle(draftLeg)
    };
  }

  function handleAddDraftLeg() {
    if (!selectedScenarioOrder) {
      return;
    }

    const nextLeg = buildManualDraftLeg(selectedScenarioOrder);
    setActiveLegId(nextLeg.id);
    setScenarioOrderDraft((current) =>
      current
        ? {
            ...current,
            legs: [...(current.legs ?? []), nextLeg]
          }
        : current
    );
  }

  function handleRemoveDraftLeg(legId) {
    setActiveLegId((current) => (current === legId ? "" : current));
    setScenarioOrderDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        legs: (current.legs ?? []).filter((leg) => leg.id !== legId)
      };
    });
  }

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

  function refreshVisibleOptionChains() {
    if (optionRootSymbol && activeChainExpiration) {
      const strikeHint = Number(chainSpot ?? 0);
      const resolvedStrikeHint =
        Number.isFinite(strikeHint) && strikeHint > 0 ? strikeHint : Number(activeOptionLeg?.strike ?? 0) || 0;
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

    (selectedScenarioOrder?.legs ?? []).forEach((leg) => {
      if (leg?.kind !== "option") {
        return;
      }

      loadOptionChain({
        expiration: leg.expiry,
        optionType: leg.optionType,
        strikeHint: Number(leg.strike ?? chainSpot ?? 0) || 0,
        force: true
      });
    });
  }

  function handleChainExpirationChange(nextExpiration) {
    if (!activeOptionLeg || !nextExpiration) {
      return;
    }

    updateScenarioDraftLeg(activeOptionLeg.id, {
      expiry: nextExpiration,
      contractSymbol: "",
      quoteSource: "Manual",
      isLive: false
    });

    const strikeHint = Number(chainSpot ?? 0);
    const resolvedStrikeHint =
      Number.isFinite(strikeHint) && strikeHint > 0 ? strikeHint : Number(activeOptionLeg?.strike ?? 0) || 0;
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

  function handleToggleShowAllStrikes() {
    if (chainShowAll) {
      setChainShowAll(false);
      return;
    }

    setChainShowAll(true);
  }

  function applyChainContractToDraftLeg(legId, contract) {
    if (!contract) {
      return;
    }

    const currentAction =
      (selectedScenarioOrder?.legs ?? []).find((leg) => leg.id === legId)?.action ?? "LONG";
    const nextEntryPrice =
      currentAction === "SHORT"
        ? Number(contract.bid ?? contract.mark ?? contract.lastPrice ?? 0)
        : Number(contract.ask ?? contract.mark ?? contract.lastPrice ?? 0);

    updateScenarioDraftLeg(legId, {
      optionType: contract.optionType ?? "call",
      expiry: contract.expiration ?? "",
      strike: Number(contract.strike ?? 0),
      contractSymbol: contract.contractSymbol ?? "",
      bid: contract.bid ?? null,
      ask: contract.ask ?? null,
      bidSize: contract.bidSize ?? null,
      askSize: contract.askSize ?? null,
      volume: contract.volume ?? null,
      openInterest: contract.openInterest ?? null,
      entryPrice: Number.isFinite(nextEntryPrice) ? nextEntryPrice : 0,
      quoteSource: contract.sourceLabel ?? contract.source ?? "chain",
      isLive: contract.isLive === true,
      hasRealBidAsk: contract.hasRealBidAsk === true
    });
  }

  useEffect(() => {
    if (!strategyEditorOpen) {
      return;
    }

    const optionLegIds = (selectedScenarioOrder?.legs ?? [])
      .filter((leg) => leg?.kind === "option")
      .map((leg) => String(leg.id ?? ""))
      .filter(Boolean);

    if (!optionLegIds.length) {
      setActiveLegId("");
      return;
    }

    setActiveLegId((current) =>
      current && optionLegIds.includes(current) ? current : optionLegIds[optionLegIds.length - 1]
    );
  }, [
    strategyEditorOpen,
    (selectedScenarioOrder?.legs ?? [])
      .map((leg) => `${leg?.id ?? ""}:${leg?.kind ?? ""}`)
      .join("|")
  ]);

  useEffect(() => {
    if (!strategyEditorOpen || !optionRootSymbol || !activeChainExpiration) {
      return;
    }

    const strikeHint = Number(chainSpot ?? 0);
    const resolvedStrikeHint =
      Number.isFinite(strikeHint) && strikeHint > 0 ? strikeHint : Number(activeOptionLeg?.strike ?? 0) || 0;
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
  }, [activeChainExpiration, activeOptionLeg?.strike, chainShowAll, chainSpot, optionRootSymbol, strategyEditorOpen]);

  useEffect(() => {
    if (!strategyEditorOpen || !optionRootSymbol) {
      return;
    }

    (selectedScenarioOrder?.legs ?? []).forEach((leg) => {
      if (leg?.kind !== "option") {
        return;
      }

      if (!leg.expiry) {
        return;
      }

      loadOptionChain({
        expiration: leg.expiry,
        optionType: leg.optionType ?? "call",
        strikeHint: Number(leg.strike ?? chainSpot ?? 0) || 0
      });
    });
  }, [
    strategyEditorOpen,
    optionRootSymbol,
    chainSpot,
    (selectedScenarioOrder?.legs ?? [])
      .map((leg) => `${leg?.id ?? ""}:${leg?.expiry ?? ""}:${leg?.optionType ?? ""}:${leg?.strike ?? ""}`)
      .join("|")
  ]);

  useEffect(() => {
    if (!strategyEditorOpen || !optionRootSymbol) {
      return;
    }

    (selectedScenarioOrder?.legs ?? []).forEach((leg) => {
      if (leg?.kind !== "option" || !leg.expiry || !leg.contractSymbol) {
        return;
      }

      const chainKey = buildChainKey(optionRootSymbol, leg.expiry, leg.optionType ?? "call");
      const payload = optionChains[chainKey];
      const contracts = payload?.contracts ?? [];
      if (!contracts.length) {
        return;
      }

      const contract = contracts.find((item) => item.contractSymbol === leg.contractSymbol);
      if (!contract) {
        return;
      }

      const nextBid = Number(contract.bid ?? NaN);
      const nextAsk = Number(contract.ask ?? NaN);
      const currentBid = Number(leg.bid ?? NaN);
      const currentAsk = Number(leg.ask ?? NaN);
      const shouldPatchBid =
        (!Number.isFinite(currentBid) || currentBid <= 0) && Number.isFinite(nextBid) && nextBid > 0;
      const shouldPatchAsk =
        (!Number.isFinite(currentAsk) || currentAsk <= 0) && Number.isFinite(nextAsk) && nextAsk > 0;

      if (!shouldPatchBid && !shouldPatchAsk) {
        return;
      }

      updateScenarioDraftLeg(leg.id, {
        ...(shouldPatchBid ? { bid: nextBid } : {}),
        ...(shouldPatchAsk ? { ask: nextAsk } : {}),
        bidSize: contract.bidSize ?? leg.bidSize ?? null,
        askSize: contract.askSize ?? leg.askSize ?? null,
        volume: contract.volume ?? leg.volume ?? null,
        openInterest: contract.openInterest ?? leg.openInterest ?? null,
        quoteSource: contract.sourceLabel ?? contract.source ?? leg.quoteSource ?? "Market data",
        isLive: contract.isLive === true,
        hasRealBidAsk: contract.hasRealBidAsk === true
      });
    });
  }, [
    strategyEditorOpen,
    optionRootSymbol,
    optionChains,
    (selectedScenarioOrder?.legs ?? [])
      .map((leg) => `${leg?.id ?? ""}:${leg?.contractSymbol ?? ""}:${leg?.bid ?? ""}:${leg?.ask ?? ""}`)
      .join("|")
  ]);

  async function handleCreatePaperTrade() {
    if (!selectedScenarioOrder || !onCreatePaperOrder) {
      return;
    }

    setPaperOrderSaving(true);
    setPaperOrderState(null);

    try {
      const execution = {
        route: "local-paper"
      };
      const createResponse = await onCreatePaperOrder(
        buildTradingViewPaperOrderPayload({
          order: selectedScenarioOrder,
          row: selectedRow,
          strategyDefinition,
          purchaseDate: paperTradeDate || selectedScenarioOrder.purchaseDate || new Date().toISOString().slice(0, 10),
          execution
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

  function applyDatePreset(preset) {
    setDateFrom(preset.from);
    setDateTo(preset.to);
  }

  function resetDateRange() {
    const defaultPreset = datePresets.find((preset) => preset.id === "this-month");
    setDateFrom(defaultPreset?.from ?? startOfCurrentMonthIso());
    setDateTo(defaultPreset?.to ?? endOfCurrentMonthIso());
  }

  function applyExpectedPricePreset(preset) {
    setPriceMin(String(preset.min));
    setPriceMax(String(preset.max));
  }

  function resetExpectedPriceRange() {
    setPriceMin(String(DEFAULT_EXPECTED_PRICE_RANGE.min));
    setPriceMax(String(DEFAULT_EXPECTED_PRICE_RANGE.max));
  }

  function saveFilters() {
    persistSavedFilters(TRADING_VIEW_FILTERS_STORAGE_KEY, {
      symbolInput,
      dateFrom,
      dateTo,
      priceMin,
      priceMax,
      selectedStrategyTypeKeys,
      selectedMoneynessKeys,
      symmetryOnly,
      optionSpreadType,
      optionSpreadMin,
      optionSpreadMax,
      volumeMin,
      volumeMax,
      spreadWidthMin,
      spreadWidthMax,
      normalizedVolumeMin,
      normalizedVolumeMax,
      tableMaxLossMin,
      tableMaxLossMax,
      midMinusTheoMin,
      midMinusTheoMax
    });
  }

  function applyVolumePreset(preset) {
    setVolumeMin(preset.min == null ? "" : String(preset.min));
    setVolumeMax(preset.max == null ? "" : String(preset.max));
  }

  function applySpreadWidthPreset(preset) {
    setSpreadWidthMin(preset.min == null ? "" : String(preset.min));
    setSpreadWidthMax(preset.max == null ? "" : String(preset.max));
  }

  function applyBidAskSpreadPreset(preset) {
    setOptionSpreadType("percent");
    setOptionSpreadMin(preset.min == null ? "" : String(preset.min));
    setOptionSpreadMax(preset.max == null ? "" : String(preset.max));
  }

  function toggleSort(nextSortKey, options = {}) {
    const isAdditive = options.additive === true;

    setSortState((current) => {
      const currentSortState = Array.isArray(current) ? current : [];
      const existingIndex = currentSortState.findIndex((sortDescriptor) => sortDescriptor?.key === nextSortKey);
      const existingDescriptor = existingIndex >= 0 ? currentSortState[existingIndex] : null;
      const defaultDirection = SORT_DEFAULT_DIRECTIONS[nextSortKey] ?? "desc";
      const hasSingleActiveSort = existingIndex === 0 && currentSortState.length === 1;

      if (!isAdditive) {
        if (hasSingleActiveSort) {
          const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
          return [{ key: nextSortKey, direction }];
        }

        const direction = existingDescriptor?.direction ?? defaultDirection;
        return [{ key: nextSortKey, direction }];
      }

      if (existingIndex >= 0) {
        const direction = existingDescriptor?.direction === "asc" ? "desc" : "asc";
        const nextSortState = [...currentSortState];
        nextSortState[existingIndex] = { key: nextSortKey, direction };
        return nextSortState;
      }

      const nextSortState =
        currentSortState.length >= MAX_SORT_PRIORITIES
          ? currentSortState.slice(0, MAX_SORT_PRIORITIES - 1)
          : currentSortState;

      return [...nextSortState, { key: nextSortKey, direction: defaultDirection }];
    });
  }

  function renderSortHeader(nextSortKey, label) {
    const sortIndex = sortState.findIndex((sortDescriptor) => sortDescriptor?.key === nextSortKey);
    const isActive = sortIndex >= 0;
    const sortDescriptor = isActive ? sortState[sortIndex] : null;
    const direction =
      sortDescriptor?.direction === "asc"
        ? "asc"
        : sortDescriptor?.direction === "desc"
          ? "desc"
          : SORT_DEFAULT_DIRECTIONS[nextSortKey] ?? "desc";

    return (
      <button
        type="button"
        className={`tv-finder__sort-button ${isActive ? "tv-finder__sort-button--active" : ""}`}
        title="Click to sort. Shift-click (or Ctrl/⌘-click) to add up to 4 sort priorities."
        onClick={(event) =>
          toggleSort(nextSortKey, {
            additive: event.shiftKey || event.metaKey || event.ctrlKey
          })
        }
      >
        <span>{label}</span>
        <span className="tv-finder__sort-icon" aria-hidden="true">
          {isActive ? (
            <span className="finder-sort__indicator">
              <span className="finder-sort__priority">{sortIndex + 1}</span>
              <span className="finder-sort__direction">{direction === "asc" ? "↑" : "↓"}</span>
            </span>
          ) : (
            ""
          )}
        </span>
      </button>
    );
  }

  return (
    <main className="workspace workspace--tradingview-strategy-finder">
      <header className="topbar">
        <div>
          <span className="brand__eyebrow">TradingView strategy finder</span>
          <h2>{strategyDefinition?.name ?? "TradingView Strategy Finder"}</h2>
          <p className="card-copy">
            Let TradingView do the screening, then open the selected row in HedgeHub&apos;s own scenario detail view.
          </p>
        </div>

        <div className="screening-v2__actions">
          <button
            type="button"
            className="finder-action"
            disabled={loading}
            onClick={() => void loadStrategies()}
          >
            {loading ? "Refreshing..." : "Refresh results"}
          </button>
        </div>
      </header>

      <section className="insight-card tv-finder__toolbar">
        <form className="tv-finder__toolbar-form" onSubmit={handleSubmit}>
          <div className="tv-finder__query-row">
            <div className="tv-finder__symbol-block">
              <div className="tv-finder__symbol-entry">
                <label className="tv-finder__symbol-field">
                  <span>Underlying symbol</span>
                  <input
                    type="text"
                    value={symbolInput}
                    onChange={(event) => setSymbolInput(event.target.value)}
                    placeholder="SPY or NASDAQ:TSLA"
                  />
                </label>
                <button
                  type="button"
                  className="chart-toggle tv-finder__save-ticker-button"
                  onClick={handleSaveTickerTag}
                  disabled={!normalizedSymbolTag}
                >
                  Tag
                </button>
                <button type="submit" className="finder-action tv-finder__run-button" disabled={loading}>
                  {loading ? "Loading..." : "Run scan"}
                </button>
              </div>

              {savedTickers.length ? (
                <div className="tv-finder__saved-tickers" aria-label="Saved tickers">
                  {savedTickers.map((ticker) => (
                    <div key={ticker} className="tv-finder__saved-ticker">
                      <button
                        type="button"
                        className={`tv-finder__saved-ticker-button ${
                          normalizedSymbolTag === ticker ? "tv-finder__saved-ticker-button--active" : ""
                        }`}
                        onClick={() => handleSelectSavedTicker(ticker)}
                        title={`Use ${ticker}`}
                      >
                        <span>{ticker}</span>
                      </button>
                      <button
                        type="button"
                        className="tv-finder__saved-ticker-remove"
                        onClick={(event) => {
                          event.stopPropagation();
                          handleRemoveSavedTicker(ticker);
                        }}
                        aria-label={`Remove ${ticker}`}
                        title={`Remove ${ticker}`}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {payload?.source?.pageUrl ? (
              <div className="tv-finder__toolbar-actions">
                <a
                  className="finder-action tv-finder__link-button"
                  href={payload.source.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open TradingView
                </a>
              </div>
            ) : null}
          </div>

          <div className="tv-finder__filter-row">
            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("dateRange", node)}
              onToggle={() => handleFilterMenuToggle("dateRange")}
            >
              <summary className="finder-control tv-finder__filter-control tv-finder__filter-control--primary">
                <span>{dateRangeSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Prediction period</strong>
                  <button type="button" className="finder-menu__reset" onClick={resetDateRange}>
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
                      onClick={() => applyDatePreset(preset)}
                    >
                      <span className="tv-finder__menu-title">{preset.label}</span>
                    </button>
                  ))}
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>From</span>
                      <input
                        type="date"
                        value={dateFrom}
                        onChange={(event) => setDateFrom(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>To</span>
                      <input
                        type="date"
                        value={dateTo}
                        onChange={(event) => setDateTo(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("expectedPriceRange", node)}
              onToggle={() => handleFilterMenuToggle("expectedPriceRange")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  isDefaultExpectedPriceRange ? "" : "tv-finder__filter-control--active"
                }`}
              >
                <span>{activeExpectedPricePreset?.label ?? expectedPriceSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Expected price range</strong>
                  <button type="button" className="finder-menu__reset" onClick={resetExpectedPriceRange}>
                    Reset
                  </button>
                </div>

                <div className="finder-menu__list">
                  {EXPECTED_PRICE_RANGE_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`finder-menu__option ${
                        preset.min === priceRange.min && preset.max === priceRange.max
                          ? "finder-menu__option--active"
                          : ""
                      }`}
                      onClick={() => applyExpectedPricePreset(preset)}
                    >
                      <span className="tv-finder__menu-title">{preset.label}</span>
                      <span className="tv-finder__menu-copy">{preset.description}</span>
                    </button>
                  ))}
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min %</span>
                      <input
                        type="number"
                        step="0.5"
                        value={priceMin}
                        onChange={(event) => setPriceMin(event.target.value)}
                        placeholder="-5"
                      />
                    </label>
                    <label>
                      <span>Max %</span>
                      <input
                        type="number"
                        step="0.5"
                        value={priceMax}
                        onChange={(event) => setPriceMax(event.target.value)}
                        placeholder="5"
                      />
                    </label>
                  </div>
                  <span className="finder-menu__notice">
                    Use negative values for bearish ranges (for example -10 to -5).
                  </span>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__strategy-menu"
              ref={(node) => setFilterMenuRef("strategyTypes", node)}
              onToggle={() => handleFilterMenuToggle("strategyTypes")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  allStrategyTypesSelected ? "" : "tv-finder__filter-control--active"
                }`}
              >
                <span>{strategyTypeSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Strategy types</strong>
                  <div className="finder-menu__header-actions">
                    <button
                      type="button"
                      className="finder-menu__reset"
                      onClick={() => setSelectedStrategyTypeKeys(allStrategyTypeKeys)}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="finder-menu__reset"
                      onClick={() => setSelectedStrategyTypeKeys([])}
                    >
                      Clear all
                    </button>
                  </div>
                </div>

                <div className="finder-menu__custom tv-finder__strategy-search">
                  <label>
                    <span>Search</span>
                    <input
                      type="search"
                      value={strategyTypeSearchInput}
                      onChange={(event) => setStrategyTypeSearchInput(event.target.value)}
                      placeholder="Search"
                    />
                  </label>
                </div>

                <div className="tv-finder__strategy-menu-list">
                  {visibleStrategyTypes.length ? (
                    visibleStrategyTypes.map((strategyType) => (
                      <label
                        key={strategyType.key}
                        className={`tv-finder__strategy-option ${
                          isStrategyTypeSelected(strategyType.key)
                            ? "tv-finder__strategy-option--active"
                            : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isStrategyTypeSelected(strategyType.key)}
                          onChange={() => toggleStrategyType(strategyType.key)}
                        />
                        <span>{strategyType.label}</span>
                      </label>
                    ))
                  ) : (
                    <div className="tv-finder__strategy-empty">No strategy types match this search.</div>
                  )}
                </div>

                <div className="tv-finder__strategy-footer">
                  <span className="finder-menu__notice">
                    {selectedStrategyTypeKeys.length === 0
                      ? "None selected"
                      : allStrategyTypesSelected
                        ? `All ${TRADING_VIEW_STRATEGY_TYPES.length} strategy types selected`
                        : `${selectedStrategyTypeKeys.length} selected`}
                  </span>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => setStrategyTypeSearchInput("")}
                  >
                    Clear search
                  </button>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("volume", node)}
              onToggle={() => handleFilterMenuToggle("volume")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  volumeRange ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{activeVolumePreset?.label ?? volumeSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Volume</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => {
                      setVolumeMin("");
                      setVolumeMax("");
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div className="finder-menu__list">
                  {VOLUME_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`finder-menu__option ${
                        activeVolumePreset?.label === preset.label ? "finder-menu__option--active" : ""
                      }`}
                      onClick={() => applyVolumePreset(preset)}
                    >
                      <span className="tv-finder__menu-title">{preset.label}</span>
                      <span className="tv-finder__menu-copy">{preset.description}</span>
                    </button>
                  ))}
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={volumeMin}
                        onChange={(event) => setVolumeMin(event.target.value)}
                        placeholder="0"
                      />
                    </label>
                    <label>
                      <span>Max</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={volumeMax}
                        onChange={(event) => setVolumeMax(event.target.value)}
                        placeholder="Any"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("spreadWidth", node)}
              onToggle={() => handleFilterMenuToggle("spreadWidth")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  spreadWidth ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{activeSpreadWidthPreset?.label ?? spreadWidthSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Spread width</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => {
                      setSpreadWidthMin("");
                      setSpreadWidthMax("");
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div className="finder-menu__list">
                  {SPREAD_WIDTH_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      type="button"
                      className={`finder-menu__option ${
                        activeSpreadWidthPreset?.label === preset.label
                          ? "finder-menu__option--active"
                          : ""
                      }`}
                      onClick={() => applySpreadWidthPreset(preset)}
                    >
                      <span className="tv-finder__menu-title">{preset.label}</span>
                      <span className="tv-finder__menu-copy">{preset.description}</span>
                    </button>
                  ))}
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min strikes</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={spreadWidthMin}
                        onChange={(event) => setSpreadWidthMin(event.target.value)}
                        placeholder="1"
                      />
                    </label>
                    <label>
                      <span>Max strikes</span>
                      <input
                        type="number"
                        min="1"
                        step="1"
                        value={spreadWidthMax}
                        onChange={(event) => setSpreadWidthMax(event.target.value)}
                        placeholder="5"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("moneyness", node)}
              onToggle={() => handleFilterMenuToggle("moneyness")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  allMoneynessSelected ? "" : "tv-finder__filter-control--active"
                }`}
              >
                <span>{moneynessSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Moneyness</strong>
                  <div className="finder-menu__header-actions">
                    <button
                      type="button"
                      className="finder-menu__reset"
                      onClick={() => setSelectedMoneynessKeys(allMoneynessKeys)}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="finder-menu__reset"
                      onClick={() => setSelectedMoneynessKeys([])}
                    >
                      Clear all
                    </button>
                  </div>
                </div>

                <div className="finder-menu__custom tv-finder__strategy-search">
                  <label>
                    <span>Search</span>
                    <input
                      type="search"
                      value={moneynessSearchInput}
                      onChange={(event) => setMoneynessSearchInput(event.target.value)}
                      placeholder="Search"
                    />
                  </label>
                </div>

                <div className="tv-finder__menu-checklist">
                  {visibleMoneynessOptions.length ? (
                    visibleMoneynessOptions.map((option) => (
                      <label
                        key={option.key}
                        className={`tv-finder__strategy-option ${
                          isMoneynessSelected(option.key) ? "tv-finder__strategy-option--active" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isMoneynessSelected(option.key)}
                          onChange={() => toggleMoneynessKey(option.key)}
                        />
                        <span>{option.label}</span>
                      </label>
                    ))
                  ) : (
                    <div className="tv-finder__strategy-empty">No moneyness filters match this search.</div>
                  )}
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("symmetry", node)}
              onToggle={() => handleFilterMenuToggle("symmetry")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  symmetryOnly ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>Symmetric strikes</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Symmetric strikes</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => setSymmetryOnly(false)}
                  >
                    Reset
                  </button>
                </div>

                <button
                  type="button"
                  className={`tv-finder__toggle-row ${symmetryOnly ? "tv-finder__toggle-row--active" : ""}`}
                  onClick={() => setSymmetryOnly((current) => !current)}
                >
                  <span>On</span>
                  <span className={`tv-finder__toggle-switch ${symmetryOnly ? "tv-finder__toggle-switch--active" : ""}`}>
                    <span className="tv-finder__toggle-switch-knob" />
                  </span>
                </button>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("bidAskSpread", node)}
              onToggle={() => handleFilterMenuToggle("bidAskSpread")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  optionSpreadRange ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{activeBidAskSpreadPreset?.label ?? optionSpreadSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Bid-ask spread</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => {
                      setOptionSpreadType("percent");
                      setOptionSpreadMin("");
                      setOptionSpreadMax("");
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
                        activeBidAskSpreadPreset?.label === preset.label
                          ? "finder-menu__option--active"
                          : ""
                      }`}
                      onClick={() => applyBidAskSpreadPreset(preset)}
                    >
                      <span className="tv-finder__menu-title">{preset.label}</span>
                      <span className="tv-finder__menu-copy">{preset.description}</span>
                    </button>
                  ))}
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min %</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={optionSpreadMin}
                        onChange={(event) => {
                          setOptionSpreadType("percent");
                          setOptionSpreadMin(event.target.value);
                        }}
                        placeholder="1.0"
                      />
                    </label>
                    <label>
                      <span>Max %</span>
                      <input
                        type="number"
                        min="0"
                        step="0.1"
                        value={optionSpreadMax}
                        onChange={(event) => {
                          setOptionSpreadType("percent");
                          setOptionSpreadMax(event.target.value);
                        }}
                        placeholder="3.0"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("normalizedVolume", node)}
              onToggle={() => handleFilterMenuToggle("normalizedVolume")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  normalizedVolumeRange ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{normalizedVolumeSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Opt vol (norm)</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => {
                      setNormalizedVolumeMin("");
                      setNormalizedVolumeMax("");
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={normalizedVolumeMin}
                        onChange={(event) => setNormalizedVolumeMin(event.target.value)}
                        placeholder="0"
                      />
                    </label>
                    <label>
                      <span>Max</span>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={normalizedVolumeMax}
                        onChange={(event) => setNormalizedVolumeMax(event.target.value)}
                        placeholder="Any"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("maxLoss", node)}
              onToggle={() => handleFilterMenuToggle("maxLoss")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  maxLossRange ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{maxLossSummary}</span>
              </summary>
              <div className="finder-menu__panel">
                <div className="finder-menu__header">
                  <strong>Max loss</strong>
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => {
                      setTableMaxLossMin(DEFAULT_TABLE_MAX_LOSS_MIN);
                      setTableMaxLossMax(DEFAULT_TABLE_MAX_LOSS_MAX);
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
                    <label>
                      <span>Min</span>
                      <input
                        type="number"
                        step="0.01"
                        value={tableMaxLossMin}
                        onChange={(event) => setTableMaxLossMin(event.target.value)}
                        placeholder={DEFAULT_TABLE_MAX_LOSS_MIN}
                      />
                    </label>
                    <label>
                      <span>Max</span>
                      <input
                        type="number"
                        step="0.01"
                        value={tableMaxLossMax}
                        onChange={(event) => setTableMaxLossMax(event.target.value)}
                        placeholder={DEFAULT_TABLE_MAX_LOSS_MAX}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details
              className="finder-menu tv-finder__compact-menu"
              ref={(node) => setFilterMenuRef("midMinusTheo", node)}
              onToggle={() => handleFilterMenuToggle("midMinusTheo")}
            >
              <summary
                className={`finder-control tv-finder__filter-control ${
                  midMinusTheoRange ? "tv-finder__filter-control--active" : ""
                }`}
              >
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

                <div className="finder-menu__custom">
                  <span className="tv-finder__manual-label">Manual setup...</span>
                  <div className="tv-finder__range-grid">
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
              </div>
            </details>

            <button
              type="button"
              className="finder-action"
              onClick={saveFilters}
            >
              Save filters
            </button>
          </div>
        </form>

        <p className="card-copy tv-finder__hint">
          Public option underlyings like SPY and TSLA can work without your TradingView account in the current scan flow. We can widen the symbol coverage from here once you like the detail experience.
        </p>
      </section>

      {error ? (
        <div className="screening-v2__notice screening-v2__notice--error">{error}</div>
      ) : null}

      <section className="insight-card screening-v2__table-card">
        <div className="section-heading">
          <span>TradingView-ranked strategies</span>
          <span className="pill pill--ghost">{visibleRowsCountLabel}</span>
        </div>

	        {loading && !payload ? (
	          <div className="app-state app-state--inline">Loading TradingView strategy rows…</div>
	        ) : sortedRows.length ? (
	          <div className="screening-v2__table-wrap">
	            <table className="screening-v2__table tv-finder__table">
	              <colgroup>
	                {TRADING_VIEW_TABLE_COLUMNS.map((column) => (
	                  <col key={column.key} style={{ width: `${column.width}px` }} />
	                ))}
	              </colgroup>
	              <thead>
	                <tr>
	                  {TRADING_VIEW_TABLE_COLUMNS.map((column) => (
	                    <th key={column.key}>{renderSortHeader(column.key, column.label)}</th>
	                  ))}
	                </tr>
	              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const isSelected = row.id === selectedRowId;
                  const marketBias = inferTradingViewMarketBias(row.strategyTypeKey);

                  return (
                    <Fragment key={row.id}>
                      <tr
                        aria-expanded={isSelected && !detailCollapsed}
                        className={isSelected ? "screening-v2__table-row--active" : ""}
                        onClick={() => handleRowSelect(row.id)}
	                      >
	                        <td>{row.expiration || "n/a"}</td>
	                        <td>{row.daysToExpiration ?? "n/a"}</td>
	                        <td>{getTradingViewAssetLabel(row) || "n/a"}</td>
	                        <td>
	                          <strong>{row.strategyTypeLabel}</strong>
	                        </td>
	                        <td>
	                          <span className={`bias-pill bias-pill--${marketBias.tone}`}>{marketBias.label}</span>
	                        </td>
	                        <td>
                          <div className="tv-finder__formula">
                            {(row.legs ?? []).map((leg) => (
                              <span
                                key={`${row.id}:${leg.contractSymbol}:${leg.action}`}
                                className={`formula-pill formula-pill--${leg.optionType === "put" ? "put" : "call"}`}
                              >
                                {formatStrategyLegLabel(leg)}
                              </span>
                            ))}
                          </div>
                        </td>
	                        <td>{formatCompactCount(row.normalizedOptionVolume)}</td>
	                        <td>
	                          <span className={getTradingViewMidMinusTheoTone(row)}>
	                            {formatNumber(getTradingViewMidMinusTheo(row))}
	                          </span>
	                        </td>
	                        <td>
	                          <span
	                            className={getMetricTone(row.probabilityOfProfit, {
	                              kind: "threshold",
	                              threshold: 50
	                            })}
	                          >
	                            {formatPercent(row.probabilityOfProfit)}
	                          </span>
	                        </td>
	                        <td>
	                          <span className={getMetricTone(row.maxProfit)}>
	                            {formatCurrency(row.maxProfit)}
	                          </span>
	                        </td>
	                        <td>
                          <span className={getMetricTone(row.maxLoss, { kind: "cost" })}>
                            {formatCurrency(row.maxLoss)}
                          </span>
                        </td>
                        <td>
                          <span className={getMetricTone(row.rewardRisk, { kind: "threshold", threshold: 1 })}>
                            {formatNumber(row.rewardRisk)}
                          </span>
                        </td>
                        <td>
                          {row.breakevens?.length
                            ? row.breakevens.map((value) => formatCurrency(value)).join(", ")
                            : "n/a"}
                        </td>
                        <td>{formatCurrency(row.theoreticalPrice)}</td>
                        <td>{formatCurrency(row.bid)}</td>
                        <td>{formatCurrency(row.ask)}</td>
                        <td>
                          <span className={getMetricTone(row.bidAskSpreadPercent, { kind: "cost" })}>
	                            {formatPercent(row.bidAskSpreadPercent)}
	                          </span>
	                        </td>
	                      </tr>

                      {isSelected && !detailCollapsed ? (
                        <tr className="tv-finder__detail-row">
                          <td colSpan={tableColumnCount} className="tv-finder__detail-cell">
                            <section className="selection-banner tv-finder__selection-banner">
                              <div className="selection-banner__title">
                                <span className="brand__eyebrow">Selected strategy</span>
                                <strong>
                                  {row.underlyingSymbol} · {formatStrategyTypeForDirection(row.strategyTypeLabel, strategyDirection)} · {row.expiration || "n/a"}
                                </strong>
                              </div>
                              <div className="selection-banner__actions">
                                <div className="detail-badges">
                                  <span className="pill pill--ghost">{row.underlyingFamily || row.underlyingSymbol}</span>
                                  {row.daysToExpiration != null ? (
                                    <span className="pill pill--ghost">{row.daysToExpiration} DTE</span>
                                  ) : null}
                                  {row.score != null ? (
                                    <span className="pill pill--live">Score {formatNumber(row.score, 3)}</span>
                                  ) : null}
                                  {liveComboQuote ? (
                                    <span
                                      className="pill pill--ghost"
                                      title={
                                        liveComboQuote.ready
                                          ? `Bid ${formatCurrency(liveComboQuote.bid)} · Ask ${formatCurrency(liveComboQuote.ask)}`
                                          : "Waiting for live option bid/ask quotes..."
                                      }
                                    >
                                      Live mark {formatCurrency(liveComboQuote.mid)}
                                    </span>
                                  ) : null}
                                  <span className="pill pill--ghost">
                                    Live theo {formatCurrency(liveTheoPrice ?? row.theoreticalPrice)}
                                  </span>
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
                              <article className="insight-card screening-v2__selected-top">
                                <div className="screening-v2__selected-head">
                                  <div className="screening-v2__selected-copy">
                                    <h3>{formatStrategyTypeForDirection(row.strategyTypeLabel, strategyDirection)}</h3>
                                    <p className="screening-v2__selected-question">
                                      {row.underlyingSymbol} screened by TradingView, detailed by HedgeHub.
                                    </p>
                                    <div className="detail-badges">
                                      <span className="pill pill--ghost">{row.underlyingFamily || row.underlyingSymbol}</span>
                                      {row.expiration ? <span className="pill pill--ghost">{row.expiration}</span> : null}
                                      {row.daysToExpiration != null ? (
                                        <span className="pill pill--ghost">{row.daysToExpiration} DTE</span>
                                      ) : null}
                                      {row.score != null ? (
                                        <span className="pill pill--live">Score {formatNumber(row.score, 3)}</span>
                                      ) : null}
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
                                      className={`finder-action ${paperOrderSaving ? "chart-toggle--active" : ""}`}
                                      onClick={handleCreatePaperTrade}
                                      disabled={!onCreatePaperOrder || paperOrderSaving}
                                    >
                                      {paperOrderSaving ? "Saving..." : "Place order"}
                                    </button>
                                    {onOpenPaperTrading ? (
                                      <button
                                        type="button"
                                        className="chart-toggle"
                                        onClick={onOpenPaperTrading}
                                      >
                                        View holdings
                                      </button>
                                    ) : null}
                                    {row.pageUrl ? (
                                      <a href={row.pageUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                                        Open TradingView screen
                                      </a>
                                    ) : null}
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
                                        {row.underlyingSymbol} · {formatStrategyTypeForDirection(row.strategyTypeLabel, strategyDirection)}
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
	                                            disabled={!selectedScenarioOrder}
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
                                  </div>
                                </section>

                                {strategyEditorOpen && selectedScenarioOrder ? (
                                  <section className="strategy-editor">
                                    <div className="strategy-editor__header">
                                      <div>
                                        <span className="brand__eyebrow">Strategy builder</span>
                                        <p className="detail-chart__copy">
                                          Adjust the selected TradingView legs before sending the setup into HedgeHub&apos;s paper book.
                                        </p>
                                      </div>
                                      <div className="detail-badges">
                                        <button
                                          type="button"
                                          className="chart-toggle chart-toggle--compact"
                                          onClick={handleAddDraftLeg}
                                        >
                                          Add leg
                                        </button>
                                        <button
                                          type="button"
                                          className="chart-toggle chart-toggle--compact"
                                          onClick={refreshVisibleOptionChains}
                                          disabled={!optionRootSymbol}
                                        >
                                          Refresh chain
                                        </button>
                                        <span className="pill pill--ghost">Manual editor</span>
                                        <span className="pill pill--live">{selectedScenarioOrder.assetLabel}</span>
                                      </div>
                                    </div>

                                    <div className="strategy-editor__chain">
                                      <div className="strategy-editor__chain-head">
                                        <div className="strategy-editor__chain-title">
                                          <span className="brand__eyebrow">Option chain</span>
                                          <strong>
                                            {optionRootSymbol || selectedScenarioOrder.assetLabel}
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
                                            const dte = diffDaysIso(todayIso(), expiry);
                                            const dteLabel =
                                              dte == null
                                                ? ""
                                                : `${dte >= 0 ? dte : `-${Math.abs(dte)}`}D`;

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
                                          Spot: {Number.isFinite(chainSpot) ? formatCurrency(chainSpot, 2) : "n/a"}
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
                                                <th
                                                  colSpan={OPTION_CHAIN_SIDE_COLUMNS.length}
                                                  className="chain-group chain-group--call"
                                                >
                                                  Calls
                                                </th>
                                                <th rowSpan={2} className="chain-strike-head">
                                                  Strike
                                                </th>
                                                <th
                                                  colSpan={OPTION_CHAIN_SIDE_COLUMNS.length}
                                                  className="chain-group chain-group--put"
                                                >
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
                                                const spotSeparatorLabel =
                                                  chainSpot > 0
                                                    ? `Spot ${formatNumber(chainSpot, 2)}`
                                                    : "";
                                                let spotSeparatorInserted = false;
                                                const activeStrike = Number(activeOptionLeg?.strike ?? NaN);
                                                const activeType = String(activeOptionLeg?.optionType ?? "").toLowerCase();
                                                const activeContractSymbol = String(activeOptionLeg?.contractSymbol ?? "");
                                                const chainColumnSpan = OPTION_CHAIN_SIDE_COLUMNS.length * 2 + 1;

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
                                                      return formatPercent(scaledValue, column.digits ?? 2);
                                                    }

                                                    return formatSignedPercentLabel(scaledValue, column.digits ?? 2);
                                                  }

                                                  return String(rawValue);
                                                };

                                                const renderSideCells = (side, contract, isActiveStrike, columns) =>
                                                  columns.map((column) => {
                                                    if (column.kind === "select") {
                                                      const markValue = Number(contract?.mark ?? contract?.mid ?? NaN);
                                                      const markLabel = Number.isFinite(markValue)
                                                        ? formatNumber(markValue, 2)
                                                        : "—";
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
                                                              activeOptionLeg?.id
                                                                ? applyChainContractToDraftLeg(
                                                                    activeOptionLeg.id,
                                                                    contract
                                                                  )
                                                                : null
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
                                                    const volumeValue =
                                                      column.key === "volume" ? Number(contract?.volume ?? NaN) : NaN;
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
                                                          <span
                                                            className={`chain-metric__value ${metricToneClass}`}
                                                          >
                                                            {metricLabel}
                                                          </span>
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
                                                        <td className="chain-strike">{formatNumber(strike, 2)}</td>
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
	                                      {(selectedScenarioOrder.legs ?? []).length ? (
	                                        (selectedScenarioOrder.legs ?? []).map((leg, index) => {
	                                          const chainKey =
	                                            optionRootSymbol && leg.expiry
	                                              ? buildChainKey(optionRootSymbol, leg.expiry, leg.optionType)
	                                              : "";
	                                          const chainPayload = chainKey ? optionChains[chainKey] ?? null : null;
	                                          const chainState = chainKey ? optionChainStatus[chainKey] ?? null : null;
	                                          const chainContracts = [...(chainPayload?.contracts ?? [])].sort(
	                                            (left, right) => Number(left?.strike ?? 0) - Number(right?.strike ?? 0)
	                                          );
	                                          const selectedContractValue = chainContracts.some(
	                                            (contract) => contract.contractSymbol === leg.contractSymbol
	                                          )
	                                            ? leg.contractSymbol
	                                            : "";
	                                          const selectedChainContract = selectedContractValue
	                                            ? chainContracts.find((contract) => contract.contractSymbol === selectedContractValue) ??
	                                              null
	                                            : null;
	                                          const chainBid = selectedChainContract?.bid ?? leg.bid;
	                                          const chainAsk = selectedChainContract?.ask ?? leg.ask;
	                                          const spotSeparatorLabel =
	                                            chainSpot > 0
	                                              ? `---------- Spot ${formatNumber(chainSpot, 2)} ----------`
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
	                                                    {leg.contractSymbol || formatStrategyLegLabel(leg)}
	                                                  </span>
	                                                  <button
	                                                    type="button"
	                                                    className="chart-toggle chart-toggle--compact"
	                                                    onClick={() => handleRemoveDraftLeg(leg.id)}
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
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, { action: event.target.value })
	                                                    }
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
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        optionType: event.target.value,
	                                                        contractSymbol: "",
	                                                        quoteSource: "Manual",
	                                                        isLive: false
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
	                                                    value={leg.expiry ?? ""}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        expiry: event.target.value,
	                                                        contractSymbol: "",
	                                                        quoteSource: "Manual",
	                                                        isLive: false
	                                                      })
	                                                    }
	                                                  />
	                                                </label>

	                                                <label>
	                                                  <span>Qty</span>
	                                                  <input
	                                                    type="number"
	                                                    min="1"
	                                                    step="1"
	                                                    value={leg.quantity ?? 1}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        quantity: Math.max(Number(event.target.value || 1), 1)
	                                                      })
	                                                    }
	                                                  />
	                                                </label>
	                                              </div>

	                                              <div className="strategy-editor__row">
	                                                <label>
	                                                  <span>Strike</span>
	                                                  <input
	                                                    type="number"
	                                                    step="0.01"
	                                                    value={leg.strike ?? 0}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        strike: Number(event.target.value || 0),
	                                                        contractSymbol: "",
	                                                        quoteSource: "Manual",
	                                                        isLive: false
	                                                      })
	                                                    }
	                                                  />
	                                                </label>

	                                                <label>
	                                                  <span>Entry</span>
	                                                  <input
	                                                    type="number"
	                                                    min="0"
	                                                    step="0.01"
	                                                    value={leg.entryPrice ?? 0}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        entryPrice: Number(event.target.value || 0)
	                                                      })
	                                                    }
	                                                  />
	                                                </label>

	                                                <label>
	                                                  <span>Bid</span>
	                                                  <input
	                                                    type="number"
	                                                    min="0"
	                                                    step="0.01"
	                                                    value={leg.bid ?? 0}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        bid: Number(event.target.value || 0)
	                                                      })
	                                                    }
	                                                  />
	                                                </label>

	                                                <label>
	                                                  <span>Ask</span>
	                                                  <input
	                                                    type="number"
	                                                    min="0"
	                                                    step="0.01"
	                                                    value={leg.ask ?? 0}
	                                                    onChange={(event) =>
	                                                      updateScenarioDraftLeg(leg.id, {
	                                                        ask: Number(event.target.value || 0)
	                                                      })
	                                                    }
	                                                  />
	                                                </label>
	                                              </div>

	                                              <div className="strategy-editor__row">
	                                                <label className="strategy-editor__contract-picker">
	                                                  <span>Option chain</span>
	                                                  <select
	                                                    value={selectedContractValue}
	                                                    onChange={(event) => {
	                                                      const nextValue = event.target.value;
	                                                      if (!nextValue) {
	                                                        updateScenarioDraftLeg(leg.id, {
	                                                          contractSymbol: "",
	                                                          quoteSource: "Manual",
	                                                          isLive: false
	                                                        });
	                                                        return;
	                                                      }

	                                                      const contract =
	                                                        chainContracts.find(
	                                                          (item) => item.contractSymbol === nextValue
	                                                        ) ?? null;
	                                                      applyChainContractToDraftLeg(leg.id, contract);
	                                                    }}
	                                                    disabled={!optionRootSymbol || !leg.expiry}
	                                                  >
	                                                    <option value="">
	                                                      {optionRootSymbol && leg.expiry
	                                                        ? "Select contract"
	                                                        : "Select an expiry to load the chain."}
	                                                    </option>
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
	                                                          <option key={`spot:${leg.id}`} value="__spot__" disabled>
	                                                            {spotSeparatorLabel}
	                                                          </option>
	                                                        ) : null,
	                                                        <option key={contract.contractSymbol} value={contract.contractSymbol}>
	                                                          {formatChainContractChoiceLabel(contract)}
	                                                        </option>
	                                                      ];
	                                                    })}
	                                                    {spotSeparatorLabel && chainContracts.length && !spotSeparatorInserted ? (
	                                                      <option key={`spot:${leg.id}`} value="__spot__" disabled>
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
	                                                  {formatNumber(leg.strike, 2)}
	                                                  {leg.optionType === "put" ? "P" : "C"} · {formatNumber(chainBid, 2)} /{" "}
	                                                  {formatNumber(chainAsk, 2)}
	                                                </strong>
	                                              </div>
	                                            </article>
	                                          );
	                                        })
	                                      ) : (
	                                        <div className="strategy-editor__empty">
	                                          No legs in this builder yet. Click <strong>Add leg</strong> to create one.
	                                        </div>
	                                      )}
                                    </div>
                                  </section>
                                ) : null}

                                <div className="screening-v2__selected-grid">
                                  <section className="screening-v2__selected-panel">
                                    <h4>Strategy overview</h4>
                                    <div className="summary-stack">
                                      <div className="summary-row">
                                        <span>Underlying price</span>
                                        <strong>{formatCurrency(row.underlyingPrice)}</strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Probability of profit</span>
                                        <strong
                                          className={getMetricTone(row.probabilityOfProfit, {
                                            kind: "threshold",
                                            threshold: 50
                                          })}
                                        >
                                          {formatPercent(row.probabilityOfProfit)}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Average payoff</span>
                                        <strong className={getMetricTone(row.avgPayoff)}>
                                          {formatCurrency(row.avgPayoff)}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Max profit</span>
                                        <strong className={getMetricTone(row.maxProfit)}>
                                          {formatCurrency(row.maxProfit)}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Max loss</span>
                                        <strong className={getMetricTone(row.maxLoss, { kind: "cost" })}>
                                          {formatCurrency(row.maxLoss)}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Reward/Risk</span>
                                        <strong
                                          className={getMetricTone(row.rewardRisk, {
                                            kind: "threshold",
                                            threshold: 1
                                          })}
                                        >
                                          {formatNumber(row.rewardRisk)}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Breakeven(s)</span>
                                        <strong>
                                          {row.breakevens?.length
                                            ? row.breakevens.map((value) => formatCurrency(value)).join(", ")
                                            : "n/a"}
                                        </strong>
                                      </div>
                                      <div className="summary-row">
                                        <span>Bid/Ask spread</span>
                                        <strong className={getMetricTone(row.bidAskSpreadPercent, { kind: "cost" })}>
                                          {formatPercent(row.bidAskSpreadPercent)}
                                        </strong>
                                      </div>
                                    </div>
                                  </section>

                                  <section className="screening-v2__selected-panel screening-v2__selected-panel--contracts">
                                    <h4>Contract details</h4>
                                    {liveComboQuote || liveOptionLegQuotesUpdatedAt ? (
                                      <div className="detail-badges">
                                        {liveComboQuote ? (
                                          <span
                                            className="pill pill--ghost"
                                            title={
                                              liveComboQuote.ready
                                                ? `Bid ${formatCurrency(liveComboQuote.bid)} · Ask ${formatCurrency(liveComboQuote.ask)}`
                                                : "Waiting for live option bid/ask quotes..."
                                            }
                                          >
                                            Live mark {formatCurrency(liveComboQuote.mid)}
                                          </span>
                                        ) : null}
                                        {liveOptionLegQuotesUpdatedAt ? (
                                          <span className="pill pill--ghost">
                                            Updated {formatShortTime(liveOptionLegQuotesUpdatedAt)}
                                          </span>
                                        ) : null}
                                      </div>
                                    ) : null}
                                    <div className="screening-v2__contract-table-wrap">
                                      <table className="screening-v2__contract-table">
                                        <thead>
                                          <tr>
                                            <th>Action</th>
                                            <th>Qty</th>
                                            <th>Strike / expiry</th>
                                            <th>Entry</th>
                                            <th>Bid</th>
                                            <th>Ask</th>
                                            <th>Mark</th>
                                            <th>Vol</th>
                                            <th>OI</th>
                                            <th>Code</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {(selectedScenarioOrder?.legs ?? []).map((leg) => {
                                            const liveQuote = liveOptionLegQuotes?.[leg.id] ?? null;
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

                                            return (
                                              <tr key={`${row.id}:${leg.contractSymbol}:${leg.action}`}>
                                                <td>{leg.action}</td>
                                                <td>{leg.quantity}</td>
                                                <td>
                                                  {formatNumber(leg.strike, 2)}
                                                  {String(leg.optionType ?? "call").toUpperCase()} · {leg.expiry}
                                                </td>
                                                <td>{formatCurrency(leg.entryPrice)}</td>
                                                <td>{formatCurrency(bid)}</td>
                                                <td>{formatCurrency(ask)}</td>
                                                <td>{formatCurrency(mark)}</td>
                                                <td>{formatCompactCount(volume)}</td>
                                                <td>{formatCompactCount(openInterest)}</td>
                                                <td>
                                                  <div className="screening-v2__contract-link">
                                                    <strong>
                                                      {leg.contractSymbol || `${leg.action} ${leg.optionType} ${leg.strike}`}
                                                    </strong>
                                                    <span>{liveQuote?.sourceLabel ?? leg.quoteSource ?? "TradingView"}</span>
                                                  </div>
                                                </td>
                                              </tr>
                                            );
                                          })}
                                        </tbody>
                                      </table>
                                    </div>
                                  </section>
                                </div>
                              </article>

                              {selectedScenarioOrder ? (
                                <PaperTradeScenarioPanel
                                  order={selectedScenarioOrder}
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
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="app-state app-state--inline">
            No TradingView strategy rows matched the current filters.
          </div>
        )}
      </section>

    </main>
  );
}
