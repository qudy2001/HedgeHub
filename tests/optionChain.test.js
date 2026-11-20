import test from "node:test";
import assert from "node:assert/strict";
import {
  buildChain,
  chainExpiries,
  contractKey,
  contractMetrics,
  earningsForExpiry,
  indexCandidates,
  isWeeklyExpiry,
  nearestExpiry,
  scoreLabel,
  scoreRank,
} from "../shared/optionChain.js";
import { DAY } from "../shared/builderEngine.js";
import { optionPrice } from "../shared/optionMath.js";

const asOf = "2026-10-14T15:00:00Z";
const ctx = { spot: 100, asOf, fee: 0.65, hv: 0.3 };
const contract = (optionType, strike, over = {}) => ({
  contractSymbol: `T:${over.expiration ?? "2026-11-20"}:${optionType}:${strike}`,
  symbol: "TSLA",
  expiration: "2026-11-20",
  optionType,
  strike,
  bid: 1,
  ask: 1.2,
  bidSize: 10,
  askSize: 20,
  volume: 50,
  openInterest: 400,
  impliedVolatility: 0.4,
  multiplier: 100,
  hasRealBidAsk: true,
  isLive: true,
  ...over,
});

test("expiry tabs list today and later dates in order, flag weeklies, and drop expired or malformed contracts", () => {
  const rows = [
    contract("call", 100, { expiration: "2026-10-23" }),
    contract("put", 100, { expiration: "2026-10-14" }),
    contract("put", 100, { expiration: "2026-10-16" }),
    contract("call", 100, { expiration: "2026-10-23" }),
    contract("call", 100, { expiration: "2026-10-02" }),
    contract("call", 100, { expiration: "not-a-date" }),
    contract("call", 100, { expiration: "2026-12-18", multiplier: 10 }),
    contract("straddle", 100, { expiration: "2026-12-18" }),
    contract("call", 0, { expiration: "2026-12-18" }),
  ];
  assert.deepEqual(chainExpiries(rows, "2026-10-14"), [
    { date: "2026-10-14", dte: 0, weekly: true },
    { date: "2026-10-16", dte: 2, weekly: false },
    { date: "2026-10-23", dte: 9, weekly: true },
  ]);
  assert.equal(isWeeklyExpiry("2026-11-20"), false, "third Friday is the monthly");
  assert.equal(isWeeklyExpiry("2026-11-27"), true);
  assert.equal(isWeeklyExpiry("2026-12-18"), false);
});

test("the chain opens on the listed expiry closest to the selected result, or the first when nothing is selected", () => {
  const tabs = chainExpiries(
    ["2026-10-23", "2026-11-20", "2026-12-18"].map((expiration) => contract("call", 100, { expiration })),
    "2026-10-14",
  );
  assert.equal(nearestExpiry(tabs, "2026-11-20").date, "2026-11-20");
  assert.equal(nearestExpiry(tabs, "2026-11-18").date, "2026-11-20", "a Wednesday target lands on the Friday listing");
  assert.equal(nearestExpiry(tabs, "2027-06-01").date, "2026-12-18");
  assert.equal(nearestExpiry(tabs, "2026-01-01").date, "2026-10-23");
  assert.equal(nearestExpiry(tabs, undefined).date, "2026-10-23");
  assert.equal(nearestExpiry([], "2026-11-20"), undefined);
});

test("a bought put is priced like the scanner: ask debit, fees in the breakeven, loss capped at the premium", () => {
  const m = contractMetrics(contract("put", 95), ctx);
  assert.equal(m.priced, true);
  assert.equal(m.netDebit, 120);
  assert.ok(Math.abs(m.maxLoss - -120.65) < 1e-9, `maxLoss ${m.maxLoss}`);
  assert.ok(Math.abs(m.maxProfit - ((95 - 1.2) * 100 - 0.65)) < 1e-9, `maxProfit ${m.maxProfit}`);
  assert.ok(Math.abs(m.downBreakeven - (95 - 1.2 - 0.0065)) < 1e-9, `breakeven ${m.downBreakeven}`);
  assert.equal(m.bidSize, 10);
  assert.equal(m.askSize, 20);
  assert.equal(m.openInterest, 400);
  assert.equal(m.iv, 0.4);
  assert.equal(m.ivDerived, false);
  assert.equal(m.quoted, true);
  assert.equal(m.annRetPct, null, "a debit position has no income yield");
  assert.ok(Number.isFinite(m.evPerBp));
  assert.ok(m.liquidity >= 0 && m.liquidity <= 100);
});

test("a bought call has unlimited profit and breaks even above the strike by premium plus fees", () => {
  const m = contractMetrics(contract("call", 105, { bid: 0.7, ask: 0.8 }), ctx);
  assert.equal(m.maxProfit, null);
  assert.ok(Math.abs(m.maxLoss - -80.65) < 1e-9);
  assert.ok(Math.abs(m.downBreakeven - 105.8065) < 1e-9);
  assert.equal(m.netDebit, 80);
});

