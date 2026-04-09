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

db.exec(`
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

  CREATE TABLE IF NOT EXISTS strategy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    scenario_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS paper_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    strategy_id,
    scenario_json
  ) VALUES (
    @strategyId,
    @scenarioJson
  )
`);

const insertPaperOrder = db.prepare(`
  INSERT INTO paper_orders (
    strategy_id,
    combination_id,
    position_json
  ) VALUES (
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
        ORDER BY id
      `
    )
    .all();

  return rows.map((row) => ({
    ...row,
    config: JSON.parse(row.configJson),
  }));
}

export function saveStrategyRun(strategyId, scenario) {
  insertRun.run({
    strategyId,
    scenarioJson: JSON.stringify(scenario),
  });
}

export function getRecentRuns(limit = 8) {
  return db
    .prepare(
      `
        SELECT
          id,
          strategy_id AS strategyId,
          scenario_json AS scenarioJson,
          created_at AS createdAt
        FROM strategy_runs
        ORDER BY created_at DESC
        LIMIT ?
      `
    )
    .all(limit)
    .map((row) => ({
      ...row,
      scenario: JSON.parse(row.scenarioJson),
    }));
}

function mapPaperOrderRow(row) {
  return {
    ...row,
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

export function listPaperOrders(strategyId = null) {
  const rows = strategyId
    ? db
        .prepare(
          `
            SELECT
              id,
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
        .all(strategyId)
    : db
        .prepare(
          `
            SELECT
              id,
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

export default db;
