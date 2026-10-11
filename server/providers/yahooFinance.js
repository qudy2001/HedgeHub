const STOOQ_BASE_URL = "https://stooq.com/q/l/?f=sd2t2ohlcvn&e=csv&s=";
const YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3/simple/price";

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

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function blackScholesGreeks({
  type,
  spot,
  strike,
  timeYears,
  volatility,
  riskFreeRate
}) {
  const normalizedSpot = Number(spot ?? 0);
  const normalizedStrike = Number(strike ?? 0);
  const normalizedT = Number(timeYears ?? 0);
  const normalizedVol = Number(volatility ?? 0);
  const normalizedRate = Number(riskFreeRate ?? 0);

  if (
    !Number.isFinite(normalizedSpot) ||
    normalizedSpot <= 0 ||
    !Number.isFinite(normalizedStrike) ||
    normalizedStrike <= 0 ||
    !Number.isFinite(normalizedT) ||
    normalizedT <= 0 ||
    !Number.isFinite(normalizedVol) ||
    normalizedVol <= 0
  ) {
    return {
      delta: null,
      gamma: null,
      theta: null,
      vega: null,
      rho: null
    };
  }

  const sqrtT = Math.sqrt(normalizedT);
  const d1 =
    (Math.log(normalizedSpot / normalizedStrike) +
      (normalizedRate + 0.5 * normalizedVol * normalizedVol) * normalizedT) /
    (normalizedVol * sqrtT);
  const d2 = d1 - normalizedVol * sqrtT;
  const pdfD1 = normalPdf(d1);
  const discountedStrike = normalizedStrike * Math.exp(-normalizedRate * normalizedT);
  const cdfD1 = normalCdf(d1);
  const cdfD2 = normalCdf(d2);
  const cdfMinusD2 = normalCdf(-d2);

  const delta = type === "put" ? cdfD1 - 1 : cdfD1;
  const gamma = pdfD1 / (normalizedSpot * normalizedVol * sqrtT);

  const yearlyTheta =
    type === "put"
      ? (-normalizedSpot * pdfD1 * normalizedVol) / (2 * sqrtT) + normalizedRate * discountedStrike * cdfMinusD2
      : (-normalizedSpot * pdfD1 * normalizedVol) / (2 * sqrtT) - normalizedRate * discountedStrike * cdfD2;

  const vega = normalizedSpot * pdfD1 * sqrtT;
  const rho =
    type === "put"
      ? -normalizedStrike * normalizedT * Math.exp(-normalizedRate * normalizedT) * cdfMinusD2
      : normalizedStrike * normalizedT * Math.exp(-normalizedRate * normalizedT) * cdfD2;

  return {
    delta,
    gamma,
    theta: yearlyTheta,
    vega,
    rho
  };
}

