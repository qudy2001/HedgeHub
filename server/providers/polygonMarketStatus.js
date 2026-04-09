const POLYGON_MARKET_STATUS_URL = "https://api.polygon.io/v1/marketstatus/now";
const POLYGON_MARKET_UPCOMING_URL = "https://api.polygon.io/v1/marketstatus/upcoming";

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
      throw new Error(`Polygon request failed with ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeStateMap(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).map(([key, state]) => [String(key ?? "").trim(), String(state ?? "").trim().toLowerCase()])
  );
}

function normalizeUpcomingEntry(entry) {
  const date = String(entry?.date ?? "").trim();
  const exchange = String(entry?.exchange ?? "").trim().toUpperCase();
  const status = String(entry?.status ?? "").trim().toLowerCase();

  if (!date || !exchange || !status) {
    return null;
  }

  return {
    date,
    exchange,
    name: String(entry?.name ?? "").trim(),
    status,
    open: entry?.open ? new Date(entry.open).toISOString() : null,
    close: entry?.close ? new Date(entry.close).toISOString() : null
  };
}

export async function fetchPolygonMarketStatusNow() {
  if (!process.env.POLYGON_API_KEY) {
    return null;
  }

  const url = new URL(POLYGON_MARKET_STATUS_URL);
  url.searchParams.set("apiKey", process.env.POLYGON_API_KEY);

  const payload = await fetchJson(url.toString());

  return {
    market: String(payload?.market ?? "").trim().toLowerCase(),
    serverTime: payload?.serverTime ? new Date(payload.serverTime).toISOString() : null,
    earlyHours: payload?.earlyHours === true,
    afterHours: payload?.afterHours === true,
    exchanges: normalizeStateMap(payload?.exchanges),
    currencies: normalizeStateMap(payload?.currencies),
    indicesGroups: normalizeStateMap(payload?.indicesGroups)
  };
}

export async function fetchPolygonUpcomingMarketClosures() {
  if (!process.env.POLYGON_API_KEY) {
    return [];
  }

  const url = new URL(POLYGON_MARKET_UPCOMING_URL);
  url.searchParams.set("apiKey", process.env.POLYGON_API_KEY);

  const payload = await fetchJson(url.toString());

  return Array.isArray(payload)
    ? payload
        .map((entry) => normalizeUpcomingEntry(entry))
        .filter(Boolean)
        .sort((left, right) => {
          return (
            left.date.localeCompare(right.date) ||
            left.exchange.localeCompare(right.exchange) ||
            left.status.localeCompare(right.status)
          );
        })
    : [];
}
