import { fetchStockDailyOhlcHistory, normalizeTicker } from "./stockOhlcHistory.js";

const DEFAULT_LOOKBACK_POINTS = 320;

function mean(values) {
  const numericValues = (values ?? []).filter((value) => Number.isFinite(value));
  if (!numericValues.length) {
    return null;
  }

  const sum = numericValues.reduce((total, value) => total + value, 0);
  return sum / numericValues.length;
}

function sma(values, period) {
  const numericPeriod = Math.max(Math.round(Number(period ?? 0) || 0), 1);
  const numericValues = (values ?? []).filter((value) => Number.isFinite(value));
  if (numericValues.length < numericPeriod) {
    return null;
  }

  return mean(numericValues.slice(-numericPeriod));
}

function rsi(values, period = 14) {
  const closes = (values ?? []).filter((value) => Number.isFinite(value));
  const numericPeriod = Math.max(Math.round(Number(period ?? 0) || 0), 1);
  if (closes.length <= numericPeriod) {
    return null;
  }

  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= numericPeriod; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) {
      averageGain += delta;
    } else {
      averageLoss += -delta;
    }
  }

  averageGain /= numericPeriod;
  averageLoss /= numericPeriod;

  for (let index = numericPeriod + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    averageGain = (averageGain * (numericPeriod - 1) + gain) / numericPeriod;
    averageLoss = (averageLoss * (numericPeriod - 1) + loss) / numericPeriod;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

export async function fetchStockTechnicals({ symbol, lookbackPoints = DEFAULT_LOOKBACK_POINTS } = {}) {
  const normalizedSymbol = normalizeTicker(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required");
  }

  const desiredLookback = Math.max(Math.round(Number(lookbackPoints ?? DEFAULT_LOOKBACK_POINTS) || 0), 60);
  const history = await fetchStockDailyOhlcHistory({
    symbol: normalizedSymbol,
    lookbackPoints: desiredLookback
  });
  const points = Array.isArray(history?.points) ? history.points : [];

  if (points.length < 2) {
    throw new Error("Not enough price history to compute technicals.");
  }

  const closes = points.map((point) => point.close);
  const highs = points.map((point) => point.high);
  const lows = points.map((point) => point.low);

  const lastPoint = points[points.length - 1];
  const prevPoint = points[points.length - 2];
  const change = lastPoint.close - prevPoint.close;
  const changePct = prevPoint.close !== 0 ? (change / prevPoint.close) * 100 : null;

  const atr14 = (() => {
    const period = 14;
    if (points.length <= period) {
      return null;
    }

    let average = 0;
    for (let index = 1; index <= period; index += 1) {
      const high = highs[index];
      const low = lows[index];
      const prevClose = closes[index - 1];
      const trueRange = Math.max(
        Number.isFinite(high) && Number.isFinite(low) ? high - low : 0,
        Number.isFinite(high) && Number.isFinite(prevClose) ? Math.abs(high - prevClose) : 0,
        Number.isFinite(low) && Number.isFinite(prevClose) ? Math.abs(low - prevClose) : 0
      );
      average += trueRange;
    }

    average /= period;
    for (let index = period + 1; index < points.length; index += 1) {
      const high = highs[index];
      const low = lows[index];
      const prevClose = closes[index - 1];
      const trueRange = Math.max(
        Number.isFinite(high) && Number.isFinite(low) ? high - low : 0,
        Number.isFinite(high) && Number.isFinite(prevClose) ? Math.abs(high - prevClose) : 0,
        Number.isFinite(low) && Number.isFinite(prevClose) ? Math.abs(low - prevClose) : 0
      );
      average = (average * (period - 1) + trueRange) / period;
    }

    return average;
  })();

  return {
    generatedAt: new Date().toISOString(),
    symbol: normalizedSymbol,
    stooqSymbol: `${normalizedSymbol.toLowerCase().replace(/\\./g, "-")}.us`,
    historySource: history?.source ?? null,
    historySourceLabel: history?.sourceLabel ?? null,
    historyWarning: history?.warning ?? null,
    historyPoints: points.length,
    lastClose: lastPoint.close,
    prevClose: prevPoint.close,
    change,
    changePct,
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    sma200: sma(closes, 200),
    rsi14: rsi(closes, 14),
    atr14
  };
}
