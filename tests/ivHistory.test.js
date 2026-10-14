import test from "node:test";
import assert from "node:assert/strict";
import { isRefreshBlackout, targetRunDate, tigerPointDate, normalizeTigerAnalysis, runIvRefresh } from "../server/ivHistory.js";

// 2026-10-13 is a Tuesday (EDT, UTC-4)
const at = (iso) => new Date(iso);

test("blackout covers the US trading day on weekdays only", () => {
  assert.equal(isRefreshBlackout(at("2026-10-13T14:00:00Z")), true); // 10:00 ET
  assert.equal(isRefreshBlackout(at("2026-10-13T21:00:00Z")), true); // 17:00 ET, still blocked
  assert.equal(isRefreshBlackout(at("2026-10-13T22:30:00Z")), false); // 18:30 ET
  assert.equal(isRefreshBlackout(at("2026-10-13T11:00:00Z")), false); // 07:00 ET
  assert.equal(isRefreshBlackout(at("2026-10-17T15:00:00Z")), false); // Saturday
});

test("target run date rolls back before 18:00 ET and over weekends", () => {
  assert.equal(targetRunDate(at("2026-10-13T22:30:00Z")), "2026-10-13");
  assert.equal(targetRunDate(at("2026-10-14T11:00:00Z")), "2026-10-13");
  assert.equal(targetRunDate(at("2026-10-17T15:00:00Z")), "2026-10-16"); // Sat -> Fri
  assert.equal(targetRunDate(at("2026-10-19T11:00:00Z")), "2026-10-16"); // Mon morning -> Fri
});

test("Tiger timestamps map to the calendar date in both DST regimes", () => {
  assert.equal(tigerPointDate(Date.parse("2026-10-13T04:00:00Z")), "2026-10-13");
  assert.equal(tigerPointDate(Date.parse("2026-01-13T05:00:00Z")), "2026-01-13");
});

const sample = (symbol, n = 80) => ({
  symbol, implied_vol_30_days: 0.5,
  volatility_list: Array.from({ length: n }, (_, i) => ({
    implied_vol: 0.3 + i * 0.002, his_volatility: 0.25, rank: 0.5, percentile: 0.25,
    timestamp: Date.parse("2026-07-01T04:00:00Z") + i * 86_400_000 }))
});

test("normalizes scale to 0-100 and dedupes dates", () => {
  const n = normalizeTigerAnalysis({ ...sample("TSLA", 3), volatility_list: [...sample("TSLA", 3).volatility_list, { implied_vol: 0, timestamp: 1 }] });
  assert.equal(n.rows.length, 3);
  assert.equal(n.rows[0].providerRank, 50);
  assert.equal(n.rows[0].providerPercentile, 25);
});

function makeDeps(overrides = {}) {
  const store = { history: {}, snapshots: [], runs: {} };
  return { store, deps: {
    listSymbols: () => ["tsla", "AAPL", "TSLA"],
    fetchAnalysis: async (batch) => batch.map((s) => sample(s)),
    saveHistory: (s, rows) => { store.history[s] = rows; },
    saveSnapshot: (x) => store.snapshots.push(x),
    getRun: (d) => store.runs[d] ?? null,
    saveRun: (r) => { store.runs[r.runDate] = { ...r, finishedAt: new Date().toISOString() }; },
    ...overrides } };
}

test("job skips during trading hours without touching Tiger", async () => {
  let calls = 0;
  const { deps } = makeDeps({ fetchAnalysis: async () => { calls++; return []; } });
  assert.equal(await runIvRefresh({ now: at("2026-10-13T15:00:00Z"), deps }), null);
  assert.equal(calls, 0);
});

test("job dedupes symbols, stores shared history and rank snapshot, runs once per day", async () => {
  const { deps, store } = makeDeps();
  const run = await runIvRefresh({ now: at("2026-10-13T23:00:00Z"), deps });
  assert.equal(run.status, "ok");
  assert.equal(run.symbolsTotal, 2);
  assert.deepEqual(Object.keys(store.history).sort(), ["AAPL", "TSLA"]);
  assert.equal(store.snapshots[0].date, "2026-09-18"); // last sample point
  assert.ok(store.snapshots[0].ivRank52w >= 0);
  assert.equal(await runIvRefresh({ now: at("2026-10-13T23:30:00Z"), deps }), null);
});

test("partial failure is recorded, retried after the delay, and capped by attempts", async () => {
  let clock = at("2026-10-13T23:00:00Z");
  const { deps, store } = makeDeps({
    fetchAnalysis: async (b) => b.filter((s) => s !== "AAPL").map((s) => sample(s)),
    saveRun: (r) => { store.runs[r.runDate] = { ...r, finishedAt: clock.toISOString() }; }
  });
  const store2 = store;
  const run = (minutes) => { clock = new Date(at("2026-10-13T23:00:00Z").getTime() + minutes * 60_000); return runIvRefresh({ now: clock, deps }); };
  const first = await run(0);
  assert.equal(first.status, "partial");
  assert.equal(first.failedSymbols, "AAPL");
  assert.equal(await run(10), null); // inside the 30 min retry delay
  assert.equal((await run(40)).attempts, 2);
  assert.equal((await run(80)).attempts, 3);
  assert.equal(await run(120), null); // attempts exhausted
  assert.equal(store2.runs["2026-10-13"].attempts, 3);
});
