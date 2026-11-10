import test from "node:test";
import assert from "node:assert/strict";
import { parseAgentReport, parseInline, parseListItem } from "../shared/agentReport.js";

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
