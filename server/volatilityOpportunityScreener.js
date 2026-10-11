import { fetchStockDailyOhlcHistory } from "./stockOhlcHistory.js";

const TRADING_DAYS_PER_YEAR = 252;
const DEFAULT_LIMIT = 25;
const DEFAULT_BATCH_SIZE = 4;

const DEFAULT_CONFIG = {
  realizedVolLookbackDays: 20,
  baselineVolLookbackDays: 120,
  movementLookbackDays: 5,
  maxVolatilityRatio: 2.5,
  maxMovementRatio: 3.0,
  weights: {
    volatilityDivergence: 0.35,
    movementDivergence: 0.35,
    liquidity: 0.2,
    dataQuality: 0.1
  },
  batchSize: DEFAULT_BATCH_SIZE
};

function toNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(Math.max(value, min), max);
}

function formatNumber(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function mean(values) {
  const numericValues = (values ?? []).filter((value) => Number.isFinite(value));
  if (!numericValues.length) {
    return null;
  }

  const sum = numericValues.reduce((total, value) => total + value, 0);
  return sum / numericValues.length;
}

function standardDeviation(values) {
  const numericValues = (values ?? []).filter((value) => Number.isFinite(value));
  if (numericValues.length < 2) {
    return null;
  }

  const avg = mean(numericValues);
  if (avg == null) {
    return null;
  }

  const variance =
    numericValues.reduce((sum, value) => sum + (value - avg) * (value - avg), 0) /
    (numericValues.length - 1);

  return Math.sqrt(Math.max(variance, 0));
}

function computeLogReturns(closes) {
  const values = (closes ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < 2) {
    return [];
  }

  const returns = [];
  for (let index = 1; index < values.length; index += 1) {
    returns.push(Math.log(values[index] / values[index - 1]));
  }

  return returns;
}

function annualizeVolatility(dailyStdDev) {
  if (!Number.isFinite(dailyStdDev) || dailyStdDev <= 0) {
    return null;
  }

  return dailyStdDev * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function computeRealizedVol(closes, lookbackDays) {
  const resolvedLookback = Math.max(Math.round(Number(lookbackDays ?? 0) || 0), 2);
  const values = (closes ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < resolvedLookback + 1) {
    return null;
  }

  const slice = values.slice(-(resolvedLookback + 1));
  const logReturns = computeLogReturns(slice);
  const dailyStdDev = standardDeviation(logReturns);
  const annualized = annualizeVolatility(dailyStdDev);

  return annualized;
}

function computeAbsoluteMovePct(closes, lookbackDays) {
  const resolvedLookback = Math.max(Math.round(Number(lookbackDays ?? 0) || 0), 1);
  const values = (closes ?? []).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < resolvedLookback + 1) {
    return null;
  }

  const last = values[values.length - 1];
  const prior = values[values.length - 1 - resolvedLookback];
  if (!Number.isFinite(last) || !Number.isFinite(prior) || prior <= 0) {
    return null;
  }

  return Math.abs(last / prior - 1);
}

function normalizeWeights(weights) {
  const normalized = {
    ...DEFAULT_CONFIG.weights,
    ...(weights && typeof weights === "object" ? weights : {})
  };

  const total =
    Number(normalized.volatilityDivergence ?? 0) +
    Number(normalized.movementDivergence ?? 0) +
    Number(normalized.liquidity ?? 0) +
    Number(normalized.dataQuality ?? 0);

  return {
    weights: normalized,
    weightTotal: total > 0 ? total : 1
  };
}

function normalizeConfig(overrides = {}) {
  const resolved = overrides && typeof overrides === "object" ? overrides : {};
  const { weights, weightTotal } = normalizeWeights(resolved.weights);

  return {
    realizedVolLookbackDays: Math.max(Math.round(Number(resolved.realizedVolLookbackDays ?? DEFAULT_CONFIG.realizedVolLookbackDays) || 0), 5),
    baselineVolLookbackDays: Math.max(Math.round(Number(resolved.baselineVolLookbackDays ?? DEFAULT_CONFIG.baselineVolLookbackDays) || 0), 20),
    movementLookbackDays: Math.max(Math.round(Number(resolved.movementLookbackDays ?? DEFAULT_CONFIG.movementLookbackDays) || 0), 1),
    maxVolatilityRatio: Math.max(toNumber(resolved.maxVolatilityRatio, DEFAULT_CONFIG.maxVolatilityRatio) ?? DEFAULT_CONFIG.maxVolatilityRatio, 1.1),
    maxMovementRatio: Math.max(toNumber(resolved.maxMovementRatio, DEFAULT_CONFIG.maxMovementRatio) ?? DEFAULT_CONFIG.maxMovementRatio, 1.1),
    weights,
    weightTotal,
    batchSize: Math.max(Math.round(Number(resolved.batchSize ?? DEFAULT_CONFIG.batchSize) || 0), 1)
  };
}

function buildStockLiquidityScoreFromVolume(volume) {
  const numericVolume = Number(volume ?? 0);
  if (!Number.isFinite(numericVolume) || numericVolume <= 0) {
    return 0;
  }

  const capped = Math.min(Math.log10(numericVolume + 1), 8);
  return clamp(capped / 8, 0, 1);
}

function computeDataQualityScore({ historyPoints, requiredPoints, historySource, optionCandidate } = {}) {
  const pointsScore =
    requiredPoints > 0 && Number.isFinite(historyPoints) ? clamp(historyPoints / requiredPoints, 0, 1) : 0.5;
  const historyScore = historySource === "stooq" ? 0.9 : 0.85;
  const optionScore =
    optionCandidate && typeof optionCandidate === "object"
      ? String(optionCandidate.quoteQuality ?? "").toLowerCase().includes("modeled")
        ? 0.85
        : 1
      : 0.8;

  return clamp(pointsScore * historyScore * optionScore, 0, 1);
}

function buildNotes({
  realizedVol,
  impliedVolatility,
  volatilityRatio,
  movementLookbackDays,
  actualMovePct,
  expectedMovePct,
  liquidityScore,
  usedOptionProxy
} = {}) {
  const parts = [];

  if (impliedVolatility != null) {
    parts.push(
      `Realized vol ${formatNumber(realizedVol, 2)} vs implied ${formatNumber(impliedVolatility, 2)} (ratio ${formatNumber(volatilityRatio, 2)})`
    );
  } else if (usedOptionProxy) {
    parts.push("Options IV unavailable; using statistical proxy for expected move.");
  } else {
    parts.push("Options IV unavailable; using historical baseline for expected move.");
  }

  if (actualMovePct != null && expectedMovePct != null) {
    parts.push(
      `${movementLookbackDays}d move ${(actualMovePct * 100).toFixed(2)}% vs expected ${(expectedMovePct * 100).toFixed(2)}%`
    );
  }

  if (liquidityScore != null) {
    parts.push(`Liquidity ${(liquidityScore * 100).toFixed(0)}/100`);
  }

  return parts.join(" · ");
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

export async function buildVolatilityOpportunityScan({
  stockUniverse = [],
  optionCandidates = [],
  limit = DEFAULT_LIMIT,
  now = new Date(),
  config: configOverrides = {},
  fetchDailyOhlc = fetchStockDailyOhlcHistory
} = {}) {
  const config = normalizeConfig(configOverrides);
  const warnings = [];

  const symbols = (stockUniverse ?? [])
    .map((stock) => String(stock?.symbol ?? "").trim().toUpperCase())
    .filter(Boolean);

  const candidatesBySymbol = new Map();
  for (const candidate of optionCandidates ?? []) {
    if (!candidate || typeof candidate !== "object" || !candidate.symbol) {
      continue;
    }

    const symbol = String(candidate.symbol).trim().toUpperCase();
    if (!symbol) {
      continue;
    }

    const existing = candidatesBySymbol.get(symbol);
    if (!existing) {
      candidatesBySymbol.set(symbol, candidate);
      continue;
    }

    const existingScore = Number(existing?.compositeScore ?? Number.NEGATIVE_INFINITY);
    const candidateScore = Number(candidate?.compositeScore ?? Number.NEGATIVE_INFINITY);
    if (
      (Number.isFinite(candidateScore) && !Number.isFinite(existingScore)) ||
      (Number.isFinite(candidateScore) && Number.isFinite(existingScore) && candidateScore > existingScore)
    ) {
      candidatesBySymbol.set(symbol, candidate);
    }
  }

  const requiredPoints = config.baselineVolLookbackDays + 1;
  const historyLookbackPoints = Math.max(requiredPoints, config.realizedVolLookbackDays + 1, config.movementLookbackDays + 1) + 10;

  const settled = await mapInBatches(symbols, config.batchSize, async (symbol) => {
    const optionCandidate = candidatesBySymbol.get(symbol) ?? null;

    let history = null;
    try {
      history = await fetchDailyOhlc({ symbol, lookbackPoints: historyLookbackPoints, now });
    } catch (error) {
      warnings.push(`${symbol} history unavailable: ${error.message ?? String(error)}`);
      return null;
    }

    const points = Array.isArray(history?.points) ? history.points : [];
    if (points.length < 2) {
      warnings.push(`${symbol} not enough history to compute volatility metrics.`);
      return null;
    }

    const closes = points.map((point) => toNumber(point?.close, null)).filter((value) => value != null);
    const lastClose = closes.length ? closes[closes.length - 1] : null;
    const spot = toNumber(optionCandidate?.underlyingPrice, lastClose);

    const realizedVol = computeRealizedVol(closes, config.realizedVolLookbackDays);
    const baselineVol = computeRealizedVol(closes, config.baselineVolLookbackDays);
    const impliedVolatility = toNumber(optionCandidate?.marketContext?.impliedVolatility, null);

    const expectedMovePct =
      impliedVolatility != null
        ? impliedVolatility * Math.sqrt(config.movementLookbackDays / TRADING_DAYS_PER_YEAR)
        : baselineVol != null
          ? baselineVol * Math.sqrt(config.movementLookbackDays / TRADING_DAYS_PER_YEAR)
          : realizedVol != null
            ? realizedVol * Math.sqrt(config.movementLookbackDays / TRADING_DAYS_PER_YEAR)
            : null;

    const actualMovePct = computeAbsoluteMovePct(closes, config.movementLookbackDays);
    const volatilityRatio =
      realizedVol != null && impliedVolatility != null && impliedVolatility > 0 ? realizedVol / impliedVolatility : null;
    const movementRatio =
      actualMovePct != null && expectedMovePct != null && expectedMovePct > 0 ? actualMovePct / expectedMovePct : null;

    const liquidityScore =
      optionCandidate?.liquidityScore != null
        ? clamp(Number(optionCandidate.liquidityScore ?? 0) / 100, 0, 1)
        : buildStockLiquidityScoreFromVolume(points[points.length - 1]?.volume);

    const dataQualityScore = computeDataQualityScore({
      historyPoints: points.length,
      requiredPoints,
      historySource: history?.source,
      optionCandidate
    });

    const volatilityDivergenceScore =
      volatilityRatio != null
        ? clamp((volatilityRatio - 1) / (config.maxVolatilityRatio - 1), 0, 1)
        : 0;
    const movementDivergenceScore =
      movementRatio != null
        ? clamp((movementRatio - 1) / (config.maxMovementRatio - 1), 0, 1)
        : 0;

    const composite =
      ((config.weights.volatilityDivergence * volatilityDivergenceScore +
        config.weights.movementDivergence * movementDivergenceScore +
        config.weights.liquidity * liquidityScore +
        config.weights.dataQuality * dataQualityScore) /
        config.weightTotal) *
      100;

    const expectedMoveUsd = spot != null && expectedMovePct != null ? spot * expectedMovePct : null;
    const actualMoveUsd = spot != null && actualMovePct != null ? spot * actualMovePct : null;

    return {
      id: `vol-opportunity:${symbol}`,
      symbol,
      spot: formatNumber(spot, 4),
      historySource: history?.source ?? null,
      realizedVol: formatNumber(realizedVol, 4),
      baselineVol: formatNumber(baselineVol, 4),
      impliedVolatility: formatNumber(impliedVolatility, 4),
      expectedMovePct: expectedMovePct != null ? formatNumber(expectedMovePct * 100, 2) : null,
      expectedMoveUsd: formatNumber(expectedMoveUsd, 4),
      actualMovePct: actualMovePct != null ? formatNumber(actualMovePct * 100, 2) : null,
      actualMoveUsd: formatNumber(actualMoveUsd, 4),
      volatilityRatio: formatNumber(volatilityRatio, 4),
      movementRatio: formatNumber(movementRatio, 4),
      liquidityScore: formatNumber(liquidityScore, 4),
      dataQualityScore: formatNumber(dataQualityScore, 4),
      compositeScore: formatNumber(composite, 2),
      notes: buildNotes({
        realizedVol,
        impliedVolatility,
        volatilityRatio,
        movementLookbackDays: config.movementLookbackDays,
        actualMovePct,
        expectedMovePct,
        liquidityScore,
        usedOptionProxy: impliedVolatility == null
      })
    };
  });

  const rows = settled
    .flatMap((result) => {
      if (result.status === "rejected") {
        warnings.push(result.reason?.message ?? "Volatility opportunity scan failed for one symbol.");
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
    .slice(0, Math.max(Math.round(Number(limit ?? DEFAULT_LIMIT) || 0), 1));

  const averageScore = rows.length ? mean(rows.map((row) => Number(row.compositeScore ?? 0))) : null;

  return {
    generatedAt: new Date().toISOString(),
    warnings: [...new Set(warnings)],
    config,
    summary: {
      symbolsScanned: symbols.length,
      opportunities: rows.length,
      averageScore: averageScore != null ? formatNumber(averageScore, 2) : null
    },
    rows
  };
}

export { DEFAULT_CONFIG as DEFAULT_VOLATILITY_OPPORTUNITY_CONFIG };
