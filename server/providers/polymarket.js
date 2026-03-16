const GAMMA_BASE_URL = "https://gamma-api.polymarket.com/markets";

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
    volume: Number(rawMarket.volume ?? rawMarket.volumeClob ?? 0),
    liquidity: Number(rawMarket.liquidity ?? 0),
    endDate: rawMarket.endDate || rawMarket.end_date || rawMarket.closedTime || null,
    closed: rawMarket.closed ?? rawMarket.isClosed ?? false,
    active: rawMarket.active ?? rawMarket.isActive ?? true,
    url: overrides.url ||
      (eventSlug
      ? `https://polymarket.com/event/${eventSlug}`
      : slug
        ? `https://polymarket.com/event/${slug}`
        : "https://polymarket.com/"),
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

  if (yesPrice <= 0.001 || yesPrice >= 0.999 || noPrice <= 0.001 || noPrice >= 0.999) {
    return false;
  }

  return true;
}

function extractJsonArray(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    return null;
  }

  const arrayStart = html.indexOf("[", markerIndex + marker.length);
  if (arrayStart < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = arrayStart; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "[") {
      depth += 1;
      continue;
    }

    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(arrayStart, index + 1);
      }
    }
  }

  return null;
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

export async function searchPolymarketMarkets(query, limit = 8) {
  const params = new URLSearchParams({
    limit: String(limit),
    closed: "false",
    active: "true",
    search: query,
  });

  const url = `${GAMMA_BASE_URL}?${params.toString()}`;
  const payload = await fetchJson(url);
  const markets = Array.isArray(payload) ? payload : payload.markets ?? [];

  const minimumScore = Math.min(
    2,
    query
      .split(/\s+/)
      .map((token) => token.replace(/[^a-z0-9]/gi, ""))
      .filter(Boolean).length
  );

  return markets
    .map(normalizeMarket)
    .map((market) => ({
      ...market,
      score: scoreQuestion(query, market.question)
    }))
    .filter((market) => market.score >= minimumScore)
    .filter((market) => isTradablePolymarketMarket(market))
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return right.volume - left.volume;
    });
}

export async function fetchPolymarketMarketsFromEventPage(eventUrl) {
  if (!eventUrl?.startsWith("https://polymarket.com/event/")) {
    return [];
  }

  const html = await fetchText(eventUrl);
  const rawMarketsJson = extractJsonArray(html, "\"markets\":");

  if (!rawMarketsJson) {
    throw new Error("Event markets payload not found");
  }

  const rawMarkets = safeJsonParse(rawMarketsJson, []);
  return rawMarkets
    .map((market) =>
      normalizeMarket(
        {
          ...market,
          active: market.active ?? true
        },
        {
          url: eventUrl,
          source: "event-page"
        }
      )
    )
    .filter((market) => market.question && market.yesPrice != null)
    .filter((market) => isTradablePolymarketMarket(market));
}
