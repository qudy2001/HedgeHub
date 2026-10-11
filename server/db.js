import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultStrategyConfig, sidebarStrategies } from "./marketCatalog.js";

const dataDir = path.join(process.cwd(), "data");
const dbPath = path.join(dataDir, "hedgehub.db");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function normalizeSqliteIdentifier(value) {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(`Invalid sqlite identifier: ${normalized}`);
  }
  return normalized;
}

function tableExists(tableName) {
  const name = String(tableName ?? "").trim();
  if (!name) {
    return false;
  }

  return Boolean(
    db
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'table'
            AND name = ?
        `
      )
      .get(name)
  );
}

function getTableColumns(tableName) {
  const normalizedTableName = normalizeSqliteIdentifier(tableName);
  return db.prepare(`PRAGMA table_info(${normalizedTableName})`).all();
}

function tableHasColumn(tableName, columnName) {
  const normalizedColumnName = String(columnName ?? "").trim();
  if (!normalizedColumnName) {
    return false;
  }

  try {
    return getTableColumns(tableName).some((column) => column.name === normalizedColumnName);
  } catch (_error) {
    return false;
  }
}

function migrateStrategyWatchlistTable() {
  if (!tableExists("strategy_watchlist")) {
    return;
  }

  if (tableHasColumn("strategy_watchlist", "user_id")) {
    return;
  }

  db.transaction(() => {
    db.exec(`
      ALTER TABLE strategy_watchlist RENAME TO strategy_watchlist_legacy;
      CREATE TABLE strategy_watchlist (
        user_id TEXT NOT NULL DEFAULT 'legacy',
        strategy_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, strategy_id)
      );
      INSERT INTO strategy_watchlist (
        user_id,
        strategy_id,
        created_at
      )
      SELECT
        'legacy' AS user_id,
        strategy_id,
        created_at
      FROM strategy_watchlist_legacy;
      DROP TABLE strategy_watchlist_legacy;
    `);
  })();
}

function migrateSetupWatchlistTable() {
  if (!tableExists("setup_watchlist")) {
    return;
  }

  if (tableHasColumn("setup_watchlist", "user_id")) {
    return;
  }

  db.transaction(() => {
    db.exec(`
      ALTER TABLE setup_watchlist RENAME TO setup_watchlist_legacy;
      CREATE TABLE setup_watchlist (
        user_id TEXT NOT NULL DEFAULT 'legacy',
        id TEXT NOT NULL,
        source TEXT NOT NULL,
        strategy_id TEXT NOT NULL,
        combination_id TEXT NOT NULL,
        title TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(user_id, id)
      );
      INSERT INTO setup_watchlist (
        user_id,
        id,
        source,
        strategy_id,
        combination_id,
        title,
        payload_json,
        created_at,
        updated_at
      )
      SELECT
        'legacy' AS user_id,
        id,
        source,
        strategy_id,
        combination_id,
        title,
        payload_json,
        created_at,
        updated_at
      FROM setup_watchlist_legacy;
      DROP TABLE setup_watchlist_legacy;
    `);
  })();
}

function migrateAddColumn(tableName, columnDefinition) {
  const normalizedTableName = normalizeSqliteIdentifier(tableName);
  const columnName = String(columnDefinition ?? "").trim().split(/\s+/)[0] ?? "";

  if (!columnName) {
    return;
  }

  if (tableHasColumn(normalizedTableName, columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${normalizedTableName} ADD COLUMN ${columnDefinition}`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
    ON user_sessions(user_id);
  CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
    ON user_sessions(expires_at);

  CREATE TABLE IF NOT EXISTS strategy_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    asset_label TEXT NOT NULL,
    description TEXT NOT NULL,
    config_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS strategy_watchlist (
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ,PRIMARY KEY(user_id, strategy_id)
  );

  CREATE TABLE IF NOT EXISTS setup_watchlist (
    user_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    combination_id TEXT NOT NULL,
    title TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ,PRIMARY KEY(user_id, id)
  );

  CREATE TABLE IF NOT EXISTS strategy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    scenario_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS paper_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    combination_id TEXT NOT NULL,
    position_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS paper_order_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    status TEXT NOT NULL,
    current_holding_value REAL NOT NULL,
    net_marked_value REAL NOT NULL,
    profit_loss_value REAL NOT NULL,
    profit_loss_percent REAL,
    captured_at TEXT NOT NULL,
    UNIQUE(order_id, captured_at)
  );

  CREATE TABLE IF NOT EXISTS paper_calculator_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    snapshot_name TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    price REAL,
    change_percent REAL,
    currency TEXT,
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS macro_dashboard_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payload_json TEXT NOT NULL,
    refreshed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS strategy_asset_mappings (
    id TEXT PRIMARY KEY,
    mapping_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS delta_hedge_scanner_symbols (
    symbol TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

migrateStrategyWatchlistTable();
migrateSetupWatchlistTable();
migrateAddColumn("strategy_runs", "user_id TEXT NOT NULL DEFAULT 'legacy'");
migrateAddColumn("paper_orders", "user_id TEXT NOT NULL DEFAULT 'legacy'");

db.exec(`
  CREATE INDEX IF NOT EXISTS strategy_runs_user_created_idx
    ON strategy_runs(user_id, created_at);
  CREATE INDEX IF NOT EXISTS paper_orders_user_updated_idx
    ON paper_orders(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS strategy_watchlist_user_created_idx
    ON strategy_watchlist(user_id, created_at);
  CREATE INDEX IF NOT EXISTS setup_watchlist_user_created_idx
    ON setup_watchlist(user_id, created_at);
`);

const upsertStrategy = db.prepare(`
  INSERT INTO strategy_profiles (
    id,
    name,
    status,
    asset_label,
    description,
    config_json
  ) VALUES (
    @id,
    @name,
    @status,
    @assetLabel,
    @description,
    @configJson
  )
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    status = excluded.status,
    asset_label = excluded.asset_label,
    description = excluded.description,
    config_json = excluded.config_json,
    updated_at = CURRENT_TIMESTAMP
`);

for (const strategy of sidebarStrategies) {
  const configJson = JSON.stringify(
    strategy.id === defaultStrategyConfig.id ? defaultStrategyConfig : {}
  );

  upsertStrategy.run({
    ...strategy,
    configJson,
  });
}

const insertSnapshot = db.prepare(`
  INSERT INTO market_snapshots (
    symbol,
    label,
    group_name,
    provider,
    price,
    change_percent,
    currency
  ) VALUES (
    @symbol,
    @label,
    @groupName,
    @provider,
    @price,
    @changePercent,
    @currency
  )
`);

const insertRun = db.prepare(`
  INSERT INTO strategy_runs (
    user_id,
    strategy_id,
    scenario_json
  ) VALUES (
    @userId,
    @strategyId,
    @scenarioJson
  )
`);

const insertStrategyWatchlistStatement = db.prepare(`
  INSERT OR IGNORE INTO strategy_watchlist (
    user_id,
    strategy_id
  ) VALUES (?, ?)
`);

const deleteStrategyWatchlistStatement = db.prepare(`
  DELETE FROM strategy_watchlist
  WHERE user_id = ?
    AND strategy_id = ?
`);

const upsertSetupWatchlistStatement = db.prepare(`
  INSERT INTO setup_watchlist (
    user_id,
    id,
    source,
    strategy_id,
    combination_id,
    title,
    payload_json
  ) VALUES (
    @userId,
    @id,
    @source,
    @strategyId,
    @combinationId,
    @title,
    @payloadJson
  )
  ON CONFLICT(user_id, id) DO UPDATE SET
    source = excluded.source,
    strategy_id = excluded.strategy_id,
    combination_id = excluded.combination_id,
    title = excluded.title,
    payload_json = excluded.payload_json,
    updated_at = CURRENT_TIMESTAMP
`);

const deleteSetupWatchlistStatement = db.prepare(`
  DELETE FROM setup_watchlist
  WHERE user_id = ?
    AND id = ?
`);

const insertPaperOrder = db.prepare(`
  INSERT INTO paper_orders (
    user_id,
    strategy_id,
    combination_id,
    position_json
  ) VALUES (
    @userId,
    @strategyId,
    @combinationId,
    @positionJson
  )
`);

const updatePaperOrderStatement = db.prepare(`
  UPDATE paper_orders
  SET
    strategy_id = @strategyId,
    combination_id = @combinationId,
    position_json = @positionJson,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const deletePaperOrderStatement = db.prepare(`
  DELETE FROM paper_orders
  WHERE id = ?
`);

const insertPaperOrderSnapshot = db.prepare(`
  INSERT INTO paper_order_snapshots (
    order_id,
    status,
    current_holding_value,
    net_marked_value,
    profit_loss_value,
    profit_loss_percent,
    captured_at
  ) VALUES (
    @orderId,
    @status,
    @currentHoldingValue,
    @netMarkedValue,
    @profitLossValue,
    @profitLossPercent,
    @capturedAt
  )
  ON CONFLICT(order_id, captured_at) DO UPDATE SET
    status = excluded.status,
    current_holding_value = excluded.current_holding_value,
    net_marked_value = excluded.net_marked_value,
    profit_loss_value = excluded.profit_loss_value,
    profit_loss_percent = excluded.profit_loss_percent
`);

const deletePaperOrderSnapshotsStatement = db.prepare(`
  DELETE FROM paper_order_snapshots
  WHERE order_id = ?
`);

const insertPaperCalculatorSnapshot = db.prepare(`
  INSERT INTO paper_calculator_snapshots (
    order_id,
    snapshot_name,
    snapshot_json
  ) VALUES (
    @orderId,
    @snapshotName,
    @snapshotJson
  )
`);

const deletePaperCalculatorSnapshotsStatement = db.prepare(`
  DELETE FROM paper_calculator_snapshots
  WHERE order_id = ?
`);

const insertMacroDashboardSnapshot = db.prepare(`
  INSERT INTO macro_dashboard_snapshots (
    payload_json,
    refreshed_at
  ) VALUES (
    @payloadJson,
    @refreshedAt
  )
`);

const pruneMacroDashboardSnapshots = db.prepare(`
  DELETE FROM macro_dashboard_snapshots
  WHERE id NOT IN (
    SELECT id
    FROM macro_dashboard_snapshots
    ORDER BY refreshed_at DESC
    LIMIT @keepCount
  )
`);

const upsertStrategyAssetMappingStatement = db.prepare(`
  INSERT INTO strategy_asset_mappings (
    id,
    mapping_json
  ) VALUES (
    @id,
    @mappingJson
  )
  ON CONFLICT(id) DO UPDATE SET
    mapping_json = excluded.mapping_json,
    updated_at = CURRENT_TIMESTAMP
`);

const deleteStrategyAssetMappingStatement = db.prepare(`
  DELETE FROM strategy_asset_mappings
  WHERE id = ?
`);

const upsertDeltaHedgeScannerSymbolStatement = db.prepare(`
  INSERT INTO delta_hedge_scanner_symbols (
    symbol,
    label
  ) VALUES (
    @symbol,
    @label
  )
  ON CONFLICT(symbol) DO UPDATE SET
    label = excluded.label,
    updated_at = CURRENT_TIMESTAMP
`);

const deleteDeltaHedgeScannerSymbolStatement = db.prepare(`
  DELETE FROM delta_hedge_scanner_symbols
  WHERE symbol = ?
`);

const countUsersStatement = db.prepare(`
  SELECT COUNT(*) AS userCount
  FROM users
`);

const insertUserStatement = db.prepare(`
  INSERT INTO users (
    id,
    username,
    password_hash,
    role,
    disabled
  ) VALUES (
    @id,
    @username,
    @passwordHash,
    @role,
    @disabled
  )
`);

const listUsersStatement = db.prepare(`
  SELECT
    id,
    username,
    role,
    disabled,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
  ORDER BY created_at DESC, username ASC
`);

const getUserByUsernameStatement = db.prepare(`
  SELECT
    id,
    username,
    password_hash AS passwordHash,
    role,
    disabled,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
  WHERE username = ?
  LIMIT 1
`);

const getUserByIdStatement = db.prepare(`
  SELECT
    id,
    username,
    password_hash AS passwordHash,
    role,
    disabled,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM users
  WHERE id = ?
  LIMIT 1
`);

const updateUserPasswordStatement = db.prepare(`
  UPDATE users
  SET
    password_hash = @passwordHash,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = @id
`);

const insertSessionStatement = db.prepare(`
  INSERT INTO user_sessions (
    token_hash,
    user_id,
    expires_at
  ) VALUES (
    @tokenHash,
    @userId,
    @expiresAt
  )
`);

const getSessionWithUserStatement = db.prepare(`
  SELECT
    s.token_hash AS tokenHash,
    s.user_id AS userId,
    s.created_at AS createdAt,
    s.last_seen_at AS lastSeenAt,
    s.expires_at AS expiresAt,
    u.username AS username,
    u.role AS role,
    u.disabled AS disabled
  FROM user_sessions AS s
  INNER JOIN users AS u
    ON u.id = s.user_id
  WHERE s.token_hash = ?
  LIMIT 1
`);

const touchSessionStatement = db.prepare(`
  UPDATE user_sessions
  SET last_seen_at = CURRENT_TIMESTAMP
  WHERE token_hash = ?
`);

const deleteSessionStatement = db.prepare(`
  DELETE FROM user_sessions
  WHERE token_hash = ?
`);

const deleteExpiredSessionsStatement = db.prepare(`
  DELETE FROM user_sessions
  WHERE expires_at <= ?
`);

export function getStrategies() {
  const rows = db
    .prepare(
      `
        SELECT
          id,
          name,
          status,
          asset_label AS assetLabel,
          description,
          config_json AS configJson,
          updated_at AS updatedAt
        FROM strategy_profiles
        ORDER BY
          CASE
            WHEN id = 'strategy-1' THEN 0
            WHEN id = 'strategy-tv-finder' THEN 1
            ELSE 2
          END,
          id
      `
    )
    .all();

  return rows.map((row) => ({
    ...row,
    config: JSON.parse(row.configJson),
  }));
}

export function saveStrategyRun(strategyId, scenario, userId = "legacy") {
  insertRun.run({
    userId,
    strategyId,
    scenarioJson: JSON.stringify(scenario),
  });
}

export function listStrategyWatchlist(userId = "legacy") {
  return db
    .prepare(
      `
        SELECT
          strategy_id AS strategyId,
          created_at AS createdAt
        FROM strategy_watchlist
        WHERE user_id = ?
        ORDER BY created_at DESC, strategy_id ASC
      `
    )
    .all(userId);
}

export function addStrategyToWatchlist(strategyId, userId = "legacy") {
  insertStrategyWatchlistStatement.run(userId, strategyId);
  return db
    .prepare(
      `
        SELECT
          strategy_id AS strategyId,
          created_at AS createdAt
        FROM strategy_watchlist
        WHERE user_id = ?
          AND strategy_id = ?
      `
    )
    .get(userId, strategyId);
}

export function removeStrategyFromWatchlist(strategyId, userId = "legacy") {
  return deleteStrategyWatchlistStatement.run(userId, strategyId).changes > 0;
}

export function listSetupWatchlist(userId = "legacy") {
  return db
    .prepare(
      `
        SELECT
          id,
          source,
          strategy_id AS strategyId,
          combination_id AS combinationId,
          title,
          payload_json AS payloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM setup_watchlist
        WHERE user_id = ?
        ORDER BY created_at DESC, id ASC
      `
    )
    .all(userId)
    .map((row) => ({
      ...row,
      payload: JSON.parse(row.payloadJson)
    }));
}

export function upsertSetupWatchlistItem(item, userId = "legacy") {
  upsertSetupWatchlistStatement.run({
    userId,
    id: item.id,
    source: item.source,
    strategyId: item.strategyId,
    combinationId: item.combinationId,
    title: item.title,
    payloadJson: JSON.stringify(item.payload ?? {})
  });

  const row = db
    .prepare(
      `
        SELECT
          id,
          source,
          strategy_id AS strategyId,
          combination_id AS combinationId,
          title,
          payload_json AS payloadJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM setup_watchlist
        WHERE user_id = ?
          AND id = ?
      `
    )
    .get(userId, item.id);

  return row
    ? {
        ...row,
        payload: JSON.parse(row.payloadJson)
      }
    : null;
}

export function deleteSetupWatchlistItem(id, userId = "legacy") {
  return deleteSetupWatchlistStatement.run(userId, id).changes > 0;
}

export function getRecentRuns(limit = 8, userId = "legacy") {
  return db
    .prepare(
      `
        SELECT
          id,
          strategy_id AS strategyId,
          scenario_json AS scenarioJson,
          created_at AS createdAt
        FROM strategy_runs
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(userId, limit)
    .map((row) => ({
      ...row,
      scenario: JSON.parse(row.scenarioJson),
    }));
}

function mapPaperOrderRow(row) {
  return {
    ...row,
    userId: row.userId ?? "",
    strategyId: row.strategyId,
    combinationId: row.combinationId,
    position: JSON.parse(row.positionJson)
  };
}

function getPaperOrderRow(id) {
  const row = db
    .prepare(
      `
        SELECT
          id,
          user_id AS userId,
          strategy_id AS strategyId,
          combination_id AS combinationId,
          position_json AS positionJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM paper_orders
        WHERE id = ?
      `
    )
    .get(id);

  return row ? mapPaperOrderRow(row) : null;
}

export function listPaperOrders(strategyId = null, userId = null) {
  const normalizedUserId = userId == null ? null : String(userId).trim();
  const normalizedStrategyId = strategyId == null ? null : String(strategyId).trim();

  const rows =
    normalizedUserId && normalizedStrategyId
      ? db
          .prepare(
            `
              SELECT
                id,
                user_id AS userId,
                strategy_id AS strategyId,
                combination_id AS combinationId,
                position_json AS positionJson,
                created_at AS createdAt,
                updated_at AS updatedAt
              FROM paper_orders
              WHERE user_id = ?
                AND strategy_id = ?
              ORDER BY updated_at DESC, id DESC
            `
          )
          .all(normalizedUserId, normalizedStrategyId)
      : normalizedUserId
        ? db
            .prepare(
              `
                SELECT
                  id,
                  user_id AS userId,
                  strategy_id AS strategyId,
                  combination_id AS combinationId,
                  position_json AS positionJson,
                  created_at AS createdAt,
                  updated_at AS updatedAt
                FROM paper_orders
                WHERE user_id = ?
                ORDER BY updated_at DESC, id DESC
              `
            )
            .all(normalizedUserId)
        : normalizedStrategyId
          ? db
              .prepare(
                `
                  SELECT
                    id,
                    user_id AS userId,
                    strategy_id AS strategyId,
                    combination_id AS combinationId,
                    position_json AS positionJson,
                    created_at AS createdAt,
                    updated_at AS updatedAt
                  FROM paper_orders
                  WHERE strategy_id = ?
                  ORDER BY updated_at DESC, id DESC
                `
              )
              .all(normalizedStrategyId)
          : db
              .prepare(
                `
                  SELECT
                    id,
                    user_id AS userId,
                    strategy_id AS strategyId,
                    combination_id AS combinationId,
                    position_json AS positionJson,
                    created_at AS createdAt,
                    updated_at AS updatedAt
                  FROM paper_orders
                  ORDER BY updated_at DESC, id DESC
                `
              )
              .all();

  return rows.map(mapPaperOrderRow);
}

export function createPaperOrder(order) {
  const result = insertPaperOrder.run({
    userId: order.userId ?? "legacy",
    strategyId: order.strategyId,
    combinationId: order.combinationId,
    positionJson: JSON.stringify(order)
  });

  return getPaperOrderRow(result.lastInsertRowid);
}

export function updatePaperOrder(id, order) {
  updatePaperOrderStatement.run({
    id,
    strategyId: order.strategyId,
    combinationId: order.combinationId,
    positionJson: JSON.stringify(order)
  });

  return getPaperOrderRow(id);
}

export function deletePaperOrder(id) {
  return deletePaperOrderStatement.run(id).changes > 0;
}

export function recordPaperOrderSnapshots(snapshots) {
  const insertMany = db.transaction((items) => {
    for (const snapshot of items) {
      insertPaperOrderSnapshot.run(snapshot);
    }
  });

  insertMany(snapshots ?? []);
}

export function listPaperOrderSnapshots(orderIds = null) {
  if (Array.isArray(orderIds) && orderIds.length === 0) {
    return [];
  }

  const rows =
    Array.isArray(orderIds) && orderIds.length
      ? db
          .prepare(
            `
              SELECT
                order_id AS orderId,
                status,
                current_holding_value AS currentHoldingValue,
                net_marked_value AS netMarkedValue,
                profit_loss_value AS profitLossValue,
                profit_loss_percent AS profitLossPercent,
                captured_at AS capturedAt
              FROM paper_order_snapshots
              WHERE order_id IN (${orderIds.map(() => "?").join(", ")})
              ORDER BY order_id ASC, captured_at ASC
            `
          )
          .all(...orderIds)
      : db
          .prepare(
            `
              SELECT
                order_id AS orderId,
                status,
                current_holding_value AS currentHoldingValue,
                net_marked_value AS netMarkedValue,
                profit_loss_value AS profitLossValue,
                profit_loss_percent AS profitLossPercent,
                captured_at AS capturedAt
              FROM paper_order_snapshots
              ORDER BY order_id ASC, captured_at ASC
            `
          )
          .all();

  return rows.map((row) => ({
    ...row,
    orderId: Number(row.orderId)
  }));
}

export function deletePaperOrderSnapshots(orderId) {
  return deletePaperOrderSnapshotsStatement.run(orderId).changes >= 0;
}

export function createPaperCalculatorSnapshot(orderId, snapshotName, payload) {
  const result = insertPaperCalculatorSnapshot.run({
    orderId,
    snapshotName,
    snapshotJson: JSON.stringify(payload)
  });

  const row = db
    .prepare(
      `
        SELECT
          id,
          order_id AS orderId,
          snapshot_name AS snapshotName,
          snapshot_json AS snapshotJson,
          created_at AS createdAt
        FROM paper_calculator_snapshots
        WHERE id = ?
      `
    )
    .get(result.lastInsertRowid);

  return row
    ? {
        ...row,
        orderId: Number(row.orderId),
        payload: JSON.parse(row.snapshotJson)
      }
    : null;
}

export function listPaperCalculatorSnapshots(orderIds = null) {
  if (Array.isArray(orderIds) && orderIds.length === 0) {
    return [];
  }

  const rows =
    Array.isArray(orderIds) && orderIds.length
      ? db
          .prepare(
            `
              SELECT
                id,
                order_id AS orderId,
                snapshot_name AS snapshotName,
                snapshot_json AS snapshotJson,
                created_at AS createdAt
              FROM paper_calculator_snapshots
              WHERE order_id IN (${orderIds.map(() => "?").join(", ")})
              ORDER BY created_at DESC, id DESC
            `
          )
          .all(...orderIds)
      : db
          .prepare(
            `
              SELECT
                id,
                order_id AS orderId,
                snapshot_name AS snapshotName,
                snapshot_json AS snapshotJson,
                created_at AS createdAt
              FROM paper_calculator_snapshots
              ORDER BY created_at DESC, id DESC
            `
          )
          .all();

  return rows.map((row) => ({
    ...row,
    orderId: Number(row.orderId),
    payload: JSON.parse(row.snapshotJson)
  }));
}

export function deletePaperCalculatorSnapshots(orderId) {
  return deletePaperCalculatorSnapshotsStatement.run(orderId).changes >= 0;
}

export function recordMarketSnapshots(snapshots) {
  const insertMany = db.transaction((items) => {
    for (const snapshot of items) {
      insertSnapshot.run(snapshot);
    }
  });

  insertMany(snapshots);
}

export function getLatestSnapshots() {
  return db
    .prepare(
      `
        SELECT latest.*
        FROM market_snapshots AS latest
        INNER JOIN (
          SELECT symbol, MAX(id) AS max_id
          FROM market_snapshots
          GROUP BY symbol
        ) AS grouped
          ON latest.id = grouped.max_id
        ORDER BY latest.group_name, latest.label
      `
    )
    .all()
    .map((row) => ({
      symbol: row.symbol,
      label: row.label,
      group: row.group_name,
      provider: row.provider,
      price: row.price,
      changePercent: row.change_percent,
      currency: row.currency,
      capturedAt: row.captured_at,
    }));
}

export function saveMacroDashboardSnapshot(snapshot, keepCount = 14) {
  const saveSnapshot = db.transaction((payload, retainedCount) => {
    insertMacroDashboardSnapshot.run({
      payloadJson: JSON.stringify(payload),
      refreshedAt: payload.refreshedAt
    });
    pruneMacroDashboardSnapshots.run({
      keepCount: retainedCount
    });
  });

  saveSnapshot(snapshot, keepCount);
}

export function getLatestMacroDashboardSnapshot() {
  const row = db
    .prepare(
      `
        SELECT
          payload_json AS payloadJson,
          refreshed_at AS refreshedAt
        FROM macro_dashboard_snapshots
        ORDER BY refreshed_at DESC
        LIMIT 1
      `
    )
    .get();

  if (!row) {
    return null;
  }

  const payload = JSON.parse(row.payloadJson);
  const refreshedAt = payload.refreshedAt ?? row.refreshedAt;
  const nextRefreshAt =
    payload.nextRefreshAt ?? new Date(new Date(refreshedAt).getTime() + 24 * 60 * 60 * 1000).toISOString();

  return {
    ...payload,
    refreshedAt,
    nextRefreshAt
  };
}

export function listStrategyAssetMappings() {
  return db
    .prepare(
      `
        SELECT
          id,
          mapping_json AS mappingJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM strategy_asset_mappings
        ORDER BY updated_at DESC, id ASC
      `
    )
    .all()
    .map((row) => ({
      ...JSON.parse(row.mappingJson),
      id: row.id,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
}

export function upsertStrategyAssetMapping(mapping) {
  upsertStrategyAssetMappingStatement.run({
    id: mapping.id,
    mappingJson: JSON.stringify(mapping)
  });

  return db
    .prepare(
      `
        SELECT
          id,
          mapping_json AS mappingJson,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM strategy_asset_mappings
        WHERE id = ?
      `
    )
    .get(mapping.id);
}

export function deleteStrategyAssetMapping(id) {
  return deleteStrategyAssetMappingStatement.run(id).changes > 0;
}

export function listDeltaHedgeScannerSymbols() {
  return db
    .prepare(
      `
        SELECT
          symbol,
          label,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM delta_hedge_scanner_symbols
        ORDER BY updated_at DESC, symbol ASC
      `
    )
    .all()
    .map((row) => ({
      ...row,
      isCustom: true
    }));
}

export function upsertDeltaHedgeScannerSymbol(symbolRecord) {
  upsertDeltaHedgeScannerSymbolStatement.run({
    symbol: symbolRecord.symbol,
    label: symbolRecord.label
  });

  return db
    .prepare(
      `
        SELECT
          symbol,
          label,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM delta_hedge_scanner_symbols
        WHERE symbol = ?
      `
    )
    .get(symbolRecord.symbol);
}

export function deleteDeltaHedgeScannerSymbol(symbol) {
  return deleteDeltaHedgeScannerSymbolStatement.run(symbol).changes > 0;
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function countUsers() {
  return Number(countUsersStatement.get()?.userCount ?? 0) || 0;
}

export function createUser({ id, username, passwordHash, role = "user", disabled = false } = {}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedRole = String(role ?? "user").trim().toLowerCase() === "admin" ? "admin" : "user";
  const normalizedDisabled = disabled ? 1 : 0;

  if (!id) {
    throw new Error("User id is required");
  }

  if (!normalizedUsername) {
    throw new Error("Username is required");
  }

  if (!passwordHash) {
    throw new Error("Password hash is required");
  }

  insertUserStatement.run({
    id,
    username: normalizedUsername,
    passwordHash,
    role: normalizedRole,
    disabled: normalizedDisabled
  });

  const stored = getUserById(id);
  return stored;
}

export function listUsers() {
  return listUsersStatement.all();
}

export function getUserByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return null;
  }

  return getUserByUsernameStatement.get(normalizedUsername) ?? null;
}

export function getUserById(userId) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    return null;
  }

  return getUserByIdStatement.get(normalizedId) ?? null;
}

export function setUserPassword(userId, passwordHash) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    throw new Error("User id is required");
  }

  if (!passwordHash) {
    throw new Error("Password hash is required");
  }

  return updateUserPasswordStatement.run({ id: normalizedId, passwordHash }).changes > 0;
}

