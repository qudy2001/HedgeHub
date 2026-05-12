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
  const dayOpen = Number(item?.day?.open);
  const dayClose = Number(item?.day?.close);
  const volume = Number(item?.day?.volume);
  const openInterest = Number(item?.open_interest);
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
    dayOpen: Number.isFinite(dayOpen) && dayOpen > 0 ? dayOpen : null,
    dayClose: Number.isFinite(dayClose) && dayClose > 0 ? dayClose : null,
    impliedVolatility: Number(item?.implied_volatility ?? 0) || null,
    volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    openInterest: Number.isFinite(openInterest) && openInterest >= 0 ? openInterest : null,
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

async function fetchPolygonOptionChain({
  symbol,
  expiration,
  expirationFrom,
  expirationTo,
  optionType,
  strikeMin,
  strikeMax,
  limit = 80,
  order = "asc"
}) {
  if (!process.env.POLYGON_API_KEY) {
    return null;
  }

  const POLYGON_PAGE_LIMIT = 250;
  const POLYGON_MAX_CONTRACTS = 2000;

  const normalizedOrder = String(order ?? "")
    .trim()
    .toLowerCase() === "desc"
    ? "desc"
    : "asc";

  const normalizedLimit = Number(limit ?? 80);
  const unlimitedRequested = Number.isFinite(normalizedLimit) && normalizedLimit <= 0;
  const desiredLimit = unlimitedRequested
    ? POLYGON_MAX_CONTRACTS
    : Math.min(Math.max(Number.isFinite(normalizedLimit) ? normalizedLimit : 80, 20), POLYGON_MAX_CONTRACTS);
  const pageLimit = Math.min(Math.max(desiredLimit, 20), POLYGON_PAGE_LIMIT);

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
  url.searchParams.set("limit", String(pageLimit));
  url.searchParams.set("sort", "strike_price");
  url.searchParams.set("order", normalizedOrder);

  if (Number.isFinite(strikeMin) && strikeMin > 0) {
    url.searchParams.set("strike_price.gte", String(strikeMin));
  }

  if (Number.isFinite(strikeMax) && strikeMax > 0) {
    url.searchParams.set("strike_price.lte", String(strikeMax));
  }

  url.searchParams.set("apiKey", process.env.POLYGON_API_KEY);

  const results = [];
  let nextUrl = url;
  let truncated = false;

  while (nextUrl) {
    const payload = await fetchJson(nextUrl.toString());
    results.push(...(payload?.results ?? []));

    if (results.length >= desiredLimit) {
      truncated = Boolean(payload?.next_url);
      break;
    }

    if (!payload?.next_url) {
      break;
    }

    try {
      nextUrl = new URL(payload.next_url);
    } catch (_error) {
      nextUrl = null;
    }

    if (nextUrl) {
      nextUrl.searchParams.set("apiKey", process.env.POLYGON_API_KEY);
    }
  }

  const contracts = results
    .slice(0, desiredLimit)
    .map((item) => normalizePolygonContract(item, optionType))
    .filter(Boolean);

  return {
    symbol,
    expiration,
    optionType,
    source: "polygon",
    sourceLabel: "Polygon.io",
    isLive: true,
    ...(truncated ? { warning: `Polygon chain truncated at ${desiredLimit} contracts.` } : {}),
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
  const normalizedStrikeHint = Number(strikeHint ?? 0);
  const resolvedStrikeHint =
    Number.isFinite(normalizedStrikeHint) && normalizedStrikeHint > 0 ? normalizedStrikeHint : Number(currentSpot ?? 0);

  const normalizedLimit = Number(limit ?? 60);
  const unlimitedRequested = Number.isFinite(normalizedLimit) && normalizedLimit <= 0;
  const resolvedLimit = Number.isFinite(normalizedLimit) ? normalizedLimit : 60;
  const shouldWindowAroundStrike =
    !unlimitedRequested &&
    expiration &&
    Number.isFinite(resolvedStrikeHint) &&
    resolvedStrikeHint > 0 &&
    !(Number.isFinite(strikeMin) && strikeMin > 0) &&
    !(Number.isFinite(strikeMax) && strikeMax > 0);

  const selectContractsNearStrike = (contracts, maxCount = resolvedLimit, anchor = resolvedStrikeHint) => {
    const resolvedContracts = [...(contracts ?? [])].filter((contract) => contract && Number.isFinite(contract.strike));

    if (!Number.isFinite(maxCount) || maxCount <= 0 || resolvedContracts.length <= maxCount) {
      return resolvedContracts.sort((left, right) => left.strike - right.strike);
    }

    if (!Number.isFinite(anchor) || anchor <= 0) {
      return resolvedContracts.sort((left, right) => left.strike - right.strike).slice(0, maxCount);
    }

    const trimmed = [...resolvedContracts]
      .sort((left, right) => {
        const leftDistance = Math.abs(left.strike - anchor);
        const rightDistance = Math.abs(right.strike - anchor);
        return leftDistance === rightDistance ? left.strike - right.strike : leftDistance - rightDistance;
      })
      .slice(0, maxCount);

    return trimmed.sort((left, right) => left.strike - right.strike);
  };

  try {
    let polygonResult = null;

    if (shouldWindowAroundStrike) {
      const halfLimit = Math.max(Math.ceil(resolvedLimit / 2), 20);
      const [lowerResult, upperResult] = await Promise.allSettled([
        fetchPolygonOptionChain({
          symbol,
          expiration,
          expirationFrom,
          expirationTo,
          optionType,
          strikeMax: resolvedStrikeHint,
          limit: halfLimit,
          order: "desc"
        }),
        fetchPolygonOptionChain({
          symbol,
          expiration,
          expirationFrom,
          expirationTo,
          optionType,
          strikeMin: resolvedStrikeHint,
          limit: halfLimit,
          order: "asc"
        })
      ]);

      const windowContracts = [];
      const warnings = [];
      if (lowerResult.status === "fulfilled") {
        windowContracts.push(...(lowerResult.value?.contracts ?? []));
      } else if (lowerResult.reason) {
        warnings.push(`lower strikes unavailable (${lowerResult.reason.message ?? String(lowerResult.reason)})`);
      }

      if (upperResult.status === "fulfilled") {
        windowContracts.push(...(upperResult.value?.contracts ?? []));
      } else if (upperResult.reason) {
        warnings.push(`upper strikes unavailable (${upperResult.reason.message ?? String(upperResult.reason)})`);
      }

      if (windowContracts.length) {
        const contractsBySymbol = new Map();
        windowContracts.forEach((contract) => {
          if (contract?.contractSymbol) {
            contractsBySymbol.set(contract.contractSymbol, contract);
          }
        });

        polygonResult = {
          symbol,
          expiration,
          expirationFrom,
          expirationTo,
          optionType,
          source: "polygon",
          sourceLabel: "Polygon.io",
          isLive: true,
          ...(warnings.length ? { warning: `Polygon chain partially loaded: ${warnings.join(", ")}` } : {}),
          contracts: selectContractsNearStrike(Array.from(contractsBySymbol.values()))
        };
      }
    }

    if (!polygonResult) {
      polygonResult = await fetchPolygonOptionChain({
        symbol,
        expiration,
        expirationFrom,
        expirationTo,
        optionType,
        strikeMin,
        strikeMax,
        limit: resolvedLimit
      });

      if (polygonResult?.contracts?.length && shouldWindowAroundStrike) {
        polygonResult = {
          ...polygonResult,
          contracts: selectContractsNearStrike(polygonResult.contracts)
        };
      }
    }

    if (polygonResult?.contracts?.length) {
      return {
        ...polygonResult,
        contracts: polygonResult.contracts.map((contract) => enrichContractWithDerivedMetrics(contract, currentSpot))
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
      }).map((contract) => enrichContractWithDerivedMetrics(contract, currentSpot))
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
    }).map((contract) => enrichContractWithDerivedMetrics(contract, currentSpot))
  };
}

