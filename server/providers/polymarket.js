const GAMMA_ORIGIN = "https://gamma-api.polymarket.com";
const GAMMA_BASE_URL = `${GAMMA_ORIGIN}/markets`;
const MIN_TRADABLE_POLY_PRICE = 0.03;
const MAX_TRADABLE_POLY_PRICE = 0.97;

// Accepts www./http/locale/query/trailing-slash variants and returns the canonical
// https://polymarket.com/event/<slug> form, or "" when the value is not an event URL.
export function canonicalPolymarketEventUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) {
    return "";
  }

  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!/^(www\.)?polymarket\.com$/i.test(url.hostname)) {
      return "";
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const eventIndex = parts.indexOf("event");
    const slug = eventIndex >= 0 ? parts[eventIndex + 1] : "";
    return /^[a-z0-9][a-z0-9-]*$/i.test(slug ?? "") ? `https://polymarket.com/event/${slug}` : "";
  } catch {
    return "";
  }
}

// Polymarket monthly events end at ~00:00 ET on the 1st (03:59:59.999Z or 04:00:00Z), so the last
// day to trade the underlying is the previous US Eastern calendar day.
export function polymarketEventDay(endDate) {
  const time = Date.parse(endDate ?? "");
  if (!Number.isFinite(time)) {
    return null;
  }

  return new Date(time - 60_000).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function getPolymarketEventSlug(value) {
  return canonicalPolymarketEventUrl(value).replace("https://polymarket.com/event/", "");
}

export function getPolymarketEventUrl(market) {
  const url = canonicalPolymarketEventUrl(market?.url);
  if (url) {
    return url;
  }

  const eventSlug = String(market?.eventSlug ?? "").trim();
  if (eventSlug) {
    return `https://polymarket.com/event/${eventSlug}`;
  }

  const marketSlug = String(market?.slug ?? "").trim();
  if (marketSlug) {
    return `https://polymarket.com/event/${marketSlug}`;
  }

  return "";
}

export function hasPublicPolymarketEvent(market) {
  return Boolean(getPolymarketEventUrl(market));
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "HedgeHub/0.1",
      },
    });

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    return response;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(url);
  return await response.json();
}

async function fetchText(url) {
  const response = await fetchWithTimeout(url);
  return await response.text();
}

function safeJsonParse(value, fallback = []) {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function finiteOrNull(value) {
  const number = Number(value);
  return value != null && value !== "" && Number.isFinite(number) ? number : null;
}

function normalizeMarket(rawMarket, overrides = {}) {
  const outcomes = safeJsonParse(rawMarket.outcomes);
  const outcomePrices = safeJsonParse(rawMarket.outcomePrices).map((value) => Number(value));
  const yesIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "yes");
  const noIndex = outcomes.findIndex((outcome) => String(outcome).toLowerCase() === "no");
  const yesPrice = yesIndex >= 0 ? outcomePrices[yesIndex] : outcomePrices[0] ?? null;
  const noPrice = noIndex >= 0 ? outcomePrices[noIndex] : outcomePrices[1] ?? null;
  const events = Array.isArray(rawMarket.events) ? rawMarket.events : safeJsonParse(rawMarket.events);
  const eventSlug = events.find((event) => typeof event?.slug === "string" && event.slug)?.slug || null;
  const slug = rawMarket.slug || rawMarket.market_slug || rawMarket.marketSlug || null;

  return {
    id: rawMarket.id || rawMarket.conditionId || rawMarket.condition_id || slug,
    slug,
    eventSlug,
    question: rawMarket.question || rawMarket.title || "Unknown market",
    yesPrice,
    noPrice,
    resolutionRules: rawMarket.description ?? null,
    resolutionSource: rawMarket.resolutionSource ?? null,
    groupItemTitle: rawMarket.groupItemTitle ?? null,
    bestBid: finiteOrNull(rawMarket.bestBid),
    bestAsk: finiteOrNull(rawMarket.bestAsk),
    spread: finiteOrNull(rawMarket.spread),
    lastTradePrice: finiteOrNull(rawMarket.lastTradePrice),
    liquidityClob: finiteOrNull(rawMarket.liquidityClob ?? rawMarket.liquidityNum),
    volume24hr: finiteOrNull(rawMarket.volume24hr),
    tickSize: finiteOrNull(rawMarket.orderPriceMinTickSize),
    minOrderSize: finiteOrNull(rawMarket.orderMinSize),
    acceptingOrders: rawMarket.acceptingOrders ?? null,
    negRisk: rawMarket.negRisk ?? null,
    feeSchedule: rawMarket.feeSchedule ?? null,
    eventTitle: overrides.eventTitle ?? null,
    seriesSlug: overrides.seriesSlug ?? null,
    tokenIds: safeJsonParse(rawMarket.clobTokenIds),
    fetchedAt: new Date().toISOString(),
    volume: Number(rawMarket.volume ?? rawMarket.volumeClob ?? 0),
    liquidity: Number(rawMarket.liquidity ?? 0),
    endDate: rawMarket.endDate || rawMarket.end_date || rawMarket.closedTime || null,
    closed: rawMarket.closed ?? rawMarket.isClosed ?? false,
    active: rawMarket.active ?? rawMarket.isActive ?? true,
    url: overrides.url || getPolymarketEventUrl({ slug, eventSlug }),
    source: overrides.source || rawMarket.source || "live"
  };
}

