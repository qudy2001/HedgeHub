import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalPolymarketEventUrl,
  fetchPolymarketMarketsFromEventPage
} from "../server/providers/polymarket.js";
import {
  derivePolymarketSlugKey,
  monthlyHitSlugs,
  resolveMonthlyHitEvents,
  refreshPolymarketResolutions,
  resolveAssetPolymarketEvents,
  resetPolymarketResolverCache,
  describeAssetPolymarketStatus,
  withResolvedPolymarketEvents
} from "../server/polymarketResolver.js";
import {
  collectStrategyPolymarketEventUrls,
  collectStrategyPolymarketQueries,
  strategyAssetMatchesMarket
} from "../server/strategyAssets.js";
import { parsePolymarketQuestionSignal } from "../shared/polymarketSignals.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const event = (slug, endDate, extra = {}) => ({
  slug,
  title: slug,
  endDate,
  closed: false,
  active: true,
  markets: [
    { question: "Will X hit (HIGH) $10?", outcomePrices: '["0.4","0.6"]', endDate },
    { question: "Will X hit (HIGH) $20?", outcomePrices: '["0.001","0.999"]', endDate },
    { question: "Will X hit (HIGH) $5?", outcomePrices: '["1","0"]', closed: true, endDate }
  ],
  ...extra
});

test("event URLs are canonicalised and non-event URLs are rejected", () => {
  const canon = "https://polymarket.com/event/what-price-will-tsla-hit-in-october-2026";
  for (const input of [
    canon,
    `${canon}/`,
    `${canon}?tid=123`,
    "http://www.polymarket.com/event/what-price-will-tsla-hit-in-october-2026",
    "polymarket.com/event/what-price-will-tsla-hit-in-october-2026",
    "https://polymarket.com/es/event/what-price-will-tsla-hit-in-october-2026#top"
  ]) {
    assert.equal(canonicalPolymarketEventUrl(input), canon, input);
  }
  for (const bad of ["", "https://evil.com/event/x", "https://polymarket.com/markets/x", "https://polymarket.com/event/", "not a url", null]) {
    assert.equal(canonicalPolymarketEventUrl(bad), "", String(bad));
  }
});

test("monthly slugs roll over the year boundary", () => {
  assert.deepEqual(monthlyHitSlugs("tsla", new Date("2026-11-20T00:00:00Z")), [
    "what-price-will-tsla-hit-in-october-2026",
    "what-price-will-tsla-hit-in-november-2026",
    "what-price-will-tsla-hit-in-december-2026",
    "what-price-will-tsla-hit-in-january-2027"
  ]);
});

test("slug keys derive from built-in ids, reference symbols and plain tickers", () => {
  assert.equal(derivePolymarketSlugKey({ id: "btc", optionSymbol: "IBIT", underlyingSymbol: "BTC-USD" }), "bitcoin");
  assert.equal(derivePolymarketSlugKey({ id: "btc-v2", optionSymbol: "IBIT" }), "bitcoin");
  assert.equal(derivePolymarketSlugKey({ id: "eth", optionSymbol: "ETHA" }), "ethereum");
  assert.equal(derivePolymarketSlugKey({ id: "gold", optionSymbol: "GLD" }), "xauusd");
  assert.equal(derivePolymarketSlugKey({ id: "oil", optionSymbol: "USO" }), "wti");
  assert.equal(derivePolymarketSlugKey({ id: "stocks-spy", optionSymbol: "SPY", underlyingSymbol: "SPY" }), "spy");
  assert.equal(derivePolymarketSlugKey({ id: "tsla", optionSymbol: "TSLA", underlyingSymbol: "TSLA" }), "tsla");
  assert.equal(derivePolymarketSlugKey({ id: "x", optionSymbol: "NVDA", polymarketSlugKey: "Nvidia-Corp" }), "nvidia-corp");
  // Index products have no monthly hit event, so they must not auto-resolve to something unrelated.
  for (const asset of [
    { id: "stocks-spx", optionSymbol: "SPX", underlyingSymbol: "SPX" },
    { id: "stocks-xsp-v2", optionSymbol: "XSP", underlyingSymbol: "SPX" },
    { id: "stocks", optionSymbol: "VOO", underlyingSymbol: "VOO", referenceSymbol: "SPX-INDEX" }
  ]) {
    assert.equal(derivePolymarketSlugKey(asset), "", asset.id);
  }
  assert.equal(derivePolymarketSlugKey({ id: "weird", optionSymbol: "BRK.B" }), "");
});

