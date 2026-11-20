import { tigerEnabled, tigerHistory } from "./providers/tiger.js";
import { finiteNumber } from "./quoteQuality.js";

const STOOQ_DAILY_HISTORY_URL = "https://stooq.com/q/d/l/?i=d&s=";
const YAHOO_DAILY_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

function normalizeTicker(value, fallback = "") {
  const normalized = String(value ?? fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");

  return normalized.slice(0, 16);
}

function normalizeStooqStockSymbol(symbol) {
  return `${String(symbol ?? "")
    .trim()
    .toLowerCase()
    .replace(/\./g, "-")}.us`;
}

function toNumber(value, fallback = null) {
  return finiteNumber(value, fallback);
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "HedgeHub/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "HedgeHub/0.1"
      }
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseStooqDailyLine(line) {
  if (!line) {
    return null;
  }

  const [date, open, high, low, close, volume] = line.split(",");
  if (!date || date === "Date") {
    return null;
  }

  const closeValue = toNumber(close, null);
  if (closeValue == null) {
    return null;
  }

  return {
    date,
    open: toNumber(open, null),
    high: toNumber(high, null),
    low: toNumber(low, null),
    close: closeValue,
    volume: toNumber(volume, null)
  };
}

async function fetchStooqDailyBars({ symbol, lookbackPoints } = {}) {
  const stooqSymbol = normalizeStooqStockSymbol(symbol);
  const payload = await fetchText(`${STOOQ_DAILY_HISTORY_URL}${encodeURIComponent(stooqSymbol)}`);
  const lines = payload.trim().split(/\r?\n/).filter(Boolean);
  const dataLines = lines.slice(1);
  const desiredLookback = Math.max(Math.round(Number(lookbackPoints ?? 0) || 0), 60);
  const recentLines = dataLines.slice(-desiredLookback);

  const points = recentLines
    .map(parseStooqDailyLine)
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date));

  return {
    source: "stooq",
    sourceLabel: "Stooq",
    symbol,
    sourceSymbol: stooqSymbol,
    points
  };
}

async function fetchYahooDailyBars({ symbol, lookbackPoints } = {}) {
  const desiredLookback = Math.max(Math.round(Number(lookbackPoints ?? 0) || 0), 60);
  const url = new URL(`${YAHOO_DAILY_CHART_URL}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("range", "2y");
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");

  const payload = await fetchJson(url.toString());
  const result = Array.isArray(payload?.chart?.result) ? payload.chart.result[0] : null;
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const quote = Array.isArray(result?.indicators?.quote) ? result.indicators.quote[0] : null;
  const opens = Array.isArray(quote?.open) ? quote.open : [];
  const highs = Array.isArray(quote?.high) ? quote.high : [];
  const lows = Array.isArray(quote?.low) ? quote.low : [];
  const closes = Array.isArray(quote?.close) ? quote.close : [];
  const volumes = Array.isArray(quote?.volume) ? quote.volume : [];

  const points = timestamps
    .map((timestamp, index) => {
      const close = toNumber(closes[index], null);
      if (!Number.isFinite(timestamp) || close == null) {
        return null;
      }

      return {
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        open: toNumber(opens[index], null),
        high: toNumber(highs[index], null),
        low: toNumber(lows[index], null),
        close,
        volume: toNumber(volumes[index], null)
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-desiredLookback);

  return {
    source: "yahoo",
    sourceLabel: "Yahoo Finance",
    symbol,
    points
  };
}

export async function fetchStockDailyOhlcHistory({ symbol, lookbackPoints, now = new Date() } = {}) {
  if (tigerEnabled()) return tigerHistory(arguments[0]);
  const normalizedSymbol = normalizeTicker(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required");
  }

  const desiredLookback = Math.max(Math.round(Number(lookbackPoints ?? 0) || 0), 60);

  let yahooError = null;
  try {
    const yahooResult = await fetchYahooDailyBars({
      symbol: normalizedSymbol,
      lookbackPoints: desiredLookback
    });

    if (yahooResult.points.length >= 2) {
      return yahooResult;
    }

    yahooError = new Error("Yahoo Finance returned insufficient daily bars.");
  } catch (error) {
    yahooError = error;
  }

  const stooqResult = await fetchStooqDailyBars({
    symbol: normalizedSymbol,
    lookbackPoints: desiredLookback
  });

  return {
    ...stooqResult,
    ...(yahooError ? { warning: `Yahoo daily bars unavailable: ${yahooError.message}` } : {})
  };
}

export { normalizeTicker };
