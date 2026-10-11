import "./env.js";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { defaultStrategyConfig, sidebarStrategies } from "./marketCatalog.js";

const dataDir = process.env.SQLITE_DATA_DIR
  ? path.resolve(process.cwd(), process.env.SQLITE_DATA_DIR)
  : path.join(process.cwd(), "data");
const dbPath = process.env.SQLITE_DB_PATH
  ? path.resolve(process.cwd(), process.env.SQLITE_DB_PATH)
  : path.join(dataDir, "hedgehub.db");

if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    revoked_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS user_api_keys_user_created_idx
    ON user_api_keys(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS user_api_keys_active_token_idx
    ON user_api_keys(token_hash, revoked_at);

  CREATE TABLE IF NOT EXISTS gpt_api_request_logs (
    id TEXT PRIMARY KEY,
    system_name TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    ip_address TEXT,
    user_id TEXT,
    username TEXT,
    api_key_id TEXT,
    api_key_label TEXT,
    api_key_prefix TEXT,
    auth_status TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_time_ms REAL,
    request_ticker TEXT,
    expected_price_range_low REAL,
    expected_price_range_high REAL,
    option_expiration_start_date TEXT,
    option_expiration_end_date TEXT,
    request_body_json TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY(api_key_id) REFERENCES user_api_keys(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS gpt_api_request_logs_created_idx
    ON gpt_api_request_logs(created_at DESC);

  CREATE INDEX IF NOT EXISTS gpt_api_request_logs_user_created_idx
    ON gpt_api_request_logs(user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS gpt_api_request_logs_api_key_created_idx
    ON gpt_api_request_logs(api_key_id, created_at DESC);

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

  CREATE TABLE IF NOT EXISTS scanner_presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, scanner_type, name)
  );

  CREATE TABLE IF NOT EXISTS scanner_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    strategy_id TEXT,
    preset_id INTEGER,
    config_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    market_regime_json TEXT,
    candidate_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scanner_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scanner_run_id INTEGER NOT NULL,
    scanner_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    rank_position INTEGER,
    score REAL,
    payload_json TEXT NOT NULL,
    explanation_data TEXT,
    risk_flags TEXT,
    portfolio_impact_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS scanner_promotions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    scanner_run_id INTEGER,
    scanner_candidate_id INTEGER,
    paper_order_id INTEGER,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    promotion_status TEXT NOT NULL DEFAULT 'paper_trade',
    notes_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS candidate_rank_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    scanner_candidate_id INTEGER,
    scanner_run_id INTEGER,
    score REAL,
    rank_position INTEGER,
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

  CREATE TABLE IF NOT EXISTS iv30_history (
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    underlying_price REAL,
    iv30 REAL,
    atm_call_iv REAL,
    atm_put_iv REAL,
    near_expiry TEXT,
    far_expiry TEXT,
    near_dte INTEGER,
    far_dte INTEGER,
    option_volume INTEGER,
    open_interest INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(date, symbol)
  );

  CREATE TABLE IF NOT EXISTS iv_rank_daily (
    date TEXT NOT NULL,
    symbol TEXT NOT NULL,
    iv30 REAL,
    iv30_min_52w REAL,
    iv30_max_52w REAL,
    iv_rank_52w REAL,
    iv_percentile_52w REAL,
    hv20 REAL,
    hv252 REAL,
    PRIMARY KEY(date, symbol)
  );

  CREATE TABLE IF NOT EXISTS market_regime_daily (
    date TEXT PRIMARY KEY,
    market_regime TEXT,
    volatility_regime TEXT,
    trend_regime TEXT,
    liquidity_regime TEXT,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

migrateStrategyWatchlistTable();
migrateSetupWatchlistTable();
migrateAddColumn("strategy_runs", "user_id TEXT NOT NULL DEFAULT 'legacy'");
migrateAddColumn("paper_orders", "user_id TEXT NOT NULL DEFAULT 'legacy'");

db.exec(`
  CREATE INDEX IF NOT EXISTS strategy_runs_user_created_idx
    ON strategy_runs(user_id, created_at);
  CREATE INDEX IF NOT EXISTS scanner_presets_user_type_updated_idx
    ON scanner_presets(user_id, scanner_type, updated_at);
  CREATE INDEX IF NOT EXISTS scanner_runs_user_type_created_idx
    ON scanner_runs(user_id, scanner_type, created_at);
  CREATE INDEX IF NOT EXISTS scanner_candidates_run_rank_idx
    ON scanner_candidates(scanner_run_id, rank_position);
  CREATE INDEX IF NOT EXISTS scanner_candidates_type_symbol_created_idx
    ON scanner_candidates(scanner_type, symbol, created_at);
  CREATE INDEX IF NOT EXISTS candidate_rank_history_user_lookup_idx
    ON candidate_rank_history(user_id, scanner_type, symbol, created_at);
  CREATE INDEX IF NOT EXISTS candidate_rank_history_run_idx
    ON candidate_rank_history(scanner_run_id, rank_position);
  CREATE INDEX IF NOT EXISTS scanner_promotions_user_type_created_idx
    ON scanner_promotions(user_id, scanner_type, created_at);
  CREATE INDEX IF NOT EXISTS paper_orders_user_updated_idx
    ON paper_orders(user_id, updated_at);
  CREATE INDEX IF NOT EXISTS strategy_watchlist_user_created_idx
    ON strategy_watchlist(user_id, created_at);
  CREATE INDEX IF NOT EXISTS setup_watchlist_user_created_idx
    ON setup_watchlist(user_id, created_at);
  CREATE INDEX IF NOT EXISTS iv30_history_symbol_date_idx
    ON iv30_history(symbol, date DESC);
  CREATE INDEX IF NOT EXISTS iv_rank_daily_symbol_date_idx
    ON iv_rank_daily(symbol, date DESC);
  CREATE INDEX IF NOT EXISTS market_regime_daily_date_idx
    ON market_regime_daily(date);
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

const insertUserApiKeyStatement = db.prepare(`
  INSERT INTO user_api_keys (
    id,
    user_id,
    label,
    token_hash,
    token_prefix
  ) VALUES (
    @id,
    @userId,
    @label,
    @tokenHash,
    @tokenPrefix
  )
`);

const listUserApiKeysStatement = db.prepare(`
  SELECT
    k.id,
    k.user_id AS userId,
    u.username AS username,
    k.label,
    k.token_prefix AS tokenPrefix,
    k.revoked_at AS revokedAt,
    k.last_used_at AS lastUsedAt,
    k.created_at AS createdAt,
    k.updated_at AS updatedAt
  FROM user_api_keys k
  INNER JOIN users u
    ON u.id = k.user_id
  ORDER BY
    CASE WHEN k.revoked_at IS NULL THEN 0 ELSE 1 END,
    k.created_at DESC,
    k.label ASC
`);

const getUserApiKeyWithUserStatement = db.prepare(`
  SELECT
    k.id,
    k.user_id AS userId,
    u.username AS username,
    u.role AS role,
    u.disabled AS disabled,
    k.label,
    k.token_hash AS tokenHash,
    k.token_prefix AS tokenPrefix,
    k.revoked_at AS revokedAt,
    k.last_used_at AS lastUsedAt,
    k.created_at AS createdAt,
    k.updated_at AS updatedAt
  FROM user_api_keys k
  INNER JOIN users u
    ON u.id = k.user_id
  WHERE k.token_hash = ?
  LIMIT 1
`);

const touchUserApiKeyStatement = db.prepare(`
  UPDATE user_api_keys
  SET
    last_used_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
    AND revoked_at IS NULL
`);

const revokeUserApiKeyStatement = db.prepare(`
  UPDATE user_api_keys
  SET
    revoked_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = ?
    AND revoked_at IS NULL
`);

const insertGptApiRequestLogStatement = db.prepare(`
  INSERT INTO gpt_api_request_logs (
    id,
    system_name,
    method,
    path,
    ip_address,
    user_id,
    username,
    api_key_id,
    api_key_label,
    api_key_prefix,
    auth_status,
    status_code,
    response_time_ms,
    request_ticker,
    expected_price_range_low,
    expected_price_range_high,
    option_expiration_start_date,
    option_expiration_end_date,
    request_body_json,
    error_message
  ) VALUES (
    @id,
    @systemName,
    @method,
    @path,
    @ipAddress,
    @userId,
    @username,
    @apiKeyId,
    @apiKeyLabel,
    @apiKeyPrefix,
    @authStatus,
    @statusCode,
    @responseTimeMs,
    @requestTicker,
    @expectedPriceRangeLow,
    @expectedPriceRangeHigh,
    @optionExpirationStartDate,
    @optionExpirationEndDate,
    @requestBodyJson,
    @errorMessage
  )
`);

const listGptApiRequestLogsStatement = db.prepare(`
  SELECT
    id,
    system_name AS systemName,
    method,
    path,
    ip_address AS ipAddress,
    user_id AS userId,
    username,
    api_key_id AS apiKeyId,
    api_key_label AS apiKeyLabel,
    api_key_prefix AS apiKeyPrefix,
    auth_status AS authStatus,
    status_code AS statusCode,
    response_time_ms AS responseTimeMs,
    request_ticker AS requestTicker,
    expected_price_range_low AS expectedPriceRangeLow,
    expected_price_range_high AS expectedPriceRangeHigh,
    option_expiration_start_date AS optionExpirationStartDate,
    option_expiration_end_date AS optionExpirationEndDate,
    request_body_json AS requestBodyJson,
    error_message AS errorMessage,
    created_at AS createdAt
  FROM gpt_api_request_logs
  ORDER BY created_at DESC
  LIMIT ?
`);

const summarizeGptApiRequestLogsStatement = db.prepare(`
  SELECT
    COUNT(*) AS totalRequests,
    SUM(CASE WHEN status_code >= 200 AND status_code < 300 THEN 1 ELSE 0 END) AS successCount,
    SUM(CASE WHEN auth_status = 'authorized' THEN 1 ELSE 0 END) AS authorizedCount,
    SUM(CASE WHEN auth_status != 'authorized' THEN 1 ELSE 0 END) AS unknownCount,
    COUNT(DISTINCT COALESCE(ip_address, '')) AS uniqueIpCount,
    COUNT(DISTINCT COALESCE(user_id, '')) AS uniqueUserCount,
    ROUND(AVG(response_time_ms), 1) AS averageResponseTimeMs,
    MAX(created_at) AS latestRequestAt
  FROM gpt_api_request_logs
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

const getAppSettingStatement = db.prepare(`
  SELECT
    key,
    value_json AS valueJson,
    created_at AS createdAt,
    updated_at AS updatedAt
  FROM app_settings
  WHERE key = ?
  LIMIT 1
`);

const upsertAppSettingStatement = db.prepare(`
  INSERT INTO app_settings (
    key,
    value_json
  ) VALUES (
    @key,
    @valueJson
  )
  ON CONFLICT(key) DO UPDATE SET
    value_json = excluded.value_json,
    updated_at = CURRENT_TIMESTAMP
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
  const statement =
    userId == null
      ? db.prepare(
          `
            SELECT
              user_id AS userId,
              id,
              source,
              strategy_id AS strategyId,
              combination_id AS combinationId,
              title,
              payload_json AS payloadJson,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM setup_watchlist
            ORDER BY created_at DESC, id ASC
          `
        )
      : db.prepare(
          `
            SELECT
              user_id AS userId,
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
        );

  return statement
    .all(...(userId == null ? [] : [userId]))
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

export function upsertScannerPreset({ scannerType, name, config = {}, isDefault = false }, userId = "legacy") {
  db.prepare(
    `
      INSERT INTO scanner_presets (
        user_id,
        scanner_type,
        name,
        config_json,
        is_default
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, scanner_type, name) DO UPDATE SET
        config_json = excluded.config_json,
        is_default = excluded.is_default,
        updated_at = CURRENT_TIMESTAMP
    `
  ).run(userId, scannerType, name, JSON.stringify(config ?? {}), isDefault ? 1 : 0);

  return db
    .prepare(
      `
        SELECT
          id,
          scanner_type AS scannerType,
          name,
          config_json AS configJson,
          is_default AS isDefault,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM scanner_presets
        WHERE user_id = ?
          AND scanner_type = ?
          AND name = ?
        LIMIT 1
      `
    )
    .get(userId, scannerType, name);
}

export function listScannerPresets(scannerType, userId = "legacy") {
  return db
    .prepare(
      `
        SELECT
          id,
          scanner_type AS scannerType,
          name,
          config_json AS configJson,
          is_default AS isDefault,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM scanner_presets
        WHERE user_id = ?
          AND scanner_type = ?
        ORDER BY is_default DESC, updated_at DESC, id DESC
      `
    )
    .all(userId, scannerType)
    .map((row) => ({
      ...row,
      isDefault: Boolean(row.isDefault),
      config: JSON.parse(row.configJson)
    }));
}

export function saveScannerRun(run, userId = "legacy") {
  const transaction = db.transaction((payload) => {
    const runInsert = db.prepare(
      `
        INSERT INTO scanner_runs (
          user_id,
          scanner_type,
          strategy_id,
          preset_id,
          config_json,
          summary_json,
          market_regime_json,
          candidate_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    ).run(
      userId,
      payload.scannerType,
      payload.strategyId ?? null,
      payload.presetId ?? null,
      JSON.stringify(payload.config ?? {}),
      JSON.stringify(payload.summary ?? {}),
      payload.marketRegime ? JSON.stringify(payload.marketRegime) : null,
      Array.isArray(payload.rows) ? payload.rows.length : 0
    );

    const scannerRunId = Number(runInsert.lastInsertRowid);
    const insertCandidate = db.prepare(
      `
        INSERT INTO scanner_candidates (
          scanner_run_id,
          scanner_type,
          symbol,
          strategy_type,
          rank_position,
          score,
          payload_json,
          explanation_data,
          risk_flags,
          portfolio_impact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
    );
    const insertRankHistory = db.prepare(
      `
        INSERT INTO candidate_rank_history (
          user_id,
          scanner_type,
          symbol,
          strategy_type,
          scanner_candidate_id,
          scanner_run_id,
          score,
          rank_position
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `
    );

    const storedRows = (payload.rows ?? []).map((row, index) => {
      const result = insertCandidate.run(
        scannerRunId,
        payload.scannerType,
        String(row.symbol ?? "").trim().toUpperCase(),
        row.strategyType ?? null,
        index + 1,
        row.scoreValue ?? null,
        JSON.stringify(row.payload ?? row),
        JSON.stringify(row.explanationData ?? {}),
        JSON.stringify(row.riskFlags ?? []),
        JSON.stringify(row.portfolioImpact ?? {})
      );
      const scannerCandidateId = Number(result.lastInsertRowid);
      insertRankHistory.run(
        userId,
        payload.scannerType,
        String(row.symbol ?? "").trim().toUpperCase(),
        row.strategyType ?? null,
        scannerCandidateId,
        scannerRunId,
        row.scoreValue ?? null,
        index + 1
      );
      return {
        ...row,
        scannerCandidateId,
        rankPosition: index + 1
      };
    });

    return {
      id: scannerRunId,
      rows: storedRows
    };
  });

  return transaction(run);
}

export function getLatestScannerRun(scannerType, userId = "legacy", includeRows = true) {
  const run = db
    .prepare(
      `
        SELECT
          id,
          scanner_type AS scannerType,
          strategy_id AS strategyId,
          preset_id AS presetId,
          config_json AS configJson,
          summary_json AS summaryJson,
          market_regime_json AS marketRegimeJson,
          candidate_count AS candidateCount,
          created_at AS createdAt
        FROM scanner_runs
        WHERE user_id = ?
          AND scanner_type = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `
    )
    .get(userId, scannerType);

  if (!run) {
    return null;
  }

  return {
    ...run,
    config: JSON.parse(run.configJson),
    summary: JSON.parse(run.summaryJson),
    marketRegime: run.marketRegimeJson ? JSON.parse(run.marketRegimeJson) : null,
    rows: includeRows
      ? db
          .prepare(
            `
              SELECT
                id,
                symbol,
                strategy_type AS strategyType,
                rank_position AS rankPosition,
                score,
                payload_json AS payloadJson,
                explanation_data AS explanationDataJson,
                risk_flags AS riskFlagsJson,
                portfolio_impact_json AS portfolioImpactJson,
                created_at AS createdAt
              FROM scanner_candidates
              WHERE scanner_run_id = ?
              ORDER BY rank_position ASC, id ASC
            `
          )
          .all(run.id)
          .map((row) => ({
            ...row,
            payload: JSON.parse(row.payloadJson),
            explanationData: row.explanationDataJson ? JSON.parse(row.explanationDataJson) : {},
            riskFlags: row.riskFlagsJson ? JSON.parse(row.riskFlagsJson) : [],
            portfolioImpact: row.portfolioImpactJson ? JSON.parse(row.portfolioImpactJson) : {}
          }))
      : []
  };
}

export function listCandidateRankHistory(scannerType, symbol, strategyType = null, userId = "legacy", limit = 12) {
  return db
    .prepare(
      `
        SELECT
          id,
          scanner_candidate_id AS scannerCandidateId,
          scanner_run_id AS scannerRunId,
          score,
          rank_position AS rankPosition,
          created_at AS createdAt
        FROM candidate_rank_history
        WHERE user_id = ?
          AND scanner_type = ?
          AND symbol = ?
          AND (? IS NULL OR strategy_type = ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `
    )
    .all(userId, scannerType, String(symbol ?? "").trim().toUpperCase(), strategyType, strategyType, limit);
}

export function upsertIv30History(snapshot = {}) {
  const symbol = String(snapshot.symbol ?? "").trim().toUpperCase();
  const date = String(snapshot.date ?? "").trim();
  if (!symbol || !date) {
    throw new Error("symbol and date are required for iv30 history");
  }

  db.prepare(
    `
      INSERT INTO iv30_history (
        date,
        symbol,
        underlying_price,
        iv30,
        atm_call_iv,
        atm_put_iv,
        near_expiry,
        far_expiry,
        near_dte,
        far_dte,
        option_volume,
        open_interest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, symbol) DO UPDATE SET
        underlying_price = excluded.underlying_price,
        iv30 = excluded.iv30,
        atm_call_iv = excluded.atm_call_iv,
        atm_put_iv = excluded.atm_put_iv,
        near_expiry = excluded.near_expiry,
        far_expiry = excluded.far_expiry,
        near_dte = excluded.near_dte,
        far_dte = excluded.far_dte,
        option_volume = excluded.option_volume,
        open_interest = excluded.open_interest
    `
  ).run(
    date,
    symbol,
    snapshot.underlyingPrice ?? null,
    snapshot.iv30 ?? null,
    snapshot.atmCallIv ?? null,
    snapshot.atmPutIv ?? null,
    snapshot.nearExpiry ?? null,
    snapshot.farExpiry ?? null,
    snapshot.nearDte ?? null,
    snapshot.farDte ?? null,
    snapshot.optionVolume ?? null,
    snapshot.openInterest ?? null
  );
}

export function listIv30History(symbol, limit = 252) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!normalizedSymbol) {
    return [];
  }

  return db
    .prepare(
      `
        SELECT
          date,
          symbol,
          underlying_price AS underlyingPrice,
          iv30,
          atm_call_iv AS atmCallIv,
          atm_put_iv AS atmPutIv,
          near_expiry AS nearExpiry,
          far_expiry AS farExpiry,
          near_dte AS nearDte,
          far_dte AS farDte,
          option_volume AS optionVolume,
          open_interest AS openInterest,
          created_at AS createdAt
        FROM iv30_history
        WHERE symbol = ?
        ORDER BY date DESC
        LIMIT ?
      `
    )
    .all(normalizedSymbol, Math.max(Number(limit) || 0, 0));
}

export function upsertIvRankDaily(metrics = {}) {
  const symbol = String(metrics.symbol ?? "").trim().toUpperCase();
  const date = String(metrics.date ?? "").trim();
  if (!symbol || !date) {
    throw new Error("symbol and date are required for iv_rank_daily");
  }

  db.prepare(
    `
      INSERT INTO iv_rank_daily (
        date,
        symbol,
        iv30,
        iv30_min_52w,
        iv30_max_52w,
        iv_rank_52w,
        iv_percentile_52w,
        hv20,
        hv252
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, symbol) DO UPDATE SET
        iv30 = excluded.iv30,
        iv30_min_52w = excluded.iv30_min_52w,
        iv30_max_52w = excluded.iv30_max_52w,
        iv_rank_52w = excluded.iv_rank_52w,
        iv_percentile_52w = excluded.iv_percentile_52w,
        hv20 = excluded.hv20,
        hv252 = excluded.hv252
    `
  ).run(
    date,
    symbol,
    metrics.iv30 ?? null,
    metrics.iv30Min52w ?? null,
    metrics.iv30Max52w ?? null,
    metrics.ivRank52w ?? null,
    metrics.ivPercentile52w ?? null,
    metrics.hv20 ?? null,
    metrics.hv252 ?? null
  );
}

export function getLatestIvRankDaily(symbol, asOfDate = null) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }

  return db
    .prepare(
      `
        SELECT
          date,
          symbol,
          iv30,
          iv30_min_52w AS iv30Min52w,
          iv30_max_52w AS iv30Max52w,
          iv_rank_52w AS ivRank52w,
          iv_percentile_52w AS ivPercentile52w,
          hv20,
          hv252
        FROM iv_rank_daily
        WHERE symbol = ?
          AND (? IS NULL OR date <= ?)
        ORDER BY date DESC
        LIMIT 1
      `
    )
    .get(normalizedSymbol, asOfDate ?? null, asOfDate ?? null);
}

export function createScannerPromotion(promotion, userId = "legacy") {
  const result = db.prepare(
    `
      INSERT INTO scanner_promotions (
        user_id,
        scanner_type,
        scanner_run_id,
        scanner_candidate_id,
        paper_order_id,
        symbol,
        strategy_type,
        promotion_status,
        notes_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    userId,
    promotion.scannerType,
    promotion.scannerRunId ?? null,
    promotion.scannerCandidateId ?? null,
    promotion.paperOrderId ?? null,
    String(promotion.symbol ?? "").trim().toUpperCase(),
    promotion.strategyType ?? null,
    promotion.promotionStatus ?? "paper_trade",
    JSON.stringify(promotion.notes ?? {})
  );

  return db
    .prepare(
      `
        SELECT
          id,
          scanner_type AS scannerType,
          scanner_run_id AS scannerRunId,
          scanner_candidate_id AS scannerCandidateId,
          paper_order_id AS paperOrderId,
          symbol,
          strategy_type AS strategyType,
          promotion_status AS promotionStatus,
          notes_json AS notesJson,
          created_at AS createdAt
        FROM scanner_promotions
        WHERE id = ?
      `
    )
    .get(result.lastInsertRowid);
}

export function listScannerPromotions(userId = null, limit = 100) {
  const statement =
    userId == null
      ? db.prepare(
          `
            SELECT
              promotions.id,
              promotions.user_id AS userId,
              promotions.scanner_type AS scannerType,
              promotions.scanner_run_id AS scannerRunId,
              promotions.scanner_candidate_id AS scannerCandidateId,
              promotions.paper_order_id AS paperOrderId,
              promotions.symbol,
              promotions.strategy_type AS strategyType,
              promotions.promotion_status AS promotionStatus,
              promotions.notes_json AS notesJson,
              candidates.payload_json AS candidatePayloadJson,
              promotions.created_at AS createdAt
            FROM scanner_promotions AS promotions
            LEFT JOIN scanner_candidates AS candidates
              ON candidates.id = promotions.scanner_candidate_id
            ORDER BY promotions.created_at DESC, promotions.id DESC
            LIMIT ?
          `
        )
      : db.prepare(
          `
            SELECT
              promotions.id,
              promotions.user_id AS userId,
              promotions.scanner_type AS scannerType,
              promotions.scanner_run_id AS scannerRunId,
              promotions.scanner_candidate_id AS scannerCandidateId,
              promotions.paper_order_id AS paperOrderId,
              promotions.symbol,
              promotions.strategy_type AS strategyType,
              promotions.promotion_status AS promotionStatus,
              promotions.notes_json AS notesJson,
              candidates.payload_json AS candidatePayloadJson,
              promotions.created_at AS createdAt
            FROM scanner_promotions AS promotions
            LEFT JOIN scanner_candidates AS candidates
              ON candidates.id = promotions.scanner_candidate_id
            WHERE promotions.user_id = ?
            ORDER BY promotions.created_at DESC, promotions.id DESC
            LIMIT ?
          `
        );

  return statement
    .all(...(userId == null ? [limit] : [userId, limit]))
    .map((row) => ({
      ...row,
      notes: row.notesJson ? JSON.parse(row.notesJson) : {},
      candidatePayload: row.candidatePayloadJson ? JSON.parse(row.candidatePayloadJson) : null
    }));
}

function assertPostgresOnlyFeature(featureName) {
  throw new Error(`${featureName} requires DB_TYPE=postgres.`);
}

export function recordOptionShortlistObservations(_observations = []) {
  return assertPostgresOnlyFeature("Option shortlist observations");
}

export function listOptionShortlistObservations(_query = {}) {
  return assertPostgresOnlyFeature("Option shortlist observations");
}

export function createOptionsHistoryIngestionRun(_run = {}) {
  return assertPostgresOnlyFeature("Options history ingestion");
}

export function updateOptionsHistoryIngestionRun(_id, _patch = {}) {
  return assertPostgresOnlyFeature("Options history ingestion");
}

export function listOptionsHistoryIngestionRuns(_limit = 20) {
  return assertPostgresOnlyFeature("Options history ingestion");
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

export function createUserApiKey({ id, userId, label, tokenHash, tokenPrefix } = {}) {
  const normalizedId = String(id ?? "").trim();
  const normalizedUserId = String(userId ?? "").trim();
  const normalizedLabel = String(label ?? "").trim();
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  const normalizedTokenPrefix = String(tokenPrefix ?? "").trim();

  if (!normalizedId || !normalizedUserId || !normalizedLabel || !normalizedTokenHash || !normalizedTokenPrefix) {
    throw new Error("id, userId, label, tokenHash, and tokenPrefix are required");
  }

  insertUserApiKeyStatement.run({
    id: normalizedId,
    userId: normalizedUserId,
    label: normalizedLabel,
    tokenHash: normalizedTokenHash,
    tokenPrefix: normalizedTokenPrefix
  });

  return listUserApiKeys().find((item) => item.id === normalizedId) ?? null;
}

export function listUserApiKeys() {
  return listUserApiKeysStatement.all();
}

export function getUserApiKeyWithUser(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return null;
  }

  const row = getUserApiKeyWithUserStatement.get(normalizedTokenHash);
  return row
    ? {
        ...row,
        disabled: Boolean(row.disabled)
      }
    : null;
}

export function touchUserApiKey(id) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return false;
  }

  return touchUserApiKeyStatement.run(normalizedId).changes > 0;
}

export function revokeUserApiKey(id) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return false;
  }

  return revokeUserApiKeyStatement.run(normalizedId).changes > 0;
}

export function createGptApiRequestLog(entry = {}) {
  const normalizedId = String(entry.id ?? "").trim();
  if (!normalizedId) {
    throw new Error("Log id is required");
  }

  insertGptApiRequestLogStatement.run({
    id: normalizedId,
    systemName: String(entry.systemName ?? "gpt-strategy-query").trim() || "gpt-strategy-query",
    method: String(entry.method ?? "POST").trim() || "POST",
    path: String(entry.path ?? "/api/gpt/strategy-query").trim() || "/api/gpt/strategy-query",
    ipAddress: entry.ipAddress == null ? null : String(entry.ipAddress).trim() || null,
    userId: entry.userId == null ? null : String(entry.userId).trim() || null,
    username: entry.username == null ? null : String(entry.username).trim() || null,
    apiKeyId: entry.apiKeyId == null ? null : String(entry.apiKeyId).trim() || null,
    apiKeyLabel: entry.apiKeyLabel == null ? null : String(entry.apiKeyLabel).trim() || null,
    apiKeyPrefix: entry.apiKeyPrefix == null ? null : String(entry.apiKeyPrefix).trim() || null,
    authStatus: String(entry.authStatus ?? "unknown").trim() || "unknown",
    statusCode: Number(entry.statusCode ?? 0) || 0,
    responseTimeMs: Number.isFinite(Number(entry.responseTimeMs)) ? Number(entry.responseTimeMs) : null,
    requestTicker: entry.requestTicker == null ? null : String(entry.requestTicker).trim() || null,
    expectedPriceRangeLow:
      Number.isFinite(Number(entry.expectedPriceRangeLow)) ? Number(entry.expectedPriceRangeLow) : null,
    expectedPriceRangeHigh:
      Number.isFinite(Number(entry.expectedPriceRangeHigh)) ? Number(entry.expectedPriceRangeHigh) : null,
    optionExpirationStartDate:
      entry.optionExpirationStartDate == null ? null : String(entry.optionExpirationStartDate).trim() || null,
    optionExpirationEndDate:
      entry.optionExpirationEndDate == null ? null : String(entry.optionExpirationEndDate).trim() || null,
    requestBodyJson: JSON.stringify(entry.requestBody ?? {}),
    errorMessage: entry.errorMessage == null ? null : String(entry.errorMessage).trim() || null
  });

  return true;
}

export function listGptApiRequestLogs(limit = 100) {
  const rows = listGptApiRequestLogsStatement.all(Math.max(Number(limit) || 100, 1));
  return rows.map((row) => ({
    ...row,
    requestBody: row.requestBodyJson ? JSON.parse(row.requestBodyJson) : {}
  }));
}

export function summarizeGptApiRequestLogs() {
  const row = summarizeGptApiRequestLogsStatement.get() ?? {};
  return {
    totalRequests: Number(row.totalRequests ?? 0) || 0,
    successCount: Number(row.successCount ?? 0) || 0,
    authorizedCount: Number(row.authorizedCount ?? 0) || 0,
    unknownCount: Number(row.unknownCount ?? 0) || 0,
    uniqueIpCount: Number(row.uniqueIpCount ?? 0) || 0,
    uniqueUserCount: Number(row.uniqueUserCount ?? 0) || 0,
    averageResponseTimeMs: Number.isFinite(Number(row.averageResponseTimeMs)) ? Number(row.averageResponseTimeMs) : null,
    latestRequestAt: row.latestRequestAt ?? null
  };
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

export function getAppSetting(key) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    return null;
  }

  const row = getAppSettingStatement.get(normalizedKey);
  if (!row) {
    return null;
  }

  let value = null;
  try {
    value = JSON.parse(row.valueJson ?? "null");
  } catch (_error) {
    value = null;
  }

  return {
    ...row,
    value
  };
}

export function upsertAppSetting(key, value) {
  const normalizedKey = String(key ?? "").trim();
  if (!normalizedKey) {
    throw new Error("Setting key is required");
  }

  upsertAppSettingStatement.run({
    key: normalizedKey,
    valueJson: JSON.stringify(value ?? null)
  });

  return getAppSetting(normalizedKey);
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
