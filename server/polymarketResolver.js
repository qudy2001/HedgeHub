import {
  canonicalPolymarketEventUrl,
  fetchPolymarketEventBySlug,
  isTradablePolymarketMarket,
  searchPolymarketMarkets
} from "./providers/polymarket.js";

// Resolves the *current* Polymarket monthly "hit" event for a tracked asset, so nobody has to paste a
// new event URL every month. Slugs follow what-price-will-<key>-hit-in-<month>-<year>.

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];
const DAY_MS = 86_400_000;
const OK_TTL_MS = 10 * 60_000;
const EMPTY_TTL_MS = 2 * 60_000;
const MIN_LEAD_DAYS = 1;

// Built-in assets whose Polymarket slug key is not just their lowercase ticker.
const SLUG_KEY_BY_ASSET_ID = {
  btc: "bitcoin",
  eth: "ethereum",
  gold: "xauusd",
  oil: "wti",
  "stocks-spy": "spy"
};
const SLUG_KEY_BY_SYMBOL = {
  "BTC-USD": "bitcoin",
  BTC: "bitcoin",
  IBIT: "bitcoin",
  "ETH-USD": "ethereum",
  ETH: "ethereum",
  ETHA: "ethereum",
  "SOL-USD": "solana",
  "XAU-USD": "xauusd",
  GLD: "xauusd",
  "XAG-USD": "xagusd",
  SLV: "xagusd",
  "WTI-USD": "wti",
  USO: "wti"
};
// Index products without a monthly Polymarket "hit" event (their auto-resolve would only find stale or unrelated events).
const NO_MONTHLY_EVENT_SYMBOLS = new Set(["SPX", "SPX-INDEX", "XSP", "VOO", "^SPX", "^GSPC"]);

export function derivePolymarketSlugKey(asset = {}) {
  const explicit = String(asset.polymarketSlugKey ?? "").trim().toLowerCase();
  if (/^[a-z0-9-]+$/.test(explicit)) {
    return explicit;
  }

  const byId = SLUG_KEY_BY_ASSET_ID[String(asset.id ?? "").replace(/-v2$/, "")];
  if (byId) {
    return byId;
  }

  const symbols = [asset.referenceSymbol, asset.underlyingSymbol, asset.optionSymbol]
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter(Boolean);
  for (const symbol of symbols) {
    if (SLUG_KEY_BY_SYMBOL[symbol]) {
      return SLUG_KEY_BY_SYMBOL[symbol];
    }
  }

  if (symbols.some((symbol) => NO_MONTHLY_EVENT_SYMBOLS.has(symbol))) {
    return "";
  }

  // Single stocks and ETFs use their lowercase ticker (tsla, nvda, spy...).
  const ticker = String(asset.underlyingSymbol || asset.optionSymbol || "").trim().toUpperCase();
  return /^[A-Z]{1,5}$/.test(ticker) ? ticker.toLowerCase() : "";
}

// Candidate monthly-hit slugs: last month (a crypto event stays live until 04:00Z on the 1st), this month and the next two.
export function monthlyHitSlugs(slugKey, now = new Date(), months = 4) {
  const slugs = [];
  for (let offset = -1; offset < months - 1; offset += 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    slugs.push(`what-price-will-${slugKey}-hit-in-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`);
  }
  return slugs;
}

// `now` decides which markets still count as tradable, so a caller that resolves events for a given moment gets
// counts for that same moment.
function summarizeEvent(event, now = new Date()) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const open = markets.filter((market) => market.closed !== true && market.active !== false);
  const tradable = open.filter((market) => {
    let yesPrice = null;
    try {
      const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : JSON.parse(market.outcomePrices ?? "[]");
      yesPrice = Number(prices[0]);
    } catch {
      yesPrice = null;
    }
    return isTradablePolymarketMarket({
      active: true,
      closed: false,
      endDate: market.endDate ?? event.endDate,
      yesPrice,
      noPrice: Number.isFinite(yesPrice) ? 1 - yesPrice : null
    }, now);
  });

  return {
    slug: event.slug,
    url: canonicalPolymarketEventUrl(`https://polymarket.com/event/${event.slug}`),
    title: event.title ?? event.slug,
    endDate: event.endDate ?? null,
    marketCount: markets.length,
    openMarketCount: open.length,
    tradableCount: tradable.length,
    liquidity: Number(event.liquidity ?? 0) || 0,
    volume: Number(event.volume ?? 0) || 0
  };
}

