import { pickOptionReferencePrice } from "./optionPricing.js";

const DEFAULT_RISK_FREE_RATE = 0.0425;
const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_DAYS_TO_EXPIRY_MIN = 14;
const DEFAULT_DAYS_TO_EXPIRY_MAX = 45;
const DEFAULT_LIMIT = 25;

export const DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE = [
  { symbol: "AMD", label: "AMD" },
  { symbol: "QCOM", label: "Qualcomm" },
  { symbol: "GOOG", label: "Alphabet" },
  { symbol: "NVDA", label: "NVIDIA" },
  { symbol: "AAPL", label: "Apple" },
  { symbol: "META", label: "Meta" },
  { symbol: "PLTR", label: "Palantir" },
  { symbol: "MSFT", label: "Microsoft" },
  { symbol: "TSLA", label: "Tesla" },
  { symbol: "RBLX", label: "Roblox" },
  { symbol: "AVAV", label: "AeroVironment" },
  { symbol: "ISRG", label: "Intuitive Surgical" },
  { symbol: "TEM", label: "Tempus AI" },
  { symbol: "NFLX", label: "Netflix" },
  { symbol: "NIO", label: "NIO" },
  { symbol: "RCL", label: "Royal Caribbean" },
  { symbol: "DIS", label: "Disney" },
  { symbol: "AMZN", label: "Amazon" },
  { symbol: "BILI", label: "Bilibili" },
  { symbol: "FDX", label: "FedEx" },
  { symbol: "AMBA", label: "Ambarella" },
  { symbol: "TGT", label: "Target" },
  { symbol: "MDB", label: "MongoDB" },
  { symbol: "ORCL", label: "Oracle" },
  { symbol: "ADBE", label: "Adobe" }
];

