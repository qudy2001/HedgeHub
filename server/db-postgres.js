import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { logWarn } from "./logger.js";
import { defaultStrategyConfig, sidebarStrategies } from "./marketCatalog.js";

const initDir = path.join(process.cwd(), "db", "init");
const DEFAULT_PSQL_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_PSQL_TIMEOUT_MS = 15000;

function buildDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL;
  }

  const host = process.env.POSTGRES_HOST || "localhost";
  const port = process.env.POSTGRES_PORT || "5432";
  const database = process.env.POSTGRES_DB || "optionsdb";
  const user = encodeURIComponent(process.env.POSTGRES_USER || "postgres");
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD || "postgres");
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

const databaseUrl = buildDatabaseUrl();

function quoteLiteral(value) {
  if (value == null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "NULL";
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quoteJson(value) {
  return `${quoteLiteral(JSON.stringify(value ?? {}))}::jsonb`;
}

function runPsql(sql) {
  const maxBuffer = Number.parseInt(process.env.PSQL_MAX_BUFFER_BYTES ?? "", 10);
  const timeoutMs = Number.parseInt(process.env.PSQL_TIMEOUT_MS ?? "", 10);
  const result = spawnSync(
    "psql",
    ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", databaseUrl, "-f", "-"],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: "utf8",
      input: sql,
      // Paper-trade history can legitimately return large JSON payloads.
      maxBuffer: Number.isFinite(maxBuffer) && maxBuffer > 0 ? maxBuffer : DEFAULT_PSQL_MAX_BUFFER_BYTES,
      timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PSQL_TIMEOUT_MS
    }
  );

  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(
        `psql timed out after ${Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_PSQL_TIMEOUT_MS}ms.`
      );
    }
    if (result.error.code === "ENOENT") {
      throw new Error(
        "psql was not found on PATH. Install PostgreSQL client tools locally or run HedgeHub in Docker mode."
      );
    }
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "psql command failed").trim());
  }

  return result.stdout.trim();
}

function queryJson(sql, expectMany = true) {
  const wrapped = expectMany
    ? `SELECT COALESCE(json_agg(row_to_json(t)), '[]'::json) AS payload FROM (${sql}) AS t;`
    : `SELECT row_to_json(t) AS payload FROM (${sql}) AS t LIMIT 1;`;
  const raw = runPsql(`${wrapped}`);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const payloadLine = lines[lines.length - 1] ?? "";
  if (!payloadLine || payloadLine === "") {
    return expectMany ? [] : null;
  }
  return JSON.parse(payloadLine);
}

function mutateJson(sql, expectMany = false) {
  const wrapped = expectMany
    ? `WITH mutation AS (${sql}) SELECT COALESCE(json_agg(row_to_json(mutation)), '[]'::json) AS payload FROM mutation;`
    : `WITH mutation AS (${sql}) SELECT row_to_json(mutation) AS payload FROM mutation LIMIT 1;`;
  const raw = runPsql(wrapped);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const payloadLine = lines[lines.length - 1] ?? "";
  if (!payloadLine || payloadLine === "") {
    return expectMany ? [] : null;
  }
  return JSON.parse(payloadLine);
}

function execute(sql) {
  runPsql(sql);
}

function executeReturning(sql) {
  const raw = runPsql(sql);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0;
}

function executeTransaction(statements) {
  const sql = ["BEGIN", ...statements, "COMMIT"].join(";\n");
  execute(sql);
}

function applyInitFiles() {
  if (!fs.existsSync(initDir)) {
    return;
  }

  const files = fs
    .readdirSync(initDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = fs.readFileSync(path.join(initDir, file), "utf8");
    execute(sql);
  }
}

function repairOwnedSequences() {
  execute(`
    DO $$
    DECLARE
      sequence_record RECORD;
      next_value BIGINT;
    BEGIN
      FOR sequence_record IN
        SELECT
          table_name,
          column_name,
          pg_get_serial_sequence(format('%I.%I', table_schema, table_name), column_name) AS sequence_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_default LIKE 'nextval(%'
      LOOP
        IF sequence_record.sequence_name IS NULL THEN
          CONTINUE;
        END IF;

        EXECUTE format(
          'SELECT COALESCE(MAX(%I), 0) + 1 FROM %I.%I',
          sequence_record.column_name,
          'public',
          sequence_record.table_name
        )
        INTO next_value;

        EXECUTE format(
          'ALTER SEQUENCE %s RESTART WITH %s',
          sequence_record.sequence_name,
          GREATEST(next_value, 1)
        );
      END LOOP;
    END $$;
  `);
}

function shouldRepairSequencesOnBoot() {
  return String(process.env.POSTGRES_REPAIR_SEQUENCES_ON_BOOT ?? "false").trim().toLowerCase() === "true";
}

function seedStrategies() {
  for (const strategy of sidebarStrategies) {
    const configJson = JSON.stringify(
      strategy.id === defaultStrategyConfig.id ? defaultStrategyConfig : {}
    );
    execute(`
      INSERT INTO strategy_profiles (
        id,
        name,
        status,
        asset_label,
        description,
        config_json
      ) VALUES (
        ${quoteLiteral(strategy.id)},
        ${quoteLiteral(strategy.name)},
        ${quoteLiteral(strategy.status)},
        ${quoteLiteral(strategy.assetLabel)},
        ${quoteLiteral(strategy.description)},
        ${quoteJson(JSON.parse(configJson))}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        asset_label = EXCLUDED.asset_label,
        description = EXCLUDED.description,
        config_json = EXCLUDED.config_json,
        updated_at = NOW();
    `);
  }
}

