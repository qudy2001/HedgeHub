const TRADING_VIEW_STRATEGY_FINDER_URL = "https://options-spread-explorer.tradingview.com/v1/scan";
const TRADING_VIEW_STRATEGY_FINDER_PAGE_URL = "https://www.tradingview.com/options/strategy-finder/";
const DEFAULT_SYMBOL = "AMEX:SPY";
const DEFAULT_PRICE_RANGE = {
  min: 5,
  max: 10,
  type: "percent"
};
const DEFAULT_RISK_FREE_RATE = 0.0425;
const TRADING_VIEW_HEADERS = {
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "content-type": "application/json",
  origin: "https://www.tradingview.com",
  referer: `${TRADING_VIEW_STRATEGY_FINDER_PAGE_URL}?symbol=${encodeURIComponent(DEFAULT_SYMBOL)}`,
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
};

const SYMBOL_EXCHANGE_HINTS = {
  ETHA: "NASDAQ",
  GLD: "AMEX",
  IBIT: "NASDAQ",
  IWM: "AMEX",
  QQQ: "NASDAQ",
  SMH: "NASDAQ",
  SPX: "SP",
  SPY: "AMEX",
  USO: "AMEX",
  VOO: "AMEX",
  XSP: "CBOE"
};
const COMMON_UNDERLYING_EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "CBOE"];
const MONEYNESS_KEYS = ["out_of_the_money", "at_the_money", "in_the_money"];