test("missing provider IV is implied from the bid/ask mid; an impossible price leaves IV blank", () => {
  const timeYears = (Date.parse("2026-11-20T20:00:00Z") - Date.parse(asOf)) / (365 * DAY);
  const mid = optionPrice({ type: "put", spot: 100, strike: 95, timeYears, volatility: 0.3 });
  const derived = contractMetrics(
    contract("put", 95, { impliedVolatility: 0, bid: mid - 0.02, ask: mid + 0.02 }),
    ctx,
  );
  assert.equal(derived.ivDerived, true);
  assert.ok(Math.abs(derived.iv - 0.3) < 1e-6, `iv ${derived.iv}`);
  // A 110 put quoted at ~5.5 is below its ~9.5 intrinsic value at spot 100, so no volatility reproduces it.
  const impossible = contractMetrics(contract("put", 110, { impliedVolatility: 0, bid: 5, ask: 6 }), ctx);
  assert.equal(impossible.iv, null);
  assert.equal(impossible.ivDerived, false);
  assert.equal(impossible.priced, true, "IV is optional for pricing a purchase");
});

test("a contract without a usable ask is shown as raw quote data, never given invented position metrics", () => {
  for (const over of [{ ask: 0, bid: 0 }, { ask: null }, { bid: 2, ask: 1 }]) {
    const m = contractMetrics(contract("put", 95, over), ctx);
    assert.equal(m.priced, false, JSON.stringify(over));
    assert.equal(m.maxLoss, undefined);
    assert.equal(m.downBreakeven, undefined);
    assert.equal(m.openInterest, 400);
  }
  assert.equal(contractMetrics(contract("put", 95), { ...ctx, spot: 0 }).priced, false);
  assert.equal(contractMetrics(contract("put", 95, { hasRealBidAsk: false }), ctx).quoted, false);
});

test("chain rows merge calls and puts by strike, ignore duplicates and other expiries, and locate the spot divider", () => {
  const rows = [
    contract("put", 110, { volume: 5 }),
    contract("call", 90, { volume: 30 }),
    contract("put", 90, { volume: 20 }),
    contract("call", 110, { volume: 10 }),
    contract("put", 100, { volume: 7 }),
    contract("put", 100, { volume: 999 }),
    contract("call", 100, { expiration: "2026-12-18", volume: 999 }),
    contract("call", 100, { volume: 3, multiplier: 10, contractSymbol: "adjusted" }),
  ];
  const chain = buildChain(rows, "2026-11-20", ctx);
  assert.deepEqual(
    chain.strikes.map((r) => [r.strike, Boolean(r.call), Boolean(r.put)]),
    [
      [90, true, true],
      [100, false, true],
      [110, true, true],
    ],
  );
  assert.equal(chain.strikes[1].put.volume, 7, "first listing of a contract wins");
  assert.equal(chain.totals.callVolume, 40);
  assert.equal(chain.totals.putVolume, 32);
  assert.equal(chain.spotIndex, 1);
  assert.equal(buildChain(rows, "2026-11-20", { ...ctx, spot: 120 }).spotIndex, 3);
  assert.equal(buildChain(rows, "2026-11-20", { ...ctx, spot: 80 }).spotIndex, 0);
  const none = buildChain(rows, "2027-01-15", ctx);
  assert.deepEqual(none.strikes, []);
  assert.equal(none.totals.callVolume, null, "no data is not zero volume");
});

test("earnings for any expiry are derived from scanned results, and left unknown between the known bounds", () => {
  const rows = [
    { expiry: "2026-10-09", earnings: "Clear" },
    { expiry: "2026-10-23", earnings: "Before expiry" },
    { expiry: "2026-11-06", earnings: "Before expiry" },
    { expiry: "2026-10-30", earnings: "Unknown" },
    { expiry: "", earnings: "Clear" },
  ];
  assert.equal(earningsForExpiry(rows, "2026-10-02"), "Clear");
  assert.equal(earningsForExpiry(rows, "2026-10-09"), "Clear");
  assert.equal(earningsForExpiry(rows, "2026-10-16"), null);
  assert.equal(earningsForExpiry(rows, "2026-10-23"), "Before expiry");
  assert.equal(earningsForExpiry(rows, "2026-12-18"), "Before expiry");
  assert.equal(earningsForExpiry([], "2026-10-23"), null);
});

test("a contract's score follows the results table: exact score, else the range, else unscored", () => {
  const exact = { overall: 72, adjustedRange: [60, 80] };
  const range = { overall: null, adjustedRange: [57, 77] };
  const polymarket = { overall: null };
  assert.equal(scoreLabel(exact), "72");
  assert.equal(scoreLabel(range), "57–77");
  assert.equal(scoreLabel(polymarket), null);
  assert.equal(scoreLabel({ overall: 0 }), "0", "a zero score is still a score");
  const ranked = [polymarket, range, exact].sort((a, b) => scoreRank(b) - scoreRank(a));
  assert.deepEqual(ranked, [exact, range, polymarket]);
});

test("scanned results are indexed by every contract they trade", () => {
  const spread = {
    id: "a",
    expiry: "2026-10-23",
    legs: [
      { type: "call", strike: 357.5 },
      { type: "call", strike: 360 },
    ],
  };
  const put = { id: "b", expiry: "2026-10-23", legs: [{ type: "put", strike: 360 }] };
  const stock = { id: "c", expiry: "2026-10-23", legs: [] };
  const index = indexCandidates([spread, put, stock]);
  assert.deepEqual(index.get(contractKey("2026-10-23", "call", 360)), [spread]);
  assert.deepEqual(index.get(contractKey("2026-10-23", "put", 360)), [put]);
  assert.equal(index.get(contractKey("2026-10-30", "put", 360)), undefined);
  assert.equal(contractKey("2026-10-23", "put", "360.0"), contractKey("2026-10-23", "put", 360));
});
