import { tigerEnabled, tigerFundamentals } from "./providers/tiger.js";
import { finiteNumber } from "./quoteQuality.js";

const TRADING_VIEW_STOCK_SCAN_URL = "https://scanner.tradingview.com/america/scan";

const FUNDAMENTAL_COLUMNS = [
  "name",
  "description",
  "market_cap_basic",
  "price_earnings_ttm",
  "dividends_yield",
  "beta_1_year",
  "volume",
  "average_volume_10d_calc",
  "average_volume_30d_calc",
  "price_52_week_high",
  "price_52_week_low",
  "sector",
  "industry",
  "currency",
  "exchange",
  "type"
];

function normalizeTicker(value, fallback = "") {
  const normalized = String(value ?? fallback)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.\-]/g, "");

  return normalized.slice(0, 16);
}

async function fetchTradingViewJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        origin: "https://www.tradingview.com",
        referer: "https://www.tradingview.com/",
        "user-agent": "HedgeHub/0.1",
        ...(options.headers ?? {})
      }
    });

    if (!response.ok) {
      throw new Error(`TradingView request failed with ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function toNumber(value, fallback = null) {
  return finiteNumber(value, fallback);
}

export async function fetchStockFundamentals({ symbol } = {}) {
  if (tigerEnabled()) return tigerFundamentals(arguments[0]);
  const normalizedSymbol = normalizeTicker(symbol);
  if (!normalizedSymbol) {
    throw new Error("symbol is required");
  }

  const payload = {
    columns: FUNDAMENTAL_COLUMNS,
    filter: [
      {
        left: "name",
        operation: "equal",
        right: normalizedSymbol
      }
    ],
    sort: {
      sortBy: "market_cap_basic",
      sortOrder: "desc"
    },
    range: [0, 10]
  };

  const response = await fetchTradingViewJson(TRADING_VIEW_STOCK_SCAN_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json"
    }
  });

  const rows = Array.isArray(response?.data) ? response.data : [];
  if (!rows.length) {
    throw new Error("No TradingView fundamentals were available for this symbol.");
  }

  const best = rows[0];
  const values = Array.isArray(best?.d) ? best.d : [];

  const [
    ticker,
    description,
    marketCapUsd,
    peTtm,
    dividendYield,
    beta1y,
    volume,
    averageVolume10d,
    averageVolume30d,
    high52w,
    low52w,
    sector,
    industry,
    currency,
    exchange,
    assetType
  ] = values;

  return {
    generatedAt: new Date().toISOString(),
    requestedSymbol: normalizedSymbol,
    resolvedSymbol: best?.s ?? null,
    ticker: ticker ?? normalizedSymbol,
    description: description ?? null,
    marketCapUsd: toNumber(marketCapUsd, null),
    peTtm: toNumber(peTtm, null),
    dividendYield: toNumber(dividendYield, null),
    beta1y: toNumber(beta1y, null),
    volume: toNumber(volume, null),
    averageVolume10d: toNumber(averageVolume10d, null),
    averageVolume30d: toNumber(averageVolume30d, null),
    high52w: toNumber(high52w, null),
    low52w: toNumber(low52w, null),
    sector: sector ?? null,
    industry: industry ?? null,
    currency: currency ?? null,
    exchange: exchange ?? null,
    type: assetType ?? null
  };
}