applyInitFiles();
seedStrategies();
if (shouldRepairSequencesOnBoot()) {
  try {
    repairOwnedSequences();
  } catch (error) {
    logWarn("Postgres sequence repair skipped", {
      subsystem: "db-postgres",
      error
    });
  }
}

function mapPaperOrderRow(row) {
  return row
    ? {
        ...row,
        userId: row.userId ?? "",
        strategyId: row.strategyId,
        combinationId: row.combinationId,
        position: JSON.parse(row.positionJson)
      }
    : null;
}

function normalizeUsername(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

function getPaperOrderRow(id) {
  return mapPaperOrderRow(
    queryJson(
      `
        SELECT
          id,
          user_id AS "userId",
          strategy_id AS "strategyId",
          combination_id AS "combinationId",
          position_json::text AS "positionJson",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM paper_orders
        WHERE id = ${Number(id)}
      `,
      false
    )
  );
}

export function getStrategies() {
  const rows = queryJson(`
    SELECT
      id,
      name,
      status,
      asset_label AS "assetLabel",
      description,
      config_json::text AS "configJson",
      updated_at AS "updatedAt"
    FROM strategy_profiles
    ORDER BY
      CASE
        WHEN id = 'strategy-1' THEN 0
        WHEN id = 'strategy-tv-finder' THEN 1
        ELSE 2
      END,
      id
  `);

  return rows.map((row) => ({
    ...row,
    config: JSON.parse(row.configJson)
  }));
}

export function saveStrategyRun(strategyId, scenario, userId = "legacy") {
  execute(`
    INSERT INTO strategy_runs (
      user_id,
      strategy_id,
      scenario_json
    ) VALUES (
      ${quoteLiteral(userId)},
      ${quoteLiteral(strategyId)},
      ${quoteJson(scenario)}
    )
  `);
}

export function listStrategyWatchlist(userId = "legacy") {
  return queryJson(`
    SELECT
      strategy_id AS "strategyId",
      created_at AS "createdAt"
    FROM strategy_watchlist
    WHERE user_id = ${quoteLiteral(userId)}
    ORDER BY created_at DESC, strategy_id ASC
  `);
}

export function addStrategyToWatchlist(strategyId, userId = "legacy") {
  execute(`
    INSERT INTO strategy_watchlist (
      user_id,
      strategy_id
    ) VALUES (
      ${quoteLiteral(userId)},
      ${quoteLiteral(strategyId)}
    )
    ON CONFLICT (user_id, strategy_id) DO NOTHING
  `);

  return queryJson(
    `
      SELECT
        strategy_id AS "strategyId",
        created_at AS "createdAt"
      FROM strategy_watchlist
      WHERE user_id = ${quoteLiteral(userId)}
        AND strategy_id = ${quoteLiteral(strategyId)}
    `,
    false
  );
}

export function removeStrategyFromWatchlist(strategyId, userId = "legacy") {
  return executeReturning(`
    DELETE FROM strategy_watchlist
    WHERE user_id = ${quoteLiteral(userId)}
      AND strategy_id = ${quoteLiteral(strategyId)}
    RETURNING strategy_id
  `);
}

export function listSetupWatchlist(userId = "legacy") {
  const rows = queryJson(`
    SELECT
      id,
      source,
      strategy_id AS "strategyId",
      combination_id AS "combinationId",
      title,
      payload_json::text AS "payloadJson",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM setup_watchlist
    WHERE user_id = ${quoteLiteral(userId)}
    ORDER BY created_at DESC, id ASC
  `);

  return rows.map((row) => ({
    ...row,
    payload: JSON.parse(row.payloadJson)
  }));
}

export function upsertSetupWatchlistItem(item, userId = "legacy") {
  execute(`
    INSERT INTO setup_watchlist (
      user_id,
      id,
      source,
      strategy_id,
      combination_id,
      title,
      payload_json
    ) VALUES (
      ${quoteLiteral(userId)},
      ${quoteLiteral(item.id)},
      ${quoteLiteral(item.source)},
      ${quoteLiteral(item.strategyId)},
      ${quoteLiteral(item.combinationId)},
      ${quoteLiteral(item.title)},
      ${quoteJson(item.payload ?? {})}
    )
    ON CONFLICT (user_id, id) DO UPDATE SET
      source = EXCLUDED.source,
      strategy_id = EXCLUDED.strategy_id,
      combination_id = EXCLUDED.combination_id,
      title = EXCLUDED.title,
      payload_json = EXCLUDED.payload_json,
      updated_at = NOW()
  `);

  const row = queryJson(
    `
      SELECT
        id,
        source,
        strategy_id AS "strategyId",
        combination_id AS "combinationId",
        title,
        payload_json::text AS "payloadJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM setup_watchlist
      WHERE user_id = ${quoteLiteral(userId)}
        AND id = ${quoteLiteral(item.id)}
    `,
    false
  );

  return row
    ? {
        ...row,
        payload: JSON.parse(row.payloadJson)
      }
    : null;
}

export function deleteSetupWatchlistItem(id, userId = "legacy") {
  return executeReturning(`
    DELETE FROM setup_watchlist
    WHERE user_id = ${quoteLiteral(userId)}
      AND id = ${quoteLiteral(id)}
    RETURNING id
  `);
}

export function getRecentRuns(limit = 8, userId = "legacy") {
  const rows = queryJson(`
    SELECT
      id,
      strategy_id AS "strategyId",
      scenario_json::text AS "scenarioJson",
      created_at AS "createdAt"
    FROM strategy_runs
    WHERE user_id = ${quoteLiteral(userId)}
    ORDER BY created_at DESC
    LIMIT ${Math.max(Number(limit) || 0, 0)}
  `);

  return rows.map((row) => ({
    ...row,
    scenario: JSON.parse(row.scenarioJson)
  }));
}

export function upsertScannerPreset({ scannerType, name, config = {}, isDefault = false }, userId = "legacy") {
  execute(`
    INSERT INTO scanner_presets (
      user_id,
      scanner_type,
      name,
      config_json,
      is_default
    ) VALUES (
      ${quoteLiteral(userId)},
      ${quoteLiteral(scannerType)},
      ${quoteLiteral(name)},
      ${quoteJson(config)},
      ${quoteLiteral(Boolean(isDefault))}
    )
    ON CONFLICT (user_id, scanner_type, name) DO UPDATE SET
      config_json = EXCLUDED.config_json,
      is_default = EXCLUDED.is_default,
      updated_at = NOW()
  `);

  const row = queryJson(
    `
      SELECT
        id,
        scanner_type AS "scannerType",
        name,
        config_json::text AS "configJson",
        is_default AS "isDefault",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM scanner_presets
      WHERE user_id = ${quoteLiteral(userId)}
        AND scanner_type = ${quoteLiteral(scannerType)}
        AND name = ${quoteLiteral(name)}
    `,
    false
  );

  return row
    ? {
        ...row,
        isDefault: Boolean(row.isDefault),
        config: JSON.parse(row.configJson)
      }
    : null;
}

export function listScannerPresets(scannerType, userId = "legacy") {
  const rows = queryJson(`
    SELECT
      id,
      scanner_type AS "scannerType",
      name,
      config_json::text AS "configJson",
      is_default AS "isDefault",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM scanner_presets
    WHERE user_id = ${quoteLiteral(userId)}
      AND scanner_type = ${quoteLiteral(scannerType)}
    ORDER BY is_default DESC, updated_at DESC, id DESC
  `);

  return rows.map((row) => ({
    ...row,
    isDefault: Boolean(row.isDefault),
    config: JSON.parse(row.configJson)
  }));
}

export function saveScannerRun(run, userId = "legacy") {
  const runRow = mutateJson(
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
      ) VALUES (
        ${quoteLiteral(userId)},
        ${quoteLiteral(run.scannerType)},
        ${quoteLiteral(run.strategyId ?? null)},
        ${quoteLiteral(run.presetId ?? null)},
        ${quoteJson(run.config ?? {})},
        ${quoteJson(run.summary ?? {})},
        ${quoteLiteral(run.marketRegime ? JSON.stringify(run.marketRegime) : null)}::jsonb,
        ${quoteLiteral(Array.isArray(run.rows) ? run.rows.length : 0)}
      )
      RETURNING id
    `,
    false
  );

  const scannerRunId = Number(runRow?.id ?? 0);
  const storedRows = [];

  (run.rows ?? []).forEach((row, index) => {
    const candidateRow = mutateJson(
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
        ) VALUES (
          ${quoteLiteral(scannerRunId)},
          ${quoteLiteral(run.scannerType)},
          ${quoteLiteral(String(row.symbol ?? "").trim().toUpperCase())},
          ${quoteLiteral(row.strategyType ?? null)},
          ${quoteLiteral(index + 1)},
          ${quoteLiteral(row.scoreValue ?? null)},
          ${quoteJson(row.payload ?? row)},
          ${quoteJson(row.explanationData ?? {})},
          ${quoteJson(row.riskFlags ?? [])},
          ${quoteJson(row.portfolioImpact ?? {})}
        )
        RETURNING id
      `,
      false
    );

    const scannerCandidateId = Number(candidateRow?.id ?? 0);
    execute(`
      INSERT INTO candidate_rank_history (
        user_id,
        scanner_type,
        symbol,
        strategy_type,
        scanner_candidate_id,
        scanner_run_id,
        score,
        rank_position
      ) VALUES (
        ${quoteLiteral(userId)},
        ${quoteLiteral(run.scannerType)},
        ${quoteLiteral(String(row.symbol ?? "").trim().toUpperCase())},
        ${quoteLiteral(row.strategyType ?? null)},
        ${quoteLiteral(scannerCandidateId)},
        ${quoteLiteral(scannerRunId)},
        ${quoteLiteral(row.scoreValue ?? null)},
        ${quoteLiteral(index + 1)}
      )
    `);

    storedRows.push({
      ...row,
      scannerCandidateId,
      rankPosition: index + 1
    });
  });

  return {
    id: scannerRunId,
    rows: storedRows
  };
}

