import test from "node:test";
import assert from "node:assert/strict";
import {
  MARKET_TOPIC_STATUS_FILTERS,
  filterMarketTopics,
  normalizeTopicSymbols,
  parseMarketTopicFilters,
  sanitizeMarketTopicInput,
  suggestionTab,
  topicPoints,
  topicSentiment,
  topicToItem
} from "../shared/marketTopics.js";
import { validateItem } from "../server/builder/service.js";

const base = { title: "Fed policy", weight: 98, bullishScore: 20, bearishScore: 88, summary: "As of today." };

test("original topic fields are still required and range-checked", () => {
  assert.throws(() => sanitizeMarketTopicInput({ ...base, title: " " }), /title is required/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, weight: 0 }), /weight/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, weight: 101 }), /weight/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, bullishScore: -1 }), /bullishScore/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, bearishScore: 101 }), /bearishScore/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, summary: "" }), /summary is required/);
});

test("category and symbols are optional: new topics default to general, updates keep what they had", () => {
  assert.deepEqual(sanitizeMarketTopicInput(base), { ...base, category: "general", symbols: [] });

  const existing = { category: "ticker", symbols: ["TSLA", "NVDA"] };
  const kept = sanitizeMarketTopicInput(base, existing);
  assert.equal(kept.category, "ticker");
  assert.deepEqual(kept.symbols, ["TSLA", "NVDA"]);

  const changed = sanitizeMarketTopicInput({ ...base, category: "Social", symbols: [] }, existing);
  assert.equal(changed.category, "social");
  assert.deepEqual(changed.symbols, []);
});

test("category must be known and ticker topics need symbols", () => {
  assert.throws(() => sanitizeMarketTopicInput({ ...base, category: "crypto" }), /category must be one of/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, category: "ticker" }), /symbols is required/);
  assert.throws(() => sanitizeMarketTopicInput({ ...base, category: "ticker", symbols: [] }), /symbols is required/);
  assert.equal(sanitizeMarketTopicInput({ ...base, category: "commodity" }).category, "commodity");
  assert.equal(sanitizeMarketTopicInput({ ...base, category: "forex" }).category, "forex");
  assert.deepEqual(sanitizeMarketTopicInput({ ...base, category: "ticker", symbols: "tsla" }).symbols, ["TSLA"]);
});

test("symbols are normalised, de-duplicated and validated", () => {
  assert.deepEqual(normalizeTopicSymbols("tsla, nvda  TSLA;brk.b"), ["TSLA", "NVDA", "BRK.B"]);
  assert.deepEqual(normalizeTopicSymbols([" aapl ", "AAPL"]), ["AAPL"]);
  assert.deepEqual(normalizeTopicSymbols(null), []);
  assert.throws(() => normalizeTopicSymbols(["TSLA$"]), /invalid symbol: TSLA\$/);
  assert.throws(() => normalizeTopicSymbols(["1ABC"]), /invalid symbol/);
  assert.throws(() => normalizeTopicSymbols(Array.from({ length: 21 }, (_, i) => `S${i}`)), /at most 20/);
});

test("list filters: none returns every topic; status, category and symbol narrow the list", () => {
  const topics = [
    { id: 1, title: "Fed policy", status: "active", category: "general", symbols: [] },
    { id: 2, title: "Oil", status: "archived", category: "commodity", symbols: [] },
    { id: 3, title: "TSLA: robotaxi", status: "active", category: "ticker", symbols: ["TSLA", "NVDA"] },
    { id: 4, title: "NVDA: export rules", status: "archived", category: "ticker", symbols: ["NVDA"] },
    { id: 5, title: "Meme rally", status: "active", category: "social", symbols: ["GME"] }
  ];
  const ids = (query) => filterMarketTopics(topics, parseMarketTopicFilters(query)).map((topic) => topic.id);

  // A caller that predates the filters (or passes blanks) gets every topic, archived included, in the same order.
  assert.deepEqual(parseMarketTopicFilters(), { status: "all", category: null, symbol: null });
  assert.deepEqual(parseMarketTopicFilters({}), { status: "all", category: null, symbol: null });
  assert.deepEqual(ids({}), [1, 2, 3, 4, 5]);
  assert.deepEqual(ids({ status: "all", category: "", symbol: "  " }), [1, 2, 3, 4, 5]);
  assert.deepEqual(filterMarketTopics(topics), topics);

  assert.deepEqual(ids({ status: "active" }), [1, 3, 5]);
  assert.deepEqual(ids({ status: "archived" }), [2, 4]);
  assert.deepEqual(ids({ category: "ticker" }), [3, 4]);
  assert.deepEqual(ids({ symbol: "NVDA" }), [3, 4]);
  assert.deepEqual(ids({ symbol: "AAPL" }), []);
  assert.deepEqual(ids({ status: "active", category: "ticker", symbol: "NVDA" }), [3]); // all three together

  // Values are normalised: case, spaces, a repeated parameter that arrives as a one-item array.
  assert.deepEqual(parseMarketTopicFilters({ status: " Active ", category: "SOCIAL", symbol: " gme " }), {
    status: "active",
    category: "social",
    symbol: "GME"
  });
  assert.equal(parseMarketTopicFilters({ symbol: ["tsla"] }).symbol, "TSLA");

  // Older rows without a symbols list never match a symbol filter, and filtering leaves the input alone.
  assert.deepEqual(filterMarketTopics([{ id: 9, status: "active" }], { symbol: "TSLA" }), []);
  assert.equal(topics.length, 5);

  assert.deepEqual(MARKET_TOPIC_STATUS_FILTERS, ["active", "archived", "all"]);
});