// An event is open until it actually ends. Crypto monthlies are only created AFTER the previous one
// ends, so an ending event must stay in use until it ends when no successor exists yet.
export function isOpenEvent(event, now = new Date()) {
  if (!event || event.closed === true || event.active === false) {
    return false;
  }

  const end = Date.parse(event.endDate ?? "");
  return Number.isFinite(end) && end > now.getTime();
}

// Picks the open monthly events to use: the current one, plus the next month's once it exists.
// Pure and injectable so it can be tested against recorded events.
export async function resolveMonthlyHitEvents(slugKey, { now = new Date(), fetchEvent = fetchPolymarketEventBySlug, search = null, limit = 2, minLeadDays = MIN_LEAD_DAYS } = {}) {
  const errors = [];
  const found = new Map();
  const failedSlugs = [];

  const slugs = monthlyHitSlugs(slugKey, now);
  const results = await Promise.allSettled(slugs.map((slug) => fetchEvent(slug)));
  results.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      found.set(result.value.slug, result.value);
    } else if (result.status === "rejected") {
      failedSlugs.push(slugs[index]);
      errors.push(result.reason?.message ?? String(result.reason));
    }
  });

  // Slug drift fallback: text search for monthly hit events of the same key.
  if (![...found.values()].some((event) => isOpenEvent(event, now)) && search) {
    try {
      const pattern = new RegExp(`^what-price-will-${slugKey}-hit-in-`);
      for (const market of await search(`what price will ${slugKey} hit`)) {
        const slug = String(market.url ?? "").replace("https://polymarket.com/event/", "");
        if (pattern.test(slug) && !found.has(slug)) {
          const event = await fetchEvent(slug);
          if (event) {
            found.set(event.slug, event);
          }
        }
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  const open = [...found.values()]
    .filter((event) => isOpenEvent(event, now))
    .sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));
  // Skip an event that is about to end only when a later one already exists.
  const events = open
    .filter((event, index) => index === open.length - 1 || Date.parse(event.endDate) > now.getTime() + minLeadDays * DAY_MS)
    .slice(0, limit)
    .map((event) => summarizeEvent(event, now));

  return { events, errors, failedSlugs };
}

const cache = new Map();

export async function resolveAssetPolymarketEvents(asset, options = {}) {
  const slugKey = derivePolymarketSlugKey(asset);
  if (!slugKey) {
    return {
      slugKey: "",
      events: [],
      checkedAt: new Date().toISOString(),
      reason: "No Polymarket monthly event exists for this asset; paste an event URL to track a specific market."
    };
  }

  const now = options.now ?? new Date();
  const cached = cache.get(slugKey);
  if (!options.force && cached && Date.now() - cached.at < cached.ttl) {
    return cached.value;
  }

  const stillOpen = (events) => (events ?? []).filter((event) => isOpenEvent({ endDate: event.endDate }, now));
  let value;
  let degraded = false;
  try {
    const { events, errors, failedSlugs } = await resolveMonthlyHitEvents(slugKey, {
      now,
      search: (query) => searchPolymarketMarkets(query, 20),
      ...options.deps
    });
    // A lookup that threw must not silently drop an event we already knew about.
    const carried = stillOpen(cached?.value?.events).filter(
      (event) => failedSlugs.includes(event.slug) && !events.some((known) => known.slug === event.slug)
    );
    const merged = [...events, ...carried].sort((left, right) => Date.parse(left.endDate) - Date.parse(right.endDate));
    degraded = errors.length > 0;
    value = {
      slugKey,
      events: merged,
      checkedAt: new Date().toISOString(),
      stale: carried.length > 0,
      reason: merged.length
        ? degraded
          ? `Some lookups failed (${errors[0]}); showing the events that loaded.`
          : null
        : errors.length
          ? `Polymarket lookup failed: ${errors[0]}`
          : `No open Polymarket monthly event found for "${slugKey}" (next month's event is created around the start of the month for crypto, the 25th for stocks and commodities).`
    };
  } catch (error) {
    degraded = true;
    value = { slugKey, events: [], checkedAt: new Date().toISOString(), reason: `Polymarket lookup failed: ${error.message}` };
  }

  // A failed or empty lookup must not erase a previously good answer.
  if (!value.events.length && stillOpen(cached?.value?.events).length) {
    value = { ...cached.value, stale: true, reason: value.reason };
    degraded = true;
  }

  cache.set(slugKey, { at: Date.now(), ttl: degraded || !value.events.length ? EMPTY_TTL_MS : OK_TTL_MS, value });
  return value;
}

export function peekAssetPolymarketEvents(asset) {
  const slugKey = derivePolymarketSlugKey(asset);
  return slugKey ? (cache.get(slugKey)?.value ?? null) : null;
}