export function getLatestScannerRun(scannerType, userId = "legacy", includeRows = true) {
  const run = queryJson(
    `
      SELECT
        id,
        scanner_type AS "scannerType",
        strategy_id AS "strategyId",
        preset_id AS "presetId",
        config_json::text AS "configJson",
        summary_json::text AS "summaryJson",
        market_regime_json::text AS "marketRegimeJson",
        candidate_count AS "candidateCount",
        created_at AS "createdAt"
      FROM scanner_runs
      WHERE user_id = ${quoteLiteral(userId)}
        AND scanner_type = ${quoteLiteral(scannerType)}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    false
  );

  if (!run) {
    return null;
  }

  return {
    ...run,
    config: JSON.parse(run.configJson),
    summary: JSON.parse(run.summaryJson),
    marketRegime: run.marketRegimeJson ? JSON.parse(run.marketRegimeJson) : null,
    rows: includeRows
      ? queryJson(`
          SELECT
            id,
            symbol,
            strategy_type AS "strategyType",
            rank_position AS "rankPosition",
            score,
            payload_json::text AS "payloadJson",
            explanation_data::text AS "explanationDataJson",
            risk_flags::text AS "riskFlagsJson",
            portfolio_impact_json::text AS "portfolioImpactJson",
            created_at AS "createdAt"
          FROM scanner_candidates
          WHERE scanner_run_id = ${quoteLiteral(run.id)}
          ORDER BY rank_position ASC, id ASC
        `).map((row) => ({
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
  const condition = strategyType == null ? "" : `AND strategy_type = ${quoteLiteral(strategyType)}`;
  return queryJson(`
    SELECT
      id,
      scanner_candidate_id AS "scannerCandidateId",
      scanner_run_id AS "scannerRunId",
      score,
      rank_position AS "rankPosition",
      created_at AS "createdAt"
    FROM candidate_rank_history
    WHERE user_id = ${quoteLiteral(userId)}
      AND scanner_type = ${quoteLiteral(scannerType)}
      AND symbol = ${quoteLiteral(String(symbol ?? "").trim().toUpperCase())}
      ${condition}
    ORDER BY created_at DESC, id DESC
    LIMIT ${Math.max(Number(limit) || 0, 0)}
  `);
}

export function upsertIv30History(snapshot = {}) {
  const symbol = String(snapshot.symbol ?? "").trim().toUpperCase();
  const date = String(snapshot.date ?? "").trim();
  if (!symbol || !date) {
    throw new Error("symbol and date are required for iv30 history");
  }

  execute(`
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
    ) VALUES (
      ${quoteLiteral(date)},
      ${quoteLiteral(symbol)},
      ${quoteLiteral(snapshot.underlyingPrice ?? null)},
      ${quoteLiteral(snapshot.iv30 ?? null)},
      ${quoteLiteral(snapshot.atmCallIv ?? null)},
      ${quoteLiteral(snapshot.atmPutIv ?? null)},
      ${quoteLiteral(snapshot.nearExpiry ?? null)},
      ${quoteLiteral(snapshot.farExpiry ?? null)},
      ${quoteLiteral(snapshot.nearDte ?? null)},
      ${quoteLiteral(snapshot.farDte ?? null)},
      ${quoteLiteral(snapshot.optionVolume ?? null)},
      ${quoteLiteral(snapshot.openInterest ?? null)}
    )
    ON CONFLICT (date, symbol) DO UPDATE SET
      underlying_price = EXCLUDED.underlying_price,
      iv30 = EXCLUDED.iv30,
      atm_call_iv = EXCLUDED.atm_call_iv,
      atm_put_iv = EXCLUDED.atm_put_iv,
      near_expiry = EXCLUDED.near_expiry,
      far_expiry = EXCLUDED.far_expiry,
      near_dte = EXCLUDED.near_dte,
      far_dte = EXCLUDED.far_dte,
      option_volume = EXCLUDED.option_volume,
      open_interest = EXCLUDED.open_interest
  `);
}

export function listIv30History(symbol, limit = 252) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!normalizedSymbol) {
    return [];
  }

  return queryJson(`
    SELECT
      date,
      symbol,
      underlying_price AS "underlyingPrice",
      iv30,
      atm_call_iv AS "atmCallIv",
      atm_put_iv AS "atmPutIv",
      near_expiry AS "nearExpiry",
      far_expiry AS "farExpiry",
      near_dte AS "nearDte",
      far_dte AS "farDte",
      option_volume AS "optionVolume",
      open_interest AS "openInterest",
      created_at AS "createdAt"
    FROM iv30_history
    WHERE symbol = ${quoteLiteral(normalizedSymbol)}
    ORDER BY date DESC
    LIMIT ${Math.max(Number(limit) || 0, 0)}
  `);
}

export function upsertIvRankDaily(metrics = {}) {
  const symbol = String(metrics.symbol ?? "").trim().toUpperCase();
  const date = String(metrics.date ?? "").trim();
  if (!symbol || !date) {
    throw new Error("symbol and date are required for iv_rank_daily");
  }

  execute(`
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
    ) VALUES (
      ${quoteLiteral(date)},
      ${quoteLiteral(symbol)},
      ${quoteLiteral(metrics.iv30 ?? null)},
      ${quoteLiteral(metrics.iv30Min52w ?? null)},
      ${quoteLiteral(metrics.iv30Max52w ?? null)},
      ${quoteLiteral(metrics.ivRank52w ?? null)},
      ${quoteLiteral(metrics.ivPercentile52w ?? null)},
      ${quoteLiteral(metrics.hv20 ?? null)},
      ${quoteLiteral(metrics.hv252 ?? null)}
    )
    ON CONFLICT (date, symbol) DO UPDATE SET
      iv30 = EXCLUDED.iv30,
      iv30_min_52w = EXCLUDED.iv30_min_52w,
      iv30_max_52w = EXCLUDED.iv30_max_52w,
      iv_rank_52w = EXCLUDED.iv_rank_52w,
      iv_percentile_52w = EXCLUDED.iv_percentile_52w,
      hv20 = EXCLUDED.hv20,
      hv252 = EXCLUDED.hv252
  `);
}

export function getLatestIvRankDaily(symbol, asOfDate = null) {
  const normalizedSymbol = String(symbol ?? "").trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }

  const datePredicate = asOfDate ? `AND date <= ${quoteLiteral(String(asOfDate).trim())}` : "";

  return queryJson(
    `
      SELECT
        date,
        symbol,
        iv30,
        iv30_min_52w AS "iv30Min52w",
        iv30_max_52w AS "iv30Max52w",
        iv_rank_52w AS "ivRank52w",
        iv_percentile_52w AS "ivPercentile52w",
        hv20,
        hv252
      FROM iv_rank_daily
      WHERE symbol = ${quoteLiteral(normalizedSymbol)}
        ${datePredicate}
      ORDER BY date DESC
      LIMIT 1
    `,
    false
  );
}

export function createScannerPromotion(promotion, userId = "legacy") {
  const row = queryJson(
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
      ) VALUES (
        ${quoteLiteral(userId)},
        ${quoteLiteral(promotion.scannerType)},
        ${quoteLiteral(promotion.scannerRunId ?? null)},
        ${quoteLiteral(promotion.scannerCandidateId ?? null)},
        ${quoteLiteral(promotion.paperOrderId ?? null)},
        ${quoteLiteral(String(promotion.symbol ?? "").trim().toUpperCase())},
        ${quoteLiteral(promotion.strategyType ?? null)},
        ${quoteLiteral(promotion.promotionStatus ?? "paper_trade")},
        ${quoteJson(promotion.notes ?? {})}
      )
      RETURNING
        id,
        scanner_type AS "scannerType",
        scanner_run_id AS "scannerRunId",
        scanner_candidate_id AS "scannerCandidateId",
        paper_order_id AS "paperOrderId",
        symbol,
        strategy_type AS "strategyType",
        promotion_status AS "promotionStatus",
        notes_json::text AS "notesJson",
        created_at AS "createdAt"
    `,
    false
  );

  return row
    ? {
        ...row,
        notes: row.notesJson ? JSON.parse(row.notesJson) : {}
      }
    : null;
}

