import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Analysis tasks live in Postgres only. The Admin "Recent runs" list must still answer on SQLite, with nothing in it.
// (The Postgres query itself is covered by the env-gated test in analysisTaskClaim.test.js.)
test("on SQLite the recent analysis task runs are an empty list, not an error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hedgehub-sqlite-"));
  process.env.DB_TYPE = "sqlite"; // db.js picks its backend when it is first imported
  process.env.SQLITE_DB_PATH = path.join(dir, "test.db"); // never open the real data/hedgehub.db
  try {
    const db = await import("../server/db.js");
    assert.deepEqual(db.listAnalysisTasks(), []);
    assert.deepEqual(db.listAnalysisTasks(10), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// server/index.js starts the whole app when imported, so the routes are checked in the source instead.
test("the task results are admin-only and the topic list needs an API key", () => {
  const source = fs.readFileSync(new URL("../server/index.js", import.meta.url), "utf8");
  assert.match(source, /app\.get\("\/api\/admin\/analysis-tasks", requireAdmin, /);
  assert.match(source, /app\.get\("\/api\/gpt\/market-topics", requireApiKey, /);
});