function toUtcDate(dateIso) {
  if (!dateIso) {
    return null;
  }

  const value = new Date(`${dateIso}T00:00:00.000Z`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfCurrentMonthIso(now = new Date()) {
  return toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
}

function endOfCurrentMonthIso(now = new Date()) {
  return toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
}

function clampIsoDateRange(fromIso, toIso, fallbackRange) {
  const fallbackFrom = fallbackRange.from;
  const fallbackTo = fallbackRange.to;
  const fromDate = toUtcDate(fromIso) ?? toUtcDate(fallbackFrom);
  const toDate = toUtcDate(toIso) ?? toUtcDate(fallbackTo);

  if (!fromDate || !toDate) {
    return fallbackRange;
  }

  if (fromDate <= toDate) {
    return {
      from: toIsoDate(fromDate),
      to: toIsoDate(toDate)
    };
  }

  return {
    from: toIsoDate(toDate),
    to: toIsoDate(fromDate)
  };
}

function toTradingViewDateInt(dateIso) {
  return Number(String(dateIso ?? "").replace(/-/g, ""));
}

function fromTradingViewDateInt(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{8}$/.test(raw)) {
    return "";
  }

  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function differenceInDays(fromIso, toIso) {
  const fromDate = toUtcDate(fromIso);
  const toDate = toUtcDate(toIso);

  if (!fromDate || !toDate) {
    return null;
  }

  return Math.max(
    Math.round((toDate.getTime() - fromDate.getTime()) / (24 * 60 * 60 * 1000)),
    0
  );
}

function normalizeTradingViewUnderlyingSymbolInput(input) {
  const raw = String(input ?? "")
    .trim()
    .toUpperCase()
    .replace(/\//g, ":");

  if (!raw) {
    return "";
  }

  return raw;
}

function buildTradingViewUnderlyingCandidates(input) {
  const raw = normalizeTradingViewUnderlyingSymbolInput(input);

  if (!raw) {
    return [DEFAULT_SYMBOL];
  }

  if (raw.includes(":")) {
    return [raw];
  }

  const hintedExchange = SYMBOL_EXCHANGE_HINTS[raw];
  const exchanges = [
    hintedExchange,
    ...COMMON_UNDERLYING_EXCHANGES.filter((exchange) => exchange !== hintedExchange)
  ].filter(Boolean);

  return exchanges.map((exchange) => `${exchange}:${raw}`);
}

function toDisplayStrategyType(type) {
  return String(type ?? "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function toFiniteNumber(value, fallback = null) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function sanitizeOptionalVolumeRange(value) {
  const minValue = toFiniteNumber(value?.min, null);
  const maxValue = toFiniteNumber(value?.max, null);

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

function sanitizeOptionalSpreadWidthRange(value) {
  const minValue = toFiniteNumber(value?.min, null);
  const maxValue = toFiniteNumber(value?.max, null);

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

function sanitizeOptionalMoneyness(value) {
  if (!value) {
    return null;
  }

  const selectedKeys = Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim().toLowerCase()).filter(Boolean)
    : MONEYNESS_KEYS.filter((key) => value[key] === true);

  const normalizedKeys = MONEYNESS_KEYS.filter((key) => selectedKeys.includes(key));

  if (!normalizedKeys.length || normalizedKeys.length >= MONEYNESS_KEYS.length) {
    return null;
  }

  return normalizedKeys.reduce((result, key) => {
    result[key] = true;
    return result;
  }, {});
}

function sanitizeOptionalOptionSpreadRange(value) {
  const type = value?.type === "value" ? "value" : "percent";
  const minValue = toFiniteNumber(value?.min, null);
  const maxValue = toFiniteNumber(value?.max, null);

  const min = minValue != null && minValue > 0 ? minValue : null;
  const max = maxValue != null && maxValue > 0 ? maxValue : null;

  if (min == null && max == null) {
    return null;
  }

  if (min != null && max != null) {
    return {
      min: Math.min(min, max),
      max: Math.max(min, max),
      type
    };
  }

  if (min != null) {
    return {
      min,
      type
    };
  }

  return {
    max,
    type
  };
}

function computeBidAskSpreadPercent(bid, ask) {
  const numericBid = toFiniteNumber(bid);
  const numericAsk = toFiniteNumber(ask);

  if (!(numericBid > 0) || !(numericAsk > 0)) {
    return null;
  }

  const midpoint = (numericBid + numericAsk) / 2;
  if (!(midpoint > 0)) {
    return null;
  }

  return ((numericAsk - numericBid) / midpoint) * 100;
}

function estimateAnnualizedVolatility(row) {
  const sigma = toFiniteNumber(row?.sigma, null);
  if (!(sigma > 0)) {
    return 0.24;
  }

  return Number((sigma * Math.sqrt(252)).toFixed(4));
}

function buildRowId(row, expirationIso) {
  const legSignature = (row?.legs ?? [])
    .map((leg) => `${leg.side}:${leg.type}:${leg.strike}:${leg.symbol}`)
    .join("|");

  return `${row?.series?.[0]?.id ?? row?.underlying ?? "underlying"}:${row?.type ?? "strategy"}:${expirationIso}:${legSignature}`;
}

function mapTradingViewLeg(row, leg, annualizedVolatility, expirationIso) {
  return {
    action: leg?.side === "sell" ? "SHORT" : "LONG",
    ask: toFiniteNumber(leg?.ask),
    bid: toFiniteNumber(leg?.bid),
    contractMultiplier: 100,
    contractSymbol: String(leg?.symbol ?? "").trim(),
    entryPrice: toFiniteNumber(leg?.theor_price, toFiniteNumber(leg?.mid_price, 0)) ?? 0,
    expiration: expirationIso,
    impliedVolatility: annualizedVolatility,
    midPrice: toFiniteNumber(leg?.mid_price),
    optionType: leg?.type === "put" ? "put" : "call",
    priceStep: toFiniteNumber(leg?.price_step),
    quantity: Math.max(toFiniteNumber(leg?.size, 1) ?? 1, 1),
    quoteSource: "TradingView",
    riskFreeRate: DEFAULT_RISK_FREE_RATE,
    rootSymbol: String(row?.series?.[0]?.family ?? "").trim(),
    strike: toFiniteNumber(leg?.strike, 0) ?? 0
  };
}

function mapTradingViewRow(row, request, generatedAt) {
  const firstSeries = row?.series?.[0] ?? {};
  const expirationIso = fromTradingViewDateInt(firstSeries.exp);
  const annualizedVolatility = estimateAnnualizedVolatility(row);

  return {
    annualizedVolatility,
    ask: toFiniteNumber(row?.ask),
    avgPayoff: toFiniteNumber(row?.avg_payoff),
    bid: toFiniteNumber(row?.bid),
    bidAskSpreadPercent: computeBidAskSpreadPercent(row?.bid, row?.ask),
    breakevens: Array.isArray(row?.breakevens)
      ? row.breakevens.map((value) => toFiniteNumber(value)).filter((value) => value != null)
      : [],
    daysToExpiration: differenceInDays(generatedAt.slice(0, 10), expirationIso),
    expiration: expirationIso,
    id: buildRowId(row, expirationIso),
    legs: (row?.legs ?? []).map((leg) =>
      mapTradingViewLeg(row, leg, annualizedVolatility, expirationIso)
    ),
    maxLoss: toFiniteNumber(row?.max_risk?.q99),
    maxLossQ90: toFiniteNumber(row?.max_risk?.q90),
    maxProfit: toFiniteNumber(row?.max_payoff?.q99),
    pageUrl: `${TRADING_VIEW_STRATEGY_FINDER_PAGE_URL}?symbol=${encodeURIComponent(request.symbol)}`,
    probabilityOfProfit: (() => {
      const winRate = toFiniteNumber(row?.win_rate);
      return winRate == null ? null : winRate * 100;
    })(),
    requestPriceRange: request.priceRange,
    rewardRisk: toFiniteNumber(row?.risk_reward?.q99),
    score: toFiniteNumber(row?.score),
    sigma: toFiniteNumber(row?.sigma),
    strategyTypeKey: String(row?.type ?? "").trim(),
    strategyTypeLabel: toDisplayStrategyType(row?.type),
    theoreticalPrice: toFiniteNumber(row?.theor_price),
    underlyingFamily: String(firstSeries.family ?? "").trim(),
    underlyingPrice: toFiniteNumber(row?.underlying_price),
    underlyingPriceStep: toFiniteNumber(row?.underlying_price_step),
    underlyingSymbol: request.symbol
  };
}

function buildDefaultRequest(now = new Date()) {
  return {
    symbol: DEFAULT_SYMBOL,
    dateRange: {
      from: startOfCurrentMonthIso(now),
      to: endOfCurrentMonthIso(now)
    },
    priceRange: { ...DEFAULT_PRICE_RANGE },
    moneyness: null,
    optionSpreadRange: null,
    spreadWidth: null,
    symmetry: null,
    strategyTypes: [],
    volumeRange: null
  };
}

function sanitizeScanRequest(requestBody = {}, now = new Date()) {
  const defaults = buildDefaultRequest(now);
  const inputSymbol =
    normalizeTradingViewUnderlyingSymbolInput(requestBody.symbol ?? defaults.symbol) || DEFAULT_SYMBOL;
  const dateRange = clampIsoDateRange(
    requestBody?.dateRange?.from,
    requestBody?.dateRange?.to,
    defaults.dateRange
  );

  const minPriceRange = toFiniteNumber(requestBody?.priceRange?.min, defaults.priceRange.min);
  const maxPriceRange = toFiniteNumber(requestBody?.priceRange?.max, defaults.priceRange.max);
  const strategyTypes = Array.isArray(requestBody?.strategyTypes)
    ? requestBody.strategyTypes
        .map((value) => String(value ?? "").trim().toLowerCase())
        .filter(Boolean)
    : defaults.strategyTypes;
  const volumeRange = sanitizeOptionalVolumeRange(requestBody?.volumeRange);
  const spreadWidth = sanitizeOptionalSpreadWidthRange(requestBody?.spreadWidth);
  const moneyness = sanitizeOptionalMoneyness(requestBody?.moneyness);
  const symmetry = requestBody?.symmetry === true ? true : null;
  const optionSpreadRange = sanitizeOptionalOptionSpreadRange(requestBody?.optionSpreadRange);

  return {
    inputSymbol,
    symbolCandidates: buildTradingViewUnderlyingCandidates(inputSymbol),
    dateRange,
    moneyness,
    optionSpreadRange,
    priceRange: {
      min: Math.min(minPriceRange, maxPriceRange),
      max: Math.max(minPriceRange, maxPriceRange),
      type: "percent"
    },
    spreadWidth,
    symmetry,
    volumeRange,
    strategyTypes
  };
}

async function fetchTradingViewScan(payload) {
  const response = await fetch(TRADING_VIEW_STRATEGY_FINDER_URL, {
    method: "POST",
    headers: {
      ...TRADING_VIEW_HEADERS,
      referer: `${TRADING_VIEW_STRATEGY_FINDER_PAGE_URL}?symbol=${encodeURIComponent(payload.underlying)}`
    },
    body: JSON.stringify(payload)
  });

  const bodyText = await response.text();
  let parsedBody = null;

  try {
    parsedBody = bodyText ? JSON.parse(bodyText) : null;
  } catch (_error) {
    parsedBody = null;
  }

  if (!response.ok) {
    const error = new Error(parsedBody?.message || `TradingView scan failed with ${response.status}`);
    error.status = response.status;
    error.responseBody = parsedBody;
    error.isMissingUnderlying = /no such underlying/i.test(parsedBody?.message ?? "");
    throw error;
  }

  return parsedBody;
}

export async function scanTradingViewStrategyFinder(requestBody = {}, now = new Date()) {
  const request = sanitizeScanRequest(requestBody, now);
  const generatedAt = new Date().toISOString();
  let response = null;
  let resolvedSymbol = "";
  let lastMissingUnderlyingError = null;

  for (const candidateSymbol of request.symbolCandidates) {
    try {
      response = await fetchTradingViewScan({
        underlying: candidateSymbol,
        date_range: {
          min: toTradingViewDateInt(request.dateRange.from),
          max: toTradingViewDateInt(request.dateRange.to)
        },
        ...(request.moneyness ? { moneyness: request.moneyness } : {}),
        ...(request.optionSpreadRange ? { option_spread_range: request.optionSpreadRange } : {}),
        price_range: request.priceRange,
        ...(request.spreadWidth ? { spread_width: request.spreadWidth } : {}),
        ...(request.strategyTypes.length ? { strategy_types: request.strategyTypes } : {}),
        ...(request.symmetry ? { symmetry: true } : {}),
        ...(request.volumeRange ? { volume_range: request.volumeRange } : {})
      });
      resolvedSymbol = candidateSymbol;
      break;
    } catch (error) {
      if (error?.isMissingUnderlying) {
        lastMissingUnderlyingError = error;
        continue;
      }

      throw error;
    }
  }

  if (!response || !resolvedSymbol) {
    throw (
      lastMissingUnderlyingError ??
      new Error(`TradingView scan failed for ${request.inputSymbol || DEFAULT_SYMBOL}`)
    );
  }

  const resolvedRequest = {
    ...request,
    symbol: resolvedSymbol
  };
  const rows = (response?.items ?? []).map((row) => mapTradingViewRow(row, resolvedRequest, generatedAt));
  const strategyTypes = Array.from(
    new Map(
      rows.map((row) => [row.strategyTypeKey, { key: row.strategyTypeKey, label: row.strategyTypeLabel }])
    ).entries()
  )
    .map(([, value]) => value)
    .sort((left, right) => left.label.localeCompare(right.label));

  return {
    filters: {
      dateRange: request.dateRange,
      moneyness: request.moneyness,
      optionSpreadRange: request.optionSpreadRange,
      priceRange: request.priceRange,
      spreadWidth: request.spreadWidth,
      symmetry: request.symmetry,
      strategyTypes,
      volumeRange: request.volumeRange
    },
    generatedAt,
    request: {
      symbol: resolvedRequest.symbol,
      inputSymbol: resolvedRequest.inputSymbol,
      dateRange: resolvedRequest.dateRange,
      moneyness: resolvedRequest.moneyness,
      optionSpreadRange: resolvedRequest.optionSpreadRange,
      priceRange: resolvedRequest.priceRange,
      spreadWidth: resolvedRequest.spreadWidth,
      strategyTypes: resolvedRequest.strategyTypes,
      symmetry: resolvedRequest.symmetry,
      volumeRange: resolvedRequest.volumeRange
    },
    rows,
    source: {
      label: "TradingView Strategy Finder",
      pageUrl: `${TRADING_VIEW_STRATEGY_FINDER_PAGE_URL}?symbol=${encodeURIComponent(resolvedRequest.symbol)}`
    },
    summary: {
      count: toFiniteNumber(response?.count, rows.length) ?? rows.length,
      displayedCount: rows.length
    }
  };
}