test("list filters: an unknown status or category, or more than one ticker, is rejected rather than ignored", () => {
  assert.throws(() => parseMarketTopicFilters({ status: "deleted" }), /status must be one of active, archived, all/);
  assert.throws(() => parseMarketTopicFilters({ status: ["active", "archived"] }), /status must be one of/);
  assert.throws(
    () => parseMarketTopicFilters({ category: "crypto" }),
    /category must be one of general, commodity, forex, ticker, social/
  );
  assert.throws(() => parseMarketTopicFilters({ symbol: "TSLA, NVDA" }), /symbol must be a single ticker/);
  assert.throws(() => parseMarketTopicFilters({ symbol: ["TSLA", "NVDA"] }), /symbol must be a single ticker/);
  assert.throws(() => parseMarketTopicFilters({ symbol: "$BAD" }), /invalid symbol: \$BAD/);
  assert.throws(() => parseMarketTopicFilters({ status: { $ne: "x" } }), /status must be one of/);
});

test("tabs: market topics are sorted by category, and every TradingAgents suggestion stays in the ticker tab", () => {
  const topic = (category, symbols = []) => ({ kind: "topic", category, symbols });
  assert.equal(suggestionTab(topic("general"), "TSLA"), "general");
  assert.equal(suggestionTab(topic("commodity"), "TSLA"), "general");
  assert.equal(suggestionTab(topic("forex"), "TSLA"), "general");
  assert.equal(suggestionTab(topic("social", ["NVDA"]), "TSLA"), "social");
  assert.equal(suggestionTab(topic("ticker", ["TSLA", "NVDA"]), "TSLA"), "ticker");
  assert.equal(suggestionTab(topic("ticker", ["NVDA"]), "TSLA"), "other");

  const agent = (extra) => ({ kind: "agent", symbol: "TSLA", title: "x", ...extra });
  assert.equal(suggestionTab(agent(), "TSLA"), "ticker");
  assert.equal(suggestionTab(agent({ symbol: "AAPL" }), "TSLA"), "ticker");
  assert.equal(suggestionTab(agent({ title: "Retail sentiment on X/Reddit", sourceSection: "sentiment_report" }), "TSLA"), "ticker");
});

test("sentiment and rating contribution follow the net score and the topic's weight", () => {
  const t = (weight, bullishScore, bearishScore) => ({ weight, bullishScore, bearishScore });
  assert.equal(topicSentiment(t(98, 20, 88)), "Strong bearish"); // net -68
  assert.equal(topicSentiment(t(95, 45, 75)), "Bearish"); // net -30
  assert.equal(topicSentiment(t(65, 45, 45)), "Neutral");
  assert.equal(topicSentiment(t(78, 60, 45)), "Bullish"); // net +15
  assert.equal(topicSentiment(t(50, 90, 10)), "Strong bullish");

  assert.equal(topicPoints(t(98, 20, 88)), -3);
  assert.equal(topicPoints(t(95, 45, 75)), -1);
  assert.equal(topicPoints(t(78, 60, 45)), 1);
  assert.equal(topicPoints(t(65, 45, 45)), 0);
  assert.ok(Object.is(topicPoints(t(65, 45, 45)), 0), "never negative zero");
  assert.equal(topicPoints(t(100, 0, 100)), -5);
  assert.equal(topicPoints(t(100, 100, 0)), 5);
});

