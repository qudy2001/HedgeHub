import test from "node:test";
import assert from "node:assert/strict";
import { optionBrief, OPTION_BRIEF_MAX_CHARS } from "../shared/optionBrief.js";
import { createOptionContext } from "../server/builder/optionContext.js";
import { createSnapshotStore } from "../server/builder/snapshotStore.js";
import { createAgentService } from "../server/builder/agents.js";

const NOW = Date.parse("2026-11-13T19:00:00Z");
const c = (expiration, optionType, strike, openInterest, volume = 0, extra = {}) => ({
  expiration,
  optionType,
  strike,
  openInterest,
  volume,
  ...extra,
});
const chain = [
  c("2026-11-20", "call", 100, 1000, 500, { bid: 2.9, ask: 3.1 }),
  c("2026-11-20", "put", 100, 2000, 4000, { bid: 1.9, ask: 2.1 }),
  c("2026-11-20", "call", 110, 9000, 1000),
  c("2026-11-20", "put", 90, 7000, 3000),
  c("2027-06-18", "call", 150, 50000, 100),
  c("2026-11-01", "call", 100, 99999, 99999), // expired: ignored
];
const brief = (overrides = {}) =>
  optionBrief({
    symbol: "TEST",
    contracts: chain,
    spot: 100,
    source: "Tiger",
    capturedAt: "2026-11-12T18:56:00Z",
    stats: { rsi: 40, support: 88, resistance: 120, hv: 0.4, iv: 60, ivRank: 85 },
    now: NOW,
    ...overrides,
  });

