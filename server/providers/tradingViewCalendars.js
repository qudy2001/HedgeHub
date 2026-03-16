const ECONOMIC_CALENDAR_URL = "https://economic-calendar.tradingview.com/events";
const EARNINGS_CALENDAR_URL = "https://scanner.tradingview.com/america/scan?label-product=MarketEarnings";

const TRADINGVIEW_HEADERS = {
  accept: "application/json, text/plain, */*",
  origin: "https://www.tradingview.com",
  referer: "https://www.tradingview.com/",
  "user-agent": "HedgeHub/0.1"
};

const COMPANY_EVENT_COLUMNS = [
  "earnings_release_next_date",
  "earnings_release_date",
  "logoid",
  "name",
  "description",
  "earnings_per_share_fq",
  "earnings_per_share_forecast_next_fq",
  "eps_surprise_fq",
  "eps_surprise_percent_fq",
  "revenue_fq",
  "revenue_forecast_next_fq",
  "market_cap_basic",
  "earnings_release_time",
  "earnings_release_next_time",
  "earnings_per_share_forecast_fq",
  "revenue_forecast_fq",
  "fundamental_currency_code",
  "market",
  "earnings_publication_type_fq",
  "earnings_publication_type_next_fq",
  "revenue_surprise_fq",
  "revenue_surprise_percent_fq",
  "typespecs",
  "type",
  "exchange"
];

const ALLOWED_US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX"]);
const ALLOWED_COMPANY_TYPES = new Set(["stock", "dr"]);

async function fetchTradingViewJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...TRADINGVIEW_HEADERS,
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

function formatDateParam(value) {
  return value.toISOString().slice(0, 10);
}

function normalizeEconomicEvent(event) {
  return {
    id: String(event.id ?? ""),
    title: event.title ?? event.indicator ?? "Untitled event",
    indicator: event.indicator ?? event.title ?? "",
    country: event.country ?? "",
    category: event.category ?? "",
    period: event.period ?? "",
    source: event.source ?? "",
    sourceUrl: event.source_url ?? "",
    currency: event.currency ?? "",
    unit: event.unit ?? "",
    importance: Number(event.importance ?? -1),
    date: event.date ?? null,
    actual: event.actual ?? null,
    previous: event.previous ?? null,
    forecast: event.forecast ?? null,
    actualRaw: event.actualRaw ?? null,
    previousRaw: event.previousRaw ?? null,
    forecastRaw: event.forecastRaw ?? null,
    comment: event.comment ?? ""
  };
}

function isExactPublicationTime(publicationType) {
  return publicationType != null && publicationType % 10 !== 3 && publicationType % 10 !== 0;
}

function getReleaseSessionLabel(timeCode, publicationType) {
  if (!isExactPublicationTime(publicationType)) {
    return "Time TBA";
  }

  if (timeCode === 0) {
    return "Pre-market";
  }

  if (timeCode === 1) {
    return "Post-market";
  }

  if (timeCode === 2) {
    return "Market hours";
  }

  return "Scheduled";
}

function normalizeCompanyEventRow(row, rangeStartMs, rangeEndMs) {
  const values = row?.d ?? [];
  const quote = {
    symbol: row?.s ?? "",
    shortSymbol: String(row?.s ?? "").split(":")[1] ?? "",
    earningsReleaseNextDate: values[0] ?? null,
    earningsReleaseDate: values[1] ?? null,
    logoid: values[2] ?? null,
    name: values[3] ?? null,
    description: values[4] ?? null,
    earningsPerShareActual: values[5] ?? null,
    earningsPerShareEstimateNext: values[6] ?? null,
    earningsPerShareSurprise: values[7] ?? null,
    earningsPerShareSurprisePercent: values[8] ?? null,
    revenueActual: values[9] ?? null,
    revenueEstimateNext: values[10] ?? null,
    marketCapUsd: values[11] ?? null,
    earningsReleaseTime: values[12] ?? null,
    earningsReleaseNextTime: values[13] ?? null,
    earningsPerShareEstimateRecent: values[14] ?? null,
    revenueEstimateRecent: values[15] ?? null,
    currency: values[16] ?? "USD",
    market: values[17] ?? "",
    earningsPublicationType: values[18] ?? null,
    earningsPublicationTypeNext: values[19] ?? null,
    revenueSurprise: values[20] ?? null,
    revenueSurprisePercent: values[21] ?? null,
    typeSpecs: values[22] ?? [],
    type: values[23] ?? "",
    exchange: values[24] ?? ""
  };

  const recentReleaseMs = quote.earningsReleaseDate ? Number(quote.earningsReleaseDate) * 1000 : null;
  const nextReleaseMs = quote.earningsReleaseNextDate ? Number(quote.earningsReleaseNextDate) * 1000 : null;
  const isRecentRelease =
    recentReleaseMs != null && recentReleaseMs >= rangeStartMs && recentReleaseMs <= rangeEndMs;
  const timestamp = isRecentRelease ? recentReleaseMs : nextReleaseMs;
  const publicationType = isRecentRelease ? quote.earningsPublicationType : quote.earningsPublicationTypeNext;
  const releaseTimeCode = isRecentRelease ? quote.earningsReleaseTime : quote.earningsReleaseNextTime;

  if (!timestamp) {
    return null;
  }

  return {
    symbol: quote.symbol,
    shortSymbol: quote.shortSymbol,
    logoid: quote.logoid,
    name: quote.name ?? quote.description ?? quote.shortSymbol,
    description: quote.description ?? quote.name ?? quote.shortSymbol,
    exchange: quote.exchange,
    market: quote.market,
    type: quote.type,
    typeSpecs: Array.isArray(quote.typeSpecs) ? quote.typeSpecs : [],
    currency: quote.currency || "USD",
    marketCapUsd: Number(quote.marketCapUsd ?? 0) || 0,
    earningsEstimate: isRecentRelease
      ? quote.earningsPerShareEstimateRecent
      : quote.earningsPerShareEstimateNext,
    earningsActual: isRecentRelease ? quote.earningsPerShareActual : null,
    earningsSurprisePercent: isRecentRelease ? quote.earningsPerShareSurprisePercent : null,
    revenueEstimate: isRecentRelease ? quote.revenueEstimateRecent : quote.revenueEstimateNext,
    revenueActual: isRecentRelease ? quote.revenueActual : null,
    revenueSurprisePercent: isRecentRelease ? quote.revenueSurprisePercent : null,
    timestamp,
    isRecentRelease,
    isExactTime: isExactPublicationTime(publicationType),
    releaseSession: getReleaseSessionLabel(releaseTimeCode, publicationType)
  };
}