export function listPaperOrders(strategyId = null, userId = null) {
  const conditions = [];
  if (userId != null) {
    conditions.push(`user_id = ${quoteLiteral(String(userId).trim())}`);
  }
  if (strategyId != null) {
    conditions.push(`strategy_id = ${quoteLiteral(String(strategyId).trim())}`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = queryJson(`
    SELECT
      id,
      user_id AS "userId",
      strategy_id AS "strategyId",
      combination_id AS "combinationId",
      position_json::text AS "positionJson",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM paper_orders
    ${whereClause}
    ORDER BY updated_at DESC, id DESC
  `);

  return rows.map(mapPaperOrderRow);
}

export function createPaperOrder(order) {
  const row = queryJson(
    `
      INSERT INTO paper_orders (
        user_id,
        strategy_id,
        combination_id,
        position_json
      ) VALUES (
        ${quoteLiteral(order.userId ?? "legacy")},
        ${quoteLiteral(order.strategyId)},
        ${quoteLiteral(order.combinationId)},
        ${quoteJson(order)}
      )
      RETURNING id
    `,
    false
  );

  return row ? getPaperOrderRow(row.id) : null;
}

export function updatePaperOrder(id, order) {
  execute(`
    UPDATE paper_orders
    SET
      strategy_id = ${quoteLiteral(order.strategyId)},
      combination_id = ${quoteLiteral(order.combinationId)},
      position_json = ${quoteJson(order)},
      updated_at = NOW()
    WHERE id = ${Number(id)}
  `);

  return getPaperOrderRow(id);
}

export function deletePaperOrder(id) {
  return executeReturning(`
    DELETE FROM paper_orders
    WHERE id = ${Number(id)}
    RETURNING id
  `);
}

export function recordPaperOrderSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return;
  }

  const values = snapshots.map((snapshot) => `(
    ${Number(snapshot.orderId)},
    ${quoteLiteral(snapshot.status)},
    ${quoteLiteral(snapshot.currentHoldingValue)},
    ${quoteLiteral(snapshot.netMarkedValue)},
    ${quoteLiteral(snapshot.profitLossValue)},
    ${quoteLiteral(snapshot.profitLossPercent)},
    ${quoteLiteral(snapshot.capturedAt)}
  )`);

  execute(`
    INSERT INTO paper_order_snapshots (
      order_id,
      status,
      current_holding_value,
      net_marked_value,
      profit_loss_value,
      profit_loss_percent,
      captured_at
    ) VALUES
      ${values.join(",\n")}
    ON CONFLICT (order_id, captured_at) DO UPDATE SET
      status = EXCLUDED.status,
      current_holding_value = EXCLUDED.current_holding_value,
      net_marked_value = EXCLUDED.net_marked_value,
      profit_loss_value = EXCLUDED.profit_loss_value,
      profit_loss_percent = EXCLUDED.profit_loss_percent
  `);
}