test("optionBrief states source, age and the positioning the panels show", () => {
  const { text, meta } = brief();
  assert.match(text, /^### Options positioning: TEST/);
  assert.match(text, /Tiger option chain cached by HedgeHub, captured 2026-11-12 18:56 UTC \(1 day before this run\)/);
  assert.match(text, /5 contracts expiring 2026-11-20 to 2027-06-18/);
  // 60K calls / 9K puts; 19K of 69K open interest expires within 30 days.
  assert.match(text, /\*\*Open interest\*\*.*60K calls \/ 9\.0K puts, put\/call 0\.15\. By expiry: 28% within 30 days, 0% in 31-90 days, 72% beyond 90 days/);
  assert.match(text, /\*\*Volume\*\*.*1\.6K calls \/ 7\.0K puts, put\/call 4\.38/);
  assert.match(text, /\*\*Key expiry\*\*: 2026-11-20 \(7 days\), 19K open interest; max pain \$100/);
  assert.match(text, /\*\*Implied move\*\* by 2026-11-20: about ±\$5 \(±5\.0%\), range \$95 to \$105, from the at-the-money straddle/);
  assert.match(text, /\*\*Volatility\*\*: implied 60%, 21-session realized 40%, IV rank 85/);
  assert.match(text, /\| Call wall \| \$110 \| \+10\.0% \|/);
  assert.match(text, /\| Put wall \| \$90 \| -10\.0% \|/);
  assert.match(text, /Largest call open interest, all expiries: \$150 \(50K, \+50\.0%\), \$110 \(9\.0K, \+10\.0%\)/);
  assert.match(text, /Volume above open interest \(new positions, 1 contract\): 2026-11-20 \$100 put 4\.0K traded vs 2\.0K open/);
  assert.match(text, /Limits: this shows where contracts sit/);
  assert.doesNotMatch(text, /99999|undefined|NaN|null/);
  assert.deepEqual(meta, {
    source: "Tiger",
    capturedAt: "2026-11-12T18:56:00.000Z",
    ageDays: 1,
    contracts: 5,
    spot: 100,
    complete: true,
    thin: false,
  });
  assert.ok(text.length <= OPTION_BRIEF_MAX_CHARS);
});

test("optionBrief flags an incomplete chain and refuses to read a thin one", () => {
  assert.match(brief({ complete: false }).text, /did not return every expiry, so totals are a lower bound/);
  const thin = brief({ contracts: [c("2026-11-20", "put", 90, 1, 0), c("2027-05-21", "call", 150, 1, 1)] });
  assert.equal(thin.meta.thin, true);
  assert.match(thin.text, /too thin to read positioning from: 2 contracts of open interest and 1 traded/);
  assert.doesNotMatch(thin.text, /Put wall|max pain \$|Implied move/);
});

test("optionBrief returns nothing without a spot price or live contracts", () => {
  assert.equal(brief({ spot: null }), null);
  assert.equal(brief({ contracts: [] }), null);
  assert.equal(brief({ contracts: [c("2026-11-01", "call", 100, 500, 500)] }), null);
});

test("option context reads the newest cached chain and ignores stale or other owners' snapshots", () => {
  let clock = Date.parse("2026-11-12T18:00:00Z");
  const snapshots = createSnapshotStore(":memory:", { now: () => clock });
  const context = createOptionContext(snapshots, { now: () => clock });
  const bars = Array.from({ length: 30 }, (_, i) => ({ close: 100 + (i % 3), low: 95, high: 106 }));
  assert.equal(context("u1", "TEST"), null);
  snapshots.saveScan("u1", "TEST", { rows: [{}], dataset: { spot: 100, bars } }, { spot: 100 });
  assert.equal(context("u1", "TEST"), null); // a scan without a chain is not enough
  snapshots.attach("u1", "TEST", "distribution", {
    symbol: "TEST",
    contracts: chain,
    source: "Tiger",
    asOf: "2026-11-12T18:00:30Z",
    complete: true,
  });
  // A later scan the same day has no chain of its own; the earlier one still serves.
  clock += 3600000;
  snapshots.saveScan("u1", "TEST", { rows: [{}], dataset: { spot: 101, bars } }, { spot: 101 });
  const found = context("u1", "TEST");
  assert.match(found.text, /captured 2026-11-12 18:00 UTC/);
  // The chain is the earlier one either way. The spot beside it is that scan's ($100) where a rescan is
  // saved as its own snapshot, or the rescan's ($101) where it replaces the day's scan in place.
  assert.match(found.text, /Spot at capture \$10[01]\./);
  assert.match(found.text, /\| Support \| \$95 \|/);
  assert.equal(context("u2", "TEST"), null);
  assert.equal(context("u1", "OTHER"), null);
  clock += 5 * 86400000;
  assert.equal(context("u1", "TEST"), null);
  snapshots.close();
});

test("research runs carry the cached option brief only for symbols that have one", async () => {
  const saved = {};
  const store = { agent: (o, id) => saved[id] ?? null, saveAgent: (o, id, s) => (saved[id] = s), items: () => [] };
  const calls = [];
  const realFetch = globalThis.fetch,
    realUrl = process.env.TRADINGAGENTS_URL;
  process.env.TRADINGAGENTS_URL = "http://agents.test";
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ id: "run" + calls.length, status: "running" }) };
  };
  try {
    const strategy = { id: "s1", definition: { symbols: ["TEST", "NONE", "BOOM"] } };
    const agents = createAgentService(store, {
      optionContext: (owner, symbol) => {
        if (symbol === "BOOM") throw new Error("snapshot unreadable");
        return symbol === "TEST" ? { text: `brief for ${owner}`, meta: { capturedAt: "x" } } : null;
      },
    });
    const state = await agents.refresh("u1", strategy, true);
    assert.equal(calls[0].url, "http://agents.test/api/runs");
    assert.deepEqual(calls[0].body.tickers, ["TEST", "NONE", "BOOM"]);
    assert.deepEqual(calls[0].body.options_context, { TEST: "brief for u1" });
    assert.deepEqual(state.optionContext, { TEST: { capturedAt: "x" } });
    assert.equal(state.error, null);

    const single = await agents.refreshSymbol("u1", strategy, "NONE", true);
    assert.equal("options_context" in calls[1].body, false);
    assert.equal(single.runsBySymbol.NONE.optionContext, null);

    // Without an option-context source the request carries no brief, and the language defaults to English.
    await createAgentService(store).refreshSymbol("u1", { ...strategy, id: "s2" }, "TEST", true);
    assert.deepEqual(Object.keys(calls[2].body), ["tickers", "analysis_date", "look_back_days", "look_forward_days", "output_language"]);
    assert.equal(calls[2].body.output_language, "English");
    assert.equal(calls[0].body.output_language, "English");

    // A user whose research language is Chinese: every run says so, and the brief is asked for in that language.
    const asked = [];
    const zhAgents = createAgentService(store, {
      language: (owner) => (owner === "u2" ? "zh" : owner === "u3" ? "klingon" : "en"),
      optionContext: (owner, symbol, language) => {
        asked.push(language);
        return { text: `${language} brief`, meta: {} };
      },
    });
    const zhState = await zhAgents.refresh("u2", { id: "s3", definition: { symbols: ["TEST"] } }, true);
    assert.equal(calls[3].body.output_language, "Chinese");
    assert.deepEqual(calls[3].body.options_context, { TEST: "zh brief" });
    assert.equal(zhState.language, "zh");
    const zhSingle = await zhAgents.refreshSymbol("u2", { id: "s4", definition: { symbols: ["TEST"] } }, "TEST", true);
    assert.equal(calls[4].body.output_language, "Chinese");
    assert.equal(zhSingle.runsBySymbol.TEST.language, "zh");
    // An unknown value falls back to English rather than reaching TradingAgents.
    await zhAgents.refresh("u3", { id: "s5", definition: { symbols: ["TEST"] } }, true);
    assert.equal(calls[5].body.output_language, "English");
    assert.deepEqual(asked, ["zh", "zh", "en"]);
  } finally {
    globalThis.fetch = realFetch;
    if (realUrl == null) delete process.env.TRADINGAGENTS_URL;
    else process.env.TRADINGAGENTS_URL = realUrl;
  }
});

