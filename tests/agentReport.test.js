import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentReport, parseInline, parseListItem, reportHighlights, tagSentiment, ratingSentiment } from "../shared/agentReport.js";

const report = `**Rating**: Overweight

**Keywords**: Staged accumulation, Cash conversion checkpoint, Governance probe overhang, Gap-risk sizing

**Executive Summary**: Initiate NVDA as an Overweight starter at 2.5% ($2,500) in the $172-$178 zone, sized below the trader's 4%.

**Entry Price**: 178.0

**Take Profit**: 218.0

**Execution Scenarios**:
- Buy starter now (2.5%) | Trigger: Immediate; price in the $172-$178 zone | Allocation: 2.50% | Entry: 178.0 | Notes: Deploy $2,500 as an explicitly bounded probe. Effective exit is the first daily close below the shelf.
- Plain bullet`;

test("agent report: labelled lines become facts, sections and scenario steps", () => {
  const blocks = parseAgentReport(report);
  assert.deepEqual(blocks.map((b) => b.type), ["facts", "section", "section", "facts", "heading", "list"]);
  assert.deepEqual(blocks[0].items, [{ label: "Rating", value: "Overweight" }]);
  assert.equal(blocks[1].label, "Keywords");
  assert.equal(blocks[3].items.length, 2);
  assert.equal(blocks[4].text, "Execution Scenarios");
  const [step, plain] = blocks[5].items;
  assert.equal(step.title, "Buy starter now (2.5%)");
  assert.deepEqual(step.fields.map((f) => f.label), ["Trigger", "Allocation", "Entry", "Notes"]);
  assert.equal(step.fields[2].value, "178.0");
  assert.deepEqual(plain, { text: "Plain bullet" });
});

test("agent report: headings, paragraphs and tables", () => {
  const blocks = parseAgentReport("## Summary\nLine one\nline two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\nAfter");
  assert.deepEqual(blocks, [
    { type: "heading", level: 2, text: "Summary" },
    { type: "paragraph", text: "Line one line two" },
    { type: "table", head: ["A", "B"], rows: [["1", "2"]] },
    { type: "paragraph", text: "After" },
  ]);
  assert.deepEqual(parseAgentReport(""), []);
  assert.deepEqual(parseAgentReport(null), []);
});

test("agent report: inline runs and pipes that are not labelled parts", () => {
  assert.deepEqual(parseInline("a **b** `c` *d* 2*3*4"), [
    { text: "a " },
    { text: "b", bold: true },
    { text: " " },
    { text: "c", code: true },
    { text: " " },
    { text: "d", italic: true },
    { text: " 2*3*4" },
  ]);
  assert.deepEqual(parseListItem("Calls | Puts"), { text: "Calls | Puts" });
});

test("agent report highlights: rating plus keyword tags with a conservative sentiment", () => {
  const h = reportHighlights(report);
  assert.equal(h.rating, "Overweight");
  assert.deepEqual(h.tags.map((t) => t.text), ["Staged accumulation", "Cash conversion checkpoint", "Governance probe overhang", "Gap-risk sizing"]);
  assert.deepEqual(h.tags.map((t) => t.sentiment), ["bullish", "neutral", "bearish", "neutral"]);
  assert.equal(tagSentiment("Core hold at cap"), "neutral");
  assert.equal(tagSentiment("Strong demand but weak margins"), "neutral");
  assert.equal(ratingSentiment("Hold"), "neutral");
  assert.equal(ratingSentiment("Underweight"), "bearish");
  assert.equal(ratingSentiment("Buy"), "bullish");
  assert.deepEqual(reportHighlights(null), { rating: null, tags: [] });
});

