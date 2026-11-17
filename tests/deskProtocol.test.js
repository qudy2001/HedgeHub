import assert from "node:assert/strict";
import test from "node:test";
import { DESK_STAGES, DESK_WORDS, deskAnchorTitles, deskAnchors, deskHeaderExample, deskLane, parseDeskSummary } from "../shared/deskProtocol.js";
import { deskStatus } from "../shared/deskStatus.js";
import { topicTitleKey } from "../shared/marketTopics.js";

test("topic titles compare with width variants, spacing and case folded", () => {
  assert.equal(topicTitleKey("社交： X 市场情绪"), topicTitleKey("社交: X 市场情绪"));
  assert.equal(topicTitleKey("ＴＳＬＡ：　Robotaxi  进展 "), topicTitleKey("TSLA: robotaxi 进展"));
  assert.equal(topicTitleKey("社交:X市场情绪"), topicTitleKey("社交: X 市场情绪"));
  assert.equal(topicTitleKey("US market risk regime"), "usmarketriskregime");
  assert.notEqual(topicTitleKey("美股大势研判"), topicTitleKey("美股大势判断"));
  assert.equal(topicTitleKey(null), "");
});

test("lanes: the Chinese prefixes own the same lanes as the English ones, however the colon is typed", () => {
  const cases = [
    ["社交: 英伟达逼空讨论", "general", "grok"],
    ["社交：英伟达逼空讨论", "ticker", "grok"],
    ["新闻: 美联储官员讲话", "general", "gemini"],
    ["事件：美国 CPI", "general", "gemini"],
    ["专题: AI 资本开支周期", "ticker", "claude"],
    ["研究：深度研究日志", "general", "claude"],
    ["Social: X market mood", "social", "grok"],
    ["TSLA: 整体展望", "ticker", "claude"],
    ["散户情绪升温", "social", "grok"],
    ["美元与外汇", "forex", "chatgpt"],
    ["美股大势研判", "general", "chatgpt"]
  ];
  for (const [title, category, lane] of cases) assert.equal(deskLane({ title, category }), lane, title);
  // Every vocabulary has the same prefixes and stages, so neither prompt language can name something the other lacks.
  assert.deepEqual(Object.keys(DESK_WORDS.zh.prefixes), Object.keys(DESK_WORDS.en.prefixes));
  assert.deepEqual(Object.keys(DESK_WORDS.zh.stages), DESK_STAGES);
  assert.deepEqual(Object.keys(DESK_WORDS.en.stages), DESK_STAGES);
});

test("the Chinese summary header reads back as platform, stage and next check", () => {
  for (const [stage, word] of Object.entries(DESK_WORDS.zh.stages)) {
    const header = deskHeaderExample("zh", { time: "2026-11-14 08:30 ET", platform: "Grok", stage: word, nextCheck: stage === "resolved" ? "无" : "2026-11-17" });
    assert.deepEqual(
      parseDeskSummary(`${header}现状：X 上情绪偏空。提醒：无。`),
      { by: "grok", stage, nextCheck: stage === "resolved" ? "none" : "2026-11-17", flags: [] },
      header
    );
  }
  // Half-width punctuation and a model that mixes the two vocabularies are read the same way.
  assert.deepEqual(parseDeskSummary("截至 2026-11-14 08:30 ET, 由 Claude 撰写. 阶段: active. Next check: 无.").stage, "active");
  assert.deepEqual(parseDeskSummary("As of 2026-11-14 08:30 ET by Gemini. Stage: 发酵中. 下次检查：2026-11-16。"), {
    by: "gemini",
    stage: "developing",
    nextCheck: "2026-11-16",
    flags: []
  });
  // The English header is unchanged.
  assert.deepEqual(parseDeskSummary(deskHeaderExample("en", { time: "2026-11-14 08:30 ET", platform: "ChatGPT", stage: "fading", nextCheck: "none" })), {
    by: "chatgpt",
    stage: "fading",
    nextCheck: "none",
    flags: []
  });
  assert.deepEqual(parseDeskSummary("没有头部的旧摘要。"), { by: null, stage: null, nextCheck: null, flags: [] });
});

test("Chinese flags are split per lane", () => {
  const { flags } = parseDeskSummary(
    "截至 2026-11-14 08:30 ET，由 ChatGPT 撰写。阶段：长期。下次检查：2026-11-17。现状：偏空。" +
      "提醒：Grok：社交: X 市场情绪 - 恢复主话题；Claude：TSLA 与 NVDA - 复核出口管制消息；另核对指引。"
  );
  assert.deepEqual(flags, [
    { to: "grok", text: "社交: X 市场情绪 - 恢复主话题" },
    { to: "claude", text: "TSLA 与 NVDA - 复核出口管制消息; 另核对指引" }
  ]);
});

test("anchors: each language has its own titles, and the status panel accepts either", () => {
  assert.equal(deskAnchors({}, "zh").grok, "社交: X 市场情绪");
  assert.equal(deskAnchors({}, "en").grok, "Social: X market mood");
  assert.equal(deskAnchors({ hubAnchor: "我的大盘判断" }, "zh").chatgpt, "我的大盘判断");
  assert.deepEqual(deskAnchorTitles({ hubAnchor: "我的大盘判断" }).chatgpt, ["我的大盘判断", "US market risk regime", "美股大势研判"]);
  assert.deepEqual(deskAnchorTitles({}, "zh").gemini, ["新闻: 今日要闻", "News: market drivers today"]);
  assert.deepEqual(deskAnchorTitles({}, "en").gemini, ["News: market drivers today", "新闻: 今日要闻"]);
  // Every anchor sits in the lane that writes it.
  for (const language of ["en", "zh"])
    for (const [lane, title] of Object.entries(deskAnchors({}, language)))
      assert.equal(deskLane({ title, category: lane === "grok" ? "social" : "general" }), lane, title);

  const now = new Date("2026-11-16T13:00:00Z");
  const topic = (id, title, category, summary) => ({ id, title, category, summary, updatedAt: "2026-11-16T12:30:00Z", weight: 50, bullishScore: 40, bearishScore: 60, status: "active", symbols: [] });
  const status = deskStatus(
    [
      // A desk that switched to Chinese keeps its old English hub anchor and writes its summary in Chinese.
      topic(1, "US market risk regime", "general", "截至 2026-11-16 07:30 ET，由 ChatGPT 撰写。阶段：长期。下次检查：2026-11-17。提醒：Grok：英伟达 - 核对散户情绪。"),
      topic(2, "社交：X 市场情绪", "social", "截至 2026-11-16 07:00 ET，由 Grok 撰写。阶段：长期。下次检查：2026-11-16。提醒：无。"),
      topic(3, "事件: 美国 CPI", "general", "截至 2026-11-16 06:30 ET，由 Gemini 撰写。阶段：新增。下次检查：2026-11-18。")
    ],
    { now }
  );
  const lane = (id) => status.lanes.find((item) => item.id === id);
  assert.equal(lane("chatgpt").anchorState, "adopted");
  assert.equal(lane("chatgpt").anchorTitle, "US market risk regime");
  assert.equal(lane("grok").anchorState, "adopted");
  assert.equal(lane("grok").anchorTitle, "社交：X 市场情绪");
  assert.equal(lane("grok").counts.due, 1);
  assert.deepEqual(lane("grok").inbox, [{ from: "chatgpt", to: "grok", text: "英伟达 - 核对散户情绪" }]);
  assert.equal(lane("gemini").anchorState, "missing");
  assert.equal(lane("gemini").topics[0].stage, "new");
  assert.equal(lane("claude").health, "never");
});