export function listPaperOrderSnapshots(orderIds = null) {
  if (Array.isArray(orderIds) && orderIds.length === 0) {
    return [];
  }

  const whereClause =
    Array.isArray(orderIds) && orderIds.length
      ? `WHERE order_id IN (${orderIds.map((id) => Number(id)).join(", ")})`
      : "";

  const rows = queryJson(`
    SELECT
      order_id AS "orderId",
      status,
      current_holding_value AS "currentHoldingValue",
      net_marked_value AS "netMarkedValue",
      profit_loss_value AS "profitLossValue",
      profit_loss_percent AS "profitLossPercent",
      captured_at AS "capturedAt"
    FROM paper_order_snapshots
    ${whereClause}
    ORDER BY order_id ASC, captured_at ASC
  `);

  return rows.map((row) => ({
    ...row,
    orderId: Number(row.orderId)
  }));
}

export function deletePaperOrderSnapshots(orderId) {
  execute(`
    DELETE FROM paper_order_snapshots
    WHERE order_id = ${Number(orderId)}
  `);
  return true;
}

export function createPaperCalculatorSnapshot(orderId, snapshotName, payload) {
  const row = queryJson(
    `
      INSERT INTO paper_calculator_snapshots (
        order_id,
        snapshot_name,
        snapshot_json
      ) VALUES (
        ${Number(orderId)},
        ${quoteLiteral(snapshotName)},
        ${quoteJson(payload)}
      )
      RETURNING id
    `,
    false
  );

  const stored = row
    ? queryJson(
        `
          SELECT
            id,
            order_id AS "orderId",
            snapshot_name AS "snapshotName",
            snapshot_json::text AS "snapshotJson",
            created_at AS "createdAt"
          FROM paper_calculator_snapshots
          WHERE id = ${Number(row.id)}
        `,
        false
      )
    : null;

  return stored
    ? {
        ...stored,
        orderId: Number(stored.orderId),
        payload: JSON.parse(stored.snapshotJson)
      }
    : null;
}

