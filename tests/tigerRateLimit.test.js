import test from "node:test";
import assert from "node:assert/strict";
import { createJobStore } from "../server/asyncJobs.js";

process.env.TIGER_BRIDGE_TOKEN = "test";
const fresh = (tag) => import(`../server/providers/tiger.js?${tag}`);
const waiting = (mod, fn) => mod.withRateLimitWaiting(fn);

function mockBridge(responses, calls = []) {
  const queue = [...responses];
  globalThis.fetch = async (url) => {
    calls.push(new URL(url).pathname);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return {
      ok: next.status < 400,
      status: next.status,
      headers: { get: (name) => (name.toLowerCase() === "retry-after" ? String(next.retryAfter ?? "") : null) },
      json: async () => next.body
    };
  };
  return calls;
}

test("a 429 from the bridge is waited out and retried automatically", async () => {
  const realFetch = globalThis.fetch;
  try {
    const mod = await fresh("retry-ok");
    const { tigerRequest, getTigerRateLimitState } = mod;
    const calls = mockBridge([
      { status: 429, retryAfter: 1, body: { error: "Provider rate limit: retry after 1 seconds", retryAfter: 0.05 } },
      { status: 429, retryAfter: 1, body: { error: "Provider rate limit: retry after 1 seconds", retryAfter: 0.05 } },
      { status: 200, body: { data: [{ ok: true }], fetchedAt: "2026-10-13T12:00:00Z" } }
    ]);
    const started = Date.now();
    const result = await waiting(mod, () => tigerRequest("/options/chain", { symbol: "NVDA", expiry: "2026-11-06" }));
    assert.deepEqual(result.data, [{ ok: true }]);
    assert.equal(calls.length, 3);
    assert.ok(Date.now() - started >= 600, "waited roughly 2 x (0.05s + 0.3s margin)");
    assert.equal(getTigerRateLimitState().waitingUntil, null, "state is cleared once the call succeeds");
    assert.equal(getTigerRateLimitState().waits, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the waiting state is visible while a retry is pending", async () => {
  const realFetch = globalThis.fetch;
  try {
    const mod = await fresh("retry-state");
    const { tigerRequest, getTigerRateLimitState } = mod;
    mockBridge([
      { status: 429, body: { error: "limit", retryAfter: 0.4 } },
      { status: 200, body: { data: [], fetchedAt: "2026-10-13T12:00:00Z" } }
    ]);
    const pending = waiting(mod, () => tigerRequest("/quotes", { symbol: "NVDA" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = getTigerRateLimitState();
    assert.ok(state.waitingUntil > Date.now(), "waitingUntil points into the future");
    await pending;
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a rate limit that outlasts the wait budget fails with a clear message", async () => {
  const realFetch = globalThis.fetch;
  const oldBudget = process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS;
  process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS = "1200"; // each wait is 0.2s + 0.3s margin = 500ms
  try {
    const mod = await fresh("retry-budget");
    const { tigerRequest, getTigerRateLimitState } = mod;
    const calls = mockBridge([{ status: 429, body: { error: "limit", retryAfter: 0.2 } }]);
    await assert.rejects(waiting(mod, () => tigerRequest("/quotes", { symbol: "AAPL" })), /Tiger rate limit: retry after/);
    assert.equal(calls.length, 3, "two waits fit the budget, the third would not");
    assert.equal(getTigerRateLimitState().waitingUntil, null);
  } finally {
    globalThis.fetch = realFetch;
    if (oldBudget === undefined) delete process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS;
    else process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS = oldBudget;
  }
});

test("request handlers fail fast with the wait time instead of sleeping", async () => {
  const realFetch = globalThis.fetch;
  try {
    const { tigerRequest } = await fresh("fail-fast");
    const calls = mockBridge([{ status: 429, body: { error: "limit", retryAfter: 42 } }]);
    const started = Date.now();
    await assert.rejects(tigerRequest("/quotes", { symbol: "AAPL" }), /retry after 42 seconds/);
    assert.ok(Date.now() - started < 500);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a waiting scan does not block unrelated Tiger requests", async () => {
  const realFetch = globalThis.fetch;
  try {
    const mod = await fresh("no-hol-blocking");
    let chainCalls = 0;
    globalThis.fetch = async (url) => {
      const path = new URL(url).pathname;
      const respond = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => body });
      if (path === "/options/chain" && ++chainCalls === 1) return respond(429, { error: "limit", retryAfter: 0.6 });
      return respond(200, { data: [path], fetchedAt: "2026-10-13T12:00:00Z" });
    };
    const slow = waiting(mod, () => mod.tigerRequest("/options/chain", { symbol: "NVDA", expiry: "2026-11-06" }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const started = Date.now();
    const quote = await mod.tigerRequest("/quotes", { symbol: "AAPL" });
    assert.deepEqual(quote.data, ["/quotes"]);
    assert.ok(Date.now() - started < 300, "the quote did not wait behind the sleeping chain call");
    assert.deepEqual((await slow).data, ["/options/chain"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a malformed retry value falls back to a bounded wait and never spins", async () => {
  const realFetch = globalThis.fetch;
  const oldBudget = process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS;
  process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS = "1000";
  try {
    const mod = await fresh("bad-retry");
    const calls = mockBridge([{ status: 429, retryAfter: "soon", body: { error: "limit", retryAfter: "soon" } }]);
    await assert.rejects(waiting(mod, () => mod.tigerRequest("/quotes", { symbol: "AAPL" })), /retry after 60 seconds/);
    assert.equal(calls.length, 1, "the 60s fallback exceeds the budget, so it gives up immediately");
  } finally {
    globalThis.fetch = realFetch;
    if (oldBudget === undefined) delete process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS;
    else process.env.TIGER_RATE_LIMIT_MAX_WAIT_MS = oldBudget;
  }
});

test("other bridge errors are not retried", async () => {
  const realFetch = globalThis.fetch;
  try {
    const { tigerRequest } = await fresh("no-retry");
    const calls = mockBridge([{ status: 502, body: { error: "Tiger request failed" } }]);
    await assert.rejects(tigerRequest("/quotes", { symbol: "AAPL" }), /Tiger request failed/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("background jobs complete, fail, isolate users and cap concurrency", async () => {
  let clock = 0;
  const store = createJobStore({ ttlMs: 1000, maxRunningPerUser: 2, now: () => clock });
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const slow = store.start("u1", async () => {
    await gate;
    return { ok: 1 };
  });
  assert.equal(store.get("u1", slow.id).status, "running");
  assert.equal(store.get("u2", slow.id), null, "other users cannot read it");

  const second = store.start("u1", () => new Promise(() => {}));
  assert.equal(second.status, "running");
  assert.throws(() => store.start("u1", async () => 1), /Too many scans/);
  assert.doesNotThrow(() => store.start("u2", async () => 1));

  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.get("u1", slow.id).status, "completed");
  assert.deepEqual(store.get("u1", slow.id).result, { ok: 1 });

  const failing = store.start("u3", async () => {
    throw new Error("boom");
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(store.get("u3", failing.id).status, "failed");
  assert.equal(store.get("u3", failing.id).error, "boom");

  clock = 5000; // finished jobs expire; running ones do not
  store.start("u9", async () => 1);
  assert.equal(store.get("u1", slow.id), null);
  assert.equal(store.get("u1", second.id).status, "running");
});