export function resetPolymarketResolverCache() {
  cache.clear();
  overrideCache.clear();
}

const overrideCache = new Map();

// A pasted override is only honoured while its event is still open; otherwise automatic resolution takes over.
export async function checkOverrideEvent(url, { now = new Date(), fetchEvent = fetchPolymarketEventBySlug, force = false } = {}) {
  const canonical = canonicalPolymarketEventUrl(url);
  if (!canonical) {
    return null;
  }

  const cached = overrideCache.get(canonical);
  if (!force && cached && Date.now() - cached.at < OK_TTL_MS) {
    return cached.value;
  }

  const slug = canonical.replace("https://polymarket.com/event/", "");
  let value;
  try {
    const event = await fetchEvent(slug);
    if (!event) {
      value = { url: canonical, slug, expired: true, reason: "This event no longer exists on Polymarket." };
    } else if (!isOpenEvent(event, now)) {
      value = { url: canonical, slug, expired: true, title: event.title, endDate: event.endDate, reason: `"${event.title ?? slug}" has ended.` };
    } else {
      value = { url: canonical, slug, expired: false, ...summarizeEvent(event, now) };
    }
  } catch (error) {
    // A transient failure must not discard the user's choice.
    value = { url: canonical, slug, expired: false, unverified: true, reason: `Could not verify the override: ${error.message}` };
  }

  overrideCache.set(canonical, { at: Date.now(), value });
  return value;
}

export function peekOverrideEvent(url) {
  return overrideCache.get(canonicalPolymarketEventUrl(url))?.value ?? null;
}

function overrideIsActive(asset) {
  const override = canonicalPolymarketEventUrl(asset?.polymarketEventUrl);
  return Boolean(override) && peekOverrideEvent(override)?.expired !== true;
}

// Resolves every distinct slug key once per call (several assets can share one).
export async function refreshPolymarketResolutions(assets = [], options = {}) {
  const byKey = new Map();
  await Promise.allSettled(
    assets.map((asset) => checkOverrideEvent(asset?.polymarketEventUrl, options))
  );
  for (const asset of assets) {
    if (overrideIsActive(asset)) {
      continue;
    }
    const key = derivePolymarketSlugKey(asset);
    if (key && !byKey.has(key)) {
      byKey.set(key, asset);
    }
  }

  await Promise.allSettled([...byKey.values()].map((asset) => resolveAssetPolymarketEvents(asset, options)));
}

// Adds the event URLs that matching and fetching should use: a live manual override wins, else the auto-resolved events.
export function withResolvedPolymarketEvents(asset) {
  const override = canonicalPolymarketEventUrl(asset?.polymarketEventUrl);
  if (override && overrideIsActive(asset)) {
    return { ...asset, polymarketEventUrl: override, polymarketEventUrls: [override], polymarketEventMode: "override" };
  }

  const resolution = peekAssetPolymarketEvents(asset);
  const urls = (resolution?.events ?? []).map((event) => event.url).filter(Boolean);
  return {
    ...asset,
    polymarketEventUrl: "",
    polymarketEventUrls: urls,
    polymarketEventMode: urls.length ? "auto" : "none"
  };
}

export function describeAssetPolymarketStatus(asset) {
  const override = canonicalPolymarketEventUrl(asset?.polymarketEventUrl);
  const overrideState = override ? peekOverrideEvent(override) : null;
  const slug = override.replace("https://polymarket.com/event/", "");
  if (override && overrideState?.expired !== true) {
    return {
      mode: "override",
      slugKey: "",
      events: [{ ...(overrideState && !overrideState.unverified ? overrideState : {}), url: override, slug }],
      reason: overrideState?.unverified ? overrideState.reason : null,
      checkedAt: null
    };
  }

  const resolution = peekAssetPolymarketEvents(asset);
  const slugKey = derivePolymarketSlugKey(asset);
  const expiredNote = override ? `Your pasted event ${overrideState?.reason ?? "has ended"} Using automatic resolution instead; clear the Event URL field to remove this note.` : null;
  if (!slugKey) {
    return {
      mode: "none",
      slugKey: "",
      events: [],
      reason: [expiredNote, "No Polymarket monthly event exists for this asset; paste an event URL to track a specific market."].filter(Boolean).join(" "),
      checkedAt: null
    };
  }

  return {
    mode: resolution?.events?.length ? "auto" : "none",
    slugKey,
    events: resolution?.events ?? [],
    reason: [expiredNote, resolution ? resolution.reason : "Waiting for the first Polymarket refresh."].filter(Boolean).join(" ") || null,
    stale: resolution?.stale === true,
    checkedAt: resolution?.checkedAt ?? null
  };
}
