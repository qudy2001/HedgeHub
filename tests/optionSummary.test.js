import test from "node:test";
import assert from "node:assert/strict";
import { optionSummary, maxPain, volFraction } from "../shared/optionSummary.js";

const c = (expiration, optionType, strike, openInterest, volume = 0, extra = {}) => ({
  expiration,
  optionType,
  strike,
  openInterest,
  volume,
  ...extra,
});
const chain = [
  c("2026-11-20", "call", 100, 100, 50, { bid: 2.9, ask: 3.1 }),
  c("2026-11-20", "put", 100, 200, 400, { bid: 1.9, ask: 2.1 }),
  c("2026-11-20", "call", 110, 900, 100),
  c("2026-11-20", "put", 90, 700, 300),
  c("2026-11-20", "put", 110, 50, 0),
  c("2027-06-18", "call", 150, 5000, 10),
  c("2026-11-01", "call", 100, 9999, 9999), // expired: ignored
];
const stats = { rsi: 25, emaAverage: 108, support: 88, resistance: 120, iv: 60, hv: 0.4, ivRank: 85 };

test("volFraction accepts fractions and percent points", () => {
  assert.equal(volFraction(0.5), 0.5);
  assert.equal(volFraction(50), 0.5);
  assert.equal(volFraction(0), null);
});

test("maxPain picks the strike with the smallest holder payout", () => {
  assert.equal(
    maxPain([
      { strike: 90, call: 0, put: 700 },
      { strike: 100, call: 100, put: 200 },
      { strike: 110, call: 900, put: 50 },
    ]),
    100,
  );
});

test("summary derives walls, ratios, key expiry and the straddle expected move", () => {
  const s = optionSummary({ contracts: chain, spot: 100, asOf: "2026-11-13", stats });
  assert.equal(s.contracts, 6);
  assert.equal(s.positioning.callWall.strike, 110); // the far-dated 150 call is outside 90 days
  assert.equal(s.positioning.putWall.strike, 90);
  assert.equal(s.positioning.keyExpiry.expiration, "2026-11-20");
  assert.equal(s.positioning.maxPain, 100);
  assert.equal(s.positioning.putCallOi, 950 / 6000);
  assert.equal(s.flow.putCallVolume, 700 / 160);
  assert.equal(s.expected.method, "straddle");
  assert.equal(s.expected.amount, 5);
  assert.equal(s.expected.low, 95);
  assert.deepEqual(s.flow.busiest, { type: "put", strike: 100, volume: 400 });
  assert.equal(s.flow.freshCount, 1);
  assert.deepEqual(
    s.signals.map((x) => [x.key, x.label]),
    [
      ["Trend", "Below trend"],
      ["Momentum", "Oversold"],
      ["Volatility", "Options rich"],
      ["Positioning", "Call-heavy"],
      ["Flow today", "Put-heavy"],
    ],
  );
  const labels = s.levels.map((l) => l.label);
  assert.deepEqual(labels, [
    "Resistance",
    "Call wall",
    "EMA average",
    "Expected high",
    "Max pain",
    "Spot",
    "Expected low",
    "Put wall",
    "Support",
  ]);
  assert.ok(s.takeaways.some((t) => /stretched to the downside/.test(t)));
  assert.ok(s.takeaways.some((t) => /downside demand is building/.test(t)));
});

test("expected move falls back to implied volatility without quotes", () => {
  const s = optionSummary({
    contracts: chain.map(({ bid, ask, ...rest }) => rest),
    spot: 100,
    asOf: "2026-11-13",
    stats,
  });
  assert.equal(s.expected.method, "iv");
  assert.ok(Math.abs(s.expected.amount - 100 * 0.6 * Math.sqrt(7 / 365)) < 1e-9);
});

test("summary stays empty-safe without a chain", () => {
  const s = optionSummary({ contracts: [], spot: 100, asOf: "2026-11-13", stats: { rsi: 50 } });
  assert.equal(s.contracts, 0);
  assert.equal(s.expected, null);
  assert.equal(s.positioning.callWall, null);
  assert.deepEqual(s.signals.map((x) => x.key), ["Momentum"]);
  assert.deepEqual(s.levels.map((l) => l.label), ["Spot"]);
});
