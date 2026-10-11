import { coveredCapital, coveredBreakeven, coveredPayoff } from "../shared/optionMath.js";
import { assessQuote, finiteNumber, timestampIso } from "./quoteQuality.js";
import { normalCdf, optionPrice as blackScholesOptionPrice } from "../shared/optionMath.js";
import { fetchStockDailyOhlcHistory, normalizeTicker } from "./stockOhlcHistory.js";
import { fetchStockFundamentals } from "./stockFundamentals.js";
import { pickOptionReferencePrice } from "./optionPricing.js";

const DEFAULT_RISK_FREE_RATE = 0.0425;
const DEFAULT_MAX_ALLOCATED_CASH = 100_000;
const DEFAULT_TARGET_DTE = [7, 15, 21, 30];
const DEFAULT_STRATEGY_MODES = [
  "cash_secured_put",
  "covered_call",
  "covered_strangle"
];
const DEFAULT_MIN_OPTION_VOLUME = 50;
const DEFAULT_MIN_OPEN_INTEREST = 100;
const DEFAULT_MAX_BID_ASK_SPREAD_PCT = 10;
const DEFAULT_PUT_DELTA_RANGE = { min: 0.15, max: 0.3 };
const DEFAULT_CALL_DELTA_RANGE = { min: 0.1, max: 0.25 };
const DEFAULT_TOP_RESULTS = 40;
const HISTORY_LOOKBACK_POINTS = 320;
const EXPIRY_SEARCH_BUFFER_DAYS = 8;
const QUOTE_STALENESS_WARNING = "Spot quote unavailable, falling back to daily close.";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toNumber(value, fallback = null) {
  return finiteNumber(value, fallback);
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function parseIsoDate(value) {
  if (!value) {
    return null;
  }

  const normalizedValue =
    typeof value === "number" ? new Date(value).toISOString() : String(value).trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(normalizedValue)
    ? new Date(`${normalizedValue}T00:00:00.000Z`)
    : new Date(normalizedValue);

  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(value) {
  return value.toISOString().slice(0, 10);
}

function addDays(dateValue, days) {
  const date = parseIsoDate(dateValue) ?? new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  date.setUTCDate(date.getUTCDate() + days);
  return toIsoDate(date);
}

function differenceInDays(leftValue, rightValue) {
  const left = parseIsoDate(leftValue);
  const right = parseIsoDate(rightValue);
  if (!left || !right) {
    return null;
  }

  const leftUtc = new Date(Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate()));
  const rightUtc = new Date(Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate()));
  return Math.round((rightUtc.getTime() - leftUtc.getTime()) / (24 * 60 * 60 * 1000));
}

function average(values) {
  const numericValues = (values ?? []).filter(Number.isFinite);
  if (!numericValues.length) {
    return null;
  }

  return numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
}

function standardDeviation(values) {
  const numericValues = (values ?? []).filter(Number.isFinite);
  if (numericValues.length < 2) {
    return null;
  }

  const mean = average(numericValues);
  const variance =
    numericValues.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) /
    (numericValues.length - 1);
  return Math.sqrt(variance);
}

function percentile(values, percentileRank) {
  const numericValues = (values ?? []).filter(Number.isFinite).sort((left, right) => left - right);
  if (!numericValues.length) {
    return null;
  }

  const normalizedRank = clamp(Number(percentileRank ?? 0), 0, 1);
  const index = (numericValues.length - 1) * normalizedRank;
  const lowerIndex = Math.floor(index);
  const upperIndex = Math.ceil(index);
  if (lowerIndex === upperIndex) {
    return numericValues[lowerIndex];
  }

  const ratio = index - lowerIndex;
  return numericValues[lowerIndex] + (numericValues[upperIndex] - numericValues[lowerIndex]) * ratio;
}

function quoteLookup(quotes) {
  return new Map(
    (quotes ?? []).map((quote) => [String(quote.symbol ?? "").trim().toUpperCase(), quote])
  );
}

function normalizeScanConfig(input = {}) {
  const symbols = Array.isArray(input.symbols)
    ? input.symbols.map((value) => normalizeTicker(value)).filter(Boolean)
    : [];
  const uniqueSymbols = [...new Set(symbols)];

  const requestedStrategyModes = Array.isArray(input.strategyModes)
    ? input.strategyModes.filter((value) => DEFAULT_STRATEGY_MODES.includes(value))
    : [];
  const strategyModes = requestedStrategyModes.length
    ? requestedStrategyModes
    : [...DEFAULT_STRATEGY_MODES];

  const targetDte = Array.isArray(input.targetDte)
    ? input.targetDte
        .map((value) => Math.max(Math.round(Number(value ?? 0) || 0), 1))
        .filter(Boolean)
    : [...DEFAULT_TARGET_DTE];

  const putDeltaRange = {
    min: clamp(toNumber(input?.putDeltaRange?.min, DEFAULT_PUT_DELTA_RANGE.min), 0.01, 0.99),
    max: clamp(toNumber(input?.putDeltaRange?.max, DEFAULT_PUT_DELTA_RANGE.max), 0.01, 0.99)
  };
  if (putDeltaRange.min > putDeltaRange.max) {
    [putDeltaRange.min, putDeltaRange.max] = [putDeltaRange.max, putDeltaRange.min];
  }

  const callDeltaRange = {
    min: clamp(toNumber(input?.callDeltaRange?.min, DEFAULT_CALL_DELTA_RANGE.min), 0.01, 0.99),
    max: clamp(toNumber(input?.callDeltaRange?.max, DEFAULT_CALL_DELTA_RANGE.max), 0.01, 0.99)
  };
  if (callDeltaRange.min > callDeltaRange.max) {
    [callDeltaRange.min, callDeltaRange.max] = [callDeltaRange.max, callDeltaRange.min];
  }

  return {
    symbols: uniqueSymbols.slice(0, 20),
    maxAllocatedCash: Math.max(
      Math.round(toNumber(input.maxAllocatedCash, DEFAULT_MAX_ALLOCATED_CASH) || DEFAULT_MAX_ALLOCATED_CASH),
      100
    ),
    strategyModes,
    targetDte: [...new Set(targetDte.length ? targetDte : DEFAULT_TARGET_DTE)].sort((left, right) => left - right),
    minOptionVolume: Math.max(Math.round(toNumber(input.minOptionVolume, DEFAULT_MIN_OPTION_VOLUME) || 0), 0),
    minOpenInterest: Math.max(Math.round(toNumber(input.minOpenInterest, DEFAULT_MIN_OPEN_INTEREST) || 0), 0),
    maxBidAskSpreadPct: Math.max(toNumber(input.maxBidAskSpreadPct, DEFAULT_MAX_BID_ASK_SPREAD_PCT) || 0, 0),
    putDeltaRange,
    callDeltaRange,
    excludeEarningsBeforeExpiry: input.excludeEarningsBeforeExpiry !== false,
    topResults: Math.max(Math.round(toNumber(input.topResults, DEFAULT_TOP_RESULTS) || DEFAULT_TOP_RESULTS), 1)
  };
}

function buildStockQuoteRequest(symbol) {
  return {
    symbol,
    sourceSymbol: `${symbol.toLowerCase().replace(/\./g, "-")}.us`,
    label: symbol,
    provider: "stooq"
  };
}