export function listPaperCalculatorSnapshots(orderIds = null) {
  if (Array.isArray(orderIds) && orderIds.length === 0) {
    return [];
  }

  const whereClause =
    Array.isArray(orderIds) && orderIds.length
      ? `WHERE order_id IN (${orderIds.map((id) => Number(id)).join(", ")})`
      : "";

  const rows = queryJson(`
    SELECT
      id,
      order_id AS "orderId",
      snapshot_name AS "snapshotName",
      snapshot_json::text AS "snapshotJson",
      created_at AS "createdAt"
    FROM paper_calculator_snapshots
    ${whereClause}
    ORDER BY created_at DESC, id DESC
  `);

  return rows.map((row) => ({
    ...row,
    orderId: Number(row.orderId),
    payload: JSON.parse(row.snapshotJson)
  }));
}

export function deletePaperCalculatorSnapshots(orderId) {
  execute(`
    DELETE FROM paper_calculator_snapshots
    WHERE order_id = ${Number(orderId)}
  `);
  return true;
}

export function recordMarketSnapshots(snapshots) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) {
    return;
  }

  const values = snapshots.map((snapshot) => `(
    ${quoteLiteral(snapshot.symbol)},
    ${quoteLiteral(snapshot.label)},
    ${quoteLiteral(snapshot.groupName)},
    ${quoteLiteral(snapshot.provider)},
    ${quoteLiteral(snapshot.price)},
    ${quoteLiteral(snapshot.changePercent)},
    ${quoteLiteral(snapshot.currency)}
  )`);

  execute(`
    INSERT INTO market_snapshots (
      symbol,
      label,
      group_name,
      provider,
      price,
      change_percent,
      currency
    ) VALUES
      ${values.join(",\n")}
  `);
}

export function getLatestSnapshots() {
  const rows = queryJson(`
    SELECT DISTINCT ON (symbol)
      symbol,
      label,
      group_name AS "group",
      provider,
      price,
      change_percent AS "changePercent",
      currency,
      captured_at AS "capturedAt"
    FROM market_snapshots
    ORDER BY symbol, captured_at DESC, id DESC
  `);

  return rows.sort((left, right) => {
    const groupDiff = String(left.group ?? "").localeCompare(String(right.group ?? ""));
    return groupDiff !== 0 ? groupDiff : String(left.label ?? "").localeCompare(String(right.label ?? ""));
  });
}

export function saveMacroDashboardSnapshot(snapshot, keepCount = 14) {
  executeTransaction([
    `
      INSERT INTO macro_dashboard_snapshots (
        payload_json,
        refreshed_at
      ) VALUES (
        ${quoteJson(snapshot)},
        ${quoteLiteral(snapshot.refreshedAt)}
      )
    `,
    `
      DELETE FROM macro_dashboard_snapshots
      WHERE id NOT IN (
        SELECT id
        FROM macro_dashboard_snapshots
        ORDER BY refreshed_at DESC
        LIMIT ${Math.max(Number(keepCount) || 0, 0)}
      )
    `
  ]);
}

export function getLatestMacroDashboardSnapshot() {
  const row = queryJson(
    `
      SELECT
        payload_json::text AS "payloadJson",
        refreshed_at AS "refreshedAt"
      FROM macro_dashboard_snapshots
      ORDER BY refreshed_at DESC
      LIMIT 1
    `,
    false
  );

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
  const rows = queryJson(`
    SELECT
      id,
      mapping_json::text AS "mappingJson",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM strategy_asset_mappings
    ORDER BY updated_at DESC, id ASC
  `);

  return rows.map((row) => ({
    ...JSON.parse(row.mappingJson),
    id: row.id,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }));
}

