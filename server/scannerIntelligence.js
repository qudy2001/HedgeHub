function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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
    numericValues.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (numericValues.length - 1);
  return Math.sqrt(variance);
}

function computeHistoricalVolatility(points, lookback) {
  const closes = (points ?? []).map((point) => toNumber(point?.close, null)).filter(Number.isFinite);
  if (closes.length <= lookback) {
    return null;
  }

  const returns = [];
  const startIndex = Math.max(closes.length - lookback - 1, 1);
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

function normalizeIvHistoryRows(rows = [], currentIv30 = null, currentDate = null) {
  const byDate = new Map();

  (rows ?? []).forEach((row) => {
    const date = String(row?.date ?? "").trim();
    const iv30 = toNumber(row?.iv30, null);
    if (!date || iv30 == null) {
      return;
    }
    byDate.set(date, { date, iv30 });
  });

  const normalizedCurrentDate = String(currentDate ?? "").trim();
  const normalizedCurrentIv30 = toNumber(currentIv30, null);
  if (normalizedCurrentDate && normalizedCurrentIv30 != null) {
    byDate.set(normalizedCurrentDate, {
      date: normalizedCurrentDate,
      iv30: normalizedCurrentIv30
    });
  }

  return [...byDate.values()]
    .sort((left, right) => String(right.date).localeCompare(String(left.date)))
    .slice(0, 252);
}

function inferCorrelationCluster(symbol, sector, beta) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedSector = String(sector ?? "").trim().toLowerCase();
  const normalizedBeta = toNumber(beta, null);

  if (["TSLA", "NVDA", "PLTR", "QQQ", "SOXL", "SMH", "TQQQ", "AMD", "META"].includes(normalizedSymbol)) {
    return "high-beta tech";
  }
  if (["SPY", "VOO", "IVV"].includes(normalizedSymbol)) {
    return "us index beta";
  }
  if (["IWM", "RUT", "TNA"].includes(normalizedSymbol)) {
    return "small-cap beta";
  }
  if (normalizedSector.includes("technology") || normalizedSector.includes("semiconductor")) {
    return normalizedBeta != null && normalizedBeta >= 1.4 ? "high-beta tech" : "tech";
  }
  if (normalizedSector.includes("communication")) {
    return "growth";
  }
  if (normalizedSector.includes("energy")) {
    return "cyclical energy";
  }
  if (normalizedSector.includes("financial")) {
    return "financials";
  }
  if (normalizedSector.includes("health")) {
    return "healthcare";
  }
  return normalizedBeta != null && normalizedBeta >= 1.35 ? "high-beta cyclical" : "diversified";
}

function extractOrderUnderlyings(orders = []) {
  return orders.map((order) => {
    const position = order?.position ?? order ?? {};
    const underlyingSymbol =
      String(
        position?.valuationContext?.underlyingSymbol ??
          position?.valuationContext?.proxySymbol ??
          position?.symbol ??
          position?.underlyingSymbol ??
          ""
      )
        .trim()
        .toUpperCase() ||
      String(
        (position?.legs ?? []).find((leg) => leg?.rootSymbol || leg?.symbol)?.rootSymbol ??
          (position?.legs ?? []).find((leg) => leg?.rootSymbol || leg?.symbol)?.symbol ??
          ""
      )
        .trim()
        .toUpperCase();

    return {
      symbol: underlyingSymbol,
      orderId: order?.id ?? position?.id ?? null
    };
  }).filter((item) => item.symbol);
}

export function buildPortfolioContext({ paperOrders = [], fundamentalsBySymbol = {} } = {}) {
  const orderUnderlyings = extractOrderUnderlyings(paperOrders);
  const sectorCounts = new Map();
  const clusterCounts = new Map();

  orderUnderlyings.forEach(({ symbol }) => {
    const fundamentals = fundamentalsBySymbol[symbol] ?? null;
    const sector = String(fundamentals?.sector ?? "Unknown").trim() || "Unknown";
    const cluster = inferCorrelationCluster(symbol, fundamentals?.sector, fundamentals?.beta1y);
    sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
    clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
  });

  return {
    orderUnderlyings,
    sectorCounts,
    clusterCounts
  };
}

