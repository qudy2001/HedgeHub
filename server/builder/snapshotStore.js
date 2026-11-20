import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

// Historical Builder snapshots: what a scan returned and what each workspace panel showed, per user and symbol.
// One snapshot per symbol per US market day (New York date); a later scan that day replaces the earlier one.
// Kept in its own SQLite file, like the stock-volume cache, so large compressed chains stay out of builder.db.
export const SNAPSHOT_RETENTION_DAYS = 30;
const DAY = 86400000,
  PENDING_TTL = 10 * 60000,
  LATE_PART_WINDOW = 30 * 60000;
const nyDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export const marketDay = (ms) => nyDate.format(ms);
const nyClock = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
// True from the 09:30 New York open on a weekday until midnight. A chain fetched in that window carries the
// open interest published for the session before it; one fetched earlier, or at a weekend, may not yet.
export const afterMarketOpen = (ms) => {
  const p = Object.fromEntries(nyClock.formatToParts(ms).map((x) => [x.type, x.value]));
  return !["Sat", "Sun"].includes(p.weekday) && Number(p.hour) * 60 + Number(p.minute) >= 570;
};
const pack = (value) => deflateSync(Buffer.from(JSON.stringify(value)));
const unpack = (blob) => JSON.parse(inflateSync(blob).toString());

