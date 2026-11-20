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
    loadMacro: async () => ({
      events: [{ date: "2025-07-15", title: "CPI" }],
      coveredUntil: "2025-10-01",
    }),
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
    // Reviewed items need no source URL: the AI analysis itself is accepted as the evidence.
    const reviewed = await fetch(
      root + "/strategies/default/items",
      send("POST", { ...item, title: "Rates (reviewed)", verified: true }),
    );
    assert.equal(reviewed.status, 201);
    const reviewedItem = await reviewed.json();
    assert.equal(reviewedItem.verified, true);
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
    assert.equal(read.items.length, 2);
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
    // only the reviewed item counts; the unreviewed one is excluded from scoring
    assert.ok(done.result.rows.every((r) => r.catalystImpact === -3));
    assert.ok(done.result.rows.every((r) => r.riskAdjustment?.calendar.points === 0));
    assert.ok(done.result.rows.every((r) => r.riskAdjustment.calendar.status === "awaiting-ai"));
    assert.ok(done.result.rows.some((r) => r.riskAdjustment.calendar.macro?.length === 1));
    await fetch(root + "/strategies/default/items/" + added.id, send("DELETE"));
    await fetch(root + "/strategies/default/items/" + reviewedItem.id, send("DELETE"));
    assert.equal(
      (await (await fetch(root + "/strategies/default")).json()).items.length,
      0,
    );
    assert.equal(store.strategy("a", "default").definition.dailyResearch, false);
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

test("a failing or malformed macro calendar never drops scan rows", async () => {
  for (const loadMacro of [
    async () => {
      throw new Error("calendar down");
    },
    async () => ["not", "an", "object"],
  ]) {
    const store = createBuilderStore(":memory:"),
      app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: "a" };
      next();
    });
    const service = registerBuilderRoutes(app, {
      store,
      loadMacro,
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
    try {
      const job = await (
        await fetch(root + "/scan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            strategy: { ...DEFAULT_STRATEGY, symbols: ["AAPL"], pricingMode: "modeled" },
          }),
        })
      ).json();
      let done;
      for (let i = 0; i < 100; i++) {
        done = await (await fetch(root + "/jobs/" + job.id)).json();
        if (done.status !== "queued" && done.status !== "running") break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(done.status, "completed");
      assert.ok(done.result.rows.length >= 6);
      assert.ok(done.result.rows.every((r) => r.riskAdjustment.calendar.macro === null));
      assert.ok(done.result.rows.every((r) => Number.isFinite(r.overall) || r.overall === null));
    } finally {
      await new Promise((r) => server.close(r));
      service.close();
    }
  }
});

test("the research language is saved per user, defaults to English and reaches a research run", async () => {
  const store = createBuilderStore(":memory:"),
    app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { id: req.headers["test-user"] || "a" };
    next();
  });
  const service = registerBuilderRoutes(app, { store });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const root = `http://127.0.0.1:${server.address().port}/api/builder`;
  const send = (method, body, user = "a") => ({
    method,
    headers: { "content-type": "application/json", "test-user": user },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = async (path, init) => (await fetch(root + path, init)).json();
  const realFetch = globalThis.fetch,
    realUrl = process.env.TRADINGAGENTS_URL,
    runs = [];
  try {
    assert.deepEqual(await json("/preferences", send("GET")), { contentLanguage: "en" });
    assert.deepEqual((await json("/strategies", send("GET"))).preferences, { contentLanguage: "en" });
    assert.deepEqual(await json("/preferences", send("PUT", { contentLanguage: "zh" })), { contentLanguage: "zh" });
    // Another user is not affected, and a value that is not a language is refused, not stored.
    assert.deepEqual(await json("/preferences", send("GET", null, "b")), { contentLanguage: "en" });
    const bad = await fetch(root + "/preferences", send("PUT", { contentLanguage: "fr" }));
    assert.equal(bad.status, 400);
    assert.deepEqual((await json("/strategies", send("GET"))).preferences, { contentLanguage: "zh" });

    await fetch(root + "/strategies/s1", send("PUT", { definition: { ...DEFAULT_STRATEGY, symbols: ["AAPL"] } }));
    await fetch(root + "/strategies/s1", send("PUT", { definition: { ...DEFAULT_STRATEGY, symbols: ["AAPL"] } }, "b"));
    process.env.TRADINGAGENTS_URL = "http://agents.test";
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("http://agents.test")) return realFetch(url, init);
      runs.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ id: "run" + runs.length, status: "running" }) };
    };
    const started = await json("/strategies/s1/research/AAPL", send("POST", {}));
    assert.equal(runs[0].output_language, "Chinese");
    assert.equal(started.runsBySymbol.AAPL.language, "zh");
    await json("/strategies/s1/research/AAPL", send("POST", {}, "b"));
    assert.equal(runs[1].output_language, "English");
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl == null) delete process.env.TRADINGAGENTS_URL;
    else process.env.TRADINGAGENTS_URL = realUrl;
    await new Promise((r) => server.close(r));
    service.close();
  }
});