export function buildPortfolioImpact({ symbol, sector, beta, capital, premium, portfolioContext }) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const cluster = inferCorrelationCluster(normalizedSymbol, sector, beta);
  const existingSymbols = new Set((portfolioContext?.orderUnderlyings ?? []).map((item) => item.symbol));
  const sectorOverlapCount = portfolioContext?.sectorCounts?.get(sector || "Unknown") ?? 0;
  const clusterOverlapCount = portfolioContext?.clusterCounts?.get(cluster) ?? 0;
  const allocationImpact = toNumber(capital, null);
  const netVegaChange = premium != null ? Number((toNumber(premium, 0) || 0) * 18).toFixed(2) : null;

  return {
    alreadyHeld: existingSymbols.has(normalizedSymbol),
    sectorOverlap: sectorOverlapCount >= 2 ? "high" : sectorOverlapCount === 1 ? "medium" : "low",
    sectorExposureCount: sectorOverlapCount,
    correlationCluster: cluster,
    correlationOverlap: clusterOverlapCount >= 2 ? "high" : clusterOverlapCount === 1 ? "medium" : "low",
    portfolioAllocationImpact: allocationImpact,
    netVegaChange: netVegaChange == null ? null : Number(netVegaChange),
    betaWeightedDeltaHint: beta != null && capital != null ? Number((toNumber(beta, 0) * toNumber(capital, 0)).toFixed(2)) : null
  };
}

export function buildVolatilityMetrics({
  currentIv = null,
  historyPoints = [],
  nearTermIv = null,
  farTermIv = null,
  putIv = null,
  callIv = null,
  historicalIvMetrics = null
}) {
  const normalizedCurrentIv = toNumber(currentIv, null);
  const hv20 = toNumber(historicalIvMetrics?.hv20, computeHistoricalVolatility(historyPoints, 20));
  const hv60 = computeHistoricalVolatility(historyPoints, 60);
  const hv252 = toNumber(historicalIvMetrics?.hv252, computeHistoricalVolatility(historyPoints, 252));

  const hvReference = average([hv20, hv60, hv252].filter(Number.isFinite));
  const proxyIvSeries = [hv20, hv60, hv252].filter(Number.isFinite);
  const proxyIvRank52w =
    normalizedCurrentIv != null && proxyIvSeries.length >= 2
      ? clamp(
          ((normalizedCurrentIv - Math.min(...proxyIvSeries)) /
            Math.max(Math.max(...proxyIvSeries) - Math.min(...proxyIvSeries), 0.0001)) *
            100,
          0,
          100
        )
      : null;
  const ivRank52w = toNumber(historicalIvMetrics?.ivRank52w, proxyIvRank52w);
  const ivPercentile52w = toNumber(historicalIvMetrics?.ivPercentile52w, ivRank52w);
  const iv30 = toNumber(historicalIvMetrics?.iv30, normalizedCurrentIv);

  return {
    iv30,
    ivRank52w: ivRank52w == null ? null : Number(ivRank52w.toFixed(2)),
    ivPercentile: ivPercentile52w == null ? null : Number(ivPercentile52w.toFixed(2)),
    hv20: hv20 == null ? null : Number(hv20.toFixed(4)),
    hv60: hv60 == null ? null : Number(hv60.toFixed(4)),
    hv252: hv252 == null ? null : Number(hv252.toFixed(4)),
    ivHvSpread: iv30 != null && hvReference != null ? Number((iv30 - hvReference).toFixed(4)) : null,
    termStructureSlope:
      nearTermIv != null && farTermIv != null ? Number((toNumber(farTermIv, 0) - toNumber(nearTermIv, 0)).toFixed(4)) : null,
    putCallSkew:
      putIv != null && callIv != null ? Number((toNumber(putIv, 0) - toNumber(callIv, 0)).toFixed(4)) : null
  };
}