export function upsertStrategyAssetMapping(mapping) {
  execute(`
    INSERT INTO strategy_asset_mappings (
      id,
      mapping_json
    ) VALUES (
      ${quoteLiteral(mapping.id)},
      ${quoteJson(mapping)}
    )
    ON CONFLICT (id) DO UPDATE SET
      mapping_json = EXCLUDED.mapping_json,
      updated_at = NOW()
  `);

  return queryJson(
    `
      SELECT
        id,
        mapping_json::text AS "mappingJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM strategy_asset_mappings
      WHERE id = ${quoteLiteral(mapping.id)}
    `,
    false
  );
}

export function deleteStrategyAssetMapping(id) {
  return executeReturning(`
    DELETE FROM strategy_asset_mappings
    WHERE id = ${quoteLiteral(id)}
    RETURNING id
  `);
}

export function listDeltaHedgeScannerSymbols() {
  const rows = queryJson(`
    SELECT
      symbol,
      label,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM delta_hedge_scanner_symbols
    ORDER BY updated_at DESC, symbol ASC
  `);

  return rows.map((row) => ({
    ...row,
    isCustom: true
  }));
}

export function upsertDeltaHedgeScannerSymbol(symbolRecord) {
  execute(`
    INSERT INTO delta_hedge_scanner_symbols (
      symbol,
      label
    ) VALUES (
      ${quoteLiteral(symbolRecord.symbol)},
      ${quoteLiteral(symbolRecord.label)}
    )
    ON CONFLICT (symbol) DO UPDATE SET
      label = EXCLUDED.label,
      updated_at = NOW()
  `);

  return queryJson(
    `
      SELECT
        symbol,
        label,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM delta_hedge_scanner_symbols
      WHERE symbol = ${quoteLiteral(symbolRecord.symbol)}
    `,
    false
  );
}

export function deleteDeltaHedgeScannerSymbol(symbol) {
  return executeReturning(`
    DELETE FROM delta_hedge_scanner_symbols
    WHERE symbol = ${quoteLiteral(symbol)}
    RETURNING symbol
  `);
}

export function countUsers() {
  const row = queryJson(`SELECT COUNT(*)::int AS "userCount" FROM users`, false);
  return Number(row?.userCount ?? 0) || 0;
}

export function createUser({ id, username, passwordHash, role = "user", disabled = false } = {}) {
  const normalizedUsername = normalizeUsername(username);
  const normalizedRole = String(role ?? "user").trim().toLowerCase() === "admin" ? "admin" : "user";

  if (!id) {
    throw new Error("User id is required");
  }
  if (!normalizedUsername) {
    throw new Error("Username is required");
  }
  if (!passwordHash) {
    throw new Error("Password hash is required");
  }

  execute(`
    INSERT INTO users (
      id,
      username,
      password_hash,
      role,
      disabled
    ) VALUES (
      ${quoteLiteral(id)},
      ${quoteLiteral(normalizedUsername)},
      ${quoteLiteral(passwordHash)},
      ${quoteLiteral(normalizedRole)},
      ${disabled ? "TRUE" : "FALSE"}
    )
  `);

  return getUserById(id);
}

export function listUsers() {
  return queryJson(`
    SELECT
      id,
      username,
      role,
      disabled::int AS disabled,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM users
    ORDER BY created_at DESC, username ASC
  `);
}

export function getUserByUsername(username) {
  const normalizedUsername = normalizeUsername(username);
  if (!normalizedUsername) {
    return null;
  }

  return queryJson(
    `
      SELECT
        id,
        username,
        password_hash AS "passwordHash",
        role,
        disabled::int AS disabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM users
      WHERE username = ${quoteLiteral(normalizedUsername)}
      LIMIT 1
    `,
    false
  );
}

export function getUserById(userId) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    return null;
  }

  return queryJson(
    `
      SELECT
        id,
        username,
        password_hash AS "passwordHash",
        role,
        disabled::int AS disabled,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM users
      WHERE id = ${quoteLiteral(normalizedId)}
      LIMIT 1
    `,
    false
  );
}

export function setUserPassword(userId, passwordHash) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    throw new Error("User id is required");
  }
  if (!passwordHash) {
    throw new Error("Password hash is required");
  }

  return executeReturning(`
    UPDATE users
    SET
      password_hash = ${quoteLiteral(passwordHash)},
      updated_at = NOW()
    WHERE id = ${quoteLiteral(normalizedId)}
    RETURNING id
  `);
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

  mutateJson(`
    INSERT INTO user_api_keys (
      id,
      user_id,
      label,
      token_hash,
      token_prefix
    ) VALUES (
      ${quoteLiteral(normalizedId)},
      ${quoteLiteral(normalizedUserId)},
      ${quoteLiteral(normalizedLabel)},
      ${quoteLiteral(normalizedTokenHash)},
      ${quoteLiteral(normalizedTokenPrefix)}
    )
    RETURNING id
  `);

  return listUserApiKeys().find((item) => item.id === normalizedId) ?? null;
}

export function listUserApiKeys() {
  return queryJson(`
    SELECT
      k.id,
      k.user_id AS "userId",
      u.username,
      k.label,
      k.token_prefix AS "tokenPrefix",
      k.revoked_at AS "revokedAt",
      k.last_used_at AS "lastUsedAt",
      k.created_at AS "createdAt",
      k.updated_at AS "updatedAt"
    FROM user_api_keys k
    INNER JOIN users u
      ON u.id = k.user_id
    ORDER BY
      CASE WHEN k.revoked_at IS NULL THEN 0 ELSE 1 END,
      k.created_at DESC,
      k.label ASC
  `);
}

