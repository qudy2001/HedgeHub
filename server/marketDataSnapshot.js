import { fetchStockDailyOhlcHistory, normalizeTicker } from "./stockOhlcHistory.js";

const DEFAULT_LOOKBACK_DAYS = 180;
const MIN_HISTORY_BUFFER = 220;

function roundNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function parseCurrDate(value) {
  if (value == null || String(value).trim() === "") {
    return null;
  }

  const raw = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("curr_date must be in YYYY-MM-DD format");
  }

  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error("curr_date must be a valid date");
  }

  return { raw, date };
}

function rollingMean(values, period, index) {
  if (index + 1 < period) {
    return null;
  }

  let sum = 0;
  for (let offset = index - period + 1; offset <= index; offset += 1) {
    const value = Number(values[offset]);
    if (!Number.isFinite(value)) {
      return null;
    }
    sum += value;
  }

  return sum / period;
}

function rollingStdDev(values, period, index, meanValue) {
  if (index + 1 < period || !Number.isFinite(meanValue)) {
    return null;
  }

  let varianceSum = 0;
  for (let offset = index - period + 1; offset <= index; offset += 1) {
    const value = Number(values[offset]);
    if (!Number.isFinite(value)) {
      return null;
    }
    varianceSum += (value - meanValue) ** 2;
  }

  return Math.sqrt(varianceSum / period);
}

function computeEmaSeries(values, period) {
  const alpha = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  let previous = null;

  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) {
      continue;
    }

    previous = previous == null ? value : previous + alpha * (value - previous);
    result[index] = previous;
  }

  return result;
}

function computeRsiSeries(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) {
    return result;
  }

  let averageGain = 0;
  let averageLoss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = closes[index] - closes[index - 1];
    if (delta >= 0) {
      averageGain += delta;
    } else {
      averageLoss += -delta;
    }
  }

  averageGain /= period;
  averageLoss /= period;
  result[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);

  for (let index = period + 1; index < closes.length; index += 1) {
    const delta = closes[index] - closes[index - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    result[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }

  return result;
}

function computeAtrSeries(highs, lows, closes, period = 14) {
  const trueRanges = new Array(closes.length).fill(null);
  const result = new Array(closes.length).fill(null);

  for (let index = 1; index < closes.length; index += 1) {
    const high = highs[index];
    const low = lows[index];
    const previousClose = closes[index - 1];
    trueRanges[index] = Math.max(
      high - low,
      Math.abs(high - previousClose),
      Math.abs(low - previousClose)
    );
  }

  if (closes.length <= period) {
    return result;
  }

  let average = 0;
  for (let index = 1; index <= period; index += 1) {
    average += trueRanges[index] ?? 0;
  }
  average /= period;
  result[period] = average;

  for (let index = period + 1; index < closes.length; index += 1) {
    average = (average * (period - 1) + (trueRanges[index] ?? 0)) / period;
    result[index] = average;
  }

  return result;
}

function enrichPoints(points) {
  const closes = points.map((point) => Number(point.close));
  const highs = points.map((point) => Number(point.high));
  const lows = points.map((point) => Number(point.low));

  const ema12 = computeEmaSeries(closes, 12);
  const ema26 = computeEmaSeries(closes, 26);
  const macd = closes.map((_value, index) =>
    Number.isFinite(ema12[index]) && Number.isFinite(ema26[index]) ? ema12[index] - ema26[index] : null
  );
  const macdSignal = computeEmaSeries(macd.map((value) => (Number.isFinite(value) ? value : 0)), 9).map(
    (value, index) => (Number.isFinite(macd[index]) ? value : null)
  );
  const rsi = computeRsiSeries(closes, 14);
  const atr = computeAtrSeries(highs, lows, closes, 14);

  return points.map((point, index) => {
    const boll = rollingMean(closes, 20, index);
    const bollStd = rollingStdDev(closes, 20, index, boll);
    const macdValue = macd[index];
    const macdsValue = macdSignal[index];

    return {
      date: `${point.date}T00:00:00.000Z`,
      open: roundNumber(Number(point.open)),
      high: roundNumber(Number(point.high)),
      low: roundNumber(Number(point.low)),
      close: roundNumber(Number(point.close)),
      volume: Number.isFinite(Number(point.volume)) ? Number(point.volume) : null,
      rsi: roundNumber(rsi[index]),
      macd: roundNumber(macdValue),
      macds: roundNumber(macdsValue),
      macdh: roundNumber(
        Number.isFinite(macdValue) && Number.isFinite(macdsValue) ? macdValue - macdsValue : null
      ),
      boll: roundNumber(boll),
      boll_ub: roundNumber(Number.isFinite(boll) && Number.isFinite(bollStd) ? boll + 2 * bollStd : null),
      boll_lb: roundNumber(Number.isFinite(boll) && Number.isFinite(bollStd) ? boll - 2 * bollStd : null),
      atr: roundNumber(atr[index]),
      close_50_sma: roundNumber(rollingMean(closes, 50, index)),
      close_200_sma: roundNumber(rollingMean(closes, 200, index))
    };
  });
}

export async function fetchMarketDataSnapshot({ symbol, currDate, lookBackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const normalizedSymbol = normalizeTicker(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required");
  }

  const normalizedLookback = Math.max(Math.round(Number(lookBackDays ?? DEFAULT_LOOKBACK_DAYS) || 0), 1);
  const parsedCurrDate = parseCurrDate(currDate);
  const history = await fetchStockDailyOhlcHistory({
    symbol: normalizedSymbol,
    lookbackPoints: Math.max(normalizedLookback + MIN_HISTORY_BUFFER, 260)
  });

  const allPoints = Array.isArray(history?.points) ? history.points : [];
  const filteredPoints = parsedCurrDate
    ? allPoints.filter((point) => point.date <= parsedCurrDate.raw)
    : allPoints;

  if (!filteredPoints.length) {
    throw new Error("No market data found for the requested symbol/date window.");
  }

  const windowedPoints = filteredPoints.slice(-normalizedLookback);
  const candles = enrichPoints(windowedPoints);
  const latestCandle = candles[candles.length - 1] ?? null;

  return {
    symbol: normalizedSymbol,
    curr_date: parsedCurrDate?.raw ?? filteredPoints[filteredPoints.length - 1]?.date ?? null,
    look_back_days: normalizedLookback,
    candles,
    latest_candle: latestCandle
      ? {
          date: latestCandle.date,
          open: latestCandle.open,
          high: latestCandle.high,
          low: latestCandle.low,
          close: latestCandle.close,
          volume: latestCandle.volume
        }
      : null,
    latest_indicators: latestCandle
      ? {
          rsi: latestCandle.rsi,
          macd: latestCandle.macd,
          macds: latestCandle.macds,
          macdh: latestCandle.macdh,
          boll: latestCandle.boll,
          boll_ub: latestCandle.boll_ub,
          boll_lb: latestCandle.boll_lb,
          atr: latestCandle.atr,
          close_50_sma: latestCandle.close_50_sma,
          close_200_sma: latestCandle.close_200_sma
        }
      : null
  };
}
