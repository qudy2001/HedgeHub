import test from "node:test";
import assert from "node:assert/strict";
import { describeSubscriptions } from "../src/builder/subscriptions.js";

const now = Date.parse("2026-11-11T18:30:00Z");
const day = 86400_000;

test("subscriptions are labelled, classified by expiry and sorted soonest first", () => {
  const rows = describeSubscriptions([
    { name: "aStockQuoteLv1", expire_at: -1 },
    { name: "usQuoteBasic", expire_at: now + 300 * day },
    { name: "usOptionQuote", expire_at: now - 3600_000 },
    { name: "somethingNew", expire_at: now + 2 * day },
  ], now);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [
    ["usOptionQuote", "expired"],
    ["somethingNew", "soon"],
    ["usQuoteBasic", "active"],
    ["aStockQuoteLv1", "active"],
  ]);
  assert.equal(rows[0].label, "US options");
  assert.match(rows[0].text, /^Expired /);
  assert.match(rows[2].text, /^Expires .*2027/);
  assert.equal(rows[1].label, "somethingNew");
  assert.equal(rows[3].text, "No expiry");
});

test("missing or malformed permission lists give no rows", () => {
  assert.deepEqual(describeSubscriptions(undefined, now), []);
  assert.deepEqual(describeSubscriptions([null, {}], now), []);
});
