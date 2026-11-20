import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCatalysts,
  riskAdjustment,
  supportResistanceAdjustment,
} from "../shared/builderEngine.js";

const zones = {
  atr14: 10,
  supportPrice: 350,
  supportConfidenceScore: 100,
  resistancePrice: 400,
  resistanceConfidenceScore: 100,
};
const row = (legs, extra = {}) => ({
  legs,
  hv: 0.5,
  baseScore: 60,
  scoreRange: [60, 60],
  ...extra,
});
const put = (strike, quantity = -1) => ({ type: "put", strike, quantity });
const call = (strike, quantity = -1) => ({ type: "call", strike, quantity });

test("short put at least one ATR below support earns the maximum", () => {
  const r = supportResistanceAdjustment(row([put(340)]), zones);
  assert.equal(r.status, "scored");
  assert.equal(r.points, 8);
});

test("short put one ATR above support in open air takes the maximum penalty", () => {
  assert.equal(supportResistanceAdjustment(row([put(360)]), zones).points, -10);
  assert.equal(supportResistanceAdjustment(row([put(375)]), zones).points, -10);
});

test("short put exactly at support scores zero; half an ATR inside is -5", () => {
  assert.equal(supportResistanceAdjustment(row([put(350)]), zones).points, 0);
  assert.equal(supportResistanceAdjustment(row([put(355)]), zones).points, -5);
});

test("short call is judged against resistance", () => {
  assert.equal(supportResistanceAdjustment(row([call(410)]), zones).points, 8);
  assert.equal(supportResistanceAdjustment(row([call(395)]), zones).points, -5);
});

test("low confidence shrinks the reward but not the penalty", () => {
  const weak = { ...zones, supportConfidenceScore: 0 };
  assert.equal(supportResistanceAdjustment(row([put(340)]), weak).points, 4);
  assert.equal(supportResistanceAdjustment(row([put(360)]), weak).points, -10);
});

test("only short legs count and several short legs are averaged", () => {
  const r = supportResistanceAdjustment(
    row([put(340), put(360), call(410, 1)]),
    zones,
  );
  assert.equal(r.legs.length, 2);
  assert.equal(r.points, (8 - 10) / 2);
});

test("no short legs or missing levels score zero with a status", () => {
  assert.equal(supportResistanceAdjustment(row([put(340, 1)]), zones).status, "no-short-legs");
  assert.equal(supportResistanceAdjustment(row([]), zones).points, 0);
  assert.equal(supportResistanceAdjustment(row([put(340)]), null).status, "levels-unavailable");
  assert.equal(
    supportResistanceAdjustment(row([put(340)]), { ...zones, atr14: 0 }).status,
    "levels-unavailable",
  );
});

test("calendar slot is a zero-point placeholder with an HV-based sensitivity", () => {
  const r = riskAdjustment(row([put(340)]), {
    zones,
    calendar: { earningsDate: "2026-10-21", macro: [] },
  });
  assert.equal(r.calendar.points, 0);
  assert.equal(r.calendar.status, "awaiting-ai");
  assert.equal(r.calendar.earningsDate, "2026-10-21");
  assert.equal(r.total, 8);
  assert.equal(riskAdjustment(row([], { hv: 0.1 })).calendar.volSensitivity, 0.6);
  assert.equal(riskAdjustment(row([], { hv: 0.9 })).calendar.volSensitivity, 1.4);
  assert.equal(riskAdjustment(row([], { hv: null })).calendar.volSensitivity, null);
});

test("an AI-filled calendar score flows into the total and is clamped", () => {
  const r = riskAdjustment(row([put(360)]), {
    zones,
    calendar: { points: -15, status: "ai" },
  });
  assert.equal(r.total, -25);
});

test("overall = base + catalysts + risk, clamped, and unchanged without risk", () => {
  const plain = applyCatalysts(row([put(340)]), [], true);
  assert.equal(plain.overall, 60);
  const withRisk = applyCatalysts(
    { ...row([put(340)]), riskAdjustment: { total: -23 } },
    [],
    true,
  );
  assert.equal(withRisk.overall, 37);
  assert.deepEqual(withRisk.adjustedRange, [37, 37]);
  const floor = applyCatalysts(
    { ...row([put(340)]), riskAdjustment: { total: -25 }, baseScore: 10, scoreRange: [10, 10] },
    [],
    true,
  );
  assert.equal(floor.overall, 0);
});

test("unknown base score stays unknown regardless of risk", () => {
  const r = applyCatalysts(
    { ...row([put(340)]), baseScore: null, scoreRange: [40, 60], riskAdjustment: { total: 8 } },
    [],
    true,
  );
  assert.equal(r.overall, null);
  assert.deepEqual(r.adjustedRange, [48, 68]);
});

test("a level on the wrong side of spot is ignored", () => {
  // "resistance" below price after a breakout must not reward a short call.
  const broken = { ...zones, resistancePrice: 340 };
  const r = supportResistanceAdjustment(row([call(380)], { spot: 360 }), broken);
  assert.equal(r.points, 0);
  assert.equal(r.status, "levels-unavailable");
  // Support above price likewise cannot reward a short put.
  const above = { ...zones, supportPrice: 380 };
  assert.equal(
    supportResistanceAdjustment(row([put(340)], { spot: 360 }), above).status,
    "levels-unavailable",
  );
  // Correct side of spot still scores.
  assert.equal(supportResistanceAdjustment(row([put(340)], { spot: 360 }), zones).points, 8);
});

test("missing confidence earns the minimum reward weight", () => {
  const noConf = { ...zones, supportConfidenceScore: null };
  assert.equal(supportResistanceAdjustment(row([put(340)]), noConf).points, 4);
});

test("a non-finite AI calendar score cannot erase support/resistance", () => {
  for (const points of [undefined, NaN, "-5", null]) {
    const r = riskAdjustment(row([put(340)]), { zones, calendar: { points } });
    assert.equal(r.calendar.points, points === "-5" ? -5 : 0);
    assert.ok(Number.isFinite(r.total));
  }
  assert.equal(riskAdjustment(row([put(340)]), { zones, calendar: { points: undefined } }).total, 8);
});

test("risk total is an integer so displayed parts add up to the overall", () => {
  const r = riskAdjustment(row([put(355)]), { zones: { ...zones, supportPrice: 351.5, atr14: 11.04 } });
  assert.ok(Number.isInteger(r.total));
  const o = applyCatalysts({ ...row([put(355)]), riskAdjustment: r }, [], true);
  assert.equal(o.overall, 60 + r.total);
});
