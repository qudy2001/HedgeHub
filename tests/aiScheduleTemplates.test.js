import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AI_SCHEDULE_TEMPLATES,
  HEDGEHUB_MCP_TOOLS,
  TEMPLATE_GROUPS,
  defaultTemplateValues,
  describeSchedule,
  getTemplate,
  renderTemplate,
  resolveTemplateValues,
  scheduleHint,
  templateVariables
} from "../shared/aiScheduleTemplates.js";
import { MARKET_TOPIC_CATEGORIES, MARKET_TOPIC_STATUS_FILTERS, topicSentiment } from "../shared/marketTopics.js";

// Templates whose required fields have no sensible default need a sample to render.
const SAMPLES = {
  "position-risk": { positions: "Short put TSLA exp 2026-11-21 strike 350\nCovered call AAPL exp 2026-11-14 strike 240" },
  "trigger-watchdog": { triggers: "TSLA: closes below its 200-day moving average\nMarket: VIX closes above 30" }
};
const render = (template, overrides = {}, options) =>
  renderTemplate(template, { ...SAMPLES[template.id], ...overrides }, options);

test("templates have unique ids, known groups and complete definitions", () => {
  const ids = AI_SCHEDULE_TEMPLATES.map((template) => template.id);
  assert.equal(new Set(ids).size, ids.length);
  const groups = new Set(TEMPLATE_GROUPS.map((group) => group.id));
  for (const template of AI_SCHEDULE_TEMPLATES) {
    assert.ok(groups.has(template.group), `${template.id}: unknown group`);
    assert.ok(template.title && template.summary, `${template.id}: needs a title and summary`);
    assert.equal(typeof template.body, "function");
    assert.equal(typeof template.cap, "function");
    assert.equal(typeof template.schedule, "function");
    const keys = templateVariables(template).map((variable) => variable.key);
    assert.equal(new Set(keys).size, keys.length, `${template.id}: duplicate variable keys`);
    if (template.queueable) assert.ok(template.taskCadence, `${template.id}: queueable templates need a taskCadence`);
  }
  assert.ok(getTemplate("queue-runner"));
  assert.equal(getTemplate("nope"), null);
});

