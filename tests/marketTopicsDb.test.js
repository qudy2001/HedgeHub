import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Integration test against a throwaway Postgres database (see tests/analysisTaskClaim.test.js for the setup).
// Skipped unless HEDGEHUB_TEST_DATABASE_URL is set and psql is installed. Each integration file bootstraps the
// schema when it imports db-postgres.js, so on a brand-new database run them one at a time
// (node --test --test-concurrency=1 ...) to avoid two files creating the same tables at once.
const testUrl = process.env.HEDGEHUB_TEST_DATABASE_URL;
const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const skip = !testUrl || !hasPsql ? "set HEDGEHUB_TEST_DATABASE_URL (database name must contain 'test') and install psql" : false;

test("market topics store category and symbols, and updates only change them when asked", { skip }, async () => {
  assert.match(new URL(testUrl).pathname, /test/i, "refusing to run against a database whose name does not contain 'test'");
  process.env.DATABASE_URL = testUrl; // read by db-postgres.js at import time
  const db = await import("../server/db-postgres.js");
  const { filterMarketTopics, parseMarketTopicFilters, sanitizeMarketTopicInput } = await import("../shared/marketTopics.js");

  const psql = (sql) => spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", testUrl, "-c", sql], { encoding: "utf8" });
  const fields = { weight: 60, bullishScore: 40, bearishScore: 55, summary: "As of today." };
  const ids = [];

  try {
    // A client that predates categories: defaults to general with no tickers.
    const legacy = db.createMarketTopic(sanitizeMarketTopicInput({ title: "DB test legacy", ...fields }));
    ids.push(legacy.id);
    assert.equal(legacy.category, "general");
    assert.deepEqual(legacy.symbols, []);

    // A ticker topic: symbols are normalised and come back as a real array.
    const ticker = db.createMarketTopic(
      sanitizeMarketTopicInput({ title: "DB test ticker", ...fields, category: "ticker", symbols: ["tsla", "nvda"] })
    );
    ids.push(ticker.id);
    assert.equal(ticker.category, "ticker");
    assert.deepEqual(ticker.symbols, ["TSLA", "NVDA"]);

    const listed = db.listMarketTopics().filter((topic) => ids.includes(topic.id));
    assert.equal(listed.length, 2);
    assert.ok(listed.every((topic) => Array.isArray(topic.symbols) && typeof topic.category === "string"));

    // The list filters (status, category, symbol) work on the stored rows.
    const filtered = (filters) => filterMarketTopics(db.listMarketTopics(), parseMarketTopicFilters(filters)).map((topic) => topic.id).filter((id) => ids.includes(id));
    assert.deepEqual(filtered({}).sort(), [...ids].sort());
    assert.deepEqual(filtered({ status: "active" }).sort(), [...ids].sort());
    assert.deepEqual(filtered({ status: "archived" }), []);
    assert.deepEqual(filtered({ category: "ticker" }), [ticker.id]);
    assert.deepEqual(filtered({ symbol: "nvda" }), [ticker.id]);
    assert.deepEqual(filtered({ symbol: "AAPL" }), []);

    // The upsert path: title match is case-insensitive and omitted fields keep the stored category and symbols.
    const existing = db.findMarketTopicByTitle("db TEST ticker");
    assert.equal(existing.id, ticker.id);
    const kept = db.updateMarketTopic(
      existing.id,
      sanitizeMarketTopicInput({ title: "DB test ticker", ...fields, weight: 75, summary: "Updated." }, existing)
    );
    assert.equal(kept.weight, 75);
    assert.equal(kept.category, "ticker");
    assert.deepEqual(kept.symbols, ["TSLA", "NVDA"]);

    // A caller that passes neither field to the data layer cannot reset them either.
    const untouched = db.updateMarketTopic(existing.id, { ...fields, weight: 80 });
    assert.equal(untouched.weight, 80);
    assert.equal(untouched.category, "ticker");
    assert.deepEqual(untouched.symbols, ["TSLA", "NVDA"]);

    // Changing the category and clearing the tickers works.
    const social = db.updateMarketTopic(
      existing.id,
      sanitizeMarketTopicInput({ title: "DB test ticker", ...fields, category: "social", symbols: [] }, existing)
    );
    assert.equal(social.category, "social");
    assert.deepEqual(social.symbols, []);

    // History records the stored analysis: identical re-writes are skipped, changes are appended newest first.
    db.recordMarketTopicHistory(social);
    db.recordMarketTopicHistory(social);
    assert.equal(db.listMarketTopicHistory(ticker.id).length, 1);
    const revised = db.updateMarketTopic(ticker.id, { ...fields, weight: 90 });
    db.recordMarketTopicHistory(revised);
    db.recordMarketTopicHistory(revised);
    const history = db.listMarketTopicHistory(ticker.id);
    assert.equal(history.length, 2);
    assert.equal(history[0].weight, 90);
    assert.equal(history[1].category, "social");

    // Chinese titles and summaries survive the round trip, and a title that differs only in width or spacing (a
    // full-width colon, a full-width space, full-width letters) is the same topic, not a new one.
    const zh = db.createMarketTopic(
      sanitizeMarketTopicInput({ title: "DB test 社交: 英伟达逼空讨论", ...fields, summary: "截至 2026-11-14 08:30 ET，由 Grok 撰写。阶段：新增。", category: "social", symbols: ["nvda"] })
    );
    ids.push(zh.id);
    assert.equal(zh.title, "DB test 社交: 英伟达逼空讨论");
    assert.equal(zh.summary, "截至 2026-11-14 08:30 ET，由 Grok 撰写。阶段：新增。");
    for (const variant of ["DB test 社交：英伟达逼空讨论", "ＤＢ　ｔｅｓｔ 社交:  英伟达逼空讨论", "db TEST 社交:英伟达逼空讨论"])
      assert.equal(db.findMarketTopicByTitle(variant)?.id, zh.id, variant);
    assert.equal(db.findMarketTopicByTitle("DB test 社交: 英伟达逼空"), null);
    // When a width variant was saved as a second row before this rule existed, the exact spelling still wins.
    const twin = db.createMarketTopic(sanitizeMarketTopicInput({ title: "DB test 社交：英伟达逼空讨论", ...fields, category: "social" }));
    ids.push(twin.id);
    assert.equal(db.findMarketTopicByTitle("DB test 社交：英伟达逼空讨论").id, twin.id);
    assert.equal(db.findMarketTopicByTitle("DB test 社交: 英伟达逼空讨论").id, zh.id);
    psql(`DELETE FROM market_topics WHERE id IN (${zh.id}, ${twin.id})`);
    ids.splice(ids.indexOf(zh.id), 2);

    // Lifecycle: stale active topics are archived, long-archived ones are deleted with their history.
    psql(`UPDATE market_topics SET updated_at = NOW() - INTERVAL '31 days' WHERE id = ${legacy.id}`);
    assert.equal(db.maintainMarketTopics().archived >= 1, true);
    assert.equal(db.findMarketTopicByTitle("DB test legacy").status, "archived");
    assert.deepEqual(filtered({ status: "archived" }), [legacy.id]);
    assert.deepEqual(filtered({ status: "active" }), [ticker.id]);
    psql(`UPDATE market_topics SET archived_at = NOW() - INTERVAL '181 days' WHERE id = ${legacy.id}`);
    assert.equal(db.maintainMarketTopics().removed >= 1, true);
    assert.equal(db.findMarketTopicByTitle("DB test legacy"), null);
    ids.splice(ids.indexOf(legacy.id), 1);
    // A new update reactivates an archived topic.
    psql(`UPDATE market_topics SET status = 'archived', archived_at = NOW() WHERE id = ${ticker.id}`);
    assert.equal(db.updateMarketTopic(ticker.id, { ...fields }).status, "active");

    // The database rejects unknown categories even if validation is bypassed.
    assert.notEqual(psql(`UPDATE market_topics SET category = 'crypto' WHERE id = ${ticker.id}`).status, 0);
  } finally {
    if (ids.length) psql(`DELETE FROM market_topics WHERE id IN (${ids.join(",")})`);
  }
});