export function getUserApiKeyWithUser(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return null;
  }

  return queryJson(
    `
      SELECT
        k.id,
        k.user_id AS "userId",
        u.username,
        u.role,
        u.disabled::int AS disabled,
        k.label,
        k.token_hash AS "tokenHash",
        k.token_prefix AS "tokenPrefix",
        k.revoked_at AS "revokedAt",
        k.last_used_at AS "lastUsedAt",
        k.created_at AS "createdAt",
        k.updated_at AS "updatedAt"
      FROM user_api_keys k
      INNER JOIN users u
        ON u.id = k.user_id
      WHERE k.token_hash = ${quoteLiteral(normalizedTokenHash)}
      LIMIT 1
    `,
    false
  );
}

export function touchUserApiKey(id) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return false;
  }

  return executeReturning(`
    UPDATE user_api_keys
    SET
      last_used_at = NOW(),
      updated_at = NOW()
    WHERE id = ${quoteLiteral(normalizedId)}
      AND revoked_at IS NULL
    RETURNING id
  `);
}

export function revokeUserApiKey(id) {
  const normalizedId = String(id ?? "").trim();
  if (!normalizedId) {
    return false;
  }

  return executeReturning(`
    UPDATE user_api_keys
    SET
      revoked_at = NOW(),
      updated_at = NOW()
    WHERE id = ${quoteLiteral(normalizedId)}
      AND revoked_at IS NULL
    RETURNING id
  `);
}

export function createSession({ tokenHash, userId, expiresAt } = {}) {
  if (!tokenHash || !userId || !expiresAt) {
    throw new Error("tokenHash, userId, and expiresAt are required");
  }

  execute(`
    INSERT INTO user_sessions (
      token_hash,
      user_id,
      expires_at
    ) VALUES (
      ${quoteLiteral(tokenHash)},
      ${quoteLiteral(userId)},
      ${quoteLiteral(expiresAt)}
    )
  `);

  return getSessionWithUser(tokenHash);
}

export function getSessionWithUser(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return null;
  }

  return queryJson(
    `
      SELECT
        s.token_hash AS "tokenHash",
        s.user_id AS "userId",
        s.created_at AS "createdAt",
        s.last_seen_at AS "lastSeenAt",
        s.expires_at AS "expiresAt",
        u.username AS username,
        u.role AS role,
        u.disabled::int AS disabled
      FROM user_sessions AS s
      INNER JOIN users AS u
        ON u.id = s.user_id
      WHERE s.token_hash = ${quoteLiteral(normalizedTokenHash)}
      LIMIT 1
    `,
    false
  );
}

export function touchSession(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return false;
  }

  return executeReturning(`
    UPDATE user_sessions
    SET last_seen_at = NOW()
    WHERE token_hash = ${quoteLiteral(normalizedTokenHash)}
    RETURNING token_hash
  `);
}

export function deleteSession(tokenHash) {
  const normalizedTokenHash = String(tokenHash ?? "").trim();
  if (!normalizedTokenHash) {
    return false;
  }

  return executeReturning(`
    DELETE FROM user_sessions
    WHERE token_hash = ${quoteLiteral(normalizedTokenHash)}
    RETURNING token_hash
  `);
}

export function deleteExpiredSessions(nowIso = new Date().toISOString()) {
  const timestamp = String(nowIso ?? "").trim();
  if (!timestamp) {
    return 0;
  }

  const raw = runPsql(`
    DELETE FROM user_sessions
    WHERE expires_at <= ${quoteLiteral(timestamp)}
    RETURNING 1
  `);

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length;
}

export function getIbkrSettings(userId) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    return null;
  }

  const row = queryJson(
    `
      SELECT
        user_id AS "userId",
        config_json::text AS "configJson",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_ibkr_settings
      WHERE user_id = ${quoteLiteral(normalizedId)}
      LIMIT 1
    `,
    false
  );

  if (!row) {
    return null;
  }

  return {
    ...row,
    config: JSON.parse(row.configJson ?? "{}")
  };
}

export function upsertIbkrSettings(userId, config) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    throw new Error("User id is required");
  }

  const payload = config && typeof config === "object" ? config : {};
  execute(`
    INSERT INTO user_ibkr_settings (
      user_id,
      config_json
    ) VALUES (
      ${quoteLiteral(normalizedId)},
      ${quoteJson(payload)}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      config_json = EXCLUDED.config_json,
      updated_at = NOW()
  `);

  return getIbkrSettings(normalizedId);
}

export function claimLegacyUserData(userId) {
  const normalizedId = String(userId ?? "").trim();
  if (!normalizedId) {
    throw new Error("User id is required");
  }

  executeTransaction([
    `UPDATE paper_orders SET user_id = ${quoteLiteral(normalizedId)} WHERE user_id = 'legacy'`,
    `UPDATE strategy_runs SET user_id = ${quoteLiteral(normalizedId)} WHERE user_id = 'legacy'`,
    `UPDATE strategy_watchlist SET user_id = ${quoteLiteral(normalizedId)} WHERE user_id = 'legacy'`,
    `UPDATE setup_watchlist SET user_id = ${quoteLiteral(normalizedId)} WHERE user_id = 'legacy'`
  ]);
}

export default {
  type: "postgres",
  databaseUrl
};