export function buildIvRankDailySnapshot({ symbol, date, currentIv30 = null, ivHistory = [], historyPoints = [] } = {}) {
  const normalizedCurrentIv30 = toNumber(currentIv30, null);
  if (normalizedCurrentIv30 == null) {
    return null;
  }

  const normalizedRows = normalizeIvHistoryRows(ivHistory, normalizedCurrentIv30, date);
  const ivSeries = normalizedRows.map((row) => toNumber(row?.iv30, null)).filter(Number.isFinite);
  const hv20 = computeHistoricalVolatility(historyPoints, 20);
  const hv252 = computeHistoricalVolatility(historyPoints, 252);

  let ivRank52w = null;
  let ivPercentile52w = null;
  let iv30Min52w = null;
  let iv30Max52w = null;

  if (ivSeries.length) {
    iv30Min52w = Math.min(...ivSeries);
    iv30Max52w = Math.max(...ivSeries);
    const range = iv30Max52w - iv30Min52w;
    ivRank52w =
      range > 0.0001 ? clamp(((normalizedCurrentIv30 - iv30Min52w) / range) * 100, 0, 100) : 50;
    ivPercentile52w =
      (ivSeries.filter((value) => value <= normalizedCurrentIv30 + 0.0000001).length / ivSeries.length) * 100;
  }

  return {
    date: String(date ?? "").trim(),
    symbol: String(symbol ?? "").trim().toUpperCase(),
    iv30: Number(normalizedCurrentIv30.toFixed(6)),
    iv30Min52w: iv30Min52w == null ? null : Number(iv30Min52w.toFixed(6)),
    iv30Max52w: iv30Max52w == null ? null : Number(iv30Max52w.toFixed(6)),
    ivRank52w: ivRank52w == null ? null : Number(ivRank52w.toFixed(2)),
    ivPercentile52w: ivPercentile52w == null ? null : Number(ivPercentile52w.toFixed(2)),
    hv20: hv20 == null ? null : Number(hv20.toFixed(6)),
    hv252: hv252 == null ? null : Number(hv252.toFixed(6))
  };
}

export function buildMarketRegime({ quoteMap = new Map(), rowMetrics = [] } = {}) {
  const vix = toNumber(quoteMap.get("VIX"), null);
  const avgIvRank = average(rowMetrics.map((metric) => toNumber(metric?.ivRank52w, null)).filter(Number.isFinite));
  const avgIvHvSpread = average(rowMetrics.map((metric) => toNumber(metric?.ivHvSpread, null)).filter(Number.isFinite));
  const avgSlope = average(rowMetrics.map((metric) => toNumber(metric?.termStructureSlope, null)).filter(Number.isFinite));

  const volatilityRegime =
    (vix != null && vix >= 24) || (avgIvRank != null && avgIvRank >= 70)
      ? "High IV"
      : (vix != null && vix <= 15) || (avgIvRank != null && avgIvRank <= 35)
        ? "Low IV"
        : "Neutral IV";
  const trendRegime = avgIvHvSpread != null && avgIvHvSpread > 0.04 ? "Mean Reversion" : "Trend Regime";
  const marketRegime = avgSlope != null && avgSlope < -0.01 ? "Backwardation" : "Contango";
  const liquidityRegime = vix != null && vix >= 28 ? "Fragile" : "Normal";
  const recommended =
    volatilityRegime === "High IV"
      ? ["short premium spreads", "defined-risk income", "hedges with rich vol"]
      : ["long premium selectively", "debit structures", "directional expressions"];
  const avoid =
    marketRegime === "Backwardation"
      ? ["naked short vol", "complacent premium-selling"]
      : volatilityRegime === "Low IV"
        ? ["chasing small credits", "underpriced downside hedges"]
        : ["oversized concentration"];

  return {
    marketRegime,
    volatilityRegime,
    trendRegime,
    liquidityRegime,
    recommended,
    avoid
  };
}

export function buildRankDrift(history = []) {
  const recent = Array.isArray(history) ? history.slice(0, 5) : [];
  if (recent.length < 2) {
    return {
      trend: "new",
      scoreDelta: null,
      rankDelta: null,
      appearances: recent.length
    };
  }

  const latest = recent[0];
  const previous = recent[1];
  const scoreDelta =
    toNumber(latest?.score, null) != null && toNumber(previous?.score, null) != null
      ? Number((toNumber(latest.score, 0) - toNumber(previous.score, 0)).toFixed(2))
      : null;
  const rankDelta =
    toNumber(previous?.rankPosition, null) != null && toNumber(latest?.rankPosition, null) != null
      ? Number(previous.rankPosition) - Number(latest.rankPosition)
      : null;

  return {
    trend: scoreDelta != null && scoreDelta > 0.75 ? "improving" : scoreDelta != null && scoreDelta < -0.75 ? "degrading" : "stable",
    scoreDelta,
    rankDelta,
    appearances: recent.length
  };
}

