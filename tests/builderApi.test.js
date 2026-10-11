import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createBuilderStore } from "../server/builder/store.js";
import { registerBuilderRoutes } from "../server/builder/service.js";
import { DEFAULT_STRATEGY } from "../shared/builderEngine.js";

test("builder API persists layouts/items, isolates users, excludes unverified evidence and returns background scan results", async () => {
  const store = createBuilderStore(":memory:"),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: req.headers["test-user"] || "a" };
    next();
  });
  const service = registerBuilderRoutes(app, {
    store,
    loadData: async (symbol) => ({
      symbol,
      spot: 220,
      hv: 0.3,
      asOf: "2025-07-01T12:00:00Z",
      bars: [],
      chain: [],
      warnings: [],
      source: "fixture",
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/builder`;
  const send = (method, body, user = "a") => ({
    method,
    headers: { "content-type": "application/json", "test-user": user },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const definition = {
    ...DEFAULT_STRATEGY,
    symbols: ["AAPL"],
    pricingMode: "modeled",
  };
  try {
    const saved = await fetch(
      root + "/strategies/default",
      send("PUT", { definition, layout: { hidden: ["past"] } }),
    );
    assert.equal(saved.status, 200);
    assert.equal(
      (await fetch(root + "/strategies/default", send("GET", null, "b")))
        .status,
      404,
    );
    const item = {
      title: "Rates",
      condition: "US 10Y closes above 6%",
      resolution: "Closes below 6%",
      status: "monitoring",
      sentiment: "Bearish",
      points: -3,
      verified: false,
      sources: [],
    };
    const added = await (
      await fetch(root + "/strategies/default/items", send("POST", item))
    ).json();
    assert.ok(added.id);
    assert.equal(
      (
        await fetch(
          root + "/strategies/default/items",
          send("POST", { ...item, verified: true }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(
          root + "/strategies/default/items",
          send("POST", { ...item, sources: ["javascript:alert(1)"] }),
        )
      ).status,
      400,
    );
    const read = await (await fetch(root + "/strategies/default")).json();
    assert.equal(read.items.length, 1);
    assert.deepEqual(read.layout.hidden, ["past"]);
    const created = await fetch(
      root + "/scan",
      send("POST", { strategy: definition, strategyId: "default" }),
    );
    assert.equal(created.status, 202);
    const j = await created.json();
    assert.equal(
      (await fetch(root + "/jobs/" + j.id, send("GET", null, "b"))).status,
      404,
    );
    let done;
    for (let i = 0; i < 20; i++) {
      done = await (await fetch(root + "/jobs/" + j.id)).json();
      if (done.status === "completed") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(done.status, "completed");
    assert.ok(done.result.rows.length >= 6);
    assert.ok(done.result.rows.every((r) => r.catalystImpact === 0));
    await fetch(root + "/strategies/default/items/" + added.id, send("DELETE"));
    assert.equal(
      (await (await fetch(root + "/strategies/default")).json()).items.length,
      0,
    );
    assert.equal(store.strategy("a", "default").definition.dailyResearch, true);
  } finally {
    await new Promise((r) => server.close(r));
    service.close();
  }
});

test("cancelling a job during collection preserves cancelled state and skips subsequent symbols", async () => {
  let release;
  const gate = new Promise((resolve) => {
      release = resolve;
    }),
    calls = [];
  const store = createBuilderStore(":memory:"),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: "a" };
    next();
  });
  const service = registerBuilderRoutes(app, {
    store,
    loadData: async (symbol) => {
      calls.push(symbol);
      await gate;
      return { symbol, spot: 220, hv: 0.3, bars: [], chain: [] };
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/builder`;
  const post = (body) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    const job = await (
      await fetch(
        root + "/scan",
        post({ strategy: { ...DEFAULT_STRATEGY, pricingMode: "modeled" } }),
      )
    ).json();
    const cancelled = await (
      await fetch(root + "/jobs/" + job.id + "/cancel", post({}))
    ).json();
    assert.equal(cancelled.status, "cancelled");
    release();
    await new Promise((r) => setTimeout(r, 20));
    const read = await (await fetch(root + "/jobs/" + job.id)).json();
    assert.equal(read.status, "cancelled");
    assert.equal(read.result, undefined);
    assert.deepEqual(calls, ["AAPL"]);
  } finally {
    release();
    await new Promise((r) => server.close(r));
    service.close();
  }
});
