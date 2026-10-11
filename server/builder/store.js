import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
export function createBuilderStore(
  filename = process.env.BUILDER_DB_PATH ||
    path.join(process.cwd(), "data/builder.db"),
) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS studio_strategies(owner TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
    CREATE TABLE IF NOT EXISTS studio_items(owner TEXT,strategy_id TEXT,id TEXT,payload TEXT NOT NULL,PRIMARY KEY(owner,strategy_id,id));
    CREATE TABLE IF NOT EXISTS studio_jobs(owner TEXT,id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS studio_agent(owner TEXT,strategy_id TEXT,payload TEXT NOT NULL,PRIMARY KEY(owner,strategy_id));`);
  const parse = (r) => (r ? JSON.parse(r.payload) : null);
  for (const r of db.prepare("SELECT * FROM studio_jobs").all()) {
    const j = parse(r);
    if (["queued", "running"].includes(j.status)) {
      j.status = "interrupted";
      j.error = "Server restarted. Run again.";
      db.prepare("UPDATE studio_jobs SET payload=? WHERE id=?").run(
        JSON.stringify(j),
        r.id,
      );
    }
  }
  return {
    strategies(owner) {
      return db
        .prepare("SELECT * FROM studio_strategies WHERE owner=?")
        .all(owner)
        .map(parse);
    },
    allStrategies() {
      return db
        .prepare("SELECT * FROM studio_strategies")
        .all()
        .map((r) => ({ owner: r.owner, ...parse(r) }));
    },
    strategy(owner, id) {
      return parse(
        db
          .prepare("SELECT * FROM studio_strategies WHERE owner=? AND id=?")
          .get(owner, id),
      );
    },
    save(owner, id, payload) {
      const p = { ...payload, id, updatedAt: new Date().toISOString() };
      db.prepare("INSERT OR REPLACE INTO studio_strategies VALUES (?,?,?)").run(
        owner,
        id,
        JSON.stringify(p),
      );
      return p;
    },
    items(owner, id) {
      return db
        .prepare("SELECT * FROM studio_items WHERE owner=? AND strategy_id=?")
        .all(owner, id)
        .map(parse);
    },
    item(owner, strategy, id) {
      return parse(
        db
          .prepare(
            "SELECT * FROM studio_items WHERE owner=? AND strategy_id=? AND id=?",
          )
          .get(owner, strategy, id),
      );
    },
    putItem(owner, strategy, item) {
      db.prepare("INSERT OR REPLACE INTO studio_items VALUES (?,?,?,?)").run(
        owner,
        strategy,
        item.id,
        JSON.stringify(item),
      );
      return item;
    },
    removeItem(owner, strategy, id) {
      db.prepare(
        "DELETE FROM studio_items WHERE owner=? AND strategy_id=? AND id=?",
      ).run(owner, strategy, id);
    },
    job(owner, payload) {
      const job = {
        ...payload,
        id: payload.id || crypto.randomUUID(),
        updatedAt: new Date().toISOString(),
      };
      db.prepare("INSERT OR REPLACE INTO studio_jobs VALUES (?,?,?)").run(
        owner,
        job.id,
        JSON.stringify(job),
      );
      return job;
    },
    getJob(owner, id) {
      return parse(
        db
          .prepare("SELECT * FROM studio_jobs WHERE owner=? AND id=?")
          .get(owner, id),
      );
    },
    jobs(owner) {
      return db
        .prepare(
          "SELECT * FROM studio_jobs WHERE owner=? ORDER BY rowid DESC LIMIT 30",
        )
        .all(owner)
        .map(parse);
    },
    agent(owner, id) {
      return parse(
        db
          .prepare("SELECT * FROM studio_agent WHERE owner=? AND strategy_id=?")
          .get(owner, id),
      );
    },
    saveAgent(owner, id, p) {
      db.prepare("INSERT OR REPLACE INTO studio_agent VALUES (?,?,?)").run(
        owner,
        id,
        JSON.stringify(p),
      );
      return p;
    },
    close() {
      db.close();
    },
  };
}