export function isTradablePolymarketMarket(market, now = new Date()) {
  if (!market || market.active === false || market.closed === true) {
    return false;
  }

  if (market.endDate) {
    const endDate = new Date(market.endDate);
    if (!Number.isNaN(endDate.getTime()) && endDate.getTime() <= now.getTime()) {
      return false;
    }
  }

  const yesPrice = Number(market.yesPrice);
  const noPrice = Number.isFinite(Number(market.noPrice)) ? Number(market.noPrice) : 1 - yesPrice;

  if (!Number.isFinite(yesPrice) || !Number.isFinite(noPrice)) {
    return false;
  }

  if (
    yesPrice < MIN_TRADABLE_POLY_PRICE ||
    yesPrice > MAX_TRADABLE_POLY_PRICE ||
    noPrice < MIN_TRADABLE_POLY_PRICE ||
    noPrice > MAX_TRADABLE_POLY_PRICE
  ) {
    return false;
  }

  return true;
}

function scoreQuestion(query, question) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ""))
    .filter((token) => token && !["will", "the", "by", "on"].includes(token));
  const loweredQuestion = question.toLowerCase();

  return tokens.reduce((score, token) => {
    if (loweredQuestion.includes(token)) {
      return score + (/\d/.test(token) ? 2 : 1);
    }

    return score;
  }, 0);
}

function flattenEventMarkets(event, overrides = {}) {
  const eventSlug = event?.slug ?? null;
  const eventUrl = eventSlug ? `https://polymarket.com/event/${eventSlug}` : "";
  return (Array.isArray(event?.markets) ? event.markets : []).map((market) =>
    normalizeMarket(
      {
        ...market,
        active: market.active ?? true,
        endDate: market.endDate ?? event?.endDate ?? null,
        events: [{ slug: eventSlug }]
      },
      {
        url: eventUrl,
        source: "live",
        eventTitle: event?.title ?? null,
        seriesSlug: event?.seriesSlug ?? event?.series?.[0]?.slug ?? null,
        ...overrides
      }
    )
  );
}

// Text search over live events (Gamma's /markets endpoint ignores its `search` parameter).
export async function searchPolymarketMarkets(query, limit = 8) {
  const params = new URLSearchParams({
    q: query,
    events_status: "active",
    limit_per_type: String(Math.max(limit, 5)),
  });
  const payload = await fetchJson(`${GAMMA_ORIGIN}/public-search?${params.toString()}`);
  const markets = (Array.isArray(payload?.events) ? payload.events : []).flatMap((event) =>
    flattenEventMarkets(event, { source: "live" })
  );

  const minimumScore = Math.min(
    2,
    query
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9]/gi, ""))
      .filter(Boolean).length
  );

  return markets
    .map((market) => ({
      ...market,
      score: scoreQuestion(query, `${market.eventTitle ?? ""} ${market.question}`)
    }))
    .filter((market) => market.score >= minimumScore)
    .filter((market) => isTradablePolymarketMarket(market))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.volume - left.volume;
    })
    .slice(0, limit);
}

// Fetches one event (with all its markets) from the Gamma JSON API; null when it does not exist.
export async function fetchPolymarketEventBySlug(slug) {
  const normalizedSlug = String(slug ?? "").trim();
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(normalizedSlug)) {
    return null;
  }

  const payload = await fetchJson(`${GAMMA_ORIGIN}/events?slug=${encodeURIComponent(normalizedSlug)}`);
  return (Array.isArray(payload) ? payload : []).find((event) => event?.slug === normalizedSlug) ?? null;
}

export async function fetchPolymarketMarketsFromEventPage(eventUrl, options = {}) {
  const { tradableOnly = true } = options;
  const canonicalUrl = canonicalPolymarketEventUrl(eventUrl);

  if (!canonicalUrl) {
    return [];
  }

  const slug = getPolymarketEventSlug(canonicalUrl);
  const event = await fetchPolymarketEventBySlug(slug);
  if (!event) {
    throw new Error(`Polymarket event not found: ${slug}`);
  }

  // Markets that resolved early inside a still-open event stay available for valuing existing positions.
  const normalizedMarkets = flattenEventMarkets(event, { source: "event-page" }).filter(
    (market) => market.question && market.yesPrice != null
  );

  return tradableOnly
    ? normalizedMarkets.filter((market) => isTradablePolymarketMarket(market))
    : normalizedMarkets;
}
