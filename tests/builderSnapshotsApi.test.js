import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBuilderStore } from "../server/builder/store.js";
import { createSnapshotStore } from "../server/builder/snapshotStore.js";
import { registerBuilderRoutes } from "../server/builder/service.js";
import { DEFAULT_STRATEGY } from "../shared/builderEngine.js";

const DAY = 86400000;
const T0 = Date.parse("2026-11-10T15:00:00Z");
const clock = (start = T0) => {
  let at = start;
  return { now: () => at, add: (ms) => void (at += ms) };
};

test("a Builder scan saves a snapshot that the API lists and reopens with its panels", async () => {
  const store = createBuilderStore(":memory:"),
    time = clock(),
    snapshots = createSnapshotStore(":memory:", { now: time.now }),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: req.headers["test-user"] || "a" };
    next();
  });
  const chain = { symbol: "AAPL", source: "fixture", asOf: "2026-11-10T15:00:00.000Z", complete: true, warnings: [] };
  const distributionCalls = [];
  const service = registerBuilderRoutes(app, {
    store,
    snapshots,
    loadMacro: async () => ({ events: [], coveredUntil: "2027-01-01" }),
    loadData: async (symbol) => ({
      symbol,
      spot: 220,
      hv: 0.3,
      asOf: "2026-11-10T15:00:00Z",
      bars: [{ date: "2026-11-09", close: 219 }],
      chain: [],
      warnings: [],
      source: "fixture",
    }),
    loadDistribution: async (symbol, days) => {
      distributionCalls.push([symbol, days]);
      return {
        ...chain,
        contracts: [
          { contractSymbol: "A", optionType: "call", strike: 220, expiration: "2026-12-18", openInterest: 10, volume: 4 },
          ...(days > 365
            ? [{ contractSymbol: "B", optionType: "put", strike: 200, expiration: "2028-01-21", openInterest: 7, volume: 1 }]
            : []),
        ],
      };
    },
    researchService: {
      earningsCoverage: async () => ({}),
      research: async (symbol) => ({ symbol, volatility: { historical: { rank: 42 } } }),
    },
    captureChainOnScan: true,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/builder`;
  const call = async (path, { method = "GET", body, user = "a" } = {}) => {
    const r = await fetch(root + path, {
      method,
      headers: { "content-type": "application/json", "test-user": user },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const definition = { ...DEFAULT_STRATEGY, symbols: ["AAPL"], pricingMode: "modeled" };
  const runScan = async () => {
    const { body: job } = await call("/scan", { method: "POST", body: { strategy: definition, strategyId: "default" } });
    for (let i = 0; i < 50; i++) {
      const { body } = await call("/jobs/" + job.id);
      if (body.status === "completed") return body;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("scan did not complete");
  };
  try {
    await call("/strategies/default", { method: "PUT", body: { definition } });
    assert.deepEqual((await call("/snapshots?symbol=AAPL")).body.snapshots, []);
    const done = await runScan();
    assert.ok(done.result.rows.length >= 6);
    await new Promise((r) => setTimeout(r, 20)); // the single-stock scan fetches the chain in the background
    assert.deepEqual(distributionCalls, [["AAPL", 365]]);

    // Panels the user opened that day are stored with the scan.
    assert.equal((await call("/research/AAPL")).status, 200);
    assert.equal((await call("/distributions/AAPL?days=730")).body.contracts.length, 2);
    service.attachHedgeScan("a", ["AAPL"], {
      generatedAt: "2026-11-10T15:01:00.000Z",
      results: {
        polymarket_hedge: { status: "ok", count: 1, rows: [{ symbol: "AAPL", id: 1 }, { symbol: "MSFT", id: 2 }] },
      },
    });

    const listed = (await call("/snapshots?symbol=AAPL")).body;
    assert.equal(listed.retentionDays, 30);
    assert.equal(listed.snapshots.length, 1);
    assert.equal(listed.snapshots[0].rows, done.result.rows.length);
    assert.deepEqual(listed.snapshots[0].parts, ["distribution", "hedges", "research", "scan"]);
    assert.deepEqual((await call("/snapshots?symbol=AAPL", { user: "b" })).body.snapshots, []);
    assert.equal((await call("/snapshots/" + listed.snapshots[0].id, { user: "b" })).status, 404);

    // "Tomorrow": the snapshot reopens with exactly what the scan returned, without any provider call.
    time.add(DAY);
    const before = distributionCalls.length;
    const { status, body: snap } = await call("/snapshots/" + listed.snapshots[0].id);
    assert.equal(status, 200);
    assert.equal(snap.symbol, "AAPL");
    assert.deepEqual(snap.scan.rows, done.result.rows);
    assert.deepEqual(snap.scan.dataset, done.result.datasets.AAPL);
    assert.equal(snap.distribution.days, 730, "the wider chain replaced the 1-year one");
    assert.equal(snap.distribution.contracts.length, 2);
    assert.equal(snap.research.volatility.historical.rank, 42);
    assert.deepEqual(snap.hedges.results.polymarket_hedge.rows, [{ symbol: "AAPL", id: 1 }]);
    assert.deepEqual(snap.events, { past: null, future: null });
    assert.deepEqual(snap.stockVolume, []);
    assert.equal(distributionCalls.length, before, "reading a snapshot never loads live data");

    // A second day's scan is a second snapshot; a month later both are gone.
    await runScan();
    assert.equal((await call("/snapshots?symbol=AAPL")).body.snapshots.length, 2);
    time.add(31 * DAY);
    assert.deepEqual((await call("/snapshots?symbol=AAPL")).body.snapshots, []);
    assert.equal((await call("/snapshots/" + listed.snapshots[0].id)).status, 404);
    assert.equal(snapshots.prune(), 2);
  } finally {
    await new Promise((r) => server.close(r));
    service.close();
  }
});

test("a reopened snapshot carries each contract's open interest from the next saved market day", async () => {
  const store = createBuilderStore(":memory:"),
    time = clock(),
    snapshots = createSnapshotStore(":memory:", { now: time.now }),
    app = express();
  app.use((req, res, next) => {
    req.user = { id: "a" };
    next();
  });
  const service = registerBuilderRoutes(app, { store, snapshots });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const read = async (id) =>
    (await fetch(`http://127.0.0.1:${server.address().port}/api/builder/snapshots/${id}`)).json();
  const contract = (contractSymbol, strike, openInterest) => ({
    contractSymbol,
    optionType: "call",
    strike,
    expiration: "2026-12-18",
    openInterest,
    volume: 900,
  });
  try {
    const first = snapshots.saveScan("a", "AAPL", { rows: [] });
    snapshots.attach("a", "AAPL", "distribution", {
      contracts: [contract("A", 220, 100), contract("B", 230, 50), contract("", 240, 7)],
    });
    assert.equal((await read(first.id)).distribution.nextSession, undefined);
    time.add(DAY);
    const second = snapshots.saveScan("a", "AAPL", { rows: [] });
    snapshots.attach("a", "AAPL", "distribution", {
      contracts: [contract("A", 220, 940), contract("", 240, 3)],
    });
    const { distribution } = await read(first.id);
    assert.equal(distribution.nextSession.day, "2026-11-11");
    assert.deepEqual(
      distribution.contracts.map((c) => c.nextOpenInterest),
      [940, null, 3],
    );
    assert.equal((await read(second.id)).distribution.nextSession, undefined);
  } finally {
    await new Promise((r) => server.close(r));
    service.close();
  }
});