function getQuotePrice(quote) {
  return toNumber(quote?.regularMarketPrice, null);
}

function computeAtr(points, period = 14) {
  const normalizedPoints = Array.isArray(points) ? points : [];
  if (normalizedPoints.length <= period) {
    return null;
  }

  let average = 0;
  for (let index = 1; index <= period; index += 1) {
    const point = normalizedPoints[index];
    const previous = normalizedPoints[index - 1];
    const trueRange = Math.max(
      Math.abs(Number(point?.high ?? 0) - Number(point?.low ?? 0)),
      Math.abs(Number(point?.high ?? 0) - Number(previous?.close ?? 0)),
      Math.abs(Number(point?.low ?? 0) - Number(previous?.close ?? 0))
    );
    average += trueRange;
  }
  average /= period;

  for (let index = period + 1; index < normalizedPoints.length; index += 1) {
    const point = normalizedPoints[index];
    const previous = normalizedPoints[index - 1];
    const trueRange = Math.max(
      Math.abs(Number(point?.high ?? 0) - Number(point?.low ?? 0)),
      Math.abs(Number(point?.high ?? 0) - Number(previous?.close ?? 0)),
      Math.abs(Number(point?.low ?? 0) - Number(previous?.close ?? 0))
    );
    average = (average * (period - 1) + trueRange) / period;
  }

  return average;
}

function computeSma(points, period) {
  const closes = (points ?? []).map((point) => toNumber(point?.close, null)).filter(Number.isFinite);
  if (closes.length < period) {
    return null;
  }

  return average(closes.slice(-period));
}

function computeHistoricalVolatility(points, lookbackDays = 20) {
  const closes = (points ?? []).map((point) => toNumber(point?.close, null)).filter(Number.isFinite);
  if (closes.length <= lookbackDays) {
    return null;
  }

  const returns = [];
  const startIndex = Math.max(closes.length - lookbackDays - 1, 1);
  for (let index = startIndex; index < closes.length; index += 1) {
    const previous = closes[index - 1];
    const current = closes[index];
    if (!(previous > 0) || !(current > 0)) {
      continue;
    }
    returns.push(Math.log(current / previous));
  }

  const sigma = standardDeviation(returns);
  return sigma != null ? sigma * Math.sqrt(252) : null;
}

function buildSwingLevels(points, type = "low", lookback = 120, pivotWidth = 3) {
  const recentPoints = (points ?? []).slice(-lookback);
  const levels = [];
  for (let index = pivotWidth; index < recentPoints.length - pivotWidth; index += 1) {
    const point = recentPoints[index];
    const value = toNumber(point?.[type === "low" ? "low" : "high"], null);
    if (!Number.isFinite(value)) {
      continue;
    }

    let isPivot = true;
    for (let offset = 1; offset <= pivotWidth; offset += 1) {
      const previousValue = toNumber(recentPoints[index - offset]?.[type === "low" ? "low" : "high"], null);
      const nextValue = toNumber(recentPoints[index + offset]?.[type === "low" ? "low" : "high"], null);
      if (
        !Number.isFinite(previousValue) ||
        !Number.isFinite(nextValue) ||
        (type === "low" && (value > previousValue || value > nextValue)) ||
        (type === "high" && (value < previousValue || value < nextValue))
      ) {
        isPivot = false;
        break;
      }
    }

    if (isPivot) {
      levels.push({
        price: value,
        date: point?.date ?? null
      });
    }
  }

  return levels;
}

function pickNearestLevel(levels, currentPrice, direction = "below") {
  const candidates = (levels ?? []).filter((level) => {
    const price = toNumber(level?.price, null);
    if (!Number.isFinite(price)) {
      return false;
    }

    return direction === "below" ? price <= currentPrice : price >= currentPrice;
  });

  if (!candidates.length) {
    return null;
  }

  return [...candidates].sort((left, right) => {
    const leftDistance = Math.abs(left.price - currentPrice);
    const rightDistance = Math.abs(right.price - currentPrice);
    return leftDistance - rightDistance;
  })[0];
}

function buildClusterLevel(methods, currentPrice, atr, kind = "support") {
  const rawLevels = methods
    .map((method) => {
      const price = toNumber(method?.price, null);
      return Number.isFinite(price) && price > 0 ? { ...method, price } : null;
    })
    .filter(Boolean);

  if (!rawLevels.length) {
    return {
      price: null,
      confidenceScore: 0,
      sources: [],
      methods: []
    };
  }

  const tolerance = Math.max(toNumber(atr, 0) || currentPrice * 0.015, currentPrice * 0.0125, 1);
  const clustered = rawLevels.map((level) => ({
    ...level,
    weight: level.weight ?? 1
  }));
  const weightedAverage =
    clustered.reduce((sum, level) => sum + level.price * level.weight, 0) /
    clustered.reduce((sum, level) => sum + level.weight, 0);
  const inCluster = clustered.filter((level) => Math.abs(level.price - weightedAverage) <= tolerance);
  const activeLevels = inCluster.length ? inCluster : clustered;
  const price = average(activeLevels.map((level) => level.price));
  const spread = Math.max(...activeLevels.map((level) => level.price)) - Math.min(...activeLevels.map((level) => level.price));
  const proximityScore = clamp(100 - (spread / Math.max(tolerance, 1)) * 18, 20, 100);
  const countScore = clamp(activeLevels.length / 4, 0.25, 1) * 45;
  const recencyScore = activeLevels.some((level) => level.isRecent === true) ? 15 : 0;
  const directionalScore =
    kind === "support"
      ? price <= currentPrice
        ? 10
        : 0
      : price >= currentPrice
        ? 10
        : 0;

  return {
    price: formatNumber(price, 2),
    confidenceScore: formatNumber(clamp(countScore + recencyScore + directionalScore + proximityScore * 0.3, 0, 100), 0),
    sources: activeLevels.map((level) => level.source),
    methods: activeLevels
  };
}