test("current month's event is used, and next month's is added once it exists", async () => {
  const events = {
    "what-price-will-tsla-hit-in-october-2026": event("what-price-will-tsla-hit-in-october-2026", "2026-11-01T03:59:59Z")
  };
  const fetchEvent = async (slug) => events[slug] ?? null;
  let r = await resolveMonthlyHitEvents("tsla", { now: NOW, fetchEvent });
  assert.deepEqual(r.events.map((e) => e.slug), ["what-price-will-tsla-hit-in-october-2026"]);
  assert.equal(r.events[0].marketCount, 3);
  assert.equal(r.events[0].tradableCount, 1); // 0.001 is outside the tradable band, closed one is excluded

  events["what-price-will-tsla-hit-in-november-2026"] = event("what-price-will-tsla-hit-in-november-2026", "2026-12-01T04:59:59Z");
  r = await resolveMonthlyHitEvents("tsla", { now: NOW, fetchEvent });
  assert.deepEqual(r.events.map((e) => e.slug), [
    "what-price-will-tsla-hit-in-october-2026",
    "what-price-will-tsla-hit-in-november-2026"
  ]);
});

test("an event that is closed or about to end is skipped in favour of the next one", async () => {
  const fetchEvent = async (slug) =>
    ({
      "what-price-will-tsla-hit-in-october-2026": event(slug, "2026-10-13T20:00:00Z"), // ends in hours
      "what-price-will-tsla-hit-in-september-2026": null,
      "what-price-will-tsla-hit-in-november-2026": event(slug, "2026-12-01T04:59:59Z"),
      "what-price-will-tsla-hit-in-december-2026": event(slug, "2027-01-01T04:59:59Z", { closed: true })
    })[slug] ?? null;
  const r = await resolveMonthlyHitEvents("tsla", { now: NOW, fetchEvent });
  assert.deepEqual(r.events.map((e) => e.slug), ["what-price-will-tsla-hit-in-november-2026"]);
});

test("an ending event stays in use until it actually ends when no successor exists yet", async () => {
  // Crypto monthlies are created only after the previous one ends (04:00Z on the 1st, new one ~05:09Z).
  const october = event("what-price-will-bitcoin-hit-in-october-2026", "2026-11-01T04:00:00Z");
  const fetchEvent = async (slug) => (slug === october.slug ? october : null);
  const at = (iso) => resolveMonthlyHitEvents("bitcoin", { now: new Date(iso), fetchEvent });
  for (const iso of ["2026-10-31T03:59:00Z", "2026-10-31T04:01:00Z", "2026-10-31T20:00:00Z", "2026-11-01T03:30:00Z"]) {
    assert.deepEqual((await at(iso)).events.map((e) => e.slug), [october.slug], iso);
  }
  assert.deepEqual((await at("2026-11-01T04:30:00Z")).events, []); // genuinely over

  const november = event("what-price-will-bitcoin-hit-in-november-2026", "2026-12-01T05:00:00Z");
  const both = await resolveMonthlyHitEvents("bitcoin", {
    now: new Date("2026-10-31T20:00:00Z"),
    fetchEvent: async (slug) => ({ [october.slug]: october, [november.slug]: november })[slug] ?? null
  });
  assert.deepEqual(both.events.map((e) => e.slug), [november.slug]); // successor exists: skip the ending one
});

