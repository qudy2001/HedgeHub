import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBuilderStore } from "../server/builder/store.js";
import { createSnapshotStore } from "../server/builder/snapshotStore.js";
import { createScanQueue } from "../server/builder/scanQueue.js";
import { registerBuilderRoutes } from "../server/builder/service.js";
import { DEFAULT_STRATEGY } from "../shared/builderEngine.js";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test("scan queue runs one at a time and puts a requested scan right after the current stock", async () => {
  const q = createScanQueue(),
    order = [],
    gates = {};
  const entry = (symbol, source) => ({
    owner: "a",
    symbol,
    source,
    run: () => {
      order.push(symbol);
      return new Promise((r) => (gates[symbol] = r));
    },
  });
  for (const s of ["AAA", "BBB", "CCC"]) q.add(entry(s, "auto"));
  assert.equal(q.state("a").current.symbol, "AAA");
  const placed = q.add(entry("MAN1", "manual"));
  assert.equal(placed.behind.symbol, "AAA");
  assert.equal(placed.ahead, 0);
  assert.equal(q.add(entry("MAN2", "manual")).ahead, 1, "later requests line up behind earlier ones");
  assert.deepEqual(q.state("a").queue.map((e) => e.symbol), ["MAN1", "MAN2", "BBB", "CCC"]);
  assert.equal(q.has("a", "BBB"), true);
  for (const s of ["AAA", "MAN1", "MAN2", "BBB", "CCC"]) {
    await tick();
    gates[s]();
  }
  await tick();
  assert.deepEqual(order, ["AAA", "MAN1", "MAN2", "BBB", "CCC"]);
  assert.equal(q.busy(), false);
  assert.equal(q.state("a").finished.CCC.source, "auto");
  assert.equal(q.state("b").queue.length, 0, "another user sees only their own queue");
});

test("hourly auto-scan scans each monitored stock in turn and a manual scan waits for the current one", async () => {
  const store = createBuilderStore(":memory:"),
    snapshots = createSnapshotStore(":memory:"),
    app = express(),
    loads = [],
    gates = [];
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: "a" };
    next();
  });
  const hedgeCalls = [];
  const service = registerBuilderRoutes(app, {
    store,
    snapshots,
    loadMacro: async () => ({ events: [], coveredUntil: "2027-01-01" }),
    loadData: async (symbol) => {
      loads.push(symbol);
      await new Promise((r) => gates.push(r));
      return { symbol, spot: 100, hv: 0.3, asOf: new Date().toISOString(), bars: [{ date: "2026-11-09", close: 99 }], chain: [], warnings: [], source: "fixture" };
    },
    loadDistribution: async () => ({ contracts: [], warnings: [] }),
    researchService: { earningsCoverage: async () => ({}), research: async () => ({}) },
    autoScan: {
      intervalMs: 3600000,
      firstRoundMs: 3600000,
      monitored: async () => [{ symbol: "AAA" }, { symbol: "BBB" }],
      hedgeScan: async (body) => {
        hedgeCalls.push(body);
        return { generatedAt: new Date().toISOString(), results: { polymarket_hedge: { status: "ok", rows: [] } } };
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/builder`;
  const call = async (path, body) => {
    const r = await fetch(root + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return r.json();
  };
  const release = async () => {
    for (let i = 0; i < 100 && !gates.length; i++) await tick();
    gates.shift()();
  };
  const definition = { ...DEFAULT_STRATEGY, symbols: ["ZZZ"], pricingMode: "modeled" };
  try {
    await fetch(root + "/strategies/default", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    // Nobody has scanned yet, so there are no settings to auto-scan with.
    await service.runAutoScanRound();
    assert.equal((await call("/auto-scan")).configured, false);
    assert.equal(service.scanQueue.busy(), false);

    // A first manual scan saves the settings the hourly round reuses.
    const first = await call("/scan", { strategy: definition, strategyId: "default", hedgeChoices: ["polymarket_hedge"] });
    assert.equal(first.queuedBehind, null);
    await release();
    for (let i = 0; i < 100 && service.scanQueue.busy(); i++) await tick();
    assert.equal((await call("/auto-scan")).configured, true);

    await service.runAutoScanRound();
    await tick(20);
    let status = await call("/auto-scan");
    assert.equal(status.current.symbol, "AAA");
    assert.deepEqual(status.queue.map((e) => e.symbol), ["BBB"]);

    // A scan asked for while AAA is scanning goes next, ahead of BBB.
    const manual = await call("/scan", { strategy: { ...definition, symbols: ["CCC"] }, strategyId: "default" });
    assert.equal(manual.status, "queued");
    assert.equal(manual.queuedBehind, "AAA");
    status = await call("/auto-scan");
    assert.deepEqual(status.queue.map((e) => [e.symbol, e.source]), [["CCC", "manual"], ["BBB", "auto"]]);

    // Running the same round again adds nothing that is already waiting.
    await service.runAutoScanRound();
    assert.equal((await call("/auto-scan")).queue.length, 2);

    await release(); // AAA
    await release(); // CCC
    await release(); // BBB
    for (let i = 0; i < 100 && service.scanQueue.busy(); i++) await tick();
    assert.deepEqual(loads, ["ZZZ", "AAA", "CCC", "BBB"]);
    assert.equal((await call("/jobs/" + manual.id)).status, "completed");

    const [aaa] = (await call("/snapshots?symbol=AAA")).snapshots;
    assert.equal(aaa.source, "auto");
    assert.ok(aaa.parts.includes("hedges"), "the auto-scan's hedge results join its snapshot");
    assert.equal((await call("/snapshots?symbol=CCC")).snapshots[0].source, "manual");
    assert.deepEqual(hedgeCalls.map((b) => b.symbols), [["AAA"], ["BBB"]]);
    // Hourly jobs are not kept in the jobs list (their result is the snapshot).
    assert.deepEqual(
      (await call("/jobs")).map((j) => j.source ?? "manual"),
      ["manual", "manual"],
    );

    // A stock scanned in the last ~48 minutes is skipped by the next round.
    await service.runAutoScanRound();
    assert.equal(service.scanQueue.busy(), false);
  } finally {
    server.close();
    service.close();
  }
});
