const STOOQ_BASE_URL = "https://stooq.com/q/l/?f=sd2t2ohlcvn&e=csv&s=";
const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3/simple/price";
const POLYGON_OPTIONS_SNAPSHOT_URL = "https://api.polygon.io/v3/snapshot/options";

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

function toQuoteSize(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : null;
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

function normalizePolygonContract(item, fallbackType) {
  const strike = Number(item?.details?.strike_price ?? 0);
  if (!Number.isFinite(strike) || strike <= 0) {
    return null;
  }

  const bid = Number(item?.last_quote?.bid);
  const ask = Number(item?.last_quote?.ask);
  const bidSize = toQuoteSize(item?.last_quote?.bid_size);
  const askSize = toQuoteSize(item?.last_quote?.ask_size);
  const trade = Number(item?.last_trade?.price);
  const dayClose = Number(item?.day?.close);
  const hasBid = Number.isFinite(bid) && bid > 0;
  const hasAsk = Number.isFinite(ask) && ask > 0;
  const hasRealBidAsk = hasBid && hasAsk;
  const midpoint =
    hasRealBidAsk ? (bid + ask) / 2
    : hasBid ? bid
    : hasAsk ? ask
    : Number.isFinite(trade) && trade > 0 ? trade
    : Number.isFinite(dayClose) && dayClose > 0 ? dayClose
    : null;
  const fallbackQuotes = Number.isFinite(midpoint) && midpoint > 0 ? estimateBidAsk(midpoint) : null;

  return {
    contractSymbol:
      item?.details?.ticker ||
      `${item?.details?.underlying_ticker ?? "OPT"}-${item?.details?.expiration_date}-${strike}`,
    strike,
    expiration: item?.details?.expiration_date,
    optionType: item?.details?.contract_type ?? fallbackType,
    bid: hasBid ? bid : fallbackQuotes?.bid ?? null,
    ask: hasAsk ? ask : fallbackQuotes?.ask ?? null,
    bidSize,
    askSize,
    mark: Number.isFinite(midpoint) ? midpoint : null,
    lastPrice:
      Number.isFinite(trade) && trade > 0
        ? trade
        : Number.isFinite(midpoint)
          ? midpoint
          : null,
    impliedVolatility: Number(item?.implied_volatility ?? 0) || null,
    volume: Number(item?.day?.volume ?? 0) || null,
    openInterest: Number(item?.open_interest ?? 0) || null,
    exerciseStyle: String(item?.details?.exercise_style ?? "").trim().toLowerCase() || null,
    source: "polygon",
    sourceLabel: "Polygon.io",
    isLive: true,
    hasRealBidAsk
  };
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

async function fetchPolygonOptionChain({
  symbol,
  expiration,
  expirationFrom,
  expirationTo,
  optionType,
  strikeMin,
  strikeMax,
  limit = 80
}) {
  if (!process.env.POLYGON_API_KEY) {
    return null;
  }

  const url = new URL(`${POLYGON_OPTIONS_SNAPSHOT_URL}/${encodeURIComponent(symbol)}`);
  if (expiration) {
    url.searchParams.set("expiration_date", expiration);
  } else {
    if (expirationFrom) {
      url.searchParams.set("expiration_date.gte", expirationFrom);
    }

    if (expirationTo) {
      url.searchParams.set("expiration_date.lte", expirationTo);
    }
  }

  url.searchParams.set("contract_type", optionType);
  url.searchParams.set("limit", String(Math.max(limit, 20)));
  url.searchParams.set("sort", "strike_price");
  url.searchParams.set("order", "asc");

  if (Number.isFinite(strikeMin) && strikeMin > 0) {
    url.searchParams.set("strike_price.gte", String(strikeMin));
  }

  if (Number.isFinite(strikeMax) && strikeMax > 0) {
    url.searchParams.set("strike_price.lte", String(strikeMax));
  }

  url.searchParams.set("apiKey", process.env.POLYGON_API_KEY);

  const payload = await fetchJson(url.toString());
  const contracts = (payload?.results ?? [])
    .map((item) => normalizePolygonContract(item, optionType))
    .filter(Boolean);

  return {
    symbol,
    expiration,
    optionType,
    source: "polygon",
    sourceLabel: "Polygon.io",
    isLive: true,
    contracts
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

export async function fetchQuotes(items) {
  const stooqItems = items.filter((item) => item.provider === "stooq");
  const coingeckoItems = items.filter((item) => item.provider === "coingecko");
  const [stooqResult, coingeckoResult] = await Promise.allSettled([
    fetchStooqQuotes(stooqItems),
    fetchCoinGeckoQuotes(coingeckoItems)
  ]);

  return [
    ...(stooqResult.status === "fulfilled" ? stooqResult.value : []),
    ...(coingeckoResult.status === "fulfilled" ? coingeckoResult.value : [])
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
  try {
    const polygonResult = await fetchPolygonOptionChain({
      symbol,
      expiration,
      expirationFrom,
      expirationTo,
      optionType,
      strikeMin,
      strikeMax,
      limit
    });

    if (polygonResult?.contracts?.length) {
      return {
        ...polygonResult,
        contracts: polygonResult.contracts.map((contract) =>
          enrichContractWithFallbackQuotes(contract, currentSpot)
        )
      };
    }
  } catch (error) {
    return {
      symbol,
      expiration,
      expirationFrom,
      expirationTo,
      optionType,
      source: "modeled",
      sourceLabel: "Synthetic chain",
      isLive: false,
      warning: `Polygon option chain unavailable: ${error.message}`,
      contracts: buildSyntheticOptionChain({
        symbol,
        expiration,
        expirationFrom,
        expirationTo,
        optionType,
        currentSpot,
        strikeHint,
        limit
      })
    };
  }

  return {
    symbol,
    expiration,
    expirationFrom,
    expirationTo,
    optionType,
    source: "modeled",
    sourceLabel: "Synthetic chain",
    isLive: false,
    warning: process.env.POLYGON_API_KEY
      ? expirationFrom || expirationTo
        ? "No live contracts returned for this search window."
        : "No live contracts returned for this expiry."
      : "POLYGON_API_KEY not configured.",
    contracts: buildSyntheticOptionChain({
      symbol,
      expiration,
      expirationFrom,
      expirationTo,
      optionType,
      currentSpot,
      strikeHint,
      limit
    })
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