test("a pasted event URL is only honoured while its event is open", async () => {
  resetPolymarketResolverCache();
  const stale = { id: "btc", optionSymbol: "IBIT", underlyingSymbol: "BTC-USD", polymarketEventUrl: "https://polymarket.com/event/what-price-will-bitcoin-hit-in-april-2026" };
  const closed = event("what-price-will-bitcoin-hit-in-april-2026", "2026-05-01T04:00:00Z", { closed: true });
  const live = event("what-price-will-bitcoin-hit-in-october-2026", "2026-11-01T04:00:00Z");
  const fetchEvent = async (slug) => ({ [closed.slug]: closed, [live.slug]: live })[slug] ?? null;
  await refreshPolymarketResolutions([stale], { now: NOW, deps: { fetchEvent, search: null }, fetchEvent });
  const resolved = withResolvedPolymarketEvents(stale);
  assert.equal(resolved.polymarketEventMode, "auto");
  assert.deepEqual(resolved.polymarketEventUrls, ["https://polymarket.com/event/what-price-will-bitcoin-hit-in-october-2026"]);
  const status = describeAssetPolymarketStatus(stale);
  assert.equal(status.mode, "auto");
  assert.match(status.reason, /has ended/);

  // A transient lookup failure must not discard a still-valid override.
  resetPolymarketResolverCache();
  const kept = { ...stale, polymarketEventUrl: "https://polymarket.com/event/my-pinned-event" };
  await refreshPolymarketResolutions([kept], {
    now: NOW,
    fetchEvent: async () => {
      throw new Error("gamma down");
    },
    deps: { fetchEvent: async () => null, search: null }
  });
  assert.equal(withResolvedPolymarketEvents(kept).polymarketEventMode, "override");
  resetPolymarketResolverCache();
});

test("one failed slug lookup keeps the events we already knew about", async () => {
  resetPolymarketResolverCache();
  const asset = { id: "tsla", optionSymbol: "TSLA", underlyingSymbol: "TSLA" };
  const oct = event("what-price-will-tsla-hit-in-october-2026", "2026-11-01T03:59:59Z");
  const nov = event("what-price-will-tsla-hit-in-november-2026", "2026-12-01T04:59:59Z");
  const both = await resolveAssetPolymarketEvents(asset, {
    now: NOW,
    deps: { fetchEvent: async (slug) => ({ [oct.slug]: oct, [nov.slug]: nov })[slug] ?? null, search: null }
  });
  assert.equal(both.events.length, 2);
  const degraded = await resolveAssetPolymarketEvents(asset, {
    now: NOW,
    force: true,
    deps: {
      fetchEvent: async (slug) => {
        if (slug === nov.slug) throw new Error("timeout");
        return slug === oct.slug ? oct : null;
      },
      search: null
    }
  });
  assert.deepEqual(degraded.events.map((e) => e.slug), [oct.slug, nov.slug]);
  assert.equal(degraded.stale, true);
  resetPolymarketResolverCache();
});

test("lookup failures are reported instead of swallowed, and search covers slug drift", async () => {
  const failing = await resolveMonthlyHitEvents("tsla", {
    now: NOW,
    fetchEvent: async () => {
      throw new Error("gamma down");
    }
  });
  assert.equal(failing.events.length, 0);
  assert.match(failing.errors[0], /gamma down/);

  const drifted = event("what-price-will-tsla-hit-in-october-2026", "2026-11-01T03:59:59Z");
  let calls = 0;
  const viaSearch = await resolveMonthlyHitEvents("tsla", {
    now: NOW,
    fetchEvent: async (slug) => (++calls > 3 && slug === drifted.slug ? drifted : null),
    search: async () => [{ url: "https://polymarket.com/event/what-price-will-tsla-hit-in-october-2026" }]
  });
  assert.deepEqual(viaSearch.events.map((e) => e.slug), [drifted.slug]);
});