test("companySummary leads with fundamentals and news, two stances per section", async () => {
  const { companySummary } = await import("../shared/agentReport.js");
  const s = (sourceSection, sentiment, rationale, extra = {}) => ({
    symbol: "NVDA",
    sourceSection,
    sentiment,
    rationale,
    checkedAt: "2026-11-13",
    ...extra,
  });
  const suggestions = [
    s("news_report", "Neutral", "News neutral."),
    s("news_report", "Bearish", "News bearish."),
    s("news_report", "Bearish", "Same stance, second item."),
    s("news_report", "Bullish", "News bullish."),
    s("fundamentals_report", "Bearish", "Fundamentals bearish."),
    s("fundamentals_report", "Bullish", "  Fundamentals bullish.  "),
    s("sentiment_report", "Bullish", "Sentiment bullish."),
    s("investment_plan", "Bullish", "Plan, not company news."),
    s("market_report", "Bullish", "Technicals."),
    s("fundamentals_report", "Bullish", "", {}),
    { ...s("fundamentals_report", "Bullish", "Other stock."), symbol: "TSLA" },
  ];
  // Unrated research shows both sides: bullish then bearish, fundamentals before news, sentiment left out.
  assert.deepEqual(
    companySummary(suggestions, "NVDA").map((i) => [i.label, i.sentiment, i.text]),
    [
      ["Fundamentals", "Bullish", "Fundamentals bullish."],
      ["Fundamentals", "Bearish", "Fundamentals bearish."],
      ["News", "Bullish", "News bullish."],
      ["News", "Bearish", "News bearish."],
    ],
  );
  // Rated research keeps the two stances the agents were most confident in.
  const rated = [
    s("news_report", "Bullish", "Weak.", { confidence: 20 }),
    s("news_report", "Neutral", "Dominant.", { confidence: 60 }),
    s("news_report", "Bearish", "Second.", { confidence: 55 }),
  ];
  assert.deepEqual(
    companySummary(rated, "NVDA").map((i) => i.text),
    ["Dominant.", "Second."],
  );
  // Sentiment only fills in when there is nothing about the company itself.
  assert.deepEqual(
    companySummary([s("sentiment_report", "Bearish", "Only sentiment.")], "NVDA").map((i) => i.label),
    ["Sentiment"],
  );
  assert.deepEqual(companySummary(suggestions, "AAPL"), []);
  assert.deepEqual(companySummary(null, "NVDA"), []);
});

test("extractAgent carries each stance's confidence onto its suggestions", async () => {
  const { extractAgent } = await import("../server/builder/agents.js");
  const run = {
    id: "r1",
    jobs: {
      NVDA: {
        status: "completed",
        report_sections: { news_report: "x", final_trade_decision: "y" },
        section_summaries: {
          news_report: {
            categories: {
              bearish: { confidence: 70, rationale: "Why.", items: [{ label: "Export controls" }] },
              bullish: { rationale: "Unrated.", items: [{ label: "Capex guides" }] },
            },
          },
        },
      },
    },
  };
  const bySentiment = Object.fromEntries(extractAgent(run).suggestions.map((x) => [x.sentiment, x.confidence]));
  assert.deepEqual(bySentiment, { Bearish: 70, Bullish: null });
});

test("leadSentence keeps figures intact and skips a too-short opener", async () => {
  const { leadSentence, companySummary } = await import("../shared/agentReport.js");
  const text =
    "The single genuine deterioration is cash conversion: Q2 FCF fell 56% to $21.4B on a $30.7B drag. Layered on top are inventory builds.";
  assert.equal(
    leadSentence(text),
    "The single genuine deterioration is cash conversion: Q2 FCF fell 56% to $21.4B on a $30.7B drag.",
  );
  assert.equal(leadSentence("Short. Then the real point follows here."), "Short. Then the real point follows here.");
  assert.equal(leadSentence("  One sentence only.  "), "One sentence only.");
  assert.equal(leadSentence(null), "");
  const [item] = companySummary(
    [{ symbol: "NVDA", sourceSection: "news_report", sentiment: "Bearish", rationale: text }],
    "NVDA",
  );
  assert.equal(item.lead, leadSentence(text));
  assert.equal(item.text, text);
});
