import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createResearchStore(filename = process.env.RESEARCH_DB_PATH || path.join(process.cwd(), 'data/research.db')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (symbol TEXT, kind TEXT, provider TEXT, payload TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(symbol,kind,provider));
    CREATE TABLE IF NOT EXISTS observations (symbol TEXT, kind TEXT, provider TEXT, observed_at TEXT, payload TEXT NOT NULL, PRIMARY KEY(symbol,kind,provider,observed_at));
    CREATE TABLE IF NOT EXISTS research_snapshots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, symbol TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS research_owner_date ON research_snapshots(owner,created_at DESC);
    CREATE TABLE IF NOT EXISTS research_watchlist (owner TEXT, symbol TEXT, settings TEXT NOT NULL, PRIMARY KEY(owner,symbol));
    CREATE TABLE IF NOT EXISTS research_jobs (symbol TEXT PRIMARY KEY, last_attempt TEXT, last_success TEXT, error TEXT);
  `);
  return {
    get(symbol, kind, provider) {
      const row = db.prepare('SELECT * FROM datasets WHERE symbol=? AND kind=? AND provider=?').get(symbol, kind, provider);
      return row ? { data: JSON.parse(row.payload), updatedAt: row.updated_at } : null;
    },
    put(symbol, kind, provider, data, observedAt = new Date().toISOString()) {
      const payload = JSON.stringify(data);
      db.transaction(() => {
        db.prepare('INSERT OR REPLACE INTO datasets VALUES (?,?,?,?,?)').run(symbol, kind, provider, payload, observedAt);
        db.prepare('INSERT OR REPLACE INTO observations VALUES (?,?,?,?,?)').run(symbol, kind, provider, observedAt, payload);
        // Raw rolling datasets retained for 30 days. Saved decisions are immutable.
        db.prepare("DELETE FROM observations WHERE kind != 'features-daily' AND observed_at < datetime('now','-30 days')").run();
        db.prepare("DELETE FROM observations WHERE kind = 'features-daily' AND observed_at < date('now','-3 years')").run();
      })();
    },
    save(owner, research) {
      const id = crypto.randomUUID(), createdAt = new Date().toISOString();
      db.prepare('INSERT INTO research_snapshots VALUES (?,?,?,?,?)').run(id, owner, research.symbol, createdAt, JSON.stringify(research));
      return { id, symbol: research.symbol, createdAt };
    },
    snapshots(owner) { return db.prepare('SELECT id,symbol,created_at AS createdAt FROM research_snapshots WHERE owner=? ORDER BY created_at DESC LIMIT 50').all(owner); },
    snapshot(owner, id) {
      const r = db.prepare('SELECT * FROM research_snapshots WHERE owner=? AND id=?').get(owner, id);
      return r ? { id: r.id, symbol: r.symbol, createdAt: r.created_at, research: JSON.parse(r.payload) } : null;
    },
    watch(owner, symbol, settings) {
      db.prepare('INSERT OR REPLACE INTO research_watchlist VALUES (?,?,?)').run(owner, symbol, JSON.stringify(settings));
    },
    unwatch(owner, symbol) { db.prepare('DELETE FROM research_watchlist WHERE owner=? AND symbol=?').run(owner, symbol); },
    watches(owner) {
      const rows = owner == null ? db.prepare('SELECT * FROM research_watchlist').all() : db.prepare('SELECT * FROM research_watchlist WHERE owner=?').all(owner);
      return rows.map(r => ({ owner: r.owner, symbol: r.symbol, ...JSON.parse(r.settings) }));
    },
    job(symbol, error = null, started = false) {
      const now = new Date().toISOString();
      if (started) db.prepare('INSERT INTO research_jobs(symbol,last_attempt) VALUES (?,?) ON CONFLICT(symbol) DO UPDATE SET last_attempt=excluded.last_attempt').run(symbol, now);
      else if (error) db.prepare('UPDATE research_jobs SET error=? WHERE symbol=?').run(error, symbol);
      else db.prepare('UPDATE research_jobs SET last_success=?,error=NULL WHERE symbol=?').run(now, symbol);
    },
    jobs() { return db.prepare('SELECT * FROM research_jobs').all(); },
    close() { db.close(); }
  };
}