function blackScholesOptionPrice({
  type,
  spot,
  strike,
  timeYears,
  volatility,
  riskFreeRate
}) {
  if (timeYears <= 0) {
    return type === "put" ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
  }

  const sqrtT = Math.sqrt(timeYears);
  const d1 =
    (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeYears) /
    (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;
  const discountedStrike = strike * Math.exp(-riskFreeRate * timeYears);

  if (type === "put") {
    return discountedStrike * normalCdf(-d2) - spot * normalCdf(-d1);
  }

  return spot * normalCdf(d1) - discountedStrike * normalCdf(d2);
}

function estimateBidAsk(midPrice) {
  const mid = Math.max(Number(midPrice) || 0, 0.01);
  const spread = Math.max(mid * 0.08, 0.02);

  return {
    bid: Number(Math.max(mid - spread / 2, 0.01).toFixed(4)),
    ask: Number((mid + spread / 2).toFixed(4)),
    mark: Number(mid.toFixed(4))
  };
}

function roundToIncrement(value, increment) {
  return Math.round(value / increment) * increment;
}

function buildSyntheticOptionChain({
  symbol,
  expiration,
  expirationFrom,
  expirationTo,
  optionType,
  currentSpot = 0,
  strikeHint = 0,
  limit = 40
}) {
  const referenceSpot = Math.max(currentSpot || strikeHint || 1, 1);
  const now = new Date();
  const referenceExpiration =
    expiration ||
    expirationTo ||
    expirationFrom ||
    new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const volatility = referenceSpot > 200 ? 0.22 : referenceSpot > 50 ? 0.28 : 0.36;
  const strikeIncrement = referenceSpot > 200 ? 5 : referenceSpot > 50 ? 1 : 0.5;
  const strikeMultipliers = [
    0.78,
    0.82,
    0.86,
    0.9,
    0.94,
    0.98,
    1,
    1.02,
    1.06,
    1.1,
    1.14,
    1.18,
    1.22
  ];

  const syntheticExpiries = [
    expirationFrom,
    referenceExpiration,
    expirationTo
  ]
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .sort();

  const expiries = syntheticExpiries.length ? syntheticExpiries : [referenceExpiration];

  return expiries.flatMap((expiryDate) =>
    strikeMultipliers
      .map((multiplier) => roundToIncrement(referenceSpot * multiplier, strikeIncrement))
      .filter((strike, index, array) => strike > 0 && array.indexOf(strike) === index)
      .sort((left, right) => left - right)
      .slice(0, Math.max(limit, 12))
      .map((strike) => {
        const expiryTime = new Date(`${expiryDate}T00:00:00.000Z`);
        const expiryYears = Math.max((expiryTime.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000), 1 / 365);
        const modelPrice = blackScholesOptionPrice({
          type: optionType,
          spot: referenceSpot,
          strike,
          timeYears: expiryYears,
          volatility,
          riskFreeRate: 0.0425
        });
        const quotes = estimateBidAsk(modelPrice);

        return {
          contractSymbol: `${symbol}-${expiryDate}-${optionType.toUpperCase()}-${Number(strike).toFixed(1)}`,
          strike: Number(strike.toFixed(2)),
          expiration: expiryDate,
          optionType,
          bid: quotes.bid,
          ask: quotes.ask,
          bidSize: null,
          askSize: null,
          mark: quotes.mark,
          lastPrice: quotes.mark,
          impliedVolatility: volatility,
          volume: null,
          openInterest: null,
          exerciseStyle: null,
          source: "modeled",
          sourceLabel: "Synthetic chain",
          isLive: false,
          hasRealBidAsk: false
        };
      })
  );
}

function timeToExpiryYears(expiration) {
  if (!expiration) {
    return 1 / 365;
  }

  const now = new Date();
  const expiry = new Date(`${expiration}T00:00:00.000Z`);
  return Math.max((expiry.getTime() - now.getTime()) / (365 * 24 * 60 * 60 * 1000), 1 / 365);
}

function enrichContractWithFallbackQuotes(contract, currentSpot = 0) {
  const hasPrice =
    (Number.isFinite(contract.bid) && contract.bid > 0) ||
    (Number.isFinite(contract.ask) && contract.ask > 0) ||
    (Number.isFinite(contract.mark) && contract.mark > 0) ||
    (Number.isFinite(contract.lastPrice) && contract.lastPrice > 0);

  if (hasPrice || !Number.isFinite(currentSpot) || currentSpot <= 0 || !Number.isFinite(contract.strike)) {
    return contract;
  }

  const defaultVolatility = currentSpot > 200 ? 0.22 : currentSpot > 50 ? 0.28 : 0.36;
  const volatility = clamp(Number(contract.impliedVolatility ?? 0) || defaultVolatility, 0.05, 3);
  const modeledPrice = blackScholesOptionPrice({
    type: contract.optionType,
    spot: currentSpot,
    strike: contract.strike,
    timeYears: timeToExpiryYears(contract.expiration),
    volatility,
    riskFreeRate: 0.0425
  });
  const fallbackQuotes = estimateBidAsk(modeledPrice);

  return {
    ...contract,
    bid: Number.isFinite(contract.bid) && contract.bid > 0 ? contract.bid : fallbackQuotes.bid,
    ask: Number.isFinite(contract.ask) && contract.ask > 0 ? contract.ask : fallbackQuotes.ask,
    bidSize: contract.bidSize ?? null,
    askSize: contract.askSize ?? null,
    mark: Number.isFinite(contract.mark) && contract.mark > 0 ? contract.mark : fallbackQuotes.mark,
    lastPrice:
      Number.isFinite(contract.lastPrice) && contract.lastPrice > 0 ? contract.lastPrice : fallbackQuotes.mark,
    hasRealBidAsk: contract.hasRealBidAsk === true
  };
}

function enrichContractWithDerivedMetrics(contract, currentSpot = 0) {
  const withQuotes = enrichContractWithFallbackQuotes(contract, currentSpot);
  const spot = Number(currentSpot ?? 0);
  const strike = Number(withQuotes.strike ?? 0);

  const mid =
    Number.isFinite(withQuotes.bid) &&
    withQuotes.bid > 0 &&
    Number.isFinite(withQuotes.ask) &&
    withQuotes.ask > 0
      ? (withQuotes.bid + withQuotes.ask) / 2
      : Number(withQuotes.mark ?? withQuotes.lastPrice ?? NaN);
  const mark = Number(withQuotes.mark ?? mid ?? NaN);

  const dayOpen = Number(withQuotes.dayOpen ?? NaN);
  const changePercent =
    Number.isFinite(dayOpen) && dayOpen > 0 && Number.isFinite(mark)
      ? ((mark - dayOpen) / dayOpen) * 100
      : null;

  const defaultVolatility = spot > 200 ? 0.22 : spot > 50 ? 0.28 : 0.36;
  const volatility = clamp(Number(withQuotes.impliedVolatility ?? 0) || defaultVolatility, 0.05, 3);
  const greeks = blackScholesGreeks({
    type: withQuotes.optionType,
    spot,
    strike,
    timeYears: timeToExpiryYears(withQuotes.expiration),
    volatility,
    riskFreeRate: 0.0425
  });

  const intrinsicValue =
    Number.isFinite(spot) && spot > 0 && Number.isFinite(strike) && strike > 0
      ? withQuotes.optionType === "put"
        ? Math.max(strike - spot, 0)
        : Math.max(spot - strike, 0)
      : null;
  const timeValue =
    Number.isFinite(mark) && Number.isFinite(intrinsicValue)
      ? mark - intrinsicValue
      : null;
  const premiumPercent =
    Number.isFinite(timeValue) && Number.isFinite(spot) && spot > 0
      ? (timeValue / spot) * 100
      : null;

  return {
    ...withQuotes,
    mid: Number.isFinite(mid) ? mid : null,
    mark: Number.isFinite(mark) ? mark : withQuotes.mark ?? null,
    changePercent,
    intrinsicValue,
    timeValue,
    premiumPercent,
    delta: Number.isFinite(greeks.delta) ? greeks.delta : null,
    gamma: Number.isFinite(greeks.gamma) ? greeks.gamma : null,
    theta: Number.isFinite(greeks.theta) ? greeks.theta / 365 : null,
    vega: Number.isFinite(greeks.vega) ? greeks.vega / 100 : null,
    rho: Number.isFinite(greeks.rho) ? greeks.rho / 100 : null
  };
}

function parseStooqLine(line) {
  const [
    rawSymbol,
    date,
    time,
    open,
    high,
    low,
    close,
    volume,
    name
  ] = line.split(",");

  if (!rawSymbol || close === "N/D") {
    return null;
  }

  const openNumber = Number(open);
  const closeNumber = Number(close);
  const changePercent =
    Number.isFinite(openNumber) && openNumber !== 0
      ? ((closeNumber - openNumber) / openNumber) * 100
      : null;

  return {
    rawSymbol,
    date,
    time,
    name,
    regularMarketPrice: closeNumber,
    regularMarketChangePercent: changePercent,
    currency: "USD",
    volume: Number(volume)
  };
}

async function fetchStooqQuotes(items) {
  if (!items.length) {
    return [];
  }

  const payload = await fetchText(
    `${STOOQ_BASE_URL}${items.map((item) => encodeURIComponent(item.sourceSymbol)).join("+")}`
  );
  const quoteBySource = new Map(
    payload
      .trim()
      .split(/\r?\n/)
      .map(parseStooqLine)
      .filter(Boolean)
      .map((quote) => [quote.rawSymbol.toLowerCase(), quote])
  );

  return items
    .map((item) => {
      const quote = quoteBySource.get(item.sourceSymbol.toUpperCase().toLowerCase());
      if (!quote) {
        return null;
      }

      return {
        symbol: item.symbol,
        shortName: item.label,
        regularMarketPrice: quote.regularMarketPrice,
        regularMarketChangePercent: quote.regularMarketChangePercent,
        currency: quote.currency,
        exchange: "STOOQ",
        regularMarketTime: `${quote.date} ${quote.time}`
      };
    })
    .filter(Boolean);
}

function normalizeYahooEquityTicker(sourceSymbol = "") {
  return String(sourceSymbol ?? "")
    .trim()
    .replace(/\.us$/i, "")
    .toUpperCase();
}

async function fetchYahooEquityQuotes(items) {
  if (!items.length) {
    return [];
  }

  const tickers = [...new Set(items.map((item) => normalizeYahooEquityTicker(item.sourceSymbol)).filter(Boolean))];
  if (!tickers.length) {
    return [];
  }

  const chartResults = await Promise.allSettled(
    tickers.map(async (ticker) => {
      const url = new URL(`${YAHOO_CHART_URL}/${encodeURIComponent(ticker)}`);
      url.searchParams.set("interval", "1m");
      url.searchParams.set("range", "1d");
      url.searchParams.set("includePrePost", "true");

      const payload = await fetchJson(url.toString());
      const result = Array.isArray(payload?.chart?.result) ? payload.chart.result[0] : null;
      const meta = result?.meta ?? null;
      const priceCandidates = [
        Number(meta?.regularMarketPrice),
        Number(meta?.previousClose)
      ];
      const regularMarketPrice = priceCandidates.find((value) => Number.isFinite(value) && value > 0) ?? null;
      if (!meta || !(regularMarketPrice > 0)) {
        return null;
      }

      const previousClose = Number(meta?.previousClose);
      const changePercent =
        Number.isFinite(previousClose) && previousClose > 0
          ? ((regularMarketPrice - previousClose) / previousClose) * 100
          : 0;
      const marketTimeSeconds = Number(meta?.regularMarketTime ?? 0);

      return [
        ticker,
        {
          regularMarketPrice,
          regularMarketChangePercent: changePercent,
          regularMarketTime:
            Number.isFinite(marketTimeSeconds) && marketTimeSeconds > 0
              ? new Date(marketTimeSeconds * 1000).toISOString()
              : new Date().toISOString(),
          shortName: meta?.shortName ?? meta?.longName ?? ticker,
          exchange: "Yahoo Finance",
          currency: meta?.currency ?? "USD"
        }
      ];
    })
  );

  const quoteByTicker = new Map(
    chartResults
      .filter((result) => result.status === "fulfilled" && Array.isArray(result.value))
      .map((result) => result.value)
  );

  return items
    .map((item) => {
      const quote = quoteByTicker.get(normalizeYahooEquityTicker(item.sourceSymbol));
      if (!quote) {
        return null;
      }

      return {
        symbol: item.symbol,
        shortName: item.label || quote.shortName,
        regularMarketPrice: quote.regularMarketPrice,
        regularMarketChangePercent: quote.regularMarketChangePercent,
        currency: quote.currency,
        exchange: quote.exchange,
        regularMarketTime: quote.regularMarketTime
      };
    })
    .filter(Boolean);
}

async function fetchCoinGeckoQuotes(items) {
  if (!items.length) {
    return [];
  }

  const ids = items.map((item) => item.sourceSymbol).join(",");
  const url = `${COINGECKO_BASE_URL}?ids=${encodeURIComponent(
    ids
  )}&vs_currencies=usd&include_24hr_change=true`;
  const payload = await fetchJson(url);

  return items
    .map((item) => {
      const quote = payload[item.sourceSymbol];
      if (!quote) {
        return null;
      }

      return {
        symbol: item.symbol,
        shortName: item.label,
        regularMarketPrice: Number(quote.usd),
        regularMarketChangePercent: Number(quote.usd_24h_change ?? 0),
        currency: "USD",
        exchange: "CoinGecko",
        regularMarketTime: new Date().toISOString()
      };
    })
    .filter(Boolean);
}

async function fetchStockQuotesWithFallback(items) {
  if (!items.length) {
    return [];
  }

  const resolved = new Array(items.length).fill(null);
  let remaining = items.map((item, index) => ({ item, index }));

  const mergeQuotes = (quotes = []) => {
    if (!quotes.length || !remaining.length) {
      return;
    }

    const quotesBySymbol = new Map(
      quotes.map((quote) => [String(quote.symbol ?? "").trim().toUpperCase(), quote])
    );

    remaining = remaining.filter(({ item, index }) => {
      const quote = quotesBySymbol.get(String(item.symbol ?? "").trim().toUpperCase());
      if (!quote || !(Number(quote.regularMarketPrice) > 0)) {
        return true;
      }

      resolved[index] = quote;
      return false;
    });
  };

  try {
    mergeQuotes(await fetchYahooEquityQuotes(remaining.map(({ item }) => item)));
  } catch (_error) {
    // Fall through to Stooq.
  }

  try {
    mergeQuotes(await fetchStooqQuotes(remaining.map(({ item }) => item)));
  } catch (_error) {
    // Surface an empty result if every provider failed.
  }

  return resolved.filter(Boolean);
}

export async function fetchQuotes(items) {
  const stockItems = items.filter((item) => item.provider !== "coingecko");
  const coingeckoItems = items.filter((item) => item.provider === "coingecko");
  const [stockResult, coingeckoResult] = await Promise.allSettled([
    fetchStockQuotesWithFallback(stockItems),
    fetchCoinGeckoQuotes(coingeckoItems)
  ]);

  return [
    ...(stockResult.status === "fulfilled" ? stockResult.value : []),
    ...(coingeckoResult.status === "fulfilled" ? coingeckoResult.value : []),
  ];
}

export async function fetchOptionChain({
  symbol,
  expiration,
  expirationFrom,
  expirationTo,
  optionType = "call",
  currentSpot = 0,
  strikeHint = 0,
  strikeMin,
  strikeMax,
  limit = 60
}) {
  return {
    symbol,
    expiration,
    expirationFrom,
    expirationTo,
    optionType,
    source: "modeled",
    sourceLabel: "Synthetic chain",
    isLive: false,
    contracts: buildSyntheticOptionChain({
      symbol,
      expiration,
      expirationFrom,
      expirationTo,
      optionType,
      currentSpot,
      strikeHint,
      limit
    }).map((contract) => enrichContractWithDerivedMetrics(contract, currentSpot))
  };
}

export async function fetchNearestCalls(symbol, targetStrike, desiredExpiry, limit = 6, currentSpot = 0) {
  const result = await fetchOptionChain({
    symbol,
    expiration: desiredExpiry,
    optionType: "call",
    currentSpot,
    strikeHint: targetStrike,
    limit: Math.max(limit * 4, 20)
  });

  return [...result.contracts]
    .sort((left, right) => {
      const leftDistance = Math.abs(left.strike - targetStrike);
      const rightDistance = Math.abs(right.strike - targetStrike);
      return leftDistance === rightDistance ? left.strike - right.strike : leftDistance - rightDistance;
    })
    .slice(0, limit)
    .map((contract) => ({
      contractSymbol: contract.contractSymbol,
      strike: contract.strike,
      expiration: contract.expiration,
      lastPrice: contract.lastPrice ?? contract.mark ?? null,
      impliedVolatility: clamp(Number(contract.impliedVolatility ?? 0) || 0.24, 0.05, 3),
      optionType: contract.optionType,
      bid: contract.bid,
      ask: contract.ask,
      bidSize: contract.bidSize ?? null,
      askSize: contract.askSize ?? null,
      source: contract.source,
      isLive: contract.isLive,
      hasRealBidAsk: contract.hasRealBidAsk === true
    }));
}
