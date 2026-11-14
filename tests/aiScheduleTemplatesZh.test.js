import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_SCHEDULE_TEMPLATES,
  HEDGEHUB_MCP_TOOLS,
  TEMPLATE_LANGUAGES,
  defaultTemplateValues,
  getTemplate,
  renderTemplate,
  templateVariables,
  templatesFor
} from "../shared/aiScheduleTemplates.js";
import { DESK_PLATFORMS, DESK_WORDS, deskAnchors, deskLane, parseDeskSummary } from "../shared/deskProtocol.js";
import { MARKET_TOPIC_CATEGORIES, topicSentiment } from "../shared/marketTopics.js";

const ZH = templatesFor("zh");
// Fields with no default that a prompt cannot be built without.
const REQUIRED = { positions: "卖出看跌 TSLA 到期 2026-11-21 行权价 350", triggers: "TSLA: 收盘跌破 200 日均线" };
const values = (template, extra = {}) => ({ ...defaultTemplateValues(template), ...REQUIRED, ...extra });
const render = (id, extra = {}, options) => {
  const template = getTemplate(id, "zh");
  const result = renderTemplate(template, values(template, extra), options);
  assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.errors)}`);
  return result.text;
};
const quoted = (text) => [...text.matchAll(/"([^"\n]*)"/g)].map((match) => match[1]);

test("both languages are offered, and every template exists in Chinese with the same definition", () => {
  assert.deepEqual(TEMPLATE_LANGUAGES.map(([key]) => key), ["en", "zh"]);
  assert.deepEqual(ZH.map((template) => template.id), AI_SCHEDULE_TEMPLATES.map((template) => template.id));
  for (const english of AI_SCHEDULE_TEMPLATES) {
    const chinese = getTemplate(english.id, "zh");
    assert.equal(chinese.language, "zh");
    assert.equal(typeof chinese.body, "function", english.id);
    // The Admin panel shows the same title, fields and schedule in both languages: only the prompt differs.
    for (const key of ["group", "title", "summary", "tips", "queueable", "taskCadence", "schedule", "cap", "platform"])
      assert.equal(chinese[key], english[key], `${english.id}.${key}`);
    assert.deepEqual(templateVariables(chinese).map((v) => [v.key, v.label, v.type]), templateVariables(english).map((v) => [v.key, v.label, v.type]));
  }
  assert.equal(getTemplate("desk-grok"), AI_SCHEDULE_TEMPLATES.find((template) => template.id === "desk-grok")); // English by default
  assert.equal(getTemplate("desk-grok", "zh"), getTemplate("desk-grok", "zh")); // a stable object
  assert.equal(getTemplate("desk-grok", "klingon").language, undefined);
  assert.equal(getTemplate("no-such-template", "zh"), null);
});

test("every Chinese prompt renders, is written in Chinese and stays within a pasteable length", () => {
  for (const template of ZH) {
    for (const mode of ["schedule", "task"]) {
      const text = render(template.id, {}, { mode });
      assert.ok(!/undefined|NaN|\[object/.test(text), `${template.id} (${mode}) has a broken substitution`);
      // Han, ASCII, and the punctuation Chinese prose uses: nothing exotic that a paste could mangle.
      const odd = text.match(/[^\x09\x0a\x20-\x7e一-鿿，。；：？！、（）“”×]/g) ?? [];
      assert.deepEqual([...new Set(odd)], [], `${template.id} (${mode}) has unexpected characters`);
      // No English sentence left behind: outside what is copied literally (quoted titles and markers), Latin text is
      // names and identifiers, never three plain words in a row.
      const prose = text.replace(/"[^"\n]*"/g, "").replace(/（[^（）]*r\/[^（）]*）/g, "");
      assert.deepEqual(prose.match(/\b[A-Za-z]{2,}(?: [A-Za-z]{2,}){2,}\b/g) ?? [], [], `${template.id} (${mode}) has English prose`);
      const han = (text.match(/[一-鿿]/g) ?? []).length;
      // (The queue runner is mostly tool names, hence a bar well below what the prose-heavy prompts reach.)
      assert.ok(han / text.length > 0.4, `${template.id} (${mode}) is only ${Math.round((han / text.length) * 100)}% Chinese`);
    }
    const limit = template.group === "desk" ? 5600 : 3200;
    assert.ok(render(template.id).length <= limit, `${template.id} is ${render(template.id).length} characters`);
  }
  // The English prompts are untouched by the Chinese pack.
  for (const template of AI_SCHEDULE_TEMPLATES) {
    const text = renderTemplate(template, { ...defaultTemplateValues(template), positions: "Short put TSLA", triggers: "TSLA: x" }).text;
    assert.ok(!/[一-鿿]/.test(text), template.id);
  }
});

test("Chinese prompts name only real tools, real categories and the active filter, in the connector's own words", () => {
  for (const template of ZH) {
    const text = render(template.id, { includeQueue: !template.queueRunner });
    for (const tool of text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []) assert.ok(HEDGEHUB_MCP_TOOLS.includes(tool), `${template.id}: ${tool}`);
    assert.match(text, /先调用 list_market_topics，参数 status 设为 "active"/, template.id);
    assert.match(text, /"HedgeHub connector unavailable（HedgeHub 连接器不可用）"/, template.id);
    for (const [, category] of text.matchAll(/category (?:为 |用 )?([a-z]+)/g)) assert.ok(MARKET_TOPIC_CATEGORIES.includes(category), `${template.id}: ${category}`);
    for (const category of MARKET_TOPIC_CATEGORIES) assert.ok(text.includes(category), `${template.id} never mentions ${category}`);
    // Field names are the connector's, not translated.
    for (const field of ["title", "weight", "bullishScore", "bearishScore", "summary", "symbols"]) assert.ok(text.includes(field), `${template.id}: ${field}`);
    assert.match(text, /简体中文/, template.id);
  }
});

test("the Chinese scoring guidance matches how HedgeHub reads the scores, and summaries fit the Builder", () => {
  assert.equal(topicSentiment({ bullishScore: 55, bearishScore: 40 }), "Bullish");
  assert.equal(topicSentiment({ bullishScore: 70, bearishScore: 30 }), "Strong bullish");
  for (const template of ZH) {
    const text = render(template.id);
    assert.match(text, /\+15 显示为看多，\+40 为强烈看多，看空方向对称/, template.id);
    assert.match(text, /commodity 和 forex 话题打的是对股市的影响/, template.id);
    const max = Number(/最多 (\d+) 字/.exec(text)[1]);
    assert.ok(max <= 500, `${template.id}: a ${max}-character Chinese summary would be cut by the Builder's 1000-character limit once numbers and names are added`);
  }
});

