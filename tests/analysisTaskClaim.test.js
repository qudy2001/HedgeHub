import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Integration test: db-postgres.js shells out to psql and bootstraps db/init on import, so this needs a
// throwaway Postgres database. It is skipped unless HEDGEHUB_TEST_DATABASE_URL is set and psql is installed.
// On a brand-new database run integration files one at a time (--test-concurrency=1): each bootstraps the schema.
// Example: HEDGEHUB_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hedgehub_test npm test
// Both tests share this file so they never run at the same time: claiming hands out any pending task in the database.
const testUrl = process.env.HEDGEHUB_TEST_DATABASE_URL;
const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const skip = !testUrl || !hasPsql ? "set HEDGEHUB_TEST_DATABASE_URL (database name must contain 'test') and install psql" : false;

const psql = (sql) => {
  const result = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", testUrl, "-c", sql], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

test("claimNextPendingTask hands each task out once and releases stale claims", { skip }, async () => {
  assert.match(new URL(testUrl).pathname, /test/i, "refusing to run against a database whose name does not contain 'test'");
  process.env.DATABASE_URL = testUrl; // read by db-postgres.js at import time
  const db = await import("../server/db-postgres.js");

  const first = db.createAnalysisTask({ prompt: "claim test 1", scheduledFor: "2020-01-01T00:00:00Z" });
  const second = db.createAnalysisTask({ prompt: "claim test 2", scheduledFor: "2020-01-02T00:00:00Z" });
  const ids = [first.id, second.id];

  try {
    // Oldest-due first, and claiming moves it out of 'pending'.
    const claimedFirst = db.claimNextPendingTask();
    assert.equal(claimedFirst.id, first.id);
    assert.equal(claimedFirst.status, "claimed");
    assert.ok(claimedFirst.claimedAt);

    // A claimed task is not handed to a second caller.
    const claimedSecond = db.claimNextPendingTask();
    assert.equal(claimedSecond.id, second.id);
    assert.equal(db.claimNextPendingTask(), null);

    // Completed tasks stay out of the queue.
    assert.equal(db.completeAnalysisTask(first.id, "done").status, "done");
    assert.equal(db.claimNextPendingTask(), null);

    // A claim older than the timeout is released and handed out again, then locked again.
    psql(
      `UPDATE analysis_tasks SET claimed_at = NOW() - INTERVAL '${db.ANALYSIS_TASK_CLAIM_TIMEOUT_MINUTES + 1} minutes' WHERE id = ${second.id}`
    );
    const reclaimed = db.claimNextPendingTask();
    assert.equal(reclaimed.id, second.id);
    assert.equal(reclaimed.status, "claimed");
    assert.equal(db.claimNextPendingTask(), null);
  } finally {
    psql(`DELETE FROM analysis_tasks WHERE id IN (${ids.join(",")})`);
  }
});

test("listAnalysisTasks returns the newest tasks first with their prompt, topic and result", { skip }, async () => {
  assert.match(new URL(testUrl).pathname, /test/i, "refusing to run against a database whose name does not contain 'test'");
  process.env.DATABASE_URL = testUrl; // read by db-postgres.js at import time
  const db = await import("../server/db-postgres.js");

  const topic = db.createMarketTopic({ title: "List test topic", weight: 50, bullishScore: 40, bearishScore: 30, summary: "As of today." });
  const definition = db.createAnalysisTaskDefinition({ topicId: topic.id, prompt: "Definition prompt v1", cadence: "daily" });
  // Far-future dates keep these rows ahead of anything else in the database.
  const oldest = db.createAnalysisTask({
    definitionId: definition.id,
    topicId: topic.id,
    prompt: "Definition prompt v1",
    scheduledFor: "2099-01-01T00:00:00Z"
  });
  const middle = db.createAnalysisTask({ prompt: "Ad-hoc prompt\nsecond line", scheduledFor: "2099-01-02T00:00:00Z" });
  const newest = db.createAnalysisTask({
    definitionId: definition.id,
    topicId: topic.id,
    prompt: "Definition prompt v2",
    scheduledFor: "2099-01-03T00:00:00Z"
  });

  try {
    // What the AI writes back is free text: quotes, backslashes, blank lines and non-ASCII must survive the round trip.
    const writeUp = "Net +25 -> Bullish.\n\"Quoted\" and 'single', 100% sure, back\\slash, arrow \u2192, caf\u00e9\n\nSources: Reuters, 14 Oct.";
    psql(`UPDATE analysis_tasks SET status = 'claimed', claimed_at = NOW() - INTERVAL '5 minutes' WHERE id = ${oldest.id}`);
    assert.equal(db.completeAnalysisTask(oldest.id, writeUp).status, "done");
    psql(`UPDATE analysis_tasks SET status = 'claimed', claimed_at = NOW() WHERE id = ${middle.id}`);

    const [pending, claimed, done] = db.listAnalysisTasks(3);
    assert.deepEqual([pending.id, claimed.id, done.id], [newest.id, middle.id, oldest.id], "latest scheduled first");

    assert.equal(pending.status, "pending");
    assert.equal(pending.result, null);
    assert.equal(pending.claimedAt, null);
    assert.equal(pending.completedAt, null);
    assert.equal(pending.prompt, "Definition prompt v2");
    assert.equal(pending.topicId, topic.id);
    assert.equal(pending.topicTitle, "List test topic");
    assert.equal(pending.definitionId, definition.id);
    assert.ok(Date.parse(pending.scheduledFor) > Date.parse("2098-12-31"));

    assert.equal(claimed.status, "claimed");
    assert.ok(claimed.claimedAt);
    assert.equal(claimed.result, null);
    assert.equal(claimed.prompt, "Ad-hoc prompt\nsecond line");
    assert.equal(claimed.topicId, null);
    assert.equal(claimed.topicTitle, null);
    assert.equal(claimed.definitionId, null);

    assert.equal(done.status, "done");
    assert.equal(done.result, writeUp);
    assert.ok(Date.parse(done.completedAt) > Date.parse(done.claimedAt));

    // The prompt is the copy the task was created with: editing or deleting its definition does not change it.
    db.updateAnalysisTaskDefinition(definition.id, { prompt: "Edited definition prompt" });
    assert.equal(db.listAnalysisTasks(3)[0].prompt, "Definition prompt v2");
    assert.ok(db.deleteAnalysisTaskDefinition(definition.id));
    const orphan = db.listAnalysisTasks(3)[0];
    assert.equal(orphan.id, newest.id);
    assert.equal(orphan.definitionId, null);
    assert.equal(orphan.prompt, "Definition prompt v2");
    assert.equal(orphan.topicTitle, "List test topic");

    // The limit keeps the newest rows; nonsense values fall back to the default instead of failing.
    assert.deepEqual(db.listAnalysisTasks(1).map((task) => task.id), [newest.id]);
    assert.deepEqual(db.listAnalysisTasks(2.9).map((task) => task.id), [newest.id, middle.id]);
    assert.equal(db.listAnalysisTasks(-5).length, 1);
    for (const limit of [undefined, 0, "abc", NaN]) {
      const rows = db.listAnalysisTasks(limit);
      assert.ok(rows.length >= 3 && rows.length <= 50, `limit ${limit}`);
      assert.deepEqual(rows.slice(0, 3).map((task) => task.id), [newest.id, middle.id, oldest.id]);
    }
    assert.ok(db.listAnalysisTasks(100000).length <= 200);
  } finally {
    psql(`DELETE FROM analysis_tasks WHERE id IN (${oldest.id}, ${middle.id}, ${newest.id})`);
    psql(`DELETE FROM analysis_task_definitions WHERE id = ${definition.id}`);
    psql(`DELETE FROM market_topics WHERE id = ${topic.id}`);
  }
});