export function buildPriceZones(points, currentPrice) {
  const atr14 = computeAtr(points, 14);
  const atr20 = computeAtr(points, 20);
  const sma20 = computeSma(points, 20);
  const sma50 = computeSma(points, 50);
  const sma200 = computeSma(points, 200);
  const swingLows = buildSwingLevels(points, "low", 120, 3);
  const swingHighs = buildSwingLevels(points, "high", 120, 3);
  const recentRange = (points ?? []).slice(-20);
  const recentRangeLow = Math.min(...recentRange.map((point) => toNumber(point?.low, Infinity)));
  const recentRangeHigh = Math.max(...recentRange.map((point) => toNumber(point?.high, -Infinity)));
  const lowerQuarter = percentile((points ?? []).map((point) => toNumber(point?.close, null)), 0.35);
  const upperQuarter = percentile((points ?? []).map((point) => toNumber(point?.close, null)), 0.65);

  const supportMethods = [
    pickNearestLevel(swingLows, currentPrice, "below")
      ? {
          source: "recent_swing_low",
          price: pickNearestLevel(swingLows, currentPrice, "below").price,
          isRecent: true,
          weight: 1.3
        }
      : null,
    Number.isFinite(recentRangeLow)
      ? {
          source: "recent_range_low",
          price: recentRangeLow,
          isRecent: true,
          weight: 1.1
        }
      : null,
    Number.isFinite(sma20) && sma20 <= currentPrice
      ? {
          source: "moving_average_support_sma20",
          price: sma20,
          weight: 0.9
        }
      : null,
    Number.isFinite(sma50) && sma50 <= currentPrice
      ? {
          source: "moving_average_support_sma50",
          price: sma50,
          weight: 1
        }
      : null,
    Number.isFinite(sma200) && sma200 <= currentPrice
      ? {
          source: "moving_average_support_sma200",
          price: sma200,
          weight: 1.1
        }
      : null,
    Number.isFinite(atr14)
      ? {
          source: "atr_band",
          price: currentPrice - atr14,
          weight: 0.8
        }
      : null,
    Number.isFinite(lowerQuarter)
      ? {
          source: "historical_close_cluster",
          price: lowerQuarter,
          weight: 0.7
        }
      : null
  ].filter(Boolean);

  const resistanceMethods = [
    pickNearestLevel(swingHighs, currentPrice, "above")
      ? {
          source: "recent_swing_high",
          price: pickNearestLevel(swingHighs, currentPrice, "above").price,
          isRecent: true,
          weight: 1.3
        }
      : null,
    Number.isFinite(recentRangeHigh)
      ? {
          source: "recent_range_high",
          price: recentRangeHigh,
          isRecent: true,
          weight: 1.1
        }
      : null,
    Number.isFinite(sma20) && sma20 >= currentPrice
      ? {
          source: "moving_average_resistance_sma20",
          price: sma20,
          weight: 0.9
        }
      : null,
    Number.isFinite(sma50) && sma50 >= currentPrice
      ? {
          source: "moving_average_resistance_sma50",
          price: sma50,
          weight: 1
        }
      : null,
    Number.isFinite(sma200) && sma200 >= currentPrice
      ? {
          source: "moving_average_resistance_sma200",
          price: sma200,
          weight: 1.1
        }
      : null,
    Number.isFinite(atr14)
      ? {
          source: "atr_band",
          price: currentPrice + atr14,
          weight: 0.8
        }
      : null,
    Number.isFinite(upperQuarter)
      ? {
          source: "historical_close_cluster",
          price: upperQuarter,
          weight: 0.7
        }
      : null
  ].filter(Boolean);

  const support = buildClusterLevel(supportMethods, currentPrice, atr14, "support");
  const resistance = buildClusterLevel(resistanceMethods, currentPrice, atr14, "resistance");
  const fairValueFloorCandidates = [support.price, sma20, sma50].filter(Number.isFinite);
  const fairValueCeilingCandidates = [resistance.price, sma20, sma50].filter(Number.isFinite);
  const fairValueLower = percentile(fairValueFloorCandidates, 0.35);
  const fairValueUpper = percentile(fairValueCeilingCandidates, 0.65);

  return {
    supportPrice: support.price,
    supportConfidenceScore: support.confidenceScore,
    supportSources: support.sources,
    resistancePrice: resistance.price,
    resistanceConfidenceScore: resistance.confidenceScore,
    resistanceSources: resistance.sources,
    fairValueZone: {
      lower: formatNumber(
        Number.isFinite(fairValueLower) ? fairValueLower : average([support.price, currentPrice]),
        2
      ),
      upper: formatNumber(
        Number.isFinite(fairValueUpper) ? fairValueUpper : average([resistance.price, currentPrice]),
        2
      )
    },
    atr14: formatNumber(atr14, 2),
    atr20: formatNumber(atr20, 2),
    sma20: formatNumber(sma20, 2),
    sma50: formatNumber(sma50, 2),
    sma200: formatNumber(sma200, 2)
  };
}

function groupContractsByExpiration(contracts) {
  return (contracts ?? []).reduce((groups, contract) => {
    const expiration = String(contract?.expiration ?? "").trim();
    if (!expiration) {
      return groups;
    }

    const current = groups.get(expiration) ?? [];
    current.push(contract);
    groups.set(expiration, current);
    return groups;
  }, new Map());
}

function collectExpirationSet(...groups) {
  const expiries = new Set();
  groups.forEach((group) => {
    for (const key of group.keys()) {
      expiries.add(key);
    }
  });
  return [...expiries].sort();
}

function pickNearestExpiry(expiries, targetDte, todayIso) {
  const desiredDate = addDays(todayIso, targetDte);
  const normalizedExpiries = (expiries ?? []).filter(Boolean);
  if (!normalizedExpiries.length) {
    return desiredDate;
  }

  const ranked = normalizedExpiries
    .map((expiry) => ({
      expiry,
      diff: Math.abs(differenceInDays(desiredDate, expiry) ?? Infinity),
      dte: differenceInDays(todayIso, expiry)
    }))
    .filter((candidate) => Number.isFinite(candidate.diff) && Number.isFinite(candidate.dte) && candidate.dte > 0)
    .sort((left, right) => left.diff - right.diff || left.dte - right.dte);

  if (!ranked.length) {
    return desiredDate;
  }

  return ranked[0].expiry;
}

async function ensureContractsForExpiry({
  symbol,
  currentSpot,
  expiration,
  optionType,
  groupedContracts,
  fetchOptionChain
}) {
  const existing = groupedContracts.get(expiration);
  if (existing?.length) {
    return existing;
  }

  const chain = await fetchOptionChain({
    symbol,
    expiration,
    optionType,
    currentSpot,
    strikeHint: currentSpot,
    limit: 80
  });
  const contracts = Array.isArray(chain?.contracts) ? chain.contracts : [];
  groupedContracts.set(expiration, contracts);
  return contracts;
}

function getSpreadPct(contract) {
  const bid = toNumber(contract?.bid, null);
  const ask = toNumber(contract?.ask, null);
  const mid = pickOptionReferencePrice(contract, 0);
  if (!(bid >= 0) || !(ask >= 0) || !(mid > 0) || ask < bid) {
    return null;
  }

  return ((ask - bid) / mid) * 100;
}

export function buildLiquidityAssessment(contract, config) {
  const spreadPct = getSpreadPct(contract);
  const volume = Math.max(Math.round(toNumber(contract?.volume, 0) || 0), 0);
  const openInterest = Math.max(Math.round(toNumber(contract?.openInterest, 0) || 0), 0);
  const spreadScore =
    spreadPct == null
      ? 20
      : clamp(100 - (spreadPct / Math.max(config.maxBidAskSpreadPct, 1)) * 100, 0, 100);
  const volumeScore =
    config.minOptionVolume <= 0
      ? 100
      : clamp((volume / Math.max(config.minOptionVolume, 1)) * 100, 0, 100);
  const openInterestScore =
    config.minOpenInterest <= 0
      ? 100
      : clamp((openInterest / Math.max(config.minOpenInterest, 1)) * 100, 0, 100);
  const quoteQualityScore = contract?.hasRealBidAsk === true ? 100 : contract?.isLive === true ? 70 : 35;
  const score = average([spreadScore, volumeScore, openInterestScore, quoteQualityScore]);

  return {
    spreadPct: formatNumber(spreadPct, 2),
    volume,
    openInterest,
    isLiquid:
      assessQuote(contract).eligible &&
      volume >= config.minOptionVolume &&
      openInterest >= config.minOpenInterest &&
      (spreadPct != null && spreadPct <= config.maxBidAskSpreadPct),
    liquidityScore: formatNumber(score, 0)
  };
}