export function createSession({ tokenHash, userId, expiresAt } = {}) {
  if (!tokenHash || !userId || !expiresAt) {
    throw new Error("tokenHash, userId, and expiresAt are required");
  }

  insertSessionStatement.run({
    tokenHash,
    userId,
    expiresAt
  });

  return getSessionWithUser(tokenHash);
}

export function getSessionWithUser(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return null;
  }

  return getSessionWithUserStatement.get(normalizedTokenHash) ?? null;
}

export function touchSession(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return false;
  }

  return touchSessionStatement.run(normalizedTokenHash).changes > 0;
}

export function deleteSession(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return false;
  }

  return deleteSessionStatement.run(normalizedTokenHash).changes > 0;
}

export function deleteExpiredSessions(nowIso = new Date().toISOString()) {
  const timestamp = String(nowIso ?? "").trim();
  if (!timestamp) {
    return 0;
  }

  return deleteExpiredSessionsStatement.run(timestamp).changes ?? 0;
}

export function claimLegacyUserData(userId) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    throw new Error("User id is required");
  }

  db.transaction(() => {
    db.prepare(`UPDATE paper_orders SET user_id = ? WHERE user_id = 'legacy'`).run(normalizedId);
    db.prepare(`UPDATE strategy_runs SET user_id = ? WHERE user_id = 'legacy'`).run(normalizedId);
    db.prepare(`UPDATE strategy_watchlist SET user_id = ? WHERE user_id = 'legacy'`).run(normalizedId);
    db.prepare(`UPDATE setup_watchlist SET user_id = ? WHERE user_id = 'legacy'`).run(normalizedId);
  })();
}

export default db;