export function normalizeDeltaHedgeTicker(value, fallback = "") {
  const normalized = String(value ?? fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");

  return normalized.slice(0, 16);
}

export function normalizeDeltaHedgeStock(stock = {}, defaults = {}) {
  const symbol = normalizeDeltaHedgeTicker(stock.symbol, defaults.symbol);
  const label = String(stock.label ?? defaults.label ?? symbol).trim() || symbol;

  return {
    symbol,
    label,
    isCustom: stock.isCustom === true || defaults.isCustom === true
  };
}

export function buildDeltaHedgeStockUniverse(customSymbols = []) {
  const defaults = DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE.map((stock) => normalizeDeltaHedgeStock(stock));
  const universeBySymbol = new Map(defaults.map((stock) => [stock.symbol, stock]));

  for (const customStock of customSymbols) {
    const normalized = normalizeDeltaHedgeStock(customStock, { isCustom: true });
    if (!normalized.symbol) {
      continue;
    }

    universeBySymbol.set(normalized.symbol, {
      ...(universeBySymbol.get(normalized.symbol) ?? {}),
      ...normalized,
      isCustom: customStock.isCustom === true || !DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE.some((item) => item.symbol === normalized.symbol)
    });
  }

  return [...universeBySymbol.values()].sort((left, right) => {
    if ((left.isCustom === true) !== (right.isCustom === true)) {
      return left.isCustom === true ? 1 : -1;
    }

    return DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE.findIndex((item) => item.symbol === left.symbol) -
      DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE.findIndex((item) => item.symbol === right.symbol) ||
      left.symbol.localeCompare(right.symbol);
  });
}

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function differenceInDays(leftDate, rightDate) {
  return Math.round((rightDate.getTime() - leftDate.getTime()) / (24 * 60 * 60 * 1000));
}

function daysUntil(dateIso, now = new Date()) {
  const targetDate = new Date(`${dateIso}T00:00:00.000Z`);
  if (Number.isNaN(targetDate.getTime())) {
    return null;
  }

  const currentDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Math.max(differenceInDays(currentDate, targetDate), 0);
}

function normalizeStooqStockSymbol(symbol) {
  return `${String(symbol ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")}.us`;
}

function quoteLookup(quotes) {
  return new Map((quotes ?? []).map((quote) => [String(quote.symbol ?? "").trim().toUpperCase(), quote]));
}

function getQuotePrice(quote) {
  return Number(quote?.regularMarketPrice ?? 0);
}

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

function normalPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

function buildGreeksCore({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate
}) {
  if (timeToExpiryYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return null;
  }

  const sqrtT = Math.sqrt(timeToExpiryYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiryYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const pdf = normalPdf(d1);

  return {
    d1,
    d2,
    pdf,
    sqrtT
  };
}

function computeCallGreeks({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate = DEFAULT_RISK_FREE_RATE
}) {
  if (timeToExpiryYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return {
      delta: spot > strike ? 1 : 0,
      gamma: 0,
      vega: 0,
      thetaPerDay: 0
    };
  }

  const core = buildGreeksCore({
    spot,
    strike,
    timeToExpiryYears,
    volatility,
    riskFreeRate
  });
  const delta = normalCdf(core.d1);
  const gamma = core.pdf / (spot * volatility * core.sqrtT);
  const vega = spot * core.pdf * core.sqrtT;
  const thetaPerYear =
    -(spot * core.pdf * volatility) / (2 * core.sqrtT) -
    riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(core.d2);

  return {
    delta,
    gamma,
    vega,
    thetaPerDay: thetaPerYear / 365
  };
}

function computePutGreeks({
  spot,
  strike,
  timeToExpiryYears,
  volatility,
  riskFreeRate = DEFAULT_RISK_FREE_RATE
}) {
  if (timeToExpiryYears <= 0 || spot <= 0 || strike <= 0 || volatility <= 0) {
    return {
      delta: spot < strike ? -1 : 0,
      gamma: 0,
      vega: 0,
      thetaPerDay: 0
    };
  }

  const core = buildGreeksCore({
    spot,
    strike,
    timeToExpiryYears,
    volatility,
    riskFreeRate
  });
  const delta = normalCdf(core.d1) - 1;
  const gamma = core.pdf / (spot * volatility * core.sqrtT);
  const vega = spot * core.pdf * core.sqrtT;
  const thetaPerYear =
    -(spot * core.pdf * volatility) / (2 * core.sqrtT) +
    riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiryYears) * normalCdf(-core.d2);

  return {
    delta,
    gamma,
    vega,
    thetaPerDay: thetaPerYear / 365
  };
}

function groupOptionsByExpiration(contracts) {
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

function sortByStrike(contracts) {
  return [...(contracts ?? [])].sort((left, right) => Number(left?.strike ?? 0) - Number(right?.strike ?? 0));
}

function pickAtmPair(calls, puts, spot) {
  const sortedCalls = sortByStrike(calls);
  const sortedPuts = sortByStrike(puts);
  if (!sortedCalls.length || !sortedPuts.length) {
    return null;
  }

  const callsByStrike = new Map(sortedCalls.map((contract) => [Number(contract.strike).toFixed(4), contract]));
  const putsByStrike = new Map(sortedPuts.map((contract) => [Number(contract.strike).toFixed(4), contract]));
  const sharedStrikes = [...callsByStrike.keys()].filter((strikeKey) => putsByStrike.has(strikeKey));

  if (sharedStrikes.length) {
    const bestStrike = sharedStrikes
      .map((strikeKey) => Number(strikeKey))
      .sort((left, right) => Math.abs(left - spot) - Math.abs(right - spot))[0];

    return {
      call: callsByStrike.get(Number(bestStrike).toFixed(4)),
      put: putsByStrike.get(Number(bestStrike).toFixed(4)),
      strike: bestStrike
    };
  }

  const nearestCall = sortedCalls.sort((left, right) => {
    const leftDistance = Math.abs(Number(left.strike) - spot);
    const rightDistance = Math.abs(Number(right.strike) - spot);
    return leftDistance - rightDistance;
  })[0];
  const nearestPut = sortedPuts.sort((left, right) => {
    const leftDistance = Math.abs(Number(left.strike) - spot);
    const rightDistance = Math.abs(Number(right.strike) - spot);
    return leftDistance - rightDistance;
  })[0];

  if (!nearestCall || !nearestPut) {
    return null;
  }

  return {
    call: nearestCall,
    put: nearestPut,
    strike: Number(nearestCall.strike ?? nearestPut.strike)
  };
}

function buildQuoteQuality(call, put) {
  const hasRealBidAsk = call?.hasRealBidAsk === true && put?.hasRealBidAsk === true;
  const isLive = call?.isLive === true && put?.isLive === true;

  if (hasRealBidAsk) {
    return "NBBO";
  }
  if (isLive) {
    return "Live feed";
  }
  return "Modeled";
}

function computeLiquidityScore({
  minOpenInterest,
  minVolume,
  spreadPct,
  quoteQuality
}) {
  const oiScore = clamp((Math.max(minOpenInterest, 0) / 1200) * 35, 0, 35);
  const volumeScore = clamp((Math.max(minVolume, 0) / 350) * 25, 0, 25);
  const spreadScore = spreadPct == null ? 10 : clamp(28 - spreadPct * 1.6, 0, 28);
  const qualityScore =
    quoteQuality === "NBBO" ? 12
    : quoteQuality === "Live feed" ? 8
    : 4;

  return formatNumber(oiScore + volumeScore + spreadScore + qualityScore, 2);
}

function buildOptionLeg(contract, action, rootSymbol) {
  const referencePrice = pickOptionReferencePrice(contract, 0);

  return {
    contractSymbol: String(contract?.contractSymbol ?? ""),
    rootSymbol,
    action,
    optionType: String(contract?.optionType ?? "call").trim().toLowerCase() === "put" ? "put" : "call",
    strike: formatNumber(Number(contract?.strike ?? 0), 2),
    expiration: String(contract?.expiration ?? ""),
    entryPrice: formatNumber(referencePrice, 4),
    bid: formatNumber(toNumber(contract?.bid, null), 4),
    ask: formatNumber(toNumber(contract?.ask, null), 4),
    bidSize: toNumber(contract?.bidSize, null),
    askSize: toNumber(contract?.askSize, null),
    volume: toNumber(contract?.volume, null),
    openInterest: toNumber(contract?.openInterest, null),
    impliedVolatility: formatNumber(Number(contract?.impliedVolatility ?? 0) || null, 4),
    contractMultiplier: 100,
    quantity: 1,
    quoteSource: contract?.sourceLabel ?? contract?.source ?? "Option chain",
    isLive: contract?.isLive === true,
    hasRealBidAsk: contract?.hasRealBidAsk === true
  };
}

function computeCandidateScore({
  liquidityScore,
  deltaChangeForOnePctMove,
  dailyBreakevenMovePct,
  thetaBurnPctPerDay,
  impliedMovePct
}) {
  const liquidityComponent = Number(liquidityScore ?? 0) * 0.32;
  const gammaComponent = clamp(Number(deltaChangeForOnePctMove ?? 0) * 2.4, 0, 28);
  const breakevenComponent =
    dailyBreakevenMovePct == null ? 0 : clamp((5 - dailyBreakevenMovePct) * 7, 0, 30);
  const carryComponent =
    thetaBurnPctPerDay == null ? 0 : clamp((4 - thetaBurnPctPerDay) * 3.5, 0, 12);
  const pricingComponent =
    impliedMovePct == null ? 0 : clamp((8 - impliedMovePct) * 1.3, 0, 10);

  return formatNumber(
    clamp(liquidityComponent + gammaComponent + breakevenComponent + carryComponent + pricingComponent, 0, 100),
    2
  );
}

function buildExpiryCandidate({
  stock,
  quote,
  expiration,
  calls,
  puts,
  riskFreeRate = DEFAULT_RISK_FREE_RATE,
  now = new Date()
}) {
  const spot = getQuotePrice(quote);
  if (!(spot > 0)) {
    return null;
  }

  const atmPair = pickAtmPair(calls, puts, spot);
  if (!atmPair?.call || !atmPair?.put) {
    return null;
  }

  const callMid = pickOptionReferencePrice(atmPair.call, 0);
  const putMid = pickOptionReferencePrice(atmPair.put, 0);
  if (!(callMid > 0) || !(putMid > 0)) {
    return null;
  }

  const daysToExpiry = daysUntil(expiration, now);
  if (!(daysToExpiry >= 0)) {
    return null;
  }

  const timeToExpiryYears = Math.max(daysToExpiry / 365, 1 / 365);
  const callVol = clamp(Number(atmPair.call?.impliedVolatility ?? 0) || 0.32, 0.05, 3);
  const putVol = clamp(Number(atmPair.put?.impliedVolatility ?? 0) || callVol, 0.05, 3);
  const callGreeks = computeCallGreeks({
    spot,
    strike: Number(atmPair.call.strike),
    timeToExpiryYears,
    volatility: callVol,
    riskFreeRate
  });
  const putGreeks = computePutGreeks({
    spot,
    strike: Number(atmPair.put.strike),
    timeToExpiryYears,
    volatility: putVol,
    riskFreeRate
  });

  const netDebitPerShare = callMid + putMid;
  const netDebit = netDebitPerShare * 100;
  const totalDeltaShares = (callGreeks.delta + putGreeks.delta) * 100;
  const totalGamma = (callGreeks.gamma + putGreeks.gamma) * 100;
  const totalVega = (callGreeks.vega + putGreeks.vega) * 100;
  const totalThetaPerDay = (callGreeks.thetaPerDay + putGreeks.thetaPerDay) * 100;
  const impliedMovePct = (netDebitPerShare / spot) * 100;
  const impliedMoveUsd = netDebitPerShare;
  const deltaChangeForOnePctMove = totalGamma * spot * 0.01;
  const dailyBreakevenMoveUsd =
    totalGamma > 0 && totalThetaPerDay < 0
      ? Math.sqrt((2 * Math.abs(totalThetaPerDay)) / totalGamma)
      : null;
  const dailyBreakevenMovePct =
    dailyBreakevenMoveUsd != null && spot > 0 ? (dailyBreakevenMoveUsd / spot) * 100 : null;
  const rebalanceMoveForTenDeltaUsd = totalGamma > 0 ? 10 / totalGamma : null;
  const rebalanceMoveForTenDeltaPct =
    rebalanceMoveForTenDeltaUsd != null && spot > 0 ? (rebalanceMoveForTenDeltaUsd / spot) * 100 : null;
  const thetaBurnPctPerDay = netDebit > 0 ? (Math.abs(totalThetaPerDay) / netDebit) * 100 : null;
  const netBid = toNumber(atmPair.call?.bid, null) + toNumber(atmPair.put?.bid, null);
  const netAsk = toNumber(atmPair.call?.ask, null) + toNumber(atmPair.put?.ask, null);
  const spreadPct =
    Number.isFinite(netBid) && Number.isFinite(netAsk) && netDebitPerShare > 0
      ? ((netAsk - netBid) / netDebitPerShare) * 100
      : null;
  const minOpenInterest = Math.min(
    Math.max(toNumber(atmPair.call?.openInterest, 0), 0),
    Math.max(toNumber(atmPair.put?.openInterest, 0), 0)
  );
  const minVolume = Math.min(
    Math.max(toNumber(atmPair.call?.volume, 0), 0),
    Math.max(toNumber(atmPair.put?.volume, 0), 0)
  );
  const quoteQuality = buildQuoteQuality(atmPair.call, atmPair.put);
  const liquidityScore = computeLiquidityScore({
    minOpenInterest,
    minVolume,
    spreadPct,
    quoteQuality
  });
  const compositeScore = computeCandidateScore({
    liquidityScore,
    deltaChangeForOnePctMove,
    dailyBreakevenMovePct,
    thetaBurnPctPerDay,
    impliedMovePct
  });

  return {
    id: `${stock.symbol}:${expiration}:${Number(atmPair.strike).toFixed(2)}`,
    symbol: stock.symbol,
    companyName: stock.label,
    strategyType: "Long ATM straddle",
    expiration,
    daysToExpiry,
    strike: formatNumber(Number(atmPair.strike), 2),
    underlyingPrice: formatNumber(spot, 2),
    straddleCost: formatNumber(netDebit, 2),
    straddleCostPerShare: formatNumber(netDebitPerShare, 4),
    impliedMoveUsd: formatNumber(impliedMoveUsd, 2),
    impliedMovePct: formatNumber(impliedMovePct, 2),
    netDeltaShares: formatNumber(totalDeltaShares, 2),
    gammaPerDollar: formatNumber(totalGamma, 4),
    vegaPerVolPoint: formatNumber(totalVega / 100, 2),
    thetaPerDay: formatNumber(totalThetaPerDay, 2),
    thetaBurnPctPerDay: formatNumber(thetaBurnPctPerDay, 2),
    deltaChangeForOnePctMove: formatNumber(deltaChangeForOnePctMove, 2),
    dailyBreakevenMoveUsd: formatNumber(dailyBreakevenMoveUsd, 2),
    dailyBreakevenMovePct: formatNumber(dailyBreakevenMovePct, 2),
    rebalanceMoveForTenDeltaUsd: formatNumber(rebalanceMoveForTenDeltaUsd, 2),
    rebalanceMoveForTenDeltaPct: formatNumber(rebalanceMoveForTenDeltaPct, 2),
    spreadPct: formatNumber(spreadPct, 2),
    minOpenInterest: formatNumber(minOpenInterest, 0),
    minVolume: formatNumber(minVolume, 0),
    liquidityScore,
    compositeScore,
    quoteQuality,
    marketContext: {
      proxySymbol: stock.symbol,
      underlyingSymbol: stock.symbol,
      currentProxySpot: formatNumber(spot, 4),
      currentUnderlyingSpot: formatNumber(spot, 4),
      conversionRatio: 1,
      targetUnderlyingValue: formatNumber(spot, 4),
      impliedVolatility: formatNumber((callVol + putVol) / 2, 4),
      riskFreeRate: formatNumber(riskFreeRate, 4)
    },
    optionLegs: [
      buildOptionLeg(atmPair.call, "LONG", stock.symbol),
      buildOptionLeg(atmPair.put, "LONG", stock.symbol)
    ]
  };
}

async function mapInBatches(items, batchSize, iteratee) {
  const results = [];

  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    const batchResults = await Promise.allSettled(batch.map(iteratee));
    results.push(...batchResults);
  }

  return results;
}

export async function buildStockDeltaHedgeScan({
  fetchQuotes,
  fetchOptionChain,
  stockUniverse = DEFAULT_DELTA_HEDGE_STOCK_UNIVERSE,
  limit = DEFAULT_LIMIT,
  now = new Date()
}) {
  const warnings = [];
  const currentDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const expirationFrom = toIsoDate(addDays(currentDate, DEFAULT_DAYS_TO_EXPIRY_MIN));
  const expirationTo = toIsoDate(addDays(currentDate, DEFAULT_DAYS_TO_EXPIRY_MAX));
  const quoteItems = stockUniverse.map((stock) => ({
    symbol: stock.symbol,
    label: stock.label,
    sourceSymbol: normalizeStooqStockSymbol(stock.symbol),
    provider: "stooq",
    group: "Delta Hedge"
  }));

  const quotes = await fetchQuotes(quoteItems);
  const quotesBySymbol = quoteLookup(quotes);

  const results = await mapInBatches(
    stockUniverse,
    DEFAULT_BATCH_SIZE,
    async (stock) => {
      const quote = quotesBySymbol.get(stock.symbol);
      const spot = getQuotePrice(quote);
      if (!(spot > 0)) {
        return null;
      }

      const strikeMin = Math.max(spot * 0.8, 1);
      const strikeMax = Math.max(spot * 1.2, strikeMin + 1);
      const [callsPayload, putsPayload] = await Promise.all([
        fetchOptionChain({
          symbol: stock.symbol,
          expirationFrom,
          expirationTo,
          optionType: "call",
          currentSpot: spot,
          strikeHint: spot,
          strikeMin,
          strikeMax,
          limit: 120
        }),
        fetchOptionChain({
          symbol: stock.symbol,
          expirationFrom,
          expirationTo,
          optionType: "put",
          currentSpot: spot,
          strikeHint: spot,
          strikeMin,
          strikeMax,
          limit: 120
        })
      ]);

      if (callsPayload?.warning) {
        warnings.push(`${stock.symbol} calls: ${callsPayload.warning}`);
      }
      if (putsPayload?.warning) {
        warnings.push(`${stock.symbol} puts: ${putsPayload.warning}`);
      }

      const callsByExpiry = groupOptionsByExpiration(callsPayload?.contracts ?? []);
      const putsByExpiry = groupOptionsByExpiration(putsPayload?.contracts ?? []);
      const expirations = [...callsByExpiry.keys()]
        .filter((expiration) => putsByExpiry.has(expiration))
        .sort();

      const candidates = expirations
        .map((expiration) =>
          buildExpiryCandidate({
            stock,
            quote,
            expiration,
            calls: callsByExpiry.get(expiration),
            puts: putsByExpiry.get(expiration),
            now
          })
        )
        .filter(Boolean)
        .sort((left, right) => {
          if ((right.compositeScore ?? -Infinity) !== (left.compositeScore ?? -Infinity)) {
            return (right.compositeScore ?? -Infinity) - (left.compositeScore ?? -Infinity);
          }

          return (left.dailyBreakevenMovePct ?? Infinity) - (right.dailyBreakevenMovePct ?? Infinity);
        });

      return candidates[0] ?? null;
    }
  );

  const rows = results
    .flatMap((result) => {
      if (result.status === "rejected") {
        warnings.push(result.reason?.message ?? "Stock delta hedge scan failed for one symbol.");
        return [];
      }

      return result.value ? [result.value] : [];
    })
    .sort((left, right) => {
      if ((right.compositeScore ?? -Infinity) !== (left.compositeScore ?? -Infinity)) {
        return (right.compositeScore ?? -Infinity) - (left.compositeScore ?? -Infinity);
      }

      return String(left.symbol ?? "").localeCompare(String(right.symbol ?? ""));
    })
    .slice(0, Math.max(limit, 1));

  const quoteQualities = [...new Set(rows.map((row) => row.quoteQuality).filter(Boolean))];
  const liveCandidates = rows.filter((row) => row.quoteQuality === "NBBO" || row.quoteQuality === "Live feed").length;
  const modeledCandidates = rows.filter((row) => row.quoteQuality === "Modeled").length;
  const averageLiquidityScore =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + Number(row.liquidityScore ?? 0), 0) / rows.length
      : null;
  const averageBreakevenMove =
    rows.length > 0
      ? rows.reduce((sum, row) => sum + Number(row.dailyBreakevenMovePct ?? 0), 0) / rows.length
      : null;

  return {
    generatedAt: new Date().toISOString(),
    warnings: [...new Set(warnings)],
    stockUniverse: stockUniverse.map((stock) => normalizeDeltaHedgeStock(stock)),
    assumptions: [
      "Scanner ranks long ATM straddles as delta-hedge candidates rather than predicting direction.",
      "Scores reward liquidity, strong gamma response for a 1% move, and a lower one-day theta break-even move.",
      "Live Polygon chains are used when available; otherwise HedgeHub falls back to modeled option chains."
    ],
    summary: {
      symbolsScanned: stockUniverse.length,
      customSymbols: stockUniverse.filter((stock) => stock.isCustom === true).length,
      candidates: rows.length,
      liveCandidates,
      modeledCandidates,
      averageLiquidityScore: formatNumber(averageLiquidityScore, 2),
      averageBreakevenMovePct: formatNumber(averageBreakevenMove, 2)
    },
    filters: {
      quoteQualities,
      daysToExpiry: {
        min: DEFAULT_DAYS_TO_EXPIRY_MIN,
        max: DEFAULT_DAYS_TO_EXPIRY_MAX
      }
    },
    selectedRowId: rows[0]?.id ?? null,
    rows
  };
}