test("a failed refresh keeps the last good resolution", async () => {
  resetPolymarketResolverCache();
  const asset = { id: "tsla", optionSymbol: "TSLA", underlyingSymbol: "TSLA" };
  const good = event("what-price-will-tsla-hit-in-october-2026", "2026-11-01T03:59:59Z");
  const first = await resolveAssetPolymarketEvents(asset, {
    now: NOW,
    deps: { fetchEvent: async (slug) => (slug === good.slug ? good : null), search: null }
  });
  assert.equal(first.events.length, 1);

  const second = await resolveAssetPolymarketEvents(asset, {
    now: NOW,
    force: true,
    deps: {
      fetchEvent: async () => {
        throw new Error("gamma down");
      },
      search: null
    }
  });
  assert.equal(second.events.length, 1);
  assert.equal(second.stale, true);
  assert.match(second.reason, /gamma down/);

  const status = describeAssetPolymarketStatus(asset);
  assert.equal(status.mode, "auto");
  assert.equal(withResolvedPolymarketEvents(asset).polymarketEventUrls[0], "https://polymarket.com/event/what-price-will-tsla-hit-in-october-2026");
  resetPolymarketResolverCache();
});

test("a manual override wins over auto resolution; index assets explain why they are unresolved", () => {
  resetPolymarketResolverCache();
  const overridden = withResolvedPolymarketEvents({
    id: "tsla",
    optionSymbol: "TSLA",
    polymarketEventUrl: "http://www.polymarket.com/event/my-event/?tid=9"
  });
  assert.deepEqual(overridden.polymarketEventUrls, ["https://polymarket.com/event/my-event"]);
  assert.equal(overridden.polymarketEventMode, "override");

  const spx = describeAssetPolymarketStatus({ id: "stocks-spx", optionSymbol: "SPX", underlyingSymbol: "SPX" });
  assert.equal(spx.mode, "none");
  assert.match(spx.reason, /No Polymarket monthly event/);
});

test("assets match markets by event URL set, and queries match whole words only", () => {
  const asset = {
    polymarketEventUrls: ["https://polymarket.com/event/a", "https://polymarket.com/event/b"],
    polymarketQueries: ["eth above"]
  };
  assert.equal(strategyAssetMatchesMarket(asset, { url: "https://polymarket.com/event/b/", question: "q" }), true);
  assert.equal(strategyAssetMatchesMarket(asset, { url: "https://polymarket.com/event/c", question: "ETH above" }), false);
  assert.deepEqual(collectStrategyPolymarketQueries([asset]), []);
  assert.deepEqual(collectStrategyPolymarketEventUrls([asset, { polymarketEventUrl: "https://polymarket.com/event/a?x=1" }]), [
    "https://polymarket.com/event/a",
    "https://polymarket.com/event/b"
  ]);

  const queryOnly = { polymarketQueries: ["eth above", "oil above"] };
  assert.equal(strategyAssetMatchesMarket(queryOnly, { question: "Will the Netherlands win?" }), false);
  assert.equal(strategyAssetMatchesMarket(queryOnly, { question: "Will Boilermakers win?" }), false);
  assert.equal(strategyAssetMatchesMarket(queryOnly, { question: "Will ETH hit $5,000?" }), true);
});

test("query fallback ignores markets that name a different ticker", () => {
  const spx = { optionSymbol: "SPX", underlyingSymbol: "SPX", referenceSymbol: "SPX-INDEX", polymarketQueries: ["s&p 500 above"] };
  assert.equal(strategyAssetMatchesMarket(spx, { question: "Will S&P 500 (SPY) hit (HIGH) $790 in October?" }), false);
  assert.equal(strategyAssetMatchesMarket(spx, { question: "Will S&P 500 (SPX) hit (HIGH) $7,400 in December?" }), true);
  assert.equal(strategyAssetMatchesMarket(spx, { question: "Will S&P 500 close above 6,500 on March 31?" }), true);
  const oil = { optionSymbol: "USO", underlyingSymbol: "WTI-USD", polymarketQueries: ["wti hit"] };
  assert.equal(strategyAssetMatchesMarket(oil, { question: "Will WTI Crude Oil (WTI) hit (HIGH) $100 in October?" }), true);
  const gold = { optionSymbol: "GLD", underlyingSymbol: "XAU-USD", polymarketQueries: ["gold hit"] };
  assert.equal(strategyAssetMatchesMarket(gold, { question: "Will Gold (XAUUSD) hit (HIGH) $4,300 in October?" }), true);
});