test("titles in Chinese prompts use a half-width colon, carry no dates, and old English titles are kept", () => {
  for (const template of ZH) {
    const text = render(template.id);
    for (const literal of quoted(text)) {
      assert.ok(!/[：]/.test(literal), `${template.id}: "${literal}" has a full-width colon`);
      assert.ok(!/\d{4}-\d{2}-\d{2}/.test(literal), `${template.id}: "${literal}" has a date`);
    }
    assert.match(text, /沿用|原标题/, `${template.id} does not say to keep existing titles`);
  }
  // The rule that keeps a desk that switched language from duplicating its topics.
  assert.match(render("stock-overview"), /旧的英文标题也算，例如 "TSLA: overall outlook" 就是 "TSLA: 整体展望"/);
  assert.match(render("stock-overview", {}, { mode: "task" }), /旧的英文标题也沿用/);
  assert.match(render("daily-market-pulse"), /已有同一主题的旧英文标题则沿用旧标题/);
  const pulse = render("daily-market-pulse", { market: "europe" });
  assert.match(pulse, /- "欧洲股市: 趋势与宽度"（category general）/);
  assert.match(pulse, /- "美元与外汇"（category forex）/);
  assert.doesNotMatch(render("daily-market-pulse", { slots: ["fx"], breakingMax: 0 }), /趋势与宽度|突发:/);
});