export function buildCoveredIncomeEv(row) {
  const buyingPower = toNumber(row?.capital?.allocatedCashUsed, null);
  const premium = toNumber(row?.premium?.totalPremium, null);
  const downsideBuffer = toNumber(row?.stockPrice, null) != null && toNumber(row?.breakevens?.downsideBreakeven, null) != null
    ? Math.max(toNumber(row.stockPrice, 0) - toNumber(row.breakevens.downsideBreakeven, 0), 0)
    : null;
  const downsideProbability = Math.max(Math.abs(toNumber(row?.put?.delta, 0) || 0), 0.08);
  const contracts = Math.max(toNumber(row?.contracts, 0) || 0, 0);
  const downsidePenalty = downsideBuffer != null ? downsideBuffer * 100 * contracts * downsideProbability * 0.55 : 0;
  const ev = premium != null ? premium - downsidePenalty : null;
  const dte = Math.max(toNumber(row?.dte, 0) || 0, 1);
  const evAnnualized =
    ev != null && buyingPower != null && buyingPower > 0 ? (ev / buyingPower) * (365 / dte) * 100 : null;

  return {
    expectedValue: ev == null ? null : Number(ev.toFixed(2)),
    evPerBuyingPower: ev != null && buyingPower != null && buyingPower > 0 ? Number((ev / buyingPower).toFixed(4)) : null,
    evAnnualized: evAnnualized == null ? null : Number(evAnnualized.toFixed(2))
  };
}

export function buildTradingViewEv(row) {
  const avgPayoff = toNumber(row?.avgPayoff, null);
  const probabilityOfProfit = toNumber(row?.probabilityOfProfit, null);
  const maxProfit = toNumber(row?.maxProfit, null);
  const maxLoss = toNumber(row?.maxLoss, null);
  const buyingPower = Math.max(toNumber(row?.maxLoss, 0) || 0, 1);
  const fallbackExpectedValue =
    avgPayoff == null &&
    probabilityOfProfit != null &&
    maxProfit != null &&
    maxLoss != null
      ? (probabilityOfProfit / 100) * maxProfit - (1 - probabilityOfProfit / 100) * Math.abs(maxLoss)
      : null;
  const expectedValue = avgPayoff ?? fallbackExpectedValue;
  return {
    expectedValue: expectedValue == null ? null : Number(expectedValue.toFixed(2)),
    evPerBuyingPower: expectedValue == null ? null : Number((expectedValue / buyingPower).toFixed(4))
  };
}

export function buildRiskFlags({
  earningsBeforeExpiry = false,
  liquidityScore = null,
  bidAskSpreadPct = null,
  dividendYieldPct = null,
  daysToExpiration = null,
  ivHvSpread = null
}) {
  const flags = [];
  if (earningsBeforeExpiry) {
    flags.push("earnings_within_expiry_window");
  }
  if (liquidityScore != null && liquidityScore < 55) {
    flags.push("liquidity_instability");
  }
  if (bidAskSpreadPct != null && bidAskSpreadPct > 8) {
    flags.push("wide_bid_ask_spread");
  }
  if (dividendYieldPct != null && dividendYieldPct > 1.5) {
    flags.push("dividend_assignment_risk");
  }
  if (daysToExpiration != null && daysToExpiration <= 7) {
    flags.push("near_expiry_gamma_risk");
  }
  if (ivHvSpread != null && ivHvSpread < -0.03) {
    flags.push("vol_crush_risk");
  }
  return flags;
}

export function buildExplainability({
  score,
  liquidityScore,
  ivRank52w,
  evPerBuyingPower,
  portfolioImpact,
  historicalExpectancy = null,
  extraBreakdown = {}
}) {
  const scoreBreakdown = {
    liquidity_score: liquidityScore == null ? null : Number(liquidityScore.toFixed(0)),
    iv_regime_score: ivRank52w == null ? null : Number(ivRank52w.toFixed(0)),
    ev_score: evPerBuyingPower == null ? null : Number((clamp(evPerBuyingPower * 250, -100, 100) + 100) / 2).toFixed(0),
    historical_expectancy_score:
      historicalExpectancy == null ? null : Number((clamp(historicalExpectancy * 100, 0, 100)).toFixed(0)),
    ...extraBreakdown
  };

  return {
    score,
    scoreBreakdown,
    portfolioImpact
  };
}
