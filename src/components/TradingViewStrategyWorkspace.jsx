import { Fragment, useEffect, useMemo, useState } from "react";
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
const DEFAULT_EXPECTED_PRICE_RANGE = {
  min: 5,
  max: 10
};

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

function parseOptionalNumberInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const numericValue = Number(raw);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function normalizeTradingViewSymbolInput(value) {
  const raw = String(value ?? "").trim().toUpperCase();
  if (!raw) {
    return "SPY";
  }

  return raw;
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

function sortTradingViewRows(rows, sortKey, sortDirection) {
  const directionMultiplier = sortDirection === "asc" ? 1 : -1;

  return [...rows].sort((left, right) => {
    const comparedValue = compareNullableValues(
      getTradingViewSortValue(left, sortKey),
      getTradingViewSortValue(right, sortKey)
    );

    if (comparedValue !== 0) {
      return comparedValue * directionMultiplier;
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

function formatStrategyLegLabel(leg) {
  if (!leg) {
    return "";
  }

  const strike = Number(leg.strike ?? 0);
  const optionCode = leg.optionType === "put" ? "P" : "C";
  return `${Number.isFinite(strike) ? strike.toFixed(0) : "?"}${optionCode}`;
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
  theme = "dark"
}) {
  const tableColumnCount = 13;
  const [symbolInput, setSymbolInput] = useState("SPY");
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
  const [sortKey, setSortKey] = useState("rewardRisk");
  const [sortDirection, setSortDirection] = useState("desc");
  const [detailCollapsed, setDetailCollapsed] = useState(false);
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
  const visibleMoneynessOptions = useMemo(() => {
    const normalizedQuery = moneynessSearchInput.trim().toLowerCase();

    if (!normalizedQuery) {
      return TRADING_VIEW_MONEYNESS_OPTIONS;
    }

    return TRADING_VIEW_MONEYNESS_OPTIONS.filter((option) =>
      option.label.toLowerCase().includes(normalizedQuery)
    );
  }, [moneynessSearchInput]);

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
  const sortedRows = useMemo(
    () => sortTradingViewRows(rows, sortKey, sortDirection),
    [rows, sortDirection, sortKey]
  );
  const selectedRow = sortedRows.find((row) => row.id === selectedRowId) ?? null;
  const selectedScenarioOrder = useMemo(
    () => buildTradingViewScenarioOrder(selectedRow, payload?.generatedAt),
    [payload?.generatedAt, selectedRow]
  );

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

  function toggleSort(nextSortKey) {
    if (sortKey === nextSortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortKey(nextSortKey);
    setSortDirection(SORT_DEFAULT_DIRECTIONS[nextSortKey] ?? "desc");
  }

  function renderSortHeader(nextSortKey, label) {
    const isActive = sortKey === nextSortKey;

    return (
      <button
        type="button"
        className={`tv-finder__sort-button ${isActive ? "tv-finder__sort-button--active" : ""}`}
        onClick={() => toggleSort(nextSortKey)}
      >
        <span>{label}</span>
        <span className="tv-finder__sort-icon" aria-hidden="true">
          {isActive ? (sortDirection === "asc" ? "^" : "v") : ""}
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
            <label className="tv-finder__symbol-field">
              <span>Underlying symbol</span>
              <input
                type="text"
                value={symbolInput}
                onChange={(event) => setSymbolInput(event.target.value)}
                placeholder="SPY or NASDAQ:TSLA"
              />
            </label>

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
          <span className="pill pill--ghost">{sortedRows.length}</span>
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
                                    {row.pageUrl ? (
                                      <a href={row.pageUrl} target="_blank" rel="noreferrer" className="pill pill--ghost">
                                        Open TradingView screen
                                      </a>
                                    ) : null}
                                  </div>
                                </div>

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
                                          {(row.legs ?? []).map((leg) => (
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
