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
  const { sanitizeMarketTopicInput } = await import("../shared/marketTopics.js");

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

    // The database rejects unknown categories even if validation is bypassed.
    assert.notEqual(psql(`UPDATE market_topics SET category = 'crypto' WHERE id = ${legacy.id}`).status, 0);
  } finally {
    if (ids.length) psql(`DELETE FROM market_topics WHERE id IN (${ids.join(",")})`);
  }
});