function normalizeDividendYield(dividendYieldPct) {
  const value = toNumber(dividendYieldPct, null);
  return Number.isFinite(value) ? value / 100 : 0;
}

function buildExpectedMove(spot, atmIv, dte) {
  if (!(spot > 0) || !(atmIv > 0) || !(dte > 0)) {
    return {
      atmIv: formatNumber(atmIv, 4),
      expectedMove: null,
      lower: null,
      upper: null
    };
  }

  const expectedMove = spot * atmIv * Math.sqrt(dte / 365);
  return {
    atmIv: formatNumber(atmIv, 4),
    expectedMove: formatNumber(expectedMove, 2),
    lower: formatNumber(spot - expectedMove, 2),
    upper: formatNumber(spot + expectedMove, 2)
  };
}

function pickAtmContract(contracts, currentPrice) {
  const candidates = [...(contracts ?? [])].filter((contract) => Number(contract?.strike) > 0);
  if (!candidates.length) {
    return null;
  }

  return candidates.sort((left, right) => {
    const leftDistance = Math.abs(Number(left.strike) - currentPrice);
    const rightDistance = Math.abs(Number(right.strike) - currentPrice);
    return leftDistance - rightDistance;
  })[0];
}

function buildExpectedMoveContext(callContracts, putContracts, currentPrice, dte) {
  const atmCall = pickAtmContract(callContracts, currentPrice);
  const atmPut = pickAtmContract(putContracts, currentPrice);
  const atmIv = average([
    toNumber(atmCall?.impliedVolatility, null),
    toNumber(atmPut?.impliedVolatility, null)
  ]);
  return buildExpectedMove(currentPrice, atmIv, dte);
}

function scoreDistanceFromLevel(strike, levelPrice, atr) {
  if (!(strike > 0) || !(levelPrice > 0)) {
    return 0;
  }

  const tolerance = Math.max(toNumber(atr, 0) || levelPrice * 0.02, levelPrice * 0.015, 1);
  const distance = Math.abs(strike - levelPrice);
  return clamp(100 - (distance / tolerance) * 55, 0, 100);
}

function buildSafetyScore({
  optionType,
  strike,
  expectedMoveLower,
  expectedMoveUpper,
  atr,
  spot
}) {
  if (!(strike > 0)) {
    return 0;
  }

  if (optionType === "put") {
    if (!(expectedMoveLower > 0)) {
      return clamp(((spot - strike) / Math.max(atr || spot * 0.02, 1)) * 18 + 50, 0, 100);
    }
    if (strike <= expectedMoveLower) {
      const buffer = expectedMoveLower - strike;
      return clamp(70 + (buffer / Math.max(atr || spot * 0.02, 1)) * 25, 0, 100);
    }
    const insideDistance = strike - expectedMoveLower;
    return clamp(65 - (insideDistance / Math.max(atr || spot * 0.02, 1)) * 28, 0, 100);
  }

  if (!(expectedMoveUpper > 0)) {
    return clamp(((strike - spot) / Math.max(atr || spot * 0.02, 1)) * 18 + 50, 0, 100);
  }
  if (strike >= expectedMoveUpper) {
    const buffer = strike - expectedMoveUpper;
    return clamp(70 + (buffer / Math.max(atr || spot * 0.02, 1)) * 25, 0, 100);
  }
  const insideDistance = expectedMoveUpper - strike;
  return clamp(65 - (insideDistance / Math.max(atr || spot * 0.02, 1)) * 28, 0, 100);
}

function buildAssignmentRisk(deltaAbs, isInsideExpectedMove) {
  if (!(deltaAbs >= 0)) {
    return "unknown";
  }

  if (deltaAbs >= 0.28 || isInsideExpectedMove) {
    return deltaAbs >= 0.4 ? "high" : "medium";
  }

  return deltaAbs >= 0.22 ? "medium" : "low";
}

function buildOptionLegCandidate({
  contracts,
  optionType,
  currentPrice,
  targetPrice,
  targetDeltaRange,
  config,
  dividendYield,
  riskFreeRate,
  dte,
  expectedMove,
  atr
}) {
  const candidates = [...(contracts ?? [])]
    .filter((contract) => {
      const strike = toNumber(contract?.strike, null);
      const delta = toNumber(contract?.delta, null);
      if (!(strike > 0) || !Number.isFinite(delta) || (contract.multiplier ?? 100) !== 100) {
        return false;
      }

      const deltaAbs = Math.abs(delta);
      const isCorrectSide = optionType === "put" ? strike <= currentPrice * 1.02 : strike >= currentPrice * 0.98;
      const isWithinDelta =
        deltaAbs >= targetDeltaRange.min && deltaAbs <= targetDeltaRange.max;
      return isCorrectSide && isWithinDelta;
    })
    .map((contract) => {
      const strike = Number(contract.strike);
      const mid = pickOptionReferencePrice(contract, 0);
      const timeYears = Math.max(dte / 365, 1 / 365);
      const impliedVolatility = clamp(toNumber(contract?.impliedVolatility, 0.24) || 0.24, 0.01, 4);
      const theoreticalPrice = blackScholesOptionPrice({
        type: optionType,
        spot: currentPrice,
        strike,
        timeYears,
        volatility: impliedVolatility,
        riskFreeRate,
        dividendYield
      });
      const liquidity = buildLiquidityAssessment(contract, config);
      const targetDistanceScore = scoreDistanceFromLevel(strike, targetPrice, atr);
      const safetyScore = buildSafetyScore({
        optionType,
        strike,
        expectedMoveLower: expectedMove.lower,
        expectedMoveUpper: expectedMove.upper,
        atr,
        spot: currentPrice
      });
      const premiumPercent = strike > 0 ? (mid / strike) * 100 : null;
      const richnessScore = theoreticalPrice > 0 ? clamp((mid / theoreticalPrice) * 70, 0, 100) : 45;
      const premiumScore = clamp((premiumPercent ?? 0) * 12, 0, 100);
      const finalCandidateScore = average([
        targetDistanceScore,
        premiumScore,
        liquidity.liquidityScore,
        safetyScore,
        richnessScore
      ]);

      return {
        ...contract,
        optionType,
        mid: formatNumber(mid, 2),
        theoreticalPrice: formatNumber(theoreticalPrice, 2),
        premiumToModelPct:
          theoreticalPrice > 0 ? formatNumber(((mid - theoreticalPrice) / theoreticalPrice) * 100, 2) : null,
        spreadPct: liquidity.spreadPct,
        liquidityScore: liquidity.liquidityScore,
        volume: liquidity.volume,
        openInterest: liquidity.openInterest,
        isLiquid: liquidity.isLiquid,
        targetDistanceScore: formatNumber(targetDistanceScore, 0),
        safetyScore: formatNumber(safetyScore, 0),
        premiumScore: formatNumber(premiumScore, 0),
        ivRichnessScore: formatNumber(richnessScore, 0),
        candidateScore: formatNumber(finalCandidateScore, 2)
      };
    });

  if (!candidates.length) {
    return null;
  }

  const liquidCandidates = candidates.filter((candidate) => candidate.isLiquid);
  if (!liquidCandidates.length) return null;
  const rankedPool = liquidCandidates;
  const selected = rankedPool.sort((left, right) => {
    return Number(right.candidateScore ?? 0) - Number(left.candidateScore ?? 0);
  })[0];

  return {
    ...selected,
    liquidityBypass: liquidCandidates.length === 0
  };
}

