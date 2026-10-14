import test from "node:test";
import assert from "node:assert/strict";

process.env.TIGER_BRIDGE_TOKEN = "test";
const fresh = (tag) => import(`../server/providers/tiger.js?${tag}`);

const row = (strike) => ({
  identifier: `AAPL  261016C00${strike}000`,
  put_call: "CALL",
  strike,
  multiplier: 100,
  bid_price: 4.25,
  ask_price: 4.35,
  open_interest: 10,
  volume: 5,
});

function mockBridge(tradingStatus, calls = []) {
  const fetchedAt = new Date().toISOString();
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const respond = (status, body) => ({
      ok: status < 400,
      status,
      json: async () => ({ ...body, fetchedAt }),
    });
    if (path === "/session")
      return respond(200, { data: [{ market: "US", trading_status: tradingStatus }] });
    if (path === "/options/chain") return respond(200, { data: [row(340), row(345)] });
    if (path === "/options/depth")
      return respond(403, { error: "Tiger permission denied (4000) for option depth" });
    throw new Error(`unexpected ${path}`);
  };
}

test("Tiger L1 quotes are stamped with fetch time while the US market is trading", async () => {
  mockBridge("TRADING");
  const { tigerOptionChain } = await fresh("open");
  const r = await tigerOptionChain({
    symbol: "AAPL", expiration: "2026-10-16", currentSpot: 340, limit: 0,
  });
  assert.equal(r.contracts.length, 2);
  for (const c of r.contracts) {
    assert.ok(c.quoteTimestamp);
    assert.equal(c.quoteTimestampSource, "fetch-time");
  }
  assert.equal(r.warnings.filter((w) => w.startsWith("Tiger L1 quotes")).length, 1);
});

test("no quote timestamp is invented when the US market is closed", async () => {
  mockBridge("POST_HOUR_TRADING");
  const { tigerOptionChain } = await fresh("closed");
  const r = await tigerOptionChain({
    symbol: "MSFT", expiration: "2026-10-16", currentSpot: 340, limit: 0,
  });
  for (const c of r.contracts) assert.equal(c.quoteTimestamp, null);
});

test("option depth is not requested unless TIGER_OPTION_DEPTH=true", async () => {
  const calls = [];
  mockBridge("TRADING", calls);
  const { tigerOptionChain } = await fresh("depth-off");
  const r = await tigerOptionChain({
    symbol: "NVDA", expiration: "2026-10-16", currentSpot: 340, limit: 0,
  });
  assert.ok(!calls.includes("/options/depth"));
  assert.ok(!r.warnings.some((w) => /depth/i.test(w)));

  process.env.TIGER_OPTION_DEPTH = "true";
  try {
    const on = await fresh("depth-on");
    const calls2 = [];
    mockBridge("TRADING", calls2);
    const r2 = await on.tigerOptionChain({
      symbol: "AMD", expiration: "2026-10-16", currentSpot: 340, limit: 0,
    });
    assert.ok(calls2.includes("/options/depth"));
    assert.ok(r2.warnings.some((w) => /depth/i.test(w)));
  } finally {
    delete process.env.TIGER_OPTION_DEPTH;
  }
});
