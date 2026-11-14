// Market topics are written by AI agents through the MCP connector / GPT API and reviewed in the Builder's
// "AI suggestions" view. This module is shared by the server (validation) and the UI (tabs, topic -> item).

export const MARKET_TOPIC_CATEGORIES = ["general", "commodity", "forex", "ticker", "social"];
export const MARKET_TOPIC_CATEGORY_LABELS = {
  general: "General",
  commodity: "Commodity",
  forex: "Forex",
  ticker: "Ticker",
  social: "Social"
};

const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,14}$/; // same rule the Builder applies to tracking-item symbols
const MAX_SYMBOLS = 20;

export function normalizeTopicSymbols(value) {
  if (value == null || value === "") {
    return [];
  }
  const parts = Array.isArray(value) ? value : String(value).split(/[\s,;]+/);
  const symbols = [...new Set(parts.map((part) => String(part).trim().toUpperCase()).filter(Boolean))];
  const bad = symbols.find((symbol) => !SYMBOL_PATTERN.test(symbol));
  if (bad) {
    throw new Error(`invalid symbol: ${bad}`);
  }
  if (symbols.length > MAX_SYMBOLS) {
    throw new Error(`at most ${MAX_SYMBOLS} symbols are allowed`);
  }
  return symbols;
}

// Validates one upsert. `category` and `symbols` are optional: when omitted they keep the existing topic's
// values (or "general" / none for a new topic), so older clients that only send the original fields still work.
export function sanitizeMarketTopicInput(body = {}, existing = null) {
  const title = String(body.title ?? "").trim();
  const weight = Number(body.weight);
  const bullishScore = Number(body.bullishScore);
  const bearishScore = Number(body.bearishScore);
  const summary = String(body.summary ?? "").trim();

  if (!title) throw new Error("title is required");
  if (!Number.isFinite(weight) || weight < 1 || weight > 100) throw new Error("weight must be between 1 and 100");
  if (!Number.isFinite(bullishScore) || bullishScore < 0 || bullishScore > 100) {
    throw new Error("bullishScore must be between 0 and 100");
  }
  if (!Number.isFinite(bearishScore) || bearishScore < 0 || bearishScore > 100) {
    throw new Error("bearishScore must be between 0 and 100");
  }
  if (!summary) throw new Error("summary is required");

  const rawCategory = body.category == null || body.category === "" ? null : String(body.category).trim().toLowerCase();
  const category = rawCategory ?? existing?.category ?? "general";
  if (!MARKET_TOPIC_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of ${MARKET_TOPIC_CATEGORIES.join(", ")}`);
  }
  const symbols = body.symbols === undefined ? (existing?.symbols ?? []) : normalizeTopicSymbols(body.symbols);
  if (category === "ticker" && symbols.length === 0) {
    throw new Error("symbols is required when category is ticker");
  }

  return { title, weight, bullishScore, bearishScore, summary, category, symbols };
}

// ---- Listing filters (GET /api/gpt/market-topics and the MCP tool list_market_topics) ------------------------------
export const MARKET_TOPIC_STATUSES = ["active", "archived"];
export const MARKET_TOPIC_STATUS_FILTERS = [...MARKET_TOPIC_STATUSES, "all"];

const filterText = (value) => (Array.isArray(value) ? value.join(",") : String(value ?? "")).trim();

// Reads the optional ?status=, ?category= and ?symbol=. Omitted or blank values mean "no filter" (status "all"), so
// callers that predate the filters still get every topic; values that are not recognised are rejected, not ignored.
export function parseMarketTopicFilters(query = {}) {
  const status = filterText(query.status).toLowerCase() || "all";
  if (!MARKET_TOPIC_STATUS_FILTERS.includes(status)) {
    throw new Error(`status must be one of ${MARKET_TOPIC_STATUS_FILTERS.join(", ")}`);
  }
  const category = filterText(query.category).toLowerCase() || null;
  if (category && !MARKET_TOPIC_CATEGORIES.includes(category)) {
    throw new Error(`category must be one of ${MARKET_TOPIC_CATEGORIES.join(", ")}`);
  }
  const symbols = normalizeTopicSymbols(filterText(query.symbol));
  if (symbols.length > 1) {
    throw new Error("symbol must be a single ticker");
  }
  return { status, category, symbol: symbols[0] ?? null };
}

// `symbol` keeps the topics tagged with that ticker. The order of `topics` is kept.
export function filterMarketTopics(topics, { status = "all", category = null, symbol = null } = {}) {
  return topics.filter(
    (topic) =>
      (status === "all" || topic.status === status) &&
      (!category || topic.category === category) &&
      (!symbol || (topic.symbols ?? []).includes(symbol))
  );
}

// ---- Builder "AI suggestions" tabs -------------------------------------------------------------------------
export const SUGGESTION_TABS = ["general", "ticker", "social", "other"];

// item: { kind: "topic", category, symbols } for a market topic, or { kind: "agent", ... } for a TradingAgents
// suggestion. Every TradingAgents suggestion stays in the ticker tab; only market topics are sorted into the others.
export function suggestionTab(item, selectedSymbol) {
  if (item.kind !== "topic") return "ticker";
  if (item.category === "social") return "social";
  if (item.category === "ticker") return item.symbols?.includes(selectedSymbol) ? "ticker" : "other";
  return "general"; // general, commodity and forex topics are market-wide
}

// ---- Topic -> Builder tracking item ------------------------------------------------------------------------
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const netScore = (topic) => Number(topic.bullishScore) - Number(topic.bearishScore);

export function topicSentiment(topic) {
  const net = netScore(topic);
  if (net >= 40) return "Strong bullish";
  if (net >= 15) return "Bullish";
  if (net <= -40) return "Strong bearish";
  if (net <= -15) return "Bearish";
  return "Neutral";
}

// Rating contribution suggestion in the Builder's -5..+5 range: net conviction scaled by how much the topic matters.
export function topicPoints(topic) {
  return clamp(Math.round((netScore(topic) / 100) * (Number(topic.weight) / 100) * 5), -5, 5) || 0;
}

// Pre-fills the Builder's item dialog; the user reviews and edits before saving.
export function topicToItem(topic, selectedSymbol) {
  const symbols = topic.symbols ?? [];
  const symbol = symbols.length ? (symbols.includes(selectedSymbol) ? selectedSymbol : symbols[0]) : ""; // blank = all stocks
  return {
    title: String(topic.title).slice(0, 240),
    eventKey: `market topic ${topic.id}`,
    condition: String(topic.summary).slice(0, 1000),
    resolution: "Close this item when a newer verified source changes or retires the assessment.",
    sentiment: topicSentiment(topic),
    points: topicPoints(topic),
    status: "monitoring",
    verified: true, // the AI analysis is the evidence; the dialog still shows the tick so it can be removed
    symbol,
    template: "",
    sources: [],
    rationale: `AI market topic: weight ${topic.weight}, bullish ${topic.bullishScore}, bearish ${topic.bearishScore}.`
  };
}

// Items created from a topic carry eventKey "market topic <id>" and follow that topic when the AI updates it.
export const TOPIC_ITEM_KEY = /^market topic (\d+)$/;

// Returns the item refreshed from the topic (text, sentiment, contribution, last-checked, horizon); the user's own
// choices (status, stock, scope, reviewed tick, sources) are kept.
// "Last checked" is the moment the AI last wrote the topic, not the moment of this call: the server replays every topic
// when it starts, and stamping that replay with the current time made a weeks-old analysis count as freshly checked.
// An item that already carries this version of the topic is returned untouched. Pass `now` to force a time.
export function refreshItemFromTopic(item, topic, now) {
  const topicTime = Date.parse(topic.updatedAt ?? "");
  const at = now ?? (Number.isFinite(topicTime) ? new Date(topicTime) : new Date());
  const fresh = {
    title: String(topic.title).slice(0, 240),
    condition: String(topic.summary).slice(0, 1000),
    sentiment: topicSentiment(topic),
    points: topicPoints(topic),
    rationale: `AI market topic: weight ${topic.weight}, bullish ${topic.bullishScore}, bearish ${topic.bearishScore}.`
  };
  const current = !now && Date.parse(item.checkedAt ?? "") >= at.getTime() && Object.keys(fresh).every((key) => item[key] === fresh[key]);
  if (current) return item;

  const today = at.toISOString().slice(0, 10);
  const horizon = new Date(at.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    ...item,
    ...fresh,
    impactUntil: !item.impactUntil || item.impactUntil < horizon ? horizon : item.impactUntil,
    checkedAt: at.toISOString(),
    history: [...(item.history ?? []), { at: at.toISOString(), note: `Updated from AI topic (${today})` }].slice(-100)
  };
}