test("Chinese desk: each prompt speaks for its lane, and its header, stages, prefixes and anchors read back", () => {
  const prompts = Object.fromEntries(Object.keys(DESK_PLATFORMS).map((lane) => [lane, render(`desk-${lane}`)]));
  const anchors = deskAnchors({}, "zh");
  for (const [lane, text] of Object.entries(prompts)) {
    const name = DESK_PLATFORMS[lane];
    assert.match(text, new RegExp(`你是 ${name}。`));
    // The header the prompt asks for is the header HedgeHub parses.
    const header = /“(截至 [^”]+)”/.exec(text)[1];
    for (const [stage, word] of Object.entries(DESK_WORDS.zh.stages)) {
      const filled = header.replace("<YYYY-MM-DD HH:MM ET>", "2026-11-16 07:30 ET").replace("<阶段>", word).replace(/<YYYY-MM-DD；[^>]+>/, "2026-11-18");
      assert.deepEqual(parseDeskSummary(`${filled}现状：示例。提醒：无。`), { by: lane, stage, nextCheck: "2026-11-18", flags: [] }, filled);
      assert.ok(text.includes(`- ${word}：`), `${lane} does not define the stage ${word}`);
    }
    assert.ok(text.includes(`阶段只能用这六个词：${Object.values(DESK_WORDS.zh.stages).join("、")}。`));
    // Flags written the way the prompt describes come back addressed to the right lane.
    assert.deepEqual(parseDeskSummary("提醒：Claude：NVDA: 整体展望 - 核对出口管制；Gemini：事件: 美国 CPI - 确认发布时间。").flags, [
      { to: "claude", text: "NVDA: 整体展望 - 核对出口管制" },
      { to: "gemini", text: "事件: 美国 CPI - 确认发布时间" }
    ]);
    // All four prompts carry the same lane map: every prefix and every anchor, Chinese and old English.
    for (const language of ["zh", "en"]) {
      for (const prefix of Object.values(DESK_WORDS[language].prefixes)) assert.ok(text.includes(`"${prefix}"`), `${lane}: ${prefix}`);
      for (const title of Object.values(deskAnchors({}, language))) assert.ok(text.includes(`"${title}"`), `${lane}: ${title}`);
    }
    assert.match(text, new RegExp(`你的锚点："${anchors[lane]}"`));
    assert.match(text, /生命周期/);
    assert.match(text, /写完后再用 status "active" 调用一次 list_market_topics/);
    assert.match(text, /最多写入 \d+ 次，其中新建不超过 \d+ 个/);
    assert.doesNotMatch(text, /试运行/);
  }
  // What the lane map says is what deskLane does.
  const owner = { [DESK_WORDS.zh.prefixes.social]: "grok", [DESK_WORDS.zh.prefixes.news]: "gemini", [DESK_WORDS.zh.prefixes.event]: "gemini", [DESK_WORDS.zh.prefixes.thesis]: "claude", [DESK_WORDS.zh.prefixes.research]: "claude" };
  const laneLines = prompts.chatgpt.split("\n").filter((line) => /^- (Grok|Gemini|Claude|ChatGPT)，/.test(line));
  assert.equal(laneLines.length, 4);
  for (const [prefix, lane] of Object.entries(owner)) {
    assert.ok(laneLines.find((line) => line.startsWith(`- ${DESK_PLATFORMS[lane]}，`)).includes(`"${prefix}"`), prefix);
    assert.equal(deskLane({ title: `${prefix} 示例`, category: "general" }), lane);
  }
  // Titles a Chinese prompt tells a lane to create land in that lane.
  assert.equal(deskLane({ title: "TSLA: 整体展望", category: "ticker" }), "claude");
  assert.equal(deskLane({ title: "事件: FOMC 利率决议", category: "general" }), "gemini");
  assert.equal(deskLane({ title: "社交: 英伟达逼空讨论", category: "social" }), "grok");
  assert.equal(deskLane({ title: "美元与外汇", category: "forex" }), "chatgpt");
});