function companyDeduplicationKey(event) {
  const baseKey = event.logoid || event.description || event.shortSymbol || event.symbol;
  return `${baseKey}`.trim().toLowerCase();
}

function compareCompanyEventPreference(left, right) {
  const exchangeScore = (event) => {
    if (event.exchange === "NASDAQ") {
      return 3;
    }
    if (event.exchange === "NYSE") {
      return 2;
    }
    if (event.exchange === "AMEX") {
      return 1;
    }
    return 0;
  };

  const typeScore = (event) => (event.type === "stock" ? 2 : event.type === "dr" ? 1 : 0);

  const scoreDifference =
    exchangeScore(right) - exchangeScore(left) ||
    typeScore(right) - typeScore(left) ||
    right.marketCapUsd - left.marketCapUsd;

  return scoreDifference;
}

function deduplicateCompanyEvents(events) {
  const preferred = new Map();

  for (const event of events) {
    const key = `${companyDeduplicationKey(event)}|${new Date(event.timestamp).toISOString().slice(0, 10)}`;
    const current = preferred.get(key);

    if (!current || compareCompanyEventPreference(current, event) > 0) {
      preferred.set(key, event);
    }
  }

  return [...preferred.values()];
}

export async function fetchEconomicCalendar({ from, to, importance = 1 }) {
  const url = new URL(ECONOMIC_CALENDAR_URL);
  url.searchParams.set("from", formatDateParam(from));
  url.searchParams.set("to", formatDateParam(to));

  const payload = await fetchTradingViewJson(url.toString(), {
    headers: {
      referer: "https://www.tradingview.com/economic-calendar/"
    }
  });

  if (payload?.status !== "ok" || !Array.isArray(payload?.result)) {
    throw new Error("TradingView economic calendar returned an unexpected payload");
  }

  return payload.result
    .map(normalizeEconomicEvent)
    .filter((event) => event.importance === importance)
    .sort((left, right) => new Date(left.date).getTime() - new Date(right.date).getTime());
}

export async function fetchCompanyEventsCalendar({
  from,
  to,
  minMarketCapUsd = 30_000_000_000
}) {
  const rangeStartMs = from.getTime();
  const rangeEndMs = to.getTime();
  const payload = {
    columns: COMPANY_EVENT_COLUMNS,
    filter: [
      {
        left: "earnings_release_date,earnings_release_next_date",
        operation: "in_range",
        right: [Math.floor(rangeStartMs / 1000), Math.floor(rangeEndMs / 1000)]
      },
      {
        left: "market_cap_basic",
        operation: "greater",
        right: minMarketCapUsd
      }
    ],
    sort: {
      sortBy: "market_cap_basic",
      sortOrder: "desc"
    },
    range: [0, 2000]
  };

  const response = await fetchTradingViewJson(EARNINGS_CALENDAR_URL, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: {
      "content-type": "application/json",
      referer: "https://www.tradingview.com/earnings-calendar/?countries=us"
    }
  });

  if (!Array.isArray(response?.data)) {
    throw new Error("TradingView company events returned an unexpected payload");
  }

  return deduplicateCompanyEvents(
    response.data
      .map((row) => normalizeCompanyEventRow(row, rangeStartMs, rangeEndMs))
      .filter(Boolean)
      .filter((event) => ALLOWED_US_EXCHANGES.has(event.exchange))
      .filter((event) => ALLOWED_COMPANY_TYPES.has(event.type))
      .sort((left, right) => left.timestamp - right.timestamp || right.marketCapUsd - left.marketCapUsd)
  );
}