test("every template renders with its defaults and produces clean, pasteable ASCII", () => {
  for (const template of AI_SCHEDULE_TEMPLATES) {
    for (const mode of ["schedule", "task"]) {
      const result = render(template, {}, { mode });
      assert.ok(result.ok, `${template.id} (${mode}): ${JSON.stringify(result.errors)}`);
      assert.doesNotMatch(result.text, /undefined|NaN|\[object|\$\{|\{\{/, `${template.id} (${mode}) has a template leftover`);
      assert.match(result.text, /^[\x09\x0a\x20-\x7e]+$/, `${template.id} (${mode}) has non-ASCII characters`);
      assert.ok(result.text.length < 7000, `${template.id} (${mode}) is ${result.text.length} characters`);
    }
  }
});

test("prompts only name real connector tools, and those tools exist in the MCP server", () => {
  const server = readFileSync(new URL("../mcp-server/src/server.js", import.meta.url), "utf8");
  for (const tool of HEDGEHUB_MCP_TOOLS) {
    assert.match(server, new RegExp(`registerTool\\(\\s*"${tool}"`), `${tool} is not registered by the MCP server`);
  }
  const known = new Set(HEDGEHUB_MCP_TOOLS);
  for (const template of AI_SCHEDULE_TEMPLATES) {
    for (const includeQueue of [false, true]) {
      if (template.queueRunner && includeQueue) continue;
      const { text } = render(template, { includeQueue });
      for (const [name] of text.matchAll(/\b(?:list|upsert|get|complete|create|delete|update)_[a-z_]+\b/g)) {
        assert.ok(known.has(name), `${template.id} mentions unknown tool ${name}`);
      }
      assert.match(text, /upsert_market_topic/);
    }
  }
});

test("every prompt loads only the active topics, and the connector offers that filter", () => {
  const server = readFileSync(new URL("../mcp-server/src/server.js", import.meta.url), "utf8");
  const listTool = server.slice(server.indexOf('"list_market_topics"'), server.indexOf('"upsert_market_topic"'));
  for (const filter of ["status", "category", "symbol"]) {
    assert.match(listTool, new RegExp(`\\b${filter}: z`), `list_market_topics has no ${filter} input`);
  }
  assert.ok(MARKET_TOPIC_STATUS_FILTERS.includes("active"));

  for (const template of AI_SCHEDULE_TEMPLATES) {
    for (const includeQueue of [false, true]) {
      if (template.queueRunner && includeQueue) continue;
      const { text } = render(template, { includeQueue });
      assert.match(text, /Before anything else call list_market_topics with status "active" \(/, `${template.id} must ask for active topics`);
      for (const [, status] of text.matchAll(/list_market_topics with status "(\w+)"/g)) {
        assert.ok(MARKET_TOPIC_STATUS_FILTERS.includes(status), `${template.id}: "${status}" is not a status filter`);
      }
      assert.doesNotMatch(text, /status is "archived"|ignore archived/i, `${template.id} still talks about skipping archived topics`);
    }
  }

  // A queued task can point at a topic that has since been archived: the runner is told where to look for it.
  const runner = render(getTemplate("queue-runner")).text;
  assert.match(runner, /it was archived: call list_market_topics with status "archived"/);
  assert.match(render(getTemplate("weekly-sweep"), { includeQueue: true }).text, /it was archived, so call list_market_topics with status "archived"/);
  assert.match(render(getTemplate("weekly-sweep")).text, /holds active topics only; saving a title that matches an archived topic revives it/);
  assert.match(render(getTemplate("topic-review")).text, /list you loaded \(active ones only\)/);

  // Task mode is only instruction text: it never calls the list itself.
  assert.doesNotMatch(render(getTemplate("weekly-sweep"), {}, { mode: "task" }).text, /list_market_topics/);
});

test("categories named in prompts are valid HedgeHub categories, and the rules cover all of them", () => {
  for (const template of AI_SCHEDULE_TEMPLATES) {
    const { text } = render(template);
    for (const [, word] of text.matchAll(/category (\w+)/g)) {
      if (["and", "that"].includes(word)) continue;
      assert.ok(MARKET_TOPIC_CATEGORIES.includes(word), `${template.id}: "${word}" is not a topic category`);
    }
  }
  const { text } = render(getTemplate("weekly-sweep"));
  for (const category of MARKET_TOPIC_CATEGORIES) assert.match(text, new RegExp(`\\b${category}\\b`));
});

test("the scoring guidance in the rules matches how HedgeHub reads bullish and bearish scores", () => {
  const { text } = render(getTemplate("weekly-sweep"));
  assert.match(text, /\+15 reads Bullish, \+40 Strong bullish/);
  assert.equal(topicSentiment({ bullishScore: 15, bearishScore: 0 }), "Bullish");
  assert.equal(topicSentiment({ bullishScore: 14, bearishScore: 0 }), "Neutral");
  assert.equal(topicSentiment({ bullishScore: 40, bearishScore: 0 }), "Strong bullish");
  assert.equal(topicSentiment({ bullishScore: 0, bearishScore: 40 }), "Strong bearish");
});

test("the queue block and queue tools appear only when asked for (or for the runner itself)", () => {
  const sweep = getTemplate("weekly-sweep");
  const plain = render(sweep).text;
  assert.doesNotMatch(plain, /get_next_analysis_task|complete_analysis_task|HEDGEHUB TASK QUEUE/);

  const withQueue = render(sweep, { includeQueue: true }).text;
  assert.match(withQueue, /FIRST: HEDGEHUB TASK QUEUE/);
  assert.match(withQueue, /get_next_analysis_task/);
  assert.match(withQueue, /complete_analysis_task/);
  assert.ok(withQueue.indexOf("FIRST: HEDGEHUB TASK QUEUE") < withQueue.indexOf("WEEKLY TOPIC SWEEP"));

  const runner = render(getTemplate("queue-runner")).text;
  assert.match(runner, /get_next_analysis_task/);
  assert.doesNotMatch(runner, /FIRST: HEDGEHUB TASK QUEUE/);
  assert.ok(!templateVariables(getTemplate("queue-runner")).some((variable) => variable.key === "includeQueue"));
});

test("task mode is the instruction text plus compact rules, without the scheduled-run framing", () => {
  const result = render(getTemplate("stock-topic"), { includeQueue: true, extra: "Skip crypto." }, { mode: "task" });
  assert.ok(result.ok);
  assert.match(result.text, /^SINGLE-TOPIC TRACKER/);
  assert.match(result.text, /EXTRA INSTRUCTIONS FROM ME\nSkip crypto\./);
  assert.match(result.text, /Write at most 1 topic\./);
  assert.match(result.text, /TOPIC RULES \(upsert_market_topic, send every field\)/); // the compact version
  assert.doesNotMatch(result.text, /unattended scheduled run|HEDGEHUB TASK QUEUE|importance x certainty/);
  assert.ok(result.text.length < render(getTemplate("stock-topic")).text.length);
});

test("shorter rules keep the essentials and trim the prompt", () => {
  const sweep = getTemplate("weekly-sweep");
  const full = render(sweep).text;
  const short = render(sweep, { compact: true }).text;
  assert.ok(short.length < full.length - 800, `${short.length} vs ${full.length}`);
  assert.match(short, /TOPIC RULES \(upsert_market_topic, send every field\)/);
  assert.match(short, /weight 1-100/);
  assert.match(short, /bullishScore and bearishScore 0-100/);
  assert.match(short, /Write at most 20 topics\./);
  assert.doesNotMatch(short, /importance x certainty/);
  assert.match(short, /UNATTENDED|unattended scheduled run/i); // the framing stays
});

test("the connector name, extra instructions and the write cap flow into the prompt", () => {
  const result = render(getTemplate("stock-overview"), { connector: "Hedgehog", extra: "Write in Chinese.", tickers: "tsla, nvda", drivers: 2 });
  assert.match(result.text, /through my "Hedgehog" connector/);
  assert.match(result.text, /EXTRA INSTRUCTIONS FROM ME\nWrite in Chinese\./);
  assert.match(result.text, /PER-STOCK OVERALL TRACKING - TSLA, NVDA/);
  assert.match(result.text, /Write at most 6 topics in this run/); // 2 stocks x (1 anchor + 2 drivers)
});

test("tickers are normalised and validated, numbers clamped, required fields enforced", () => {
  const overview = getTemplate("stock-overview");
  assert.deepEqual(resolveTemplateValues(overview, { tickers: " tsla ,brk.b; TSLA" }).values.tickers, ["TSLA", "BRK.B"]);
  assert.match(resolveTemplateValues(overview, { tickers: "TSLA, $BAD" }).errors.tickers, /invalid symbol: \$BAD/i);
  assert.match(resolveTemplateValues(overview, { tickers: "" }).errors.tickers, /at least one/i);
  assert.match(resolveTemplateValues(overview, { tickers: "A,B,C,D,E,F,G,H,I" }).errors.tickers, /At most 8/);
  assert.equal(resolveTemplateValues(overview, { drivers: 99 }).values.drivers, 6);
  assert.equal(resolveTemplateValues(overview, { drivers: -3 }).values.drivers, 0);
  assert.match(resolveTemplateValues(overview, { drivers: "many" }).errors.drivers, /number/);
  assert.equal(resolveTemplateValues(overview, { horizon: "forever" }).values.horizon, "30 days");

  const single = getTemplate("stock-topic");
  assert.match(resolveTemplateValues(single, { ticker: "TSLA, NVDA" }).errors.ticker, /At most 1 ticker/);
  assert.equal(resolveTemplateValues(single, { theme: 'Robotaxi "FSD"\n rollout' }).values.theme, "Robotaxi 'FSD' rollout");
  assert.match(resolveTemplateValues(single, { theme: "  " }).errors.theme, /Required/);

  for (const id of ["position-risk", "trigger-watchdog"]) {
    const result = renderTemplate(getTemplate(id), {});
    assert.equal(result.ok, false);
    assert.equal(result.text, "");
    assert.ok(Object.keys(result.errors).length);
  }
  assert.ok(defaultTemplateValues(overview).tickers);
});

test("daily pulse: fixed, date-free titles; only the chosen topics; market and session change the wording", () => {
  const pulse = getTemplate("daily-market-pulse");
  const full = render(pulse).text;
  const titles = [...full.matchAll(/^- "([^"]+)" \(category (\w+)\)/gm)];
  assert.equal(titles.length, 7);
  for (const [, title, category] of titles) {
    assert.doesNotMatch(title, /\d/, `title "${title}" must not carry a date`);
    assert.ok(MARKET_TOPIC_CATEGORIES.includes(category));
  }
  assert.match(full, /US equities: trend and breadth/);
  assert.match(full, /pre-market/i);

  const some = render(pulse, { slots: ["fx", "oil"], breakingMax: 0, market: "europe", session: "close" }).text;
  assert.match(some, /"Dollar and FX" \(category forex\)/);
  assert.match(some, /"Oil and energy" \(category commodity\)/);
  assert.doesNotMatch(some, /Gold and metals|volatility regime|Breaking:/);
  assert.match(some, /After-close recap/);
  assert.match(some, /Write at most 2 topics in this run/);
  assert.match(render(pulse, { market: "europe" }).text, /UK\/Europe equities: trend and breadth/);
  assert.match(resolveTemplateValues(pulse, { slots: [] }).errors.slots, /Pick at least one/);
});

test("optional blocks follow their switches", () => {
  const overview = getTemplate("stock-overview");
  assert.match(render(overview, { includeOptions: true }).text, /For options traders/);
  assert.doesNotMatch(render(overview, { includeOptions: false }).text, /For options traders/);
  assert.doesNotMatch(render(overview, { drivers: 0 }).text, /Driver topics/);

  const single = getTemplate("stock-topic");
  assert.match(render(single).text, /pick the three most important/);
  assert.match(render(single, { triggers: "A regulator ruling" }).text, /Signals that should move the scores sharply \(check each one\):\n- A regulator ruling/);

  const social = getTemplate("social-pulse");
  assert.doesNotMatch(render(social).text, /Always check/);
  assert.match(render(social, { watch: "gme, amc" }).text, /Always check GME, AMC/);
});

test("schedule hints convert the market clock to the viewer's time zone, including DST gaps", () => {
  const weekdaysEt = { kind: "at", time: "08:00", days: [1, 2, 3, 4, 5], note: "before the US open", zone: "America/New_York" };
  const bst = new Date("2026-10-15T12:00:00Z"); // UK on BST, US on EDT: 5 hours apart
  const gmt = new Date("2026-10-28T12:00:00Z"); // UK back on GMT, US still on EDT: 4 hours apart

  const london = describeSchedule(weekdaysEt, { timeZone: "Europe/London", now: bst });
  assert.equal(london.cron, "0 13 * * 1-5");
  assert.match(london.text, /^Weekdays at 13:00 \(08:00 ET, before the US open\)$/);
  assert.equal(describeSchedule(weekdaysEt, { timeZone: "Europe/London", now: gmt }).cron, "0 12 * * 1-5");
  assert.equal(describeSchedule(weekdaysEt, { timeZone: "America/New_York", now: bst }).cron, "0 8 * * 1-5");

  // Sunday 18:00 ET is already Monday morning in Singapore: the day moves with the clock.
  const sunday = { kind: "at", time: "18:00", days: [0], note: "Sunday evening", zone: "America/New_York" };
  const singapore = describeSchedule(sunday, { timeZone: "Asia/Singapore", now: bst });
  assert.equal(singapore.cron, "0 6 * * 1");
  assert.match(singapore.text, /^Mondays at 06:00 \(18:00 ET, Sunday evening\)$/);

  const hourly = { kind: "hourly", fromHour: 10, toHour: 16, days: [1, 2, 3, 4, 5], note: "US market hours", zone: "America/New_York" };
  assert.equal(describeSchedule(hourly, { timeZone: "Europe/London", now: bst }).cron, "0 15-21 * * 1-5");
  assert.equal(describeSchedule(hourly, { timeZone: "Asia/Singapore", now: bst }).cron, null); // wraps past local midnight

  assert.equal(describeSchedule({ kind: "every", hours: 3 }).cron, "0 */3 * * *");
  assert.equal(describeSchedule({ kind: "once", note: "One time." }).cron, null);
  assert.equal(describeSchedule(weekdaysEt, { timeZone: "Not/AZone", now: bst }).cron, "0 12 * * 1-5"); // falls back to UTC
});

test("every template has a schedule hint, and the pulse follows its market", () => {
  for (const template of AI_SCHEDULE_TEMPLATES) {
    const { values } = resolveTemplateValues(template, SAMPLES[template.id]);
    const hint = scheduleHint(template, values, { timeZone: "Europe/London", now: new Date("2026-10-15T12:00:00Z") });
    assert.ok(hint.text, `${template.id} has no schedule text`);
  }
  const pulse = getTemplate("daily-market-pulse");
  const at = (raw) =>
    scheduleHint(pulse, resolveTemplateValues(pulse, raw).values, { timeZone: "Europe/London", now: new Date("2026-10-15T12:00:00Z") });
  assert.equal(at({ market: "us", session: "premarket" }).cron, "0 13 * * 1-5");
  assert.equal(at({ market: "us", session: "close" }).cron, "45 21 * * 1-5");
  assert.equal(at({ market: "europe", session: "premarket" }).cron, "0 7 * * 1-5");
});
