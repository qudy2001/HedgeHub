import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeScanSymbol,
  resetPolymarketScanCache,
  scanPolymarketHedgeForSymbol,
  slimPolymarketHedgeRow
} from "../server/polymarketScan.js";
import { polymarketEventDay } from "../server/providers/polymarket.js";
import { refreshPolymarketResolutions, resetPolymarketResolverCache } from "../server/polymarketResolver.js";

const NOW = new Date("2026-10-13T12:00:00Z");
const nvdaEvent = {
  slug: "what-price-will-nvda-hit-in-october-2026",
  title: "What will NVIDIA hit in October 2026?",
  endDate: "2026-11-01T03:59:59.999Z",
  closed: false,
  active: true,
  markets: [{ question: "Will NVIDIA (NVDA) hit (LOW) $184 in October?", outcomePrices: '["0.03","0.97"]' }]
};
const row = (id, spread, liquidity, extra = {}) => ({
  id,
  polymarketQuestion: "Will NVIDIA (NVDA) hit (LOW) $184 in October?",
  polymarketUrl: "https://polymarket.com/event/what-price-will-nvda-hit-in-october-2026",
  polymarketPriceSide: "NO",
  polymarketPrice: 0.9665,
  polymarketLiquidity: liquidity,
  polymarketTriggerType: "touch",
  polymarketDirection: "down",
  optionExpiry: "2026-11-06",
  strategyType: "Long Put",
  rewardRisk: 529.82,
  maxProfit: 515690.18,
  maxLoss: -973.33,
  breakevens: [201.54],
  legs: [
    { kind: "binary", outcome: "NO", action: "LONG", quantity: 1035, entryPrice: 0.9665 },
    { kind: "option", optionType: "put", action: "LONG", quantity: 28, strike: 185, entryPrice: 0.36, bid: 0.34, ask: 0.38, spread, contractMultiplier: 100, contractSymbol: "NVDA  261106P00185000" }
  ],
  ...extra
});

test("the event's last trading day is computed in US Eastern time", () => {
  assert.equal(polymarketEventDay("2026-11-01T03:59:59.999Z"), "2026-10-31"); // stocks, commodities
  assert.equal(polymarketEventDay("2026-11-01T04:00:00Z"), "2026-10-31"); // crypto
  assert.equal(polymarketEventDay("2026-12-01T04:59:59.999Z"), "2026-11-30"); // after DST ends
  assert.equal(polymarketEventDay("2026-12-01T05:00:00Z"), "2026-11-30");
  assert.equal(polymarketEventDay(null), null);
});

test("symbols are validated", () => {
  assert.equal(normalizeScanSymbol(" nvda "), "NVDA");
  assert.equal(normalizeScanSymbol("BRK.B"), "BRK.B");
  for (const bad of ["", "1ABC", "A B", "../x", "TOOLONGTICKERX"]) assert.equal(normalizeScanSymbol(bad), "", bad);
});

test("a candidate row is flattened without reward/risk artefacts", () => {
  const slim = slimPolymarketHedgeRow(row("r1", 11.11, 14984), "NVDA");
  assert.equal(slim.pmSide, "NO");
  assert.equal(slim.pmShares, 1035);
  assert.ok(Math.abs(slim.pmCost - 1035 * 0.9665) < 1e-9);
  assert.ok(Math.abs(slim.optionDebit - 28 * 100 * 0.36) < 1e-9);
  assert.deepEqual(slim.legs[0], {
    action: "Buy", quantity: 28, optionType: "put", strike: 185, price: 0.36, bid: 0.34, ask: 0.38, bidSize: null, askSize: null, volume: null, iv: null, spreadPct: 11.11, openInterest: null, contract: "NVDA  261106P00185000"
  });
  assert.equal(slim.maxLoss, -973.33);
  assert.equal(slim.pmTrigger, "touch");
  assert.equal("rewardRisk" in slim, false);
  assert.equal("maxProfit" in slim, false);
  assert.equal(slimPolymarketHedgeRow(row("r2", 5, 1, { maxLossUnbounded: true }), "NVDA").maxLoss, null);
});

test("an ad-hoc ticker scan resolves the event, loads options and orders rows by tradability", async () => {
  resetPolymarketScanCache();
  resetPolymarketResolverCache();
  const calls = { chain: [], markets: [] };
  const result = await scanPolymarketHedgeForSymbol("nvda", {
    now: NOW,
    force: true,
    refreshFn: (assets) =>
      refreshPolymarketResolutions(assets, { now: NOW, deps: { fetchEvent: async (slug) => (slug === nvdaEvent.slug ? nvdaEvent : null), search: null } }),
    marketsFn: async (url) => {
      calls.markets.push(url);
      return [
        { question: "Will NVIDIA (NVDA) hit (LOW) $184 in October?", endDate: "2026-11-01T03:59:59.999Z", yesPrice: 0.03 },
        { question: "Will NVIDIA (NVDA) hit (HIGH) $248 in October?", endDate: "2026-11-01T03:59:59.999Z", yesPrice: 0.2 }
      ];
    },
    quotesFn: async () => [{ symbol: "NVDA", regularMarketPrice: 228.52 }],
    chainFn: async (args) => {
      calls.chain.push(args);
      return { contracts: [{ contractSymbol: `NVDA-${args.optionType}`, strike: 185, expiration: "2026-11-06", optionType: args.optionType, bid: 0.3, ask: 0.4, isLive: true, hasRealBidAsk: true }] };
    },
    summaryFn: async () => ({
      finder: { rows: [row("wide", 30, 99999), row("tight-shallow", 4, 100), row("tight-deep", 4, 5000)] }
    })
  });
  assert.deepEqual(calls.markets, ["https://polymarket.com/event/what-price-will-nvda-hit-in-october-2026"]);
  assert.equal(result.symbol, "NVDA");
  assert.deepEqual(result.rows.map((r) => r.id), ["tight-deep", "tight-shallow", "wide"]);
  // Option window starts in the event month and covers its last trading day (Oct 31) plus a few days.
  assert.equal(calls.chain.length, 2);
  assert.equal(calls.chain[0].expirationFrom, "2026-10-13");
  assert.equal(calls.chain[0].expirationTo, "2026-11-05"); // Oct 31 + 5 days
  assert.ok(calls.chain[0].strikeMin < 184 && calls.chain[0].strikeMax > 248);
});

test("a ticker without a Polymarket monthly event explains why instead of failing", async () => {
  resetPolymarketScanCache();
  resetPolymarketResolverCache();
  const result = await scanPolymarketHedgeForSymbol("ZZZZ", {
    force: true,
    now: NOW,
    refreshFn: (assets) => refreshPolymarketResolutions(assets, { now: NOW, deps: { fetchEvent: async () => null, search: null } })
  });
  assert.deepEqual(result.rows, []);
  assert.match(result.notes[0], /No open Polymarket monthly event found for "zzzz"/);
  const bad = await scanPolymarketHedgeForSymbol("../x");
  assert.match(bad.notes[0], /valid ticker/);
});