test("a topic pre-fills a tracking item that the Builder accepts", () => {
  const topic = {
    id: 9,
    title: "TSLA and NVDA",
    weight: 90,
    bullishScore: 65,
    bearishScore: 80,
    summary: "As of 2026-10-14. Verified: deliveries above 486,000. ".repeat(30),
    symbols: ["TSLA", "NVDA"]
  };
  const forTsla = topicToItem(topic, "TSLA");
  assert.equal(forTsla.symbol, "TSLA");
  assert.equal(topicToItem(topic, "AAPL").symbol, "TSLA", "falls back to the topic's first symbol");
  assert.equal(topicToItem({ ...topic, symbols: [] }, "TSLA").symbol, "", "market-wide topics apply to all stocks");
  assert.equal(forTsla.eventKey, "market topic 9");
  assert.ok(forTsla.condition.length <= 1000);

  const accepted = validateItem(forTsla);
  assert.equal(accepted.title, "TSLA and NVDA");
  assert.equal(accepted.sentiment, forTsla.sentiment);
  assert.equal(accepted.points, forTsla.points);
  assert.equal(accepted.symbol, "TSLA");
  assert.equal(accepted.eventKey, "market topic 9");
  assert.equal(accepted.verified, true);

  // a long title is trimmed to the Builder's 240-character limit instead of being rejected
  assert.doesNotThrow(() => validateItem(topicToItem({ ...topic, title: "T".repeat(300) }, "TSLA")));
});

test("an item linked to a topic follows it, keeping the user's own choices", async () => {
  const { refreshItemFromTopic, TOPIC_ITEM_KEY } = await import("../shared/marketTopics.js");
  assert.equal(TOPIC_ITEM_KEY.exec("market topic 12")[1], "12");
  assert.equal(TOPIC_ITEM_KEY.exec("fed policy"), null);
  const item = { ...topicToItem({ id: 3, title: "Fed", weight: 50, bullishScore: 50, bearishScore: 50, summary: "old" }, "TSLA"),
    id: "x", status: "resolved", symbol: "TSLA", verified: true, impactUntil: "2099-01-01", history: [] };
  const now = new Date("2026-10-20T10:00:00Z");
  const next = refreshItemFromTopic(item, { id: 3, title: "Fed", weight: 98, bullishScore: 20, bearishScore: 88, summary: "new text" }, now);
  assert.equal(next.condition, "new text");
  assert.equal(next.sentiment, "Strong bearish");
  assert.equal(next.points, -3);
  assert.equal(next.checkedAt, now.toISOString());
  assert.equal(next.status, "resolved");
  assert.equal(next.symbol, "TSLA");
  assert.equal(next.impactUntil, "2099-01-01");
  assert.equal(refreshItemFromTopic({ ...item, impactUntil: "2026-10-21" }, { id: 3, title: "F", weight: 5, bullishScore: 1, bearishScore: 1, summary: "s" }, now).impactUntil, "2026-11-19");
  assert.equal(next.history.length, 1);
});

test("replaying a topic does not make an old analysis look freshly checked", async () => {
  const { refreshItemFromTopic } = await import("../shared/marketTopics.js");
  const topic = { id: 3, title: "Fed", weight: 98, bullishScore: 20, bearishScore: 88, summary: "hold expected", updatedAt: "2026-10-23T13:00:55.234819+00:00" };
  const item = { ...topicToItem({ ...topic, summary: "older text" }, "TSLA"), id: "x", checkedAt: "2026-10-22T01:00:00.000Z", history: [] };

  // The AI's write: the item takes the topic's text and the topic's own timestamp.
  const synced = refreshItemFromTopic(item, topic);
  assert.equal(synced.condition, "hold expected");
  assert.equal(synced.checkedAt, "2026-10-23T13:00:55.234Z");
  assert.equal(synced.impactUntil, "2026-11-22");
  assert.deepEqual(synced.history.map((entry) => entry.note), ["Updated from AI topic (2026-10-23)"]);

  // The catch-up at server start, three weeks later: nothing new from the AI, so nothing changes.
  assert.equal(refreshItemFromTopic(synced, topic), synced);
  // Saving the item by hand moves its own clock forward; the replay still leaves it alone.
  const saved = { ...synced, checkedAt: "2026-11-01T09:00:00.000Z" };
  assert.equal(refreshItemFromTopic(saved, topic), saved);

  // A newer analysis is picked up even if the item was saved after it (a sync that was missed).
  const newer = { ...topic, summary: "cut priced in", updatedAt: "2026-10-30T13:00:00+00:00" };
  const caught = refreshItemFromTopic(saved, newer);
  assert.equal(caught.condition, "cut priced in");
  assert.equal(caught.checkedAt, "2026-10-30T13:00:00.000Z");
  assert.equal(caught.history.length, 2);

  // A topic without a timestamp (older callers) still counts as checked now.
  const { updatedAt, ...bare } = topic;
  assert.ok(Date.now() - Date.parse(refreshItemFromTopic(item, bare).checkedAt) < 5000);
});