export function computeContractsForAllocation(strategyType, putStrike, callStrike, maxAllocatedCash, currentPrice) {
  const perContractAllocatedCash = coveredCapital(strategyType, currentPrice, putStrike);

  if (!(perContractAllocatedCash > 0)) {
    return {
      perContractAllocatedCash: 0,
      contracts: 0,
      allocatedCashUsed: 0
    };
  }

  const contracts = Math.max(Math.floor(maxAllocatedCash / perContractAllocatedCash), 0);
  return {
    perContractAllocatedCash,
    contracts,
    allocatedCashUsed: perContractAllocatedCash * contracts
  };
}

function buildPayoffCurveForStrategy({
  strategyType,
  currentPrice,
  putStrike,
  callStrike,
  putPremium,
  callPremium,
  contracts
}) {
  if (!(currentPrice > 0) || !(contracts > 0)) {
    return [];
  }

  const referenceLow = Math.min(
    currentPrice * 0.7,
    Number.isFinite(putStrike) ? putStrike * 0.75 : currentPrice * 0.7
  );
  const referenceHigh = Math.max(
    currentPrice * 1.3,
    Number.isFinite(callStrike) ? callStrike * 1.15 : currentPrice * 1.3
  );
  const steps = 41;
  const increment = (referenceHigh - referenceLow) / (steps - 1);

  const evaluatePnL = (terminal) => coveredPayoff({ type: strategyType, spot: currentPrice, terminal, putStrike, callStrike, putPremium, callPremium, contracts });

  return Array.from({ length: steps }, (_, index) => {
    const spot = referenceLow + increment * index;
    return {
      spot: formatNumber(spot, 2),
      pnl: formatNumber(evaluatePnL(spot), 2)
    };
  });
}

function buildScenarioPoints({
  strategyType,
  currentPrice,
  supportPrice,
  resistancePrice,
  expectedMove,
  putStrike,
  callStrike,
  putPremium,
  callPremium,
  contracts
}) {
  const candidateSpots = [
    supportPrice,
    putStrike,
    expectedMove.lower,
    currentPrice,
    callStrike,
    resistancePrice,
    expectedMove.upper
  ].filter(Number.isFinite);

  const points = [...new Set(candidateSpots.map((value) => formatNumber(value, 2)).filter(Number.isFinite))];
  const payoffCurve = buildPayoffCurveForStrategy({
    strategyType,
    currentPrice,
    putStrike,
    callStrike,
    putPremium,
    callPremium,
    contracts
  });

  return points.map(spot => ({ spot, pnl: formatNumber(coveredPayoff({ type: strategyType, spot: currentPrice, terminal: spot, putStrike, callStrike, putPremium, callPremium, contracts }), 2) }));
}