export function createSnapshotStore(
  filename = process.env.BUILDER_SNAPSHOT_DB_PATH ||
    path.join(process.cwd(), "data/builder-snapshots.db"),
  { retentionDays = SNAPSHOT_RETENTION_DAYS, now = Date.now } = {},
) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS builder_snapshots(id TEXT PRIMARY KEY,owner TEXT NOT NULL,symbol TEXT NOT NULL,day TEXT NOT NULL,captured_at INTEGER NOT NULL,summary TEXT NOT NULL,UNIQUE(owner,symbol,day));
    CREATE TABLE IF NOT EXISTS builder_snapshot_parts(snapshot_id TEXT NOT NULL,part TEXT NOT NULL,captured_at INTEGER NOT NULL,meta TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(snapshot_id,part));
    CREATE INDEX IF NOT EXISTS builder_snapshots_age ON builder_snapshots(captured_at);`);
  // Panel data that arrived just before its scan was saved (the scans run side by side) waits here briefly.
  const pending = new Map();
  const pendingKey = (owner, symbol, part) => `${owner}\n${symbol}\n${part}`;
  const iso = (ms) => new Date(ms).toISOString();
  const writePart = (id, part, at, meta, blob) =>
    db
      .prepare("INSERT OR REPLACE INTO builder_snapshot_parts VALUES (?,?,?,?,?,?)")
      .run(id, part, at, JSON.stringify(meta ?? {}), blob.length, blob);
  const readPart = (id, part) => {
    const r = db
      .prepare("SELECT captured_at,meta FROM builder_snapshot_parts WHERE snapshot_id=? AND part=?")
      .get(id, part);
    return r ? { capturedAt: r.captured_at, meta: JSON.parse(r.meta) } : null;
  };
  function prune(at = now()) {
    const cutoff = at - retentionDays * DAY;
    return db.transaction(() => {
      db.prepare(
        "DELETE FROM builder_snapshot_parts WHERE snapshot_id IN (SELECT id FROM builder_snapshots WHERE captured_at<?)",
      ).run(cutoff);
      return db.prepare("DELETE FROM builder_snapshots WHERE captured_at<?").run(cutoff).changes;
    })();
  }
  return {
    filename,
    retentionDays,
    // Saves one symbol's scan. Returns { id, replaced } or { id, kept: true } when an empty rescan left the
    // day's earlier scan (which had candidates) in place.
    saveScan(owner, symbol, scan, summary = {}) {
      const at = now(),
        day = marketDay(at),
        rows = scan.rows?.length ?? 0;
      const old = db
        .prepare("SELECT id,summary FROM builder_snapshots WHERE owner=? AND symbol=? AND day=?")
        .get(owner, symbol, day);
      if (old && !rows && JSON.parse(old.summary).rows > 0) return { id: old.id, kept: true };
      const id = old?.id ?? crypto.randomUUID(),
        blob = pack(scan);
      db.transaction(() => {
        db.prepare(
          "INSERT INTO builder_snapshots VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET captured_at=excluded.captured_at,summary=excluded.summary",
        ).run(id, owner, symbol, day, at, JSON.stringify({ ...summary, rows }));
        writePart(id, "scan", at, {}, blob);
        for (const [key, p] of pending) {
          if (at - p.at > PENDING_TTL) pending.delete(key);
          else if (p.owner === owner && p.symbol === symbol) {
            const existing = readPart(id, p.part);
            if (!existing || existing.capturedAt < p.at) writePart(id, p.part, p.at, p.meta, p.blob);
            pending.delete(key);
          }
        }
      })();
      prune(at);
      return { id, replaced: Boolean(old) };
    },
    // Adds panel data to today's snapshot for the symbol. `unless(existing, snapshot)` can veto a replacement;
    // `variants` caps how many parts sharing the name's prefix (before ":") are kept.
    attach(owner, symbol, part, data, { meta = {}, unless = null, variants = 0 } = {}) {
      const at = now(),
        target = db
          .prepare(
            "SELECT id,day,captured_at FROM builder_snapshots WHERE owner=? AND symbol=? ORDER BY captured_at DESC LIMIT 1",
          )
          .get(owner, symbol);
      if (!target || (target.day !== marketDay(at) && at - target.captured_at > LATE_PART_WINDOW)) {
        for (const [key, p] of pending) if (at - p.at > PENDING_TTL) pending.delete(key);
        if (pending.size >= 60) pending.delete(pending.keys().next().value);
        pending.set(pendingKey(owner, symbol, part), { owner, symbol, part, at, meta, blob: pack(data) });
        return false;
      }
      const existing = readPart(target.id, part);
      if (existing && unless?.(existing, { capturedAt: target.captured_at })) return false;
      db.transaction(() => {
        writePart(target.id, part, at, meta, pack(data));
        if (variants > 0)
          db.prepare(
            "DELETE FROM builder_snapshot_parts WHERE snapshot_id=? AND part LIKE ? AND part NOT IN (SELECT part FROM builder_snapshot_parts WHERE snapshot_id=? AND part LIKE ? ORDER BY captured_at DESC LIMIT ?)",
          ).run(target.id, part.split(":")[0] + ":%", target.id, part.split(":")[0] + ":%", variants);
      })();
      return true;
    },
    list(owner, symbol = null) {
      return db
        .prepare(
          `SELECT s.id,s.symbol,s.day,s.captured_at,s.summary,GROUP_CONCAT(p.part) AS parts,COALESCE(SUM(p.bytes),0) AS bytes
           FROM builder_snapshots s LEFT JOIN builder_snapshot_parts p ON p.snapshot_id=s.id
           WHERE s.owner=? AND (? IS NULL OR s.symbol=?) AND s.captured_at>=?
           GROUP BY s.id ORDER BY s.captured_at DESC`,
        )
        .all(owner, symbol, symbol, now() - retentionDays * DAY)
        .map((r) => ({
          id: r.id,
          symbol: r.symbol,
          day: r.day,
          capturedAt: iso(r.captured_at),
          ...JSON.parse(r.summary),
          parts: r.parts ? r.parts.split(",").sort() : [],
          bytes: r.bytes,
        }));
    },
    get(owner, id) {
      const s = db
        .prepare("SELECT * FROM builder_snapshots WHERE owner=? AND id=? AND captured_at>=?")
        .get(owner, id, now() - retentionDays * DAY);
      if (!s) return null;
      const parts = {};
      for (const p of db
        .prepare("SELECT * FROM builder_snapshot_parts WHERE snapshot_id=? ORDER BY captured_at")
        .all(id))
        parts[p.part] = { capturedAt: iso(p.captured_at), meta: JSON.parse(p.meta), data: unpack(p.data) };
      return {
        id: s.id,
        symbol: s.symbol,
        day: s.day,
        capturedAt: iso(s.captured_at),
        summary: JSON.parse(s.summary),
        parts,
      };
    },
    // One panel's data from the earliest later market day that has it, or null. `accept(capturedAtMs)` can
    // reject a day whose copy of the part was saved at an unsuitable time.
    nextPart(owner, symbol, afterDay, part, accept = () => true) {
      const hit = db
        .prepare(
          `SELECT s.id,s.day,p.captured_at FROM builder_snapshots s
           JOIN builder_snapshot_parts p ON p.snapshot_id=s.id AND p.part=?
           WHERE s.owner=? AND s.symbol=? AND s.day>? AND s.captured_at>=? ORDER BY s.day`,
        )
        .all(part, owner, symbol, afterDay, now() - retentionDays * DAY)
        .find((r) => accept(r.captured_at));
      if (!hit) return null;
      const row = db
        .prepare("SELECT data FROM builder_snapshot_parts WHERE snapshot_id=? AND part=?")
        .get(hit.id, part);
      return { id: hit.id, day: hit.day, capturedAt: iso(hit.captured_at), data: unpack(row.data) };
    },
    prune,
    close() {
      db.close();
    },
  };
}
