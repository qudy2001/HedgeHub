import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { addDays } from "../../shared/builderEngine.js";

const RETENTION_DAYS = 400;
const FIELDS = [
  "contractSymbol",
  "expiration",
  "strike",
  "optionType",
  "volume",
  "openInterest",
  "lastPrice",
  "bid",
  "ask",
  "multiplier",
];
const contractKey = (c) =>
  c.contractSymbol || `${c.expiration}:${c.strike}:${c.optionType}`;

// The US session a chain fetched at `at` describes, or null when it should not
// be stored. Before the open the chain still carries the previous session's
// volume next to the new open-interest count, so saving it would mix two days.
export function sessionDate(at = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(at))
      .map((p) => [p.type, p.value]),
  );
  if (["Sat", "Sun"].includes(parts.weekday)) return null;
  if (Number(parts.hour) * 60 + Number(parts.minute) < 9 * 60 + 30) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function createDistributionSnapshotStore(
  filename = process.env.OPTION_SNAPSHOT_DB_PATH ||
    path.join(process.cwd(), "data/option-snapshots.db"),
) {
  if (filename !== ":memory:")
    fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma("journal_mode=WAL");
  db.exec(
    `CREATE TABLE IF NOT EXISTS option_chain_snapshots(symbol TEXT NOT NULL,session_date TEXT NOT NULL,captured_at TEXT NOT NULL,source TEXT,horizon_days INTEGER NOT NULL,complete INTEGER NOT NULL,contract_count INTEGER NOT NULL,total_volume INTEGER NOT NULL,total_oi INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(symbol,session_date));`,
  );
  const meta =
    "symbol,session_date AS date,captured_at AS capturedAt,source,horizon_days AS horizonDays,complete,contract_count AS contracts,total_volume AS totalVolume,total_oi AS totalOpenInterest";
  const unpack = (row) =>
    JSON.parse(inflateSync(row.data).toString()).map((values) =>
      Object.fromEntries(FIELDS.map((field, i) => [field, values[i] ?? null])),
    );
  return {
    filename,
    // One row per symbol and session: each later fetch in the same session
    // replaces the earlier one, so the stored row ends up closest to the close.
    save(data, days, at = Date.now()) {
      const date = sessionDate(at),
        contracts = data?.contracts ?? [];
      if (!date) return { saved: false, reason: "outside-session" };
      if (!contracts.length) return { saved: false, reason: "empty" };
      const sum = (field) =>
          Math.round(
            contracts.reduce((t, c) => t + (Number(c[field]) || 0), 0),
          ),
        totalVolume = sum("volume"),
        totalOi = sum("openInterest"),
        complete = data.complete === false ? 0 : 1;
      const current = db
        .prepare(
          `SELECT ${meta} FROM option_chain_snapshots WHERE symbol=? AND session_date=?`,
        )
        .get(data.symbol, date);
      if (current && current.complete && !complete)
        return { saved: false, reason: "would-replace-complete" };
      if (current && current.horizonDays > days)
        return { saved: false, reason: "shorter-horizon" };
      const previous = db
        .prepare(
          `SELECT ${meta} FROM option_chain_snapshots WHERE symbol=? AND session_date<? ORDER BY session_date DESC LIMIT 1`,
        )
        .get(data.symbol, date);
      // A market holiday returns the previous session's numbers unchanged.
      if (
        previous &&
        previous.totalVolume === totalVolume &&
        previous.totalOpenInterest === totalOi
      )
        return { saved: false, reason: "unchanged-since-previous-session" };
      db.prepare(
        "INSERT OR REPLACE INTO option_chain_snapshots VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        data.symbol,
        date,
        new Date(at).toISOString(),
        data.source ?? null,
        days,
        complete,
        contracts.length,
        totalVolume,
        totalOi,
        deflateSync(
          Buffer.from(
            JSON.stringify(
              contracts.map((c) => FIELDS.map((field) => c[field] ?? null)),
            ),
          ),
        ),
      );
      db.prepare(
        "DELETE FROM option_chain_snapshots WHERE session_date<?",
      ).run(addDays(date, -RETENTION_DAYS));
      return { saved: true, date };
    },
    sessions(symbol) {
      return db
        .prepare(
          `SELECT ${meta} FROM option_chain_snapshots WHERE symbol=? ORDER BY session_date DESC`,
        )
        .all(symbol)
        .map((row) => ({ ...row, complete: Boolean(row.complete) }));
    },
    // The stored chain for one session. Where a later session is stored too,
    // each contract carries that session's open interest, which is the first
    // count that includes the positions opened on `date`.
    load(symbol, date, days = 730) {
      const row = db
        .prepare(
          "SELECT * FROM option_chain_snapshots WHERE symbol=? AND session_date=?",
        )
        .get(symbol, date);
      if (!row) return null;
      const next = db
        .prepare(
          "SELECT session_date,data FROM option_chain_snapshots WHERE symbol=? AND session_date>? ORDER BY session_date ASC LIMIT 1",
        )
        .get(symbol, date);
      const nextOi = next
          ? new Map(unpack(next).map((c) => [contractKey(c), c.openInterest]))
          : null,
        to = addDays(date, Math.min(days, row.horizon_days));
      return {
        symbol,
        contracts: unpack(row)
          .filter((c) => c.expiration <= to)
          .map((c) =>
            nextOi
              ? { ...c, nextOpenInterest: nextOi.get(contractKey(c)) ?? null }
              : c,
          ),
        source: row.source,
        asOf: row.captured_at,
        sessionDate: date,
        nextSessionDate: next?.session_date ?? null,
        historical: true,
        from: date,
        to,
        complete: Boolean(row.complete),
        warnings:
          row.horizon_days < days
            ? [
                `This session was stored with a ${row.horizon_days}-day horizon.`,
              ]
            : [],
      };
    },
    close() {
      db.close();
    },
  };
}