export function buildCandidateResult({
  symbol,
  companyName,
  currentPrice,
  expiryDate,
  dte,
  strategyType,
  priceZones,
  expectedMoveContext,
  putContract,
  callContract,
  maxAllocatedCash,
  earningsDate,
  earningsBeforeExpiry = null,
  historicalVolatility,
  dividendYieldPct,
  quoteWarning = null
}) {
  const putStrike = toNumber(putContract?.strike, null);
  const callStrike = toNumber(callContract?.strike, null);
  const putPremium = toNumber(putContract?.bid, 0) || 0;
  const callPremium = toNumber(callContract?.bid, 0) || 0;
  const allocation = computeContractsForAllocation(strategyType, putStrike, callStrike, maxAllocatedCash, currentPrice);
  const contracts = allocation.contracts;
  if (!(contracts > 0)) {
    return null;
  }

  const putContracts = strategyType === "covered_call" ? 0 : contracts;
  const callContracts = strategyType === "cash_secured_put" ? 0 : contracts;
  const sharesRequired = callContracts * 100;
  const stockCost = currentPrice * sharesRequired;
  const putCollateral = (putStrike ?? 0) * 100 * putContracts;
  const fullExposure = stockCost + putCollateral;
  const putPremiumTotal = putPremium * 100 * putContracts;
  const callPremiumTotal = callPremium * 100 * callContracts;
  const totalPremium = putPremiumTotal + callPremiumTotal;
  const returnOnAllocatedCashPct =
    allocation.allocatedCashUsed > 0 ? (totalPremium / allocation.allocatedCashUsed) * 100 : null;
  const annualizedReturnOnAllocatedCashPct =
    returnOnAllocatedCashPct != null && dte > 0 ? (returnOnAllocatedCashPct / dte) * 365 : null;
  const returnOnFullExposurePct = fullExposure > 0 ? (totalPremium / fullExposure) * 100 : null;
  const annualizedReturnOnFullExposurePct =
    returnOnFullExposurePct != null && dte > 0 ? (returnOnFullExposurePct / dte) * 365 : null;
  const totalCreditPerShare = putPremium + callPremium;
  const downsideBreakeven = formatNumber(coveredBreakeven(strategyType, currentPrice, putStrike, putPremium, callPremium), 2);
  const upsideBreakeven = null; // Covered stock offsets the short call above its strike.
  const calledAwayPrice =
    strategyType === "cash_secured_put" ? null : formatNumber((callStrike ?? 0) + callPremium, 2);
  const calledAwayReturnPct =
    strategyType === "cash_secured_put"
      ? null
      : formatNumber((((callStrike ?? 0) - currentPrice + callPremium) / currentPrice) * 100, 2);
  const expectedMove =
    expectedMoveContext ??
    buildExpectedMove(
      currentPrice,
      average([
        toNumber(putContract?.impliedVolatility, null),
        toNumber(callContract?.impliedVolatility, null)
      ]),
      dte
    );

  const putInsideExpectedMove =
    putContracts > 0 && Number.isFinite(putStrike) && Number.isFinite(expectedMove.lower)
      ? putStrike > expectedMove.lower
      : false;
  const callInsideExpectedMove =
    callContracts > 0 && Number.isFinite(callStrike) && Number.isFinite(expectedMove.upper)
      ? callStrike < expectedMove.upper
      : false;

  const liquidityWarning =
    (putContracts > 0 && putContract?.isLiquid !== true) || (callContracts > 0 && callContract?.isLiquid !== true);
  const capitalWarning = fullExposure > maxAllocatedCash;
  const nakedCallWarning = false;
  const atr = toNumber(priceZones?.atr14, null);

  const yieldScore = formatNumber(clamp((annualizedReturnOnAllocatedCashPct ?? 0) * 2.1, 0, 100), 0);
  const supportResistanceScore = formatNumber(
    average(
      [
        putContracts > 0 ? priceZones.supportConfidenceScore : null,
        callContracts > 0 ? priceZones.resistanceConfidenceScore : null
      ].filter(Number.isFinite)
    ),
    0
  );
  const expectedMoveSafetyScore = formatNumber(
    average(
      [
        putContracts > 0 ? putContract?.safetyScore : null,
        callContracts > 0 ? callContract?.safetyScore : null
      ].filter(Number.isFinite)
    ),
    0
  );
  const ivRichnessInputs = [];
  if (Number.isFinite(putContract?.ivRichnessScore)) {
    ivRichnessInputs.push(Number(putContract.ivRichnessScore));
  }
  if (Number.isFinite(callContract?.ivRichnessScore)) {
    ivRichnessInputs.push(Number(callContract.ivRichnessScore));
  }
  if (Number.isFinite(historicalVolatility) && Number.isFinite(expectedMove.atmIv) && historicalVolatility > 0) {
    ivRichnessInputs.push(clamp((expectedMove.atmIv / historicalVolatility) * 55, 0, 100));
  }
  const ivRichnessScore = formatNumber(average(ivRichnessInputs), 0);
  const liquidityScore = formatNumber(
    average(
      [
        putContracts > 0 ? putContract?.liquidityScore : null,
        callContracts > 0 ? callContract?.liquidityScore : null
      ].filter(Number.isFinite)
    ),
    0
  );
  const fairValueMid = average([priceZones?.fairValueZone?.lower, priceZones?.fairValueZone?.upper]);
  const valuationScore = formatNumber(
    Number.isFinite(fairValueMid)
      ? clamp(100 - (Math.abs(currentPrice - fairValueMid) / Math.max(currentPrice * 0.1, atr || 1)) * 18, 0, 100)
      : 55,
    0
  );

  let penalty = 0;
  if (earningsBeforeExpiry) {
    penalty += 30;
  }
  if (capitalWarning) {
    penalty += 20;
  }
  if (liquidityWarning) {
    penalty += 25;
  }
  if (nakedCallWarning) {
    penalty += 100;
  }

  const finalStrategyScore = formatNumber(
    clamp(
      Number(yieldScore ?? 0) * 0.25 +
        Number(supportResistanceScore ?? 0) * 0.2 +
        Number(expectedMoveSafetyScore ?? 0) * 0.2 +
        Number(ivRichnessScore ?? 0) * 0.15 +
        Number(liquidityScore ?? 0) * 0.1 +
        Number(valuationScore ?? 0) * 0.1 -
        penalty,
      0,
      100
    ),
    0
  );

  const warnings = [
    quoteWarning,
    earningsBeforeExpiry == null ? "Earnings coverage unknown." : earningsBeforeExpiry ? "Earnings land before expiry." : null,
    capitalWarning ? "Full cash-secured exposure exceeds the configured allocated cash." : null,
    putInsideExpectedMove ? "Short put sits inside the implied expected move." : null,
    callInsideExpectedMove ? "Short call sits inside the implied expected move." : null
  ].filter(Boolean);

  const payoffCurve = buildPayoffCurveForStrategy({
    strategyType,
    currentPrice,
    putStrike,
    callStrike,
    putPremium,
    callPremium,
    contracts
  });
  const scenarioPoints = buildScenarioPoints({
    strategyType,
    currentPrice,
    supportPrice: priceZones.supportPrice,
    resistancePrice: priceZones.resistancePrice,
    expectedMove,
    putStrike,
    callStrike,
    putPremium,
    callPremium,
    contracts
  });

  return {
    id: [
      symbol,
      strategyType,
      expiryDate,
      putStrike != null ? `p${putStrike}` : "pna",
      callStrike != null ? `c${callStrike}` : "cna"
    ].join(":"),
    symbol,
    companyName,
    stockPrice: formatNumber(currentPrice, 2),
    expiryDate,
    dte,
    strategyType,
    sharesRequired,
    contracts,
    put: putContracts > 0 && putContract
      ? {
          source: putContract.source,
          quoteTimestamp: putContract.quoteTimestamp,
          hasRealBidAsk: putContract.hasRealBidAsk,
          isLive: putContract.isLive,
          priceBasis: "bid (before fees)",
          strike: formatNumber(putStrike, 2),
          bid: formatNumber(toNumber(putContract.bid, null), 2),
          ask: formatNumber(toNumber(putContract.ask, null), 2),
          mid: formatNumber(putPremium, 2),
          delta: formatNumber(toNumber(putContract.delta, null), 3),
          iv: formatNumber(toNumber(putContract.impliedVolatility, null), 4),
          volume: putContract.volume ?? null,
          openInterest: putContract.openInterest ?? null,
          theoreticalPrice: putContract.theoreticalPrice ?? null,
          premiumToModelPct: putContract.premiumToModelPct ?? null,
          spreadPct: putContract.spreadPct ?? null,
          liquidityScore: putContract.liquidityScore ?? null,
          assignmentRisk: buildAssignmentRisk(Math.abs(toNumber(putContract.delta, 0) || 0), putInsideExpectedMove),
          contractSymbol: putContract.contractSymbol ?? ""
        }
      : null,
    call: callContracts > 0 && callContract
      ? {
          source: callContract.source,
          quoteTimestamp: callContract.quoteTimestamp,
          hasRealBidAsk: callContract.hasRealBidAsk,
          isLive: callContract.isLive,
          priceBasis: "bid (before fees)",
          strike: formatNumber(callStrike, 2),
          bid: formatNumber(toNumber(callContract.bid, null), 2),
          ask: formatNumber(toNumber(callContract.ask, null), 2),
          mid: formatNumber(callPremium, 2),
          delta: formatNumber(toNumber(callContract.delta, null), 3),
          iv: formatNumber(toNumber(callContract.impliedVolatility, null), 4),
          volume: callContract.volume ?? null,
          openInterest: callContract.openInterest ?? null,
          theoreticalPrice: callContract.theoreticalPrice ?? null,
          premiumToModelPct: callContract.premiumToModelPct ?? null,
          spreadPct: callContract.spreadPct ?? null,
          liquidityScore: callContract.liquidityScore ?? null,
          assignmentRisk: buildAssignmentRisk(Math.abs(toNumber(callContract.delta, 0) || 0), callInsideExpectedMove),
          contractSymbol: callContract.contractSymbol ?? ""
        }
      : null,
    premium: {
      putPremiumTotal: formatNumber(putPremiumTotal, 2),
      callPremiumTotal: formatNumber(callPremiumTotal, 2),
      totalPremium: formatNumber(totalPremium, 2)
    },
    capital: {
      maxAllocatedCash: formatNumber(maxAllocatedCash, 2),
      allocatedCashUsed: formatNumber(allocation.allocatedCashUsed, 2),
      allocatedCashPerContract: formatNumber(allocation.perContractAllocatedCash, 2),
      stockCost: formatNumber(stockCost, 2),
      putCollateral: formatNumber(putCollateral, 2),
      callCoverageNotional: formatNumber((callStrike ?? 0) * 100 * callContracts, 2),
      fullCashSecuredExposure: formatNumber(fullExposure, 2),
      brokerMarginRequired: null
    },
    returns: {
      returnOnAllocatedCashPct: formatNumber(returnOnAllocatedCashPct, 2),
      annualizedReturnOnAllocatedCashPct: formatNumber(annualizedReturnOnAllocatedCashPct, 2),
      returnOnFullExposurePct: formatNumber(returnOnFullExposurePct, 2),
      annualizedReturnOnFullExposurePct: formatNumber(annualizedReturnOnFullExposurePct, 2)
    },
    breakevens: {
      downsideBreakeven,
      upsideBreakeven,
      calledAwayPrice,
      calledAwayReturnPct
    },
    priceZones: {
      supportPrice: priceZones.supportPrice,
      supportConfidenceScore: priceZones.supportConfidenceScore,
      supportSources: priceZones.supportSources,
      resistancePrice: priceZones.resistancePrice,
      resistanceConfidenceScore: priceZones.resistanceConfidenceScore,
      resistanceSources: priceZones.resistanceSources,
      fairValueZone: priceZones.fairValueZone,
      expectedMoveLower: expectedMove.lower,
      expectedMoveUpper: expectedMove.upper,
      expectedMove: expectedMove.expectedMove,
      atmIv: expectedMove.atmIv
    },
    marketData: {
      historicalVolatility: formatNumber(historicalVolatility, 4),
      atr14: priceZones.atr14,
      atr20: priceZones.atr20,
      earningsDate: earningsDate ?? null,
      dividendYieldPct: formatNumber(dividendYieldPct, 2)
    },
    risk: {
      capitalWarning,
      nakedCallWarning,
      earningsBeforeExpiry,
      putInsideExpectedMove,
      callInsideExpectedMove,
      liquidityWarning,
      earlyExerciseRisk:
        Boolean(dividendYieldPct) && callContracts > 0 && Number.isFinite(callStrike) && callStrike < currentPrice,
      warningMessages: warnings
    },
    score: {
      yieldScore,
      supportResistanceScore,
      expectedMoveSafetyScore,
      ivRichnessScore,
      liquidityScore,
      valuationScore,
      finalStrategyScore
    },
    detail: {
      payoffCurve,
      scenarioPoints
    }
  };
}

