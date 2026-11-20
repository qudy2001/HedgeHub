import assert from "node:assert/strict";
import test from "node:test";
import { DESK_LANE_ORDER, deskStatus, parseDeskSummary } from "../shared/deskStatus.js";

const NOW = new Date("2026-11-14T12:00:00Z"); // 07:00 Eastern on Saturday 14 Nov

function topic(id, title, category, updatedAt, summary, extra = {}) {
  return { id, title, category, updatedAt, summary, weight: 50, bullishScore: 40, bearishScore: 60, status: "active", symbols: [], ...extra };
}

// The shape of the first real desk run: ChatGPT rewrote its lane, the other three had not run yet.
const REGIME =
  "As of 2026-11-14 06:36 ET by ChatGPT. Stage: standing. Next check: 2026-11-16. Now: BEARISH 1-4 weeks. " +
  "Lanes: Grok As of not found DOWN; Gemini As of not found DOWN; Claude As of not found DOWN. " +
  "Flags: Grok: Social: X market mood - restore anchor/sentiment; Gemini: News: market drivers today - restore anchor/calendar; " +
  "Claude: TSLA and NVDA - recheck NVDA leadership/export news; restore anchor.";

const FIRST_RUN = [
  topic(10, "US market risk regime", "general", "2026-11-14T11:36:04Z", REGIME, { weight: 85 }),
  topic(3, "Fed policy and rate expectations", "general", "2026-11-14T11:36:05Z", "As of 2026-11-14 06:36 ET by ChatGPT. Stage: standing. Next check: 2026-11-14. Now: tightening bias.", { weight: 85 }),
  topic(7, "2026 US midterms", "general", "2026-11-14T11:36:11Z", "As of 2026-11-14 06:36 ET by ChatGPT. Stage: resolved. Next check: 2026-11-13. Now: outcome known.", { weight: 5 }),
  topic(9, "TSLA and NVDA", "ticker", "2026-10-23T01:04:35Z", "As of 2026-10-22 16:00 EDT close. Verified: TSLA $374.58.", { weight: 97, symbols: ["TSLA", "NVDA"] }),
  topic(13, "Retail sentiment on TSLA and NVDA", "social", "2026-10-23T01:04:36Z", "As of 2026-10-22 close EDT. Verified visible proxies only.", { weight: 45 }),
  topic(1, "MCP test (Claude Code)", "general", "2026-10-14T20:36:42Z", "Safe to delete.", { status: "archived" })
];

test("the summary header gives the platform, stage and next check", () => {
  assert.deepEqual(
    { ...parseDeskSummary("As of 2026-11-14 06:36 ET by Grok. Stage: fading. Next check: 2026-11-19. Now: quiet."), flags: undefined },
    { by: "grok", stage: "fading", nextCheck: "2026-11-19", flags: undefined }
  );
  assert.equal(parseDeskSummary("As of 2026-11-14 06:36 ET by ChatGPT. Stage: resolved. Next check: none.").nextCheck, "none");
  // A summary written before the desk, or with an unknown stage, is not guessed at.
  assert.deepEqual(parseDeskSummary("As of 2026-10-22 close EDT. Verified: nothing."), { by: null, stage: null, nextCheck: null, flags: [] });
  assert.equal(parseDeskSummary("As of today by Claude. Stage: paused. Next check: soon.").stage, null);
  assert.deepEqual(parseDeskSummary(null), { by: null, stage: null, nextCheck: null, flags: [] });
});

test("flags are split per lane, and a semicolon inside a request stays with it", () => {
  assert.deepEqual(parseDeskSummary(REGIME).flags, [
    { to: "grok", text: "Social: X market mood - restore anchor/sentiment" },
    { to: "gemini", text: "News: market drivers today - restore anchor/calendar" },
    { to: "claude", text: "TSLA and NVDA - recheck NVDA leadership/export news; restore anchor" }
  ]);
  assert.deepEqual(parseDeskSummary("As of now by Grok. Stage: standing. Next check: 2026-11-16. Flags: none.").flags, []);
  assert.deepEqual(parseDeskSummary("As of now by Grok. Stage: standing. Next check: 2026-11-16. Now: calm.").flags, []);
});

