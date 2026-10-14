import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Integration test: db-postgres.js shells out to psql and bootstraps db/init on import, so this needs a
// throwaway Postgres database. It is skipped unless HEDGEHUB_TEST_DATABASE_URL is set and psql is installed.
// Example: HEDGEHUB_TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/hedgehub_test npm test
const testUrl = process.env.HEDGEHUB_TEST_DATABASE_URL;
const hasPsql = spawnSync("psql", ["--version"]).status === 0;
const skip = !testUrl || !hasPsql ? "set HEDGEHUB_TEST_DATABASE_URL (database name must contain 'test') and install psql" : false;

test("claimNextPendingTask hands each task out once and releases stale claims", { skip }, async () => {
  assert.match(new URL(testUrl).pathname, /test/i, "refusing to run against a database whose name does not contain 'test'");
  process.env.DATABASE_URL = testUrl; // read by db-postgres.js at import time
  const db = await import("../server/db-postgres.js");

  const psql = (sql) => {
    const result = spawnSync("psql", ["-X", "-v", "ON_ERROR_STOP=1", testUrl, "-c", sql], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };

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