async function buildSymbolScan({
  symbol,
  config,
  fetchQuotes,
  fetchOptionChain,
  companyEventsBySymbol,
  earningsCoverageBySymbol,
  todayIso
}) {
  const warnings = [];
  const [historyResult, fundamentalsResult, quoteResult] = await Promise.allSettled([
    fetchStockDailyOhlcHistory({
      symbol,
      lookbackPoints: HISTORY_LOOKBACK_POINTS
    }),
    fetchStockFundamentals({ symbol }),
    fetchQuotes([buildStockQuoteRequest(symbol)])
  ]);

  if (historyResult.status !== "fulfilled") {
    throw new Error(`${symbol}: ${historyResult.reason?.message ?? "price history unavailable"}`);
  }

  const historyPoints = (Array.isArray(historyResult.value?.points) ? historyResult.value.points : []).filter(p => p.date < todayIso && p.close > 0 && p.high >= p.low && p.low > 0);
  if (historyPoints.length < 80) {
    throw new Error(`${symbol}: not enough price history for support and resistance analysis.`);
  }

  const quote = quoteResult.status === "fulfilled"
    ? quoteLookup(quoteResult.value).get(symbol)
    : null;
  const lastHistoryPoint = historyPoints[historyPoints.length - 1];
  const currentPrice = getQuotePrice(quote) ?? toNumber(lastHistoryPoint?.close, null);
  if (!(currentPrice > 0)) {
    throw new Error(`${symbol}: spot price unavailable.`);
  }
  if (!getQuotePrice(quote)) {
    warnings.push(QUOTE_STALENESS_WARNING);
  }

  const quoteTimestamp = timestampIso(quote?.regularMarketTime);
  const quoteAge = quoteTimestamp ? Date.now() - Date.parse(quoteTimestamp) : Infinity;
  if (quoteAge > 90_000 || quoteAge < -5000) {
    return { symbol, companyName: symbol, stockPrice: currentPrice, rows: [], marketData: { quoteTimestamp },
      warnings: [...warnings, `${symbol}: underlying quote is stale or undated; excluded from current entry candidates.`] };
  }
  const fundamentals = fundamentalsResult.status === "fulfilled" ? fundamentalsResult.value : null;
  if (fundamentalsResult.status === "rejected") {
    warnings.push(`${symbol}: fundamentals unavailable (${fundamentalsResult.reason?.message ?? "unknown error"})`);
  }

  const historicalVolatility = computeHistoricalVolatility(historyPoints, 20);
  const priceZones = buildPriceZones(historyPoints, currentPrice);
  const riskFreeRate = DEFAULT_RISK_FREE_RATE;
  const dividendYield = normalizeDividendYield(fundamentals?.dividendYield);
  const earningsEvent = companyEventsBySymbol.get(symbol) ?? null;
  const coverage = earningsCoverageBySymbol[symbol];
  const earningsDate = coverage?.events?.[0]?.date ?? earningsEvent?.date ?? null;
  const companyName =
    String(fundamentals?.description ?? earningsEvent?.name ?? quote?.shortName ?? symbol).trim() || symbol;

  const minRequestedDte = Math.max(Math.min(...config.targetDte), 1);
  const maxRequestedDte = Math.max(...config.targetDte);
  const expirationFrom = addDays(todayIso, Math.max(minRequestedDte - 2, 1));
  const expirationTo = addDays(todayIso, maxRequestedDte + EXPIRY_SEARCH_BUFFER_DAYS);

  const [putWindowResult, callWindowResult] = await Promise.all([
    fetchOptionChain({
      symbol,
      expirationFrom,
      expirationTo,
      optionType: "put",
      currentSpot: currentPrice,
      strikeHint: priceZones.supportPrice ?? currentPrice,
      limit: 0
    }),
    fetchOptionChain({
      symbol,
      expirationFrom,
      expirationTo,
      optionType: "call",
      currentSpot: currentPrice,
      strikeHint: priceZones.resistancePrice ?? currentPrice,
      limit: 0
    })
  ]);

  warnings.push(...(putWindowResult?.warnings ?? []), ...(callWindowResult?.warnings ?? []));
  const putContractsByExpiry = groupContractsByExpiration(putWindowResult?.contracts ?? []);
  const callContractsByExpiry = groupContractsByExpiration(callWindowResult?.contracts ?? []);
  const discoveredExpiries = collectExpirationSet(putContractsByExpiry, callContractsByExpiry);
  const resolvedExpiries = [...new Set(config.targetDte.map((targetDte) => pickNearestExpiry(discoveredExpiries, targetDte, todayIso)))];
  const rows = [];

  for (const expiryDate of resolvedExpiries) {
    const dte = differenceInDays(todayIso, expiryDate);
    if (!(dte > 0)) {
      continue;
    }

    const [putContracts, callContracts] = await Promise.all([
      ensureContractsForExpiry({
        symbol,
        currentSpot: currentPrice,
        expiration: expiryDate,
        optionType: "put",
        groupedContracts: putContractsByExpiry,
        fetchOptionChain
      }),
      ensureContractsForExpiry({
        symbol,
        currentSpot: currentPrice,
        expiration: expiryDate,
        optionType: "call",
        groupedContracts: callContractsByExpiry,
        fetchOptionChain
      })
    ]);

    if (!putContracts.length && !callContracts.length) {
      continue;
    }

    const expectedMove = buildExpectedMoveContext(callContracts, putContracts, currentPrice, dte);
    const putCandidate = buildOptionLegCandidate({
      contracts: putContracts,
      optionType: "put",
      currentPrice,
      targetPrice: priceZones.supportPrice ?? currentPrice - (priceZones.atr14 ?? 0),
      targetDeltaRange: config.putDeltaRange,
      config,
      dividendYield,
      riskFreeRate,
      dte,
      expectedMove,
      atr: toNumber(priceZones.atr14, null)
    });
    const callCandidate = buildOptionLegCandidate({
      contracts: callContracts,
      optionType: "call",
      currentPrice,
      targetPrice: priceZones.resistancePrice ?? currentPrice + (priceZones.atr14 ?? 0),
      targetDeltaRange: config.callDeltaRange,
      config,
      dividendYield,
      riskFreeRate,
      dte,
      expectedMove,
      atr: toNumber(priceZones.atr14, null)
    });

    const earningsBeforeExpiry = earningsDate && earningsDate >= todayIso && earningsDate <= expiryDate
      ? true : coverage?.complete === true && coverage.from <= todayIso && coverage.to >= expiryDate ? false : null;
    if (config.excludeEarningsBeforeExpiry && earningsBeforeExpiry !== false) {
      warnings.push(`${symbol} ${expiryDate}: excluded — earnings ${earningsBeforeExpiry ? 'scheduled' : 'coverage unknown'}.`);
      continue;
    }
    if (!putCandidate && !callCandidate) warnings.push(`${symbol} ${expiryDate}: no fresh, verified contracts passed delta/liquidity filters.`);

    if (config.strategyModes.includes("cash_secured_put") && putCandidate) {
      const result = buildCandidateResult({
        symbol,
        companyName,
        currentPrice,
        expiryDate,
        dte,
        strategyType: "cash_secured_put",
        priceZones,
        expectedMoveContext: expectedMove,
        putContract: putCandidate,
        callContract: null,
        maxAllocatedCash: config.maxAllocatedCash,
        earningsDate,
        earningsBeforeExpiry,
        historicalVolatility,
        dividendYieldPct: fundamentals?.dividendYield ?? null,
        quoteWarning: warnings[0] ?? null
      });
      if (result) {
        rows.push(result);
      }
    }

    if (config.strategyModes.includes("covered_call") && callCandidate) {
      const result = buildCandidateResult({
        symbol,
        companyName,
        currentPrice,
        expiryDate,
        dte,
        strategyType: "covered_call",
        priceZones,
        expectedMoveContext: expectedMove,
        putContract: null,
        callContract: callCandidate,
        maxAllocatedCash: config.maxAllocatedCash,
        earningsDate,
        earningsBeforeExpiry,
        historicalVolatility,
        dividendYieldPct: fundamentals?.dividendYield ?? null,
        quoteWarning: warnings[0] ?? null
      });
      if (result) {
        rows.push(result);
      }
    }

    if (config.strategyModes.includes("covered_strangle") && putCandidate && callCandidate) {
      const result = buildCandidateResult({
        symbol,
        companyName,
        currentPrice,
        expiryDate,
        dte,
        strategyType: "covered_strangle",
        priceZones,
        expectedMoveContext: expectedMove,
        putContract: putCandidate,
        callContract: callCandidate,
        maxAllocatedCash: config.maxAllocatedCash,
        earningsDate,
        earningsBeforeExpiry,
        historicalVolatility,
        dividendYieldPct: fundamentals?.dividendYield ?? null,
        quoteWarning: warnings[0] ?? null
      });
      if (result) {
        rows.push(result);
      }
    }
  }

  return {
    symbol,
    companyName,
    stockPrice: formatNumber(currentPrice, 2),
    warnings,
    marketData: {
      averageVolume30d: fundamentals?.averageVolume30d ?? null,
      atr14: priceZones.atr14,
      atr20: priceZones.atr20,
      historicalVolatility: formatNumber(historicalVolatility, 4),
      earningsDate,
      dividendYieldPct: formatNumber(fundamentals?.dividendYield ?? null, 2)
    },
    rows
  };
}