test("after the first ChatGPT run only that lane is running, and the others show what is waiting", () => {
  const status = deskStatus(FIRST_RUN, { now: NOW });
  assert.deepEqual(status.lanes.map((lane) => lane.id), DESK_LANE_ORDER);
  assert.equal(status.today, "2026-11-14");
  assert.equal(status.started, true);
  const lane = Object.fromEntries(status.lanes.map((entry) => [entry.id, entry]));

  assert.equal(lane.chatgpt.health, "ok");
  assert.equal(lane.chatgpt.lastWrite, "2026-11-14T11:36:11Z");
  assert.equal(lane.chatgpt.anchorState, "adopted");
  assert.deepEqual(lane.chatgpt.counts, { live: 3, unresolved: 2, due: 1, legacy: 0, archivingSoon: 0 });
  // The due topic leads; the archived test topic is not listed.
  assert.deepEqual(lane.chatgpt.topics.map((row) => row.id), [3, 10, 7]);
  assert.equal(lane.chatgpt.topics[0].due, true);
  // A resolved topic is never due, whatever date it carries.
  assert.equal(lane.chatgpt.topics.find((row) => row.id === 7).due, false);

  for (const id of ["grok", "claude", "gemini"]) {
    assert.equal(lane[id].health, "never", id);
    assert.equal(lane[id].anchorState, "missing", id);
    assert.equal(lane[id].inbox.length, 1, id);
    assert.equal(lane[id].inbox[0].from, "chatgpt");
  }
  // Topics from the old prompt sit in the lane that will adopt them and are close to being archived.
  assert.deepEqual(lane.claude.topics.map((row) => [row.title, row.legacy, row.archivingSoon, row.archivesInDays]), [["TSLA and NVDA", true, true, 8]]);
  assert.deepEqual(lane.grok.counts, { live: 1, unresolved: 1, due: 0, legacy: 1, archivingSoon: 1 });
  assert.equal(lane.gemini.counts.live, 0);
  assert.equal(status.flags.length, 3);
});

test("a lane that has gone quiet is late, and a platform writing in another lane is marked", () => {
  const header = (by, at) => `As of ${at} ET by ${by}. Stage: standing. Next check: 2026-11-16. Flags: none.`;
  const status = deskStatus(
    [
      topic(20, "Social: X market mood", "social", "2026-11-10T12:00:00Z", header("Grok", "2026-11-10 07:00")),
      topic(21, "News: market drivers today", "general", "2026-11-13T11:30:00Z", header("Gemini", "2026-11-13 06:30")),
      topic(22, "Social: meme stock squeeze", "social", "2026-11-13T12:00:00Z", header("ChatGPT", "2026-11-13 07:00"))
    ],
    { now: NOW }
  );
  const lane = Object.fromEntries(status.lanes.map((entry) => [entry.id, entry]));
  assert.equal(lane.grok.health, "late");
  assert.equal(Math.floor(lane.grok.ageDays), 4);
  assert.equal(lane.gemini.health, "ok");
  // ChatGPT wrote a Social: topic: it counts for Grok's lane, not as a ChatGPT run.
  assert.equal(lane.grok.topics.find((row) => row.id === 22).foreign, true);
  assert.equal(lane.chatgpt.health, "never");
});

test("the hub anchor follows the title the user chose, and nothing is running on an empty desk", () => {
  const custom = deskStatus(
    [topic(30, "UK market regime", "general", "2026-11-14T11:00:00Z", "As of 2026-11-14 06:00 ET by ChatGPT. Stage: standing. Next check: 2026-11-16. Flags: Claude: NVDA - check guidance.")],
    { now: NOW, anchors: { chatgpt: "UK market regime", grok: "Social: X market mood", gemini: "News: market drivers today", claude: "Research: deep-dive log" } }
  );
  assert.equal(custom.lanes.find((lane) => lane.id === "chatgpt").anchorState, "adopted");
  assert.deepEqual(custom.flags, [{ from: "chatgpt", to: "claude", text: "NVDA - check guidance" }]);

  const empty = deskStatus([], { now: NOW });
  assert.equal(empty.started, false);
  assert.ok(empty.lanes.every((lane) => lane.health === "never" && lane.topics.length === 0));
});
