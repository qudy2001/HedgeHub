import { Fragment, useEffect, useMemo, useState } from "react";
import { getIbkrGatewayLoginUrl, isIbkrReady, isIbkrReloginNeeded } from "../ibkrStatus.js";
import { isTwsReady } from "../twsStatus.js";
import { createMarketTimerContext } from "../marketTimers.js";
import PaperTradeScenarioPanel from "./PaperTradeScenarioPanel.jsx";

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
  daysToExpiration: "asc",
  strategyTypeLabel: "asc",
  normalizedOptionVolume: "desc",
  midMinusTheo: "asc",
  maxProfit: "desc",
  maxLoss: "desc",
  rewardRisk: "desc",
  breakevens: "asc",
  theoreticalPrice: "desc",
  bid: "desc",
  ask: "desc",
  bidAskSpreadPercent: "asc",
  probabilityOfProfit: "desc"
};
const MAX_SORT_PRIORITIES = 4;
const DEFAULT_EXPECTED_PRICE_RANGE = {
  min: 5,
  max: 10
};
const TRADING_VIEW_SAVED_TICKERS_STORAGE_KEY = "hedgehub:tradingview-saved-tickers";
const MAX_TRADING_VIEW_SAVED_TICKERS = 20;

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
  const allSelected =
    !selectedStrategyTypeKeys.length ||
    selectedStrategyTypeKeys.length >= TRADING_VIEW_STRATEGY_TYPES.length;

  if (allSelected) {
    return "Strategy types";
  }

  const selectedLabels = TRADING_VIEW_STRATEGY_TYPES.filter((strategyType) =>
    selectedStrategyTypeKeys.includes(strategyType.key)
  ).map((strategyType) => strategyType.label);

  if (!selectedLabels.length) {
    return "Strategy types";
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
    case "daysToExpiration":
      return row.daysToExpiration ?? null;
    case "strategyTypeLabel":
      return row.strategyTypeLabel ?? "";
    case "normalizedOptionVolume":
      return row.normalizedOptionVolume ?? null;
    case "midMinusTheo":
      return getTradingViewMidMinusTheo(row);
    case "maxProfit":
      return row.maxProfit ?? null;
    case "maxLoss":
      return row.maxLoss == null ? null : Math.abs(row.maxLoss);
    case "rewardRisk":
      return row.rewardRisk ?? null;
    case "breakevens":
      return Array.isArray(row.breakevens) && row.breakevens.length ? row.breakevens[0] : null;
    case "theoreticalPrice":
      return row.theoreticalPrice ?? null;
    case "bid":
      return row.bid ?? null;
    case "ask":
      return row.ask ?? null;
    case "bidAskSpreadPercent":
      return row.bidAskSpreadPercent ?? null;
    case "probabilityOfProfit":
      return row.probabilityOfProfit ?? null;
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
  const allSelected =
    !selectedKeys.length || selectedKeys.length >= TRADING_VIEW_MONEYNESS_OPTIONS.length;

  if (allSelected) {
    return "Moneyness";
  }

  const selectedLabels = TRADING_VIEW_MONEYNESS_OPTIONS.filter((option) =>
    selectedKeys.includes(option.key)
  ).map((option) => option.label);

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
      contractMultiplier: Number(leg.contractMultiplier ?? 100),
      contractSymbol: leg.contractSymbol ?? "",
      entryPrice: Number(leg.entryPrice ?? 0),
      expiry: leg.expiration ?? row.expiration ?? purchaseDate,
      id: `${row.id}:option:${index}`,
      impliedVolatility: Number(leg.impliedVolatility ?? row.annualizedVolatility ?? 0.24) || 0.24,
      isLive: true,
      kind: "option",
      label: `${leg.action} ${String(leg.optionType ?? "call").toUpperCase()} ${leg.strike}`,
      optionType: leg.optionType ?? "call",
      quantity: Number(leg.quantity ?? 0),
      quoteSource: leg.quoteSource ?? "TradingView",
      riskFreeRate: Number(leg.riskFreeRate ?? 0.0425) || 0.0425,
      rootSymbol: leg.rootSymbol ?? row.underlyingFamily ?? row.underlyingSymbol,
      strike: Number(leg.strike ?? 0)
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
  const tableColumnCount = 15;
  const [symbolInput, setSymbolInput] = useState("SPY");
  const [savedTickers, setSavedTickers] = useState(() => readSavedTradingViewTickers());
  const [dateFrom, setDateFrom] = useState(startOfCurrentMonthIso);
  const [dateTo, setDateTo] = useState(endOfCurrentMonthIso);
  const [priceMin, setPriceMin] = useState("5");
  const [priceMax, setPriceMax] = useState("10");
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedRowId, setSelectedRowId] = useState(null);
  const [selectedStrategyTypeKeys, setSelectedStrategyTypeKeys] = useState([]);
  const [strategyTypeSearchInput, setStrategyTypeSearchInput] = useState("");
  const [moneynessSearchInput, setMoneynessSearchInput] = useState("");
  const [volumeMin, setVolumeMin] = useState("");
  const [volumeMax, setVolumeMax] = useState("");
  const [spreadWidthMin, setSpreadWidthMin] = useState("");
  const [spreadWidthMax, setSpreadWidthMax] = useState("");
  const [selectedMoneynessKeys, setSelectedMoneynessKeys] = useState([]);
  const [symmetryOnly, setSymmetryOnly] = useState(false);
  const [optionSpreadType, setOptionSpreadType] = useState("percent");
  const [optionSpreadMin, setOptionSpreadMin] = useState("");
  const [optionSpreadMax, setOptionSpreadMax] = useState("");
  const [normalizedVolumeMin, setNormalizedVolumeMin] = useState("");
  const [normalizedVolumeMax, setNormalizedVolumeMax] = useState("");
  const [tableMaxLossMin, setTableMaxLossMin] = useState("");
  const [tableMaxLossMax, setTableMaxLossMax] = useState("");
  const [midMinusTheoMin, setMidMinusTheoMin] = useState("");
  const [midMinusTheoMax, setMidMinusTheoMax] = useState("");
  const [sortState, setSortState] = useState([{ key: "rewardRisk", direction: "desc" }]);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [strategyEditorOpen, setStrategyEditorOpen] = useState(false);
  const [scenarioOrderDraft, setScenarioOrderDraft] = useState(null);
  const [paperOrderSaving, setPaperOrderSaving] = useState(false);
  const [paperOrderState, setPaperOrderState] = useState(null);
  const [paperTradeDate, setPaperTradeDate] = useState("");
  const [paperExecutionRoute, setPaperExecutionRoute] = useState("tws-paper");
  const [paperComboQuantity, setPaperComboQuantity] = useState(1);
  const [paperComboQuantityInput, setPaperComboQuantityInput] = useState("1");
  const [paperIbkrOrderType, setPaperIbkrOrderType] = useState("LMT");
  const [paperIbkrLimitPrice, setPaperIbkrLimitPrice] = useState("");
  const [paperIbkrTif, setPaperIbkrTif] = useState("DAY");
  const [paperIbkrOutsideRth, setPaperIbkrOutsideRth] = useState(false);
  const [paperIbkrSmartEnabled, setPaperIbkrSmartEnabled] = useState(false);
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

  const allStrategyTypeKeys = useMemo(
    () => TRADING_VIEW_STRATEGY_TYPES.map((strategyType) => strategyType.key),
    []
  );
  const allStrategyTypesSelected =
    !selectedStrategyTypeKeys.length ||
    selectedStrategyTypeKeys.length >= TRADING_VIEW_STRATEGY_TYPES.length;
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
  const allMoneynessSelected =
    !selectedMoneynessKeys.length ||
    selectedMoneynessKeys.length >= TRADING_VIEW_MONEYNESS_OPTIONS.length;
  const moneyness = useMemo(() => {
    if (allMoneynessSelected) {
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
      setSelectedRowId((current) => current ?? nextPayload.rows?.[0]?.id ?? null);
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
    () =>
      rows.filter((row) => {
        const normalizedVolumeMatch = matchesMetricRange(row.normalizedOptionVolume, normalizedVolumeRange);
        const maxLossMatch = matchesMetricRange(row.maxLoss, maxLossRange);
        const bidAskSpreadMatch = matchesTradingViewOptionSpreadRange(row, optionSpreadRange);
        const midMinusTheoMatch = matchesMetricRange(getTradingViewMidMinusTheo(row), midMinusTheoRange);

        return normalizedVolumeMatch && maxLossMatch && bidAskSpreadMatch && midMinusTheoMatch;
      }),
    [maxLossRange, midMinusTheoRange, normalizedVolumeRange, optionSpreadRange, rows]
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
  const ibkrSuggestedLimitPrice = useMemo(
    () => calculateIbkrNetLimitPrice(selectedScenarioOrder?.legs ?? []),
    [selectedScenarioOrder?.legs]
  );
  const twsLimitPriceWindow = useMemo(
    () => buildTwsLimitPriceWindow(ibkrSuggestedLimitPrice, paperIbkrLimitPrice),
    [ibkrSuggestedLimitPrice, paperIbkrLimitPrice]
  );
  const ibkrStatus = paperPortfolio?.brokerStatus?.ibkr ?? null;
  const [twsStatus, setTwsStatus] = useState(() => paperPortfolio?.brokerStatus?.tws ?? null);
  const ibkrReady = isIbkrReady(ibkrStatus);
  const ibkrReloginNeeded = isIbkrReloginNeeded(ibkrStatus);
  const ibkrLoginUrl = getIbkrGatewayLoginUrl();
  const twsReady = isTwsReady(twsStatus);
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
        const payload = await response.json().catch(() => null);
        if (!cancelled && response.ok) {
          setTwsStatus(payload?.tws ?? null);
        }
      } catch (_error) {
        // ignore
      }
    }

    void refreshTwsStatus();
    return () => {
      cancelled = true;
    };
  }, [paperExecutionRoute]);

  useEffect(() => {
    if (!sortedRows.length) {
      setSelectedRowId(null);
      return;
    }

    const selectionStillVisible = sortedRows.some((row) => row.id === selectedRowId);
    if (!selectionStillVisible) {
      setSelectedRowId(sortedRows[0].id);
      setDetailCollapsed(false);
    }
  }, [selectedRowId, sortedRows]);

  useEffect(() => {
    setScenarioOrderDraft(baseScenarioOrder ? cloneTradingViewScenarioOrder(baseScenarioOrder) : null);
    setStrategyEditorOpen(false);
    setPaperOrderSaving(false);
    setPaperOrderState(null);
    setPaperTradeDate(baseScenarioOrder?.purchaseDate ?? new Date().toISOString().slice(0, 10));
    setPaperExecutionRoute("tws-paper");
    setPaperComboQuantity(1);
    setPaperComboQuantityInput("1");
    setPaperIbkrOrderType("LMT");
    setPaperIbkrTif("DAY");
    setPaperIbkrOutsideRth(false);
    setPaperIbkrSmartEnabled(false);
    const nextSuggestedLimit = calculateIbkrNetLimitPrice(baseScenarioOrder?.legs ?? []);
    setPaperIbkrLimitPrice(
      nextSuggestedLimit == null ? "" : String(Number(nextSuggestedLimit.toFixed(2)))
    );
  }, [baseScenarioOrder?.id]);

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
    if (paperIbkrOrderType === "LMT" && !paperIbkrLimitPrice && ibkrSuggestedLimitPrice != null) {
      setPaperIbkrLimitPrice(String(Number(ibkrSuggestedLimitPrice.toFixed(2))));
    }
  }, [ibkrSuggestedLimitPrice, paperIbkrLimitPrice, paperIbkrOrderType]);

  useEffect(() => {
    if (paperIbkrOrderType !== "LMT" && paperIbkrSmartEnabled) {
      setPaperIbkrSmartEnabled(false);
    }
  }, [paperIbkrOrderType, paperIbkrSmartEnabled]);

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
      if (
        !current.length ||
        current.length >= TRADING_VIEW_STRATEGY_TYPES.length
      ) {
        return allStrategyTypeKeys.filter((key) => key !== strategyTypeKey);
      }

      if (current.includes(strategyTypeKey)) {
        return current.length === 1 ? current : current.filter((item) => item !== strategyTypeKey);
      }

      const nextSelection = [...current, strategyTypeKey];
      return nextSelection.length >= TRADING_VIEW_STRATEGY_TYPES.length ? [] : nextSelection;
    });
  }

  function isStrategyTypeSelected(strategyTypeKey) {
    return allStrategyTypesSelected || selectedStrategyTypeKeys.includes(strategyTypeKey);
  }

  function toggleMoneynessKey(moneynessKey) {
    setSelectedMoneynessKeys((current) => {
      if (!current.length || current.length >= TRADING_VIEW_MONEYNESS_OPTIONS.length) {
        return TRADING_VIEW_MONEYNESS_OPTIONS.map((option) => option.key).filter(
          (key) => key !== moneynessKey
        );
      }

      if (current.includes(moneynessKey)) {
        return current.length === 1 ? current : current.filter((key) => key !== moneynessKey);
      }

      const nextSelection = [...current, moneynessKey];
      return nextSelection.length >= TRADING_VIEW_MONEYNESS_OPTIONS.length ? [] : nextSelection;
    });
  }

  function isMoneynessSelected(moneynessKey) {
    return allMoneynessSelected || selectedMoneynessKeys.includes(moneynessKey);
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

  async function handleCreatePaperTrade() {
    if (!selectedScenarioOrder || !onCreatePaperOrder) {
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

        if (!(selectedScenarioOrder.legs ?? []).length) {
          throw new Error("This setup does not have any option legs to route to IBKR.");
        }

        if (paperIbkrOrderType === "LMT") {
          if (paperIbkrLimitPrice === "") {
            throw new Error("Enter an IBKR limit price before routing this order.");
          }

          const parsedLimitPrice = Number(paperIbkrLimitPrice);
          const optionLegCount = (selectedScenarioOrder.legs ?? []).filter((leg) => leg?.kind === "option").length;
          const allowsSignedNet = optionLegCount > 1;

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

        if (!(selectedScenarioOrder.legs ?? []).length) {
          throw new Error("This setup does not have any option legs to route to TWS.");
        }

        if (paperIbkrOrderType === "LMT") {
          if (paperIbkrLimitPrice === "") {
            throw new Error("Enter a TWS limit price before routing this order.");
          }

          const parsedLimitPrice = Number(paperIbkrLimitPrice);
          const optionLegCount = (selectedScenarioOrder.legs ?? []).filter((leg) => leg?.kind === "option").length;
          const allowsSignedNet = optionLegCount > 1;

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
              limitPrice:
                paperIbkrOrderType === "LMT"
                  ? Number(paperIbkrLimitPrice)
                  : null,
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
                limitPrice:
                  paperIbkrOrderType === "LMT"
                    ? Number(paperIbkrLimitPrice)
                    : null,
                accountId: twsStatus?.selectedAccount ?? ""
              }
          : {
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

            <div className="tv-finder__toolbar-actions">
              <button type="submit" className="finder-action tv-finder__run-button" disabled={loading}>
                {loading ? "Loading..." : "Run scan"}
              </button>
              {payload?.source?.pageUrl ? (
                <a
                  className="finder-action tv-finder__link-button"
                  href={payload.source.pageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open TradingView
                </a>
              ) : null}
            </div>
          </div>

          <div className="tv-finder__filter-row">
            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
              <summary
                className={`finder-control tv-finder__filter-control ${
                  activeExpectedPricePreset ? "tv-finder__filter-control--active" : ""
                }`}
              >
                <span>{expectedPriceSummary}</span>
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
                        activeExpectedPricePreset?.label === preset.label
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
                      />
                    </label>
                    <label>
                      <span>Max %</span>
                      <input
                        type="number"
                        step="0.5"
                        value={priceMax}
                        onChange={(event) => setPriceMax(event.target.value)}
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details className="finder-menu tv-finder__strategy-menu">
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
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => setSelectedStrategyTypeKeys([])}
                  >
                    Select all
                  </button>
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
                    {allStrategyTypesSelected
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

            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
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
                  <button
                    type="button"
                    className="finder-menu__reset"
                    onClick={() => setSelectedMoneynessKeys([])}
                  >
                    Select all
                  </button>
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

            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
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

            <details className="finder-menu tv-finder__compact-menu">
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
                      setTableMaxLossMin("");
                      setTableMaxLossMax("");
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
                        placeholder="-500"
                      />
                    </label>
                    <label>
                      <span>Max</span>
                      <input
                        type="number"
                        step="0.01"
                        value={tableMaxLossMax}
                        onChange={(event) => setTableMaxLossMax(event.target.value)}
                        placeholder="-50"
                      />
                    </label>
                  </div>
                </div>
              </div>
            </details>

            <details className="finder-menu tv-finder__compact-menu">
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
          </div>
        </form>

        <p className="card-copy tv-finder__hint">
          Public option underlyings like SPY and TSLA can work without your TradingView account in the current scan flow. We can widen the symbol coverage from here once you like the detail experience.
        </p>
      </section>

      {error ? (
        <div className="screening-v2__notice screening-v2__notice--error">{error}</div>
      ) : null}

      {payload ? (
        <section className="screening-v2__summary-grid">
          <article className="insight-card screening-v2__summary-card">
            <span className="brand__eyebrow">Loaded symbol</span>
            <strong>{payload.request?.symbol ?? "n/a"}</strong>
            <p className="card-copy">TradingView underlying currently backing this scan.</p>
          </article>

          <article className="insight-card screening-v2__summary-card">
            <span className="brand__eyebrow">Returned rows</span>
            <strong>{payload.summary?.displayedCount ?? sortedRows.length}</strong>
            <p className="card-copy">Live ranked rows currently returned by TradingView for this request window.</p>
          </article>

          <article className="insight-card screening-v2__summary-card">
            <span className="brand__eyebrow">Expected move</span>
            <strong>
              {formatNumber(payload.request?.priceRange?.min ?? 0, 1)}% to {formatNumber(payload.request?.priceRange?.max ?? 0, 1)}%
            </strong>
            <p className="card-copy">This matches the TradingView price-range filter used for the live scan.</p>
          </article>
        </section>
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
              <thead>
                <tr>
                  <th>{renderSortHeader("expiration", "Expiration")}</th>
                  <th>{renderSortHeader("daysToExpiration", "Days")}</th>
                  <th>{renderSortHeader("strategyTypeLabel", "Strategy type")}</th>
                  <th>Formula</th>
                  <th>{renderSortHeader("normalizedOptionVolume", "Opt vol (norm)")}</th>
                  <th>{renderSortHeader("midMinusTheo", "Avg B/A - Theo")}</th>
                  <th>{renderSortHeader("maxProfit", "Max profit")}</th>
                  <th>{renderSortHeader("maxLoss", "Max loss")}</th>
                  <th>{renderSortHeader("rewardRisk", "Reward/Risk")}</th>
                  <th>{renderSortHeader("breakevens", "Breakeven(s)")}</th>
                  <th>{renderSortHeader("theoreticalPrice", "Theo price")}</th>
                  <th>{renderSortHeader("bid", "Bid")}</th>
                  <th>{renderSortHeader("ask", "Ask")}</th>
                  <th>{renderSortHeader("bidAskSpreadPercent", "Bid-ask spread")}</th>
                  <th>{renderSortHeader("probabilityOfProfit", "POP")}</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => {
                  const isSelected = row.id === selectedRowId;

                  return (
                    <Fragment key={row.id}>
                      <tr
                        aria-expanded={isSelected && !detailCollapsed}
                        className={isSelected ? "screening-v2__table-row--active" : ""}
                        onClick={() => handleRowSelect(row.id)}
                      >
                        <td>{row.expiration || "n/a"}</td>
                        <td>{row.daysToExpiration ?? "n/a"}</td>
                        <td>
                          <strong>{row.strategyTypeLabel}</strong>
                          <div className="screening-v2__subtle">{row.underlyingFamily || row.underlyingSymbol}</div>
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
                            {formatCurrency(getTradingViewMidMinusTheo(row))}
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
                      </tr>

                      {isSelected && !detailCollapsed ? (
                        <tr className="tv-finder__detail-row">
                          <td colSpan={tableColumnCount} className="tv-finder__detail-cell">
                            <section className="selection-banner tv-finder__selection-banner">
                              <div className="selection-banner__title">
                                <span className="brand__eyebrow">Selected strategy</span>
                                <strong>
                                  {row.underlyingSymbol} · {row.strategyTypeLabel} · {row.expiration || "n/a"}
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
                                    <h3>{row.strategyTypeLabel}</h3>
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
                                      {strategyEditorOpen ? "Close editor" : "Edit strategy"}
                                    </button>
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
                                  <div>
                                    <span className="brand__eyebrow">Paper-trade this setup</span>
                                    <strong className="paper-order-ticket__title">
                                      {row.underlyingSymbol} · {row.strategyTypeLabel}
                                    </strong>
                                    <p className="card-copy">
                                      Save the current edited leg prices and contract amounts as a new paper order, or
                                      route the option legs to your IBKR paper gateway or TWS paper session.
                                    </p>
                                    <div className="paper-order-ticket__status">
                                      <span className={`pill ${paperExecutionRoute === "local-paper" ? "pill--ghost" : "pill--live"}`}>
                                        {paperExecutionRoute === "ibkr-paper"
                                          ? "IBKR paper route"
                                          : paperExecutionRoute === "tws-paper"
                                            ? "TWS paper route"
                                            : "Local paper route"}
                                      </span>
                                      {paperExecutionRoute === "ibkr-paper" ? (
                                        <span className={`pill ${ibkrReady ? "pill--long" : "pill--warning"}`}>
                                          {ibkrReady
                                            ? `Gateway ready${ibkrStatus?.selectedAccount ? ` · ${ibkrStatus.selectedAccount}` : ""}`
                                            : "Gateway not ready"}
                                        </span>
                                      ) : paperExecutionRoute === "tws-paper" ? (
                                        <span className={`pill ${twsReady ? "pill--long" : "pill--warning"}`}>
                                          {twsReady
                                            ? `TWS ready${twsStatus?.selectedAccount ? ` · ${twsStatus.selectedAccount}` : ""}`
                                            : "TWS not ready"}
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
                                    {paperExecutionRoute === "tws-paper" ? (
                                      <p className="paper-order-ticket__note">
                                        {twsReady
                                          ? "HedgeHub will submit the option legs to the connected TWS paper session and keep order status synced. Update/cancel/close orders manually inside TWS."
                                          : twsStatus?.error ||
                                            "Connect TWS in paper mode and enable API socket clients, then enter the IP/port in the sidebar and connect."}
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
	                                        <option value="tws-paper">TWS paper</option>
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
                                      <label>
                                        <span>TWS limit</span>
                                        <select
                                          value={paperIbkrLimitPrice}
                                          onChange={(event) => setPaperIbkrLimitPrice(event.target.value)}
                                        >
                                          {twsLimitPriceWindow.map((option) => (
                                            <option key={`tws-limit:${option}`} value={option}>
                                              {option}
                                            </option>
                                          ))}
                                        </select>
                                      </label>
                                    ) : null}
                                    {paperExecutionRoute === "ibkr-paper" || paperExecutionRoute === "tws-paper" ? (
                                      <label>
                                        <span>TIF</span>
                                        <select
                                          value={paperIbkrTif}
                                          onChange={(event) => setPaperIbkrTif(event.target.value)}
                                        >
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
                                  </div>
                                </section>

                                {strategyEditorOpen && selectedScenarioOrder ? (
                                  <section className="strategy-editor">
                                    <div className="strategy-editor__header">
                                      <div>
                                        <span className="brand__eyebrow">Strategy editor</span>
                                        <p className="detail-chart__copy">
                                          Adjust the selected TradingView legs before sending the setup into HedgeHub&apos;s paper book.
                                        </p>
                                      </div>
                                      <div className="detail-badges">
                                        <span className="pill pill--ghost">Manual editor</span>
                                        <span className="pill pill--live">{selectedScenarioOrder.assetLabel}</span>
                                      </div>
                                    </div>

                                    <div className="strategy-editor__grid">
                                      {(selectedScenarioOrder.legs ?? []).map((leg, index) => (
                                        <article key={leg.id} className="strategy-editor__card">
                                          <div className="strategy-editor__card-head">
                                            <strong>Leg {index + 1}</strong>
                                            <span className="pill pill--ghost">{leg.contractSymbol || formatStrategyLegLabel(leg)}</span>
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
                                                  updateScenarioDraftLeg(leg.id, { optionType: event.target.value })
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
                                                  updateScenarioDraftLeg(leg.id, { expiry: event.target.value })
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
                                                    strike: Number(event.target.value || 0)
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
                                        </article>
                                      ))}
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
                                            <th>Code</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {(selectedScenarioOrder?.legs ?? []).map((leg) => (
                                            <tr key={`${row.id}:${leg.contractSymbol}:${leg.action}`}>
                                              <td>{leg.action}</td>
                                              <td>{leg.quantity}</td>
                                              <td>
                                                {formatNumber(leg.strike, 2)}
                                                {String(leg.optionType ?? "call").toUpperCase()} · {leg.expiration}
                                              </td>
                                              <td>{formatCurrency(leg.entryPrice)}</td>
                                              <td>{formatCurrency(leg.bid)}</td>
                                              <td>{formatCurrency(leg.ask)}</td>
                                              <td>
                                                <div className="screening-v2__contract-link">
                                                  <strong>{leg.contractSymbol || `${leg.action} ${leg.optionType} ${leg.strike}`}</strong>
                                                  <span>{leg.quoteSource ?? "TradingView"}</span>
                                                </div>
                                              </td>
                                            </tr>
                                          ))}
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
