import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
export const STOCK_CACHE_VERSION = "tiger-regular-nr-v1";
export function createStockVolumeStore(
  filename = process.env.STOCK_VOLUME_DB_PATH ||
    path.join(process.cwd(), "data/stock-volume.db"),
) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode=WAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS stock_volume_chunks(cache_key TEXT PRIMARY KEY,symbol TEXT NOT NULL,interval TEXT NOT NULL,from_date TEXT NOT NULL,to_date TEXT NOT NULL,fetched_at INTEGER NOT NULL,bar_count INTEGER NOT NULL,data BLOB NOT NULL);CREATE INDEX IF NOT EXISTS stock_volume_range ON stock_volume_chunks(symbol,interval,from_date,to_date);`,
  );
  const key = (s, i, w) => `${STOCK_CACHE_VERSION}:${s}:${i}:${w.from}:${w.to}`;
  return {
    filename,
    find(symbol, interval, w, now = Date.now()) {
      return db
        .prepare(
          "SELECT cache_key,fetched_at,bar_count,from_date,to_date FROM stock_volume_chunks WHERE symbol=? AND interval=? AND from_date<=? AND to_date>=? AND cache_key LIKE ? ORDER BY fetched_at DESC LIMIT 1",
        )
        .get(symbol, interval, w.from, w.to, STOCK_CACHE_VERSION + ":%");
    },
    put(symbol, interval, w, bars) {
      const id = key(symbol, interval, w);
      db.prepare(
        "INSERT OR REPLACE INTO stock_volume_chunks VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        id,
        symbol,
        interval,
        w.from,
        w.to,
        Date.now(),
        bars.length,
        deflateSync(Buffer.from(JSON.stringify(bars))),
      );
      return id;
    },
    close() {
      db.close();
    },
  };
}
