import test from "node:test";
import assert from "node:assert/strict";
import { distribution, expiryBucket } from "../shared/optionDistribution.js";
import { createDistributionLoader } from "../server/builder/distributions.js";
import { addDays, dateOnly } from "../shared/builderEngine.js";
const contract = (expiration, optionType, openInterest, strike = 100) => ({
  expiration,
  optionType,
  openInterest,
  strike,
});
test("distribution keeps call/put totals, ranks five expiries and separates near and far exposure", () => {
  const rows = [
    contract("2026-10-16", "call", 100),
    contract("2026-10-16", "put", 50),
    contract("2026-11-20", "call", 200),
    contract("2027-03-19", "put", 300),
    contract("2027-06-18", "call", 400),
    contract("2027-07-16", "call", 500),
    contract("2027-08-20", "put", 600),
  ];
  const d = distribution(rows, "openInterest", {
    asOf: "2026-10-10",
    grouping: "day",
  });
  assert.equal(d.total, 2150);
  assert.equal(d.near, 150);
  assert.equal(d.mid, 200);
  assert.equal(d.far, 1800);
  assert.equal(d.bars[0].topDates.length, 5);
  assert.equal(d.bars[0].topDates[0].date, "2027-08-20");
  assert.equal(d.bars[0].call, 1200);
  assert.equal(d.bars[0].put, 950);
  const expiry = distribution(rows, "openInterest", {
    asOf: "2026-10-10",
    axis: "expiry",
    grouping: "month",
  });
  assert.equal(expiry.total, d.total);
  assert.equal(expiry.bars.length, 6);
});
test("missing values are not zero; duplicates and expired contracts cannot inflate totals", () => {
  const c = contract("2026-10-16", "call", 10);
  const d = distribution(
    [
      c,
      c,
      contract("2026-10-16", "put", null),
      contract("2026-10-23", "call", 0),
      contract("2026-01-01", "call", 100),
      contract("2026-10-23", "put", -1),
    ],
    "openInterest",
    { asOf: "2026-10-10" },
  );
  assert.equal(d.total, 10);
  assert.equal(d.missing, 2);
  assert.equal(d.contracts, 2);
});
test("automatic grouping crosses years using Monday weeks and months without losing totals", () => {
  assert.equal(expiryBucket("2027-01-01", "week"), "2026-12-28");
  const rows = Array.from({ length: 30 }, (_, i) =>
    contract(addDays("2026-10-16", i * 7), "call", i + 1),
  );
  const d = distribution(rows, "openInterest", { asOf: "2026-10-10" });
  assert.equal(d.grouping, "month");
  assert.equal(d.total, 465);
  const weekly = distribution(rows.slice(0, 15), "openInterest", {
    asOf: "2026-10-10",
  });
  assert.equal(weekly.grouping, "week");
});
test("full distribution collection includes far expiries and all strikes, caches requests and never uses modeled fallback", async () => {
  const today = dateOnly(Date.now()),
    expiries = Array.from({ length: 12 }, (_, i) => addDays(today, 7 + i * 25));
  let calls = 0;
  const load = createDistributionLoader({
    enabled: () => true,
    readTiger: async (path) => {
      calls++;
      return {
        data:
          path === "/options/expirations"
            ? expiries.map((date) => ({ date }))
            : Array.from({ length: 40 }, (_, i) => ({
                identifier: String(i),
                put_call: "CALL",
                strike: 80 + i,
                open_interest: 10,
                volume: 5,
              })),
      };
    },
  });
  const data = await load("AAPL", 365);
  assert.equal(data.contracts.length, 480);
  assert.equal(data.contracts.at(-1).expiration, expiries.at(-1));
  await load("AAPL", 365);
  assert.equal(calls, 13);
  const unavailable = createDistributionLoader({
    enabled: () => false,
    readChain: async () => ({
      source: "modeled",
      contracts: [{ openInterest: 1234 }],
    }),
  });
  const result = await unavailable("AAPL");
  assert.equal(result.contracts.length, 0);
  assert.equal(result.complete, false);
  assert.equal(result.warnings.length, 2);
});

test("Tiger quota retry retains the affected expiry rather than omitting far-dated contracts", async () => {
  let attempt = 0,
    waited = 0;
  const expiry = addDays(dateOnly(Date.now()), 300);
  const load = createDistributionLoader({
    enabled: () => true,
    wait: async (ms) => {
      waited = ms;
    },
    readTiger: async (path) => {
      if (path === "/options/expirations") return { data: [{ date: expiry }] };
      if (attempt++ === 0)
        throw new Error("Provider rate limit: retry after 60 seconds");
      return {
        data: [
          {
            identifier: "far-call",
            strike: 100,
            put_call: "CALL",
            open_interest: 50,
            volume: 10,
          },
        ],
      };
    },
  });
  const result = await load("AAPL");
  assert.equal(waited, 61000);
  assert.equal(result.complete, true);
  assert.equal(result.contracts[0].expiration, expiry);
});