test("event markets load from the Gamma JSON API with order-book fields", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const body = String(url).includes("missing")
      ? []
      : [
          {
            slug: "what-price-will-tsla-hit-in-october-2026",
            title: "What will Tesla hit in October 2026?",
            endDate: "2026-11-01T03:59:59.999Z",
            series: [{ slug: "tesla-hit-price-monthly" }],
            markets: [
              {
                id: "1",
                slug: "tsla-hit-420",
                question: "Will Tesla, Inc. (TSLA) hit (HIGH) $420 in October?",
                groupItemTitle: "↑ $420",
                outcomes: '["Yes","No"]',
                outcomePrices: '["0.255","0.745"]',
                bestBid: 0.24,
                bestAsk: 0.27,
                liquidityNum: 15481.2,
                acceptingOrders: true,
                active: true
              },
              { id: "2", question: "Will Tesla hit (HIGH) $375?", outcomes: '["Yes","No"]', outcomePrices: '["1","0"]', closed: true }
            ]
          }
        ];
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  try {
    const url = "https://www.polymarket.com/event/what-price-will-tsla-hit-in-october-2026/?tid=1";
    // Judged at the fixture's own date: the test must not start failing the day the sample event ends.
    const markets = await fetchPolymarketMarketsFromEventPage(url, { now: NOW });
    assert.equal(markets.length, 1);
    assert.equal(markets[0].yesPrice, 0.255);
    assert.equal(markets[0].bestBid, 0.24);
    assert.equal(markets[0].bestAsk, 0.27);
    assert.equal(markets[0].url, "https://polymarket.com/event/what-price-will-tsla-hit-in-october-2026");
    assert.equal(markets[0].endDate, "2026-11-01T03:59:59.999Z");
    assert.equal(markets[0].seriesSlug, "tesla-hit-price-monthly");
    assert.ok(seen[0].includes("gamma-api.polymarket.com/events?slug=what-price-will-tsla-hit-in-october-2026"));

    // Once the event has ended its markets are no longer tradable, but they can still be read for valuing positions.
    const after = new Date("2026-11-02T00:00:00Z");
    assert.deepEqual(await fetchPolymarketMarketsFromEventPage(url, { now: after }), []);
    assert.equal((await fetchPolymarketMarketsFromEventPage(url, { now: after, tradableOnly: false })).length, 2);

    await assert.rejects(fetchPolymarketMarketsFromEventPage("https://polymarket.com/event/missing-event"), /not found/);
    assert.deepEqual(await fetchPolymarketMarketsFromEventPage("https://example.com/event/x"), []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("question parser handles HIGH/LOW markers on either side and terminal 'above on' markets", () => {
  const cases = [
    ["Will Tesla, Inc. (TSLA) hit (HIGH) $480 in October?", 480, "up", "touch"],
    ["Will Tesla, Inc. (TSLA) hit (LOW) $375 in October?", 375, "down", "touch"],
    ["Will S&P 500 (SPX) hit $7,400 (LOW) in December?", 7400, "down", "touch"],
    ["Will S&P 500 (SPX) hit $7,400 (HIGH) in December?", 7400, "up", "touch"],
    ["Will the price of Bitcoin be above $74,000 on October 14?", 74000, "up", "close"],
    ["Will the price of Bitcoin be below $74,000 on October 14?", 74000, "down", "close"],
    ["Will Bitcoin dip to $80,000 in October?", 80000, "down", "touch"],
    ["Will Bitcoin reach $150,000 in October?", 150000, "up", "touch"]
  ];
  for (const [question, target, direction, triggerType] of cases) {
    const signal = parsePolymarketQuestionSignal(question);
    assert.equal(signal?.targetValue, target, question);
    assert.equal(signal?.direction, direction, question);
    assert.equal(signal?.triggerType, triggerType, question);
  }
});
