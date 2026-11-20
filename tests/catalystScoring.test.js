import test from "node:test";
import assert from "node:assert/strict";
import { applyCatalysts } from "../shared/builderEngine.js";
import { validateItem } from "../server/builder/service.js";

const DAY = 86_400_000;
const asOf = "2026-10-14T12:00:00.000Z";
const row = { symbol: "TSLA", template: "collar", baseScore: 70, scoreRange: [60, 80], riskAdjustment: { total: 0 } };
const daysAgo = (days) => new Date(Date.parse(asOf) - days * DAY).toISOString();

const item = (patch = {}) => ({
  id: patch.id ?? "a",
  eventKey: patch.eventKey ?? patch.id ?? "a",
  title: "Topic",
  symbol: "",
  template: "",
  sentiment: "Bearish",
  points: -3,
  status: "monitoring",
  verified: true,
  sources: [],
  impactUntil: "2026-11-13",
  checkedAt: daysAgo(0),
  ...patch
});

const run = (items) => applyCatalysts(row, items, true, asOf);

test("a reviewed item counts without any source URL", () => {
  const result = run([item()]);
  assert.equal(result.catalystImpact, -3);
  assert.equal(result.contributions[0].excluded, false);
  assert.equal(result.overall, 67);
});

test("an item that was not reviewed contributes zero", () => {
  const result = run([item({ verified: false })]);
  assert.equal(result.catalystImpact, 0);
  assert.equal(result.contributions[0].reason, "Unverified");
});

test("a reviewed contribution expires thirty days after it was last saved", () => {
  assert.equal(run([item({ checkedAt: daysAgo(29.9) })]).catalystImpact, -3);

  const stale = run([item({ checkedAt: daysAgo(30.1) })]);
  assert.equal(stale.catalystImpact, 0);
  assert.equal(stale.contributions[0].reason, "Evidence needs refresh");

  assert.equal(run([item({ checkedAt: null })]).catalystImpact, 0);
});

test("the impact window ends on its 'valid through' date", () => {
  assert.equal(run([item({ impactUntil: "2026-10-14" })]).catalystImpact, -3);
  const ended = run([item({ impactUntil: "2026-10-13" })]);
  assert.equal(ended.catalystImpact, 0);
  assert.equal(ended.contributions[0].reason, "Impact horizon ended");
});

test("items are scoped to their stock and template, and related events count once", () => {
  assert.equal(run([item({ symbol: "NVDA" })]).contributions.length, 0, "another stock's item is not listed");
  assert.equal(run([item({ symbol: "TSLA" })]).catalystImpact, -3);
  assert.equal(run([item({ template: "put-spread" })]).contributions.length, 0, "another template's item is not listed");

  const twice = run([item({ id: "x", eventKey: "same" }), item({ id: "y", eventKey: "same" })]);
  assert.equal(twice.catalystImpact, -3);
  assert.equal(twice.contributions[1].reason, "Related event already counted");
});

test("total catalyst adjustment is capped at plus or minus 15", () => {
  const many = Array.from({ length: 6 }, (_, i) => item({ id: `m${i}`, points: -5 }));
  assert.equal(run(many).catalystImpact, -15);
  const bullish = Array.from({ length: 6 }, (_, i) => item({ id: `b${i}`, points: 5, sentiment: "Bullish" }));
  assert.equal(run(bullish).catalystImpact, 15);
  assert.equal(run([item({ points: -9 })]).catalystImpact, -5, "a single item is capped at 5");
});

test("saving an item as reviewed does not require a source URL", () => {
  const saved = validateItem({
    title: "Fed policy and rate expectations",
    condition: "As of today...",
    resolution: "Close when a newer assessment replaces it.",
    sentiment: "Strong bearish",
    status: "monitoring",
    points: -3,
    verified: true,
    sources: []
  });
  assert.equal(saved.verified, true);
  assert.deepEqual(saved.sources, []);
  assert.equal(saved.points, -3);
});