function buildCompanyEventsBySymbol(companyEvents = []) {
  const mapping = new Map();

  for (const event of companyEvents) {
    const symbol = normalizeTicker(event?.shortSymbol ?? event?.symbol ?? "");
    if (!symbol) {
      continue;
    }
    const date = event?.timestamp ? new Date(event.timestamp).toISOString().slice(0, 10) : null;
    if (!date) {
      continue;
    }

    const current = mapping.get(symbol);
    if (!current || date < current.date) {
      mapping.set(symbol, {
        date,
        name: event?.name ?? symbol,
        releaseSession: event?.releaseSession ?? ""
      });
    }
  }

  return mapping;
}

export async function buildCoveredIncomeScan({
  input = {},
  fetchQuotes,
  fetchOptionChain,
  companyEvents = [],
  earningsCoverageBySymbol = {}
}) {
  if (typeof fetchQuotes !== "function" || typeof fetchOptionChain !== "function") {
    throw new Error("fetchQuotes and fetchOptionChain are required.");
  }

  const config = normalizeScanConfig(input);
  if (!config.symbols.length) {
    throw new Error("At least one stock symbol is required.");
  }

  const companyEventsBySymbol = buildCompanyEventsBySymbol(companyEvents);
  const todayIso = toIsoDate(new Date());
  const symbolResults = await Promise.allSettled(
    config.symbols.map((symbol) =>
      buildSymbolScan({
        symbol,
        config,
        fetchQuotes,
        fetchOptionChain,
        companyEventsBySymbol,
        earningsCoverageBySymbol,
        todayIso
      })
    )
  );

  const warnings = [];
  const symbolSummaries = [];
  const rows = [];

  for (const result of symbolResults) {
    if (result.status === "fulfilled") {
      symbolSummaries.push({
        symbol: result.value.symbol,
        companyName: result.value.companyName,
        stockPrice: result.value.stockPrice,
        warnings: result.value.warnings,
        marketData: result.value.marketData
      });
      rows.push(...result.value.rows);
      continue;
    }

    warnings.push(result.reason?.message ?? "One symbol failed to scan.");
  }

  const sortedRows = [...rows]
    .sort((left, right) => {
      return (
        Number(right?.score?.finalStrategyScore ?? 0) - Number(left?.score?.finalStrategyScore ?? 0) ||
        Number(right?.returns?.annualizedReturnOnAllocatedCashPct ?? 0) -
          Number(left?.returns?.annualizedReturnOnAllocatedCashPct ?? 0)
      );
    })
    .slice(0, config.topResults);

  return {
    generatedAt: new Date().toISOString(),
    calculationVersion: "income-v2",
    premiumBasis: "bid, before fees",
    config,
    warnings: [...warnings, ...symbolSummaries.flatMap(s => s.warnings ?? [])],
    symbols: symbolSummaries,
    rows: sortedRows,
    summary: {
      symbolsScanned: config.symbols.length,
      candidateCount: sortedRows.length,
      totalCandidateCount: rows.length,
      capitalWarnings: sortedRows.filter((row) => row?.risk?.capitalWarning === true).length,
      earningsFlags: sortedRows.filter((row) => row?.risk?.earningsBeforeExpiry === true).length,
      averageReturnOnAllocatedCashPct: formatNumber(
        average(sortedRows.map((row) => row?.returns?.returnOnAllocatedCashPct).filter(Number.isFinite)),
        2
      ),
      averageAnnualizedReturnOnAllocatedCashPct: formatNumber(
        average(
          sortedRows
            .map((row) => row?.returns?.annualizedReturnOnAllocatedCashPct)
            .filter(Number.isFinite)
        ),
        2
      ),
      averageFinalScore: formatNumber(
        average(sortedRows.map((row) => row?.score?.finalStrategyScore).filter(Number.isFinite)),
        1
      )
    }
  };
}