function differenceInCalendarDays(fromIso, toIso) {
  const from = new Date(`${fromIso}T00:00:00.000Z`);
  const to = new Date(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return null;
  }
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

function selectNearestAtmContract(contracts, spot) {
  const normalizedSpot = Number(spot ?? 0);
  return [...(contracts ?? [])]
    .filter((contract) => Number.isFinite(Number(contract?.strike)) && Number.isFinite(Number(contract?.impliedVolatility)))
    .sort((left, right) => {
      const leftDistance = Math.abs(Number(left.strike) - normalizedSpot);
      const rightDistance = Math.abs(Number(right.strike) - normalizedSpot);
      if (leftDistance !== rightDistance) {
        return leftDistance - rightDistance;
      }

      const leftOi = Number(left.openInterest ?? 0) || 0;
      const rightOi = Number(right.openInterest ?? 0) || 0;
      return rightOi - leftOi;
    })[0] ?? null;
}

export async function fetchPolygonAtmIv30Snapshot({ symbol, currentSpot, asOfDate = new Date().toISOString().slice(0, 10) } = {}) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  const normalizedSpot = Number(currentSpot ?? 0);
  if (!normalizedSymbol || !(normalizedSpot > 0) || !process.env.POLYGON_API_KEY) {
    return null;
  }

  const expirationFrom = new Date(`${asOfDate}T00:00:00.000Z`);
  expirationFrom.setUTCDate(expirationFrom.getUTCDate() + 20);
  const expirationTo = new Date(`${asOfDate}T00:00:00.000Z`);
  expirationTo.setUTCDate(expirationTo.getUTCDate() + 45);
  const expirationFromIso = expirationFrom.toISOString().slice(0, 10);
  const expirationToIso = expirationTo.toISOString().slice(0, 10);

  const [callsResult, putsResult] = await Promise.all([
    fetchOptionChain({
      symbol: normalizedSymbol,
      expirationFrom: expirationFromIso,
      expirationTo: expirationToIso,
      optionType: "call",
      currentSpot: normalizedSpot,
      strikeHint: normalizedSpot,
      limit: 0
    }),
    fetchOptionChain({
      symbol: normalizedSymbol,
      expirationFrom: expirationFromIso,
      expirationTo: expirationToIso,
      optionType: "put",
      currentSpot: normalizedSpot,
      strikeHint: normalizedSpot,
      limit: 0
    })
  ]);

  const callContracts = (callsResult?.contracts ?? []).filter((contract) => contract?.source === "polygon");
  const putContracts = (putsResult?.contracts ?? []).filter((contract) => contract?.source === "polygon");
  if (!callContracts.length || !putContracts.length) {
    return null;
  }

  const callsByExpiry = new Map();
  const putsByExpiry = new Map();

  callContracts.forEach((contract) => {
    const expiry = String(contract?.expiration ?? "").trim();
    if (!expiry) {
      return;
    }
    if (!callsByExpiry.has(expiry)) {
      callsByExpiry.set(expiry, []);
    }
    callsByExpiry.get(expiry).push(contract);
  });

  putContracts.forEach((contract) => {
    const expiry = String(contract?.expiration ?? "").trim();
    if (!expiry) {
      return;
    }
    if (!putsByExpiry.has(expiry)) {
      putsByExpiry.set(expiry, []);
    }
    putsByExpiry.get(expiry).push(contract);
  });

  const candidates = [...callsByExpiry.keys()]
    .filter((expiry) => putsByExpiry.has(expiry))
    .map((expiry) => {
      const callContract = selectNearestAtmContract(callsByExpiry.get(expiry), normalizedSpot);
      const putContract = selectNearestAtmContract(putsByExpiry.get(expiry), normalizedSpot);
      const dte = differenceInCalendarDays(asOfDate, expiry);
      if (!callContract || !putContract || !Number.isFinite(dte) || dte <= 0) {
        return null;
      }

      const callIv = Number(callContract.impliedVolatility ?? 0) || null;
      const putIv = Number(putContract.impliedVolatility ?? 0) || null;
      if (!(callIv > 0) || !(putIv > 0)) {
        return null;
      }

      return {
        expiry,
        dte,
        callContract,
        putContract,
        callIv,
        putIv,
        averageIv: (callIv + putIv) / 2,
        combinedDistance:
          Math.abs(Number(callContract.strike ?? normalizedSpot) - normalizedSpot) +
          Math.abs(Number(putContract.strike ?? normalizedSpot) - normalizedSpot)
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftDiff = Math.abs(left.dte - 30);
      const rightDiff = Math.abs(right.dte - 30);
      if (leftDiff !== rightDiff) {
        return leftDiff - rightDiff;
      }
      return left.combinedDistance - right.combinedDistance;
    });

  if (!candidates.length) {
    return null;
  }

  const nearCandidate =
    [...candidates].filter((candidate) => candidate.dte <= 30).sort((left, right) => right.dte - left.dte)[0] ?? null;
  const farCandidate =
    [...candidates].filter((candidate) => candidate.dte >= 30).sort((left, right) => left.dte - right.dte)[0] ?? null;
  const primaryCandidate = nearCandidate ?? farCandidate ?? candidates[0];

  let iv30 = primaryCandidate.averageIv;
  if (nearCandidate && farCandidate && nearCandidate.expiry !== farCandidate.expiry && farCandidate.dte !== nearCandidate.dte) {
    const weight = (30 - nearCandidate.dte) / (farCandidate.dte - nearCandidate.dte);
    iv30 = nearCandidate.averageIv + (farCandidate.averageIv - nearCandidate.averageIv) * weight;
  }

  const optionVolume =
    (Number(primaryCandidate.callContract.volume ?? 0) || 0) + (Number(primaryCandidate.putContract.volume ?? 0) || 0);
  const openInterest =
    (Number(primaryCandidate.callContract.openInterest ?? 0) || 0) +
    (Number(primaryCandidate.putContract.openInterest ?? 0) || 0);

  return {
    date: asOfDate,
    symbol: normalizedSymbol,
    underlyingPrice: Number(normalizedSpot.toFixed(4)),
    iv30: Number(iv30.toFixed(6)),
    atmCallIv: Number(primaryCandidate.callIv.toFixed(6)),
    atmPutIv: Number(primaryCandidate.putIv.toFixed(6)),
    nearExpiry: nearCandidate?.expiry ?? primaryCandidate.expiry,
    farExpiry: farCandidate?.expiry ?? primaryCandidate.expiry,
    nearDte: nearCandidate?.dte ?? primaryCandidate.dte,
    farDte: farCandidate?.dte ?? primaryCandidate.dte,
    optionVolume,
    openInterest
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