test("Chinese desk and templates: fields, switches and the queue flow into the prompt", () => {
  assert.match(render("desk-chatgpt", { runMode: "dry" }), /- 试运行：每一步都照做，但不要调用 upsert_market_topic/);
  // The hub anchor defaults to a Chinese title; the user's own title is used in all four prompts.
  assert.equal(defaultTemplateValues(getTemplate("desk-chatgpt", "zh")).hubAnchor, "美股市场风险状态");
  assert.equal(defaultTemplateValues(getTemplate("desk-chatgpt", "en")).hubAnchor, "US market risk regime");
  for (const lane of Object.keys(DESK_PLATFORMS)) assert.match(render(`desk-${lane}`, { hubAnchor: "我的大盘判断" }), /锚点 "我的大盘判断"（列表里已有旧标题 "US market risk regime" 时沿用旧标题）/);
  assert.match(render("desk-chatgpt", { hubAnchor: "US market risk regime" }), /锚点 "US market risk regime"。/);
  assert.match(render("desk-chatgpt", { session: "close", market: "asia" }), /CHATGPT 每日研究台 - 全局判断 - 亚太，收盘后\n[^]*日经 225[^]*对亚太股市的净压力/);
  assert.match(render("desk-claude", { tickers: "tsla, nvda, aapl", deepDives: 3, horizon: "90 days", drivers: 0 }), /深度研究 - TSLA、NVDA、AAPL\n[^]*认真研究 3 个对象[^]*未来 90 天/);
  assert.doesNotMatch(render("desk-claude", { drivers: 0 }), /- 驱动因素：/);
  assert.doesNotMatch(render("desk-gemini", { factChecks: 0 }), /事实核查：取其他线/);
  assert.match(render("desk-grok", { connector: "My Hub" }), /通过 "My Hub" 连接器/);

  // Queue: only when asked for, and always for the runner.
  assert.doesNotMatch(render("weekly-sweep"), /get_next_analysis_task/);
  const queued = render("weekly-sweep", { includeQueue: true });
  assert.match(queued, /第一步：HedgeHub 任务队列\n[^]*以“未完成：”开头/);
  assert.match(queued, /工具：list_market_topics、upsert_market_topic、get_next_analysis_task 和 complete_analysis_task/);
  assert.match(render("queue-runner", { maxTasks: 7 }), /本次运行最多 7 个。[^]*报告“队列为空”/);

  // Task mode: the instruction plus the short rules, without the scheduled-run framing.
  const task = render("earnings-tracker", { tickers: "msft", lookahead: 10 }, { mode: "task" });
  assert.match(task, /^财报跟踪 - MSFT\n/);
  assert.match(task, /未来 10 天内没有财报/);
  assert.match(task, /话题规则（upsert_market_topic，每次传全部字段）/);
  assert.doesNotMatch(task, /无人值守|运行报告/);

  assert.match(render("stock-topic", { ticker: "nvda", theme: "出口管制", triggers: "新的出口限制\n- 财报指引下调" }), /标题 "NVDA: 出口管制"，category ticker，symbols \["NVDA"\][^]*- 新的出口限制\n- 财报指引下调/);
  assert.match(render("stock-topic", { triggers: "" }), /选出最重要的三个/);
  assert.match(render("event-reaction"), /新建 "事件: FOMC 利率决议"（category general）/);
  assert.match(render("weekly-sweep", { extra: "跳过加密货币" }), /我的补充要求\n跳过加密货币/);
  assert.match(render("weekly-sweep", { compact: true }), /话题规则（upsert_market_topic，每次传全部字段）/);
  assert.match(render("trigger-watchdog"), /以“预警：”开头[^]*回复“没有条件触发”/);
  assert.match(render("position-risk"), /- 卖出看跌 TSLA 到期 2026-11-21 行权价 350\n[^]*不要让我平仓、展期或调整任何仓位/);
});