test("the Chinese brief carries the same numbers as the English one, in Chinese", () => {
  const en = brief(),
    zh = brief({ language: "zh" });
  assert.match(zh.text, /^### 期权持仓：TEST/);
  assert.match(zh.text, /来源：HedgeHub 缓存的 Tiger 期权链，采集于 2026-11-12 18:56 UTC（本次研究前 1 天）/);
  assert.match(zh.text, /\*\*未平仓量\*\*.*看涨 .* \/ 看跌 .*看跌\/看涨比/);
  assert.match(zh.text, /\| 价位 \| 价格 \| 较现价 \| 依据 \|/);
  assert.match(zh.text, /\| 看涨期权墙 \|/);
  assert.match(zh.text, /\n解读：\n- /);
  assert.match(zh.text, /局限：/);
  assert.deepEqual(zh.meta, en.meta);
  // Nothing but the wording differs: every figure in the English brief appears in the Chinese one.
  const figures = (text) => [...new Set(text.match(/\$[\d,.]+\d|[+-]?\d+(?:\.\d+)?%|\d+(?:\.\d+)?[KM]\b|\d{4}-\d{2}-\d{2}/g))].sort();
  assert.deepEqual(figures(zh.text), figures(en.text));
  // No English sentence is left behind: outside the source name, tickers and units, the brief has no Latin words.
  const latin = zh.text.replace(/HedgeHub|Tiger|TEST|UTC|RSI|EMA|IV|HV/g, "").match(/[A-Za-z]{3,}/g) ?? [];
  assert.deepEqual(latin, []);

  const thin = brief({ language: "zh", contracts: [c("2026-11-20", "call", 100, 12, 3)] });
  assert.equal(thin.meta.thin, true);
  assert.match(thin.text, /挂牌期权太清淡/);
  assert.equal(brief({ language: "zh", spot: 0 }), null);
});
