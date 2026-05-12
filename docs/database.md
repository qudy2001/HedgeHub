# Database Architecture

## Migration assessment

Current SQLite file:

- `data/hedgehub.db`
- WAL enabled: `journal_mode=wal`
- direct `better-sqlite3` usage in [server/db-sqlite.js](/Users/raylv/Developer/HedgeHub SQL/server/db-sqlite.js:1)
- no standalone migration framework before this change
- initialization previously happened inline at module load

Observed current row counts from the local SQLite file on May 6, 2026:

- `market_snapshots`: `81,488`
- `paper_order_snapshots`: `6,753`
- `macro_dashboard_snapshots`: `14`
- `paper_orders`: `12`
- most other tables are small lookup, auth, or user-state tables

Current table classification:

- Time-series candidate tables: `market_snapshots`
- Event tables: `paper_order_snapshots`, `strategy_runs`, `macro_dashboard_snapshots`
- Lookup/reference tables: `strategy_profiles`, `strategy_asset_mappings`, `delta_hedge_scanner_symbols`, `users`
- User-state tables: `strategy_watchlist`, `setup_watchlist`, `paper_orders`, `user_sessions`, `user_ibkr_settings`
- Cache-style tables: `market_snapshots`, `macro_dashboard_snapshots`

Current query patterns discovered in [server/index.js](/Users/raylv/Developer/HedgeHub SQL/server/index.js:1) and [server/auth.js](/Users/raylv/Developer/HedgeHub SQL/server/auth.js:1):

- `market_snapshots`: append-only writes plus latest-per-symbol reads
- `paper_order_snapshots`: append/upsert by `(order_id, captured_at)` plus ordered history reads
- `paper_orders`: point updates and list-by-user reads
- `setup_watchlist`: per-user upserts and reads
- `user_sessions`: point lookup by token plus expiry pruning

## Hypertable decisions

Hypertables:

- `market_snapshots`
  Expected pattern: append-heavy intraday quote snapshots with latest-per-symbol reads.
  Reason: this is the only existing high-write time-series table in the current app.
- `option_chain_snapshots`
  Expected pattern: append-heavy historical options snapshots across symbols and expiries.
  Reason: this is the core new Timescale use case for future options ingestion.
- `underlying_prices`
  Expected pattern: append-heavy OHLCV history and rolling lookbacks.
  Reason: classic time-series storage with symbol/time filters.

Normal PostgreSQL tables:

- `paper_order_snapshots`
  Reason: append-heavy, but it is transactional application state tied to interactive paper trading, not large-scale market history.
- `iv30_history`
  Reason: daily-granularity derived metrics with moderate volume; standard PostgreSQL indexing is enough initially.
- `iv_rank_daily`
  Reason: daily derived analytics, not high-frequency ingestion.
- all auth, lookup, watchlist, and settings tables
  Reason: transactional and low volume.

## Docker flow

1. Copy `.env.compose.example` to `.env`.
2. Start the stack with `docker compose up -d`.
3. The `postgres` service uses `timescale/timescaledb:latest-pg16`.
4. SQL files in `db/init/` run in deterministic order.

## Local macOS flow

```bash
brew install postgresql@16
brew services start postgresql@16
createdb optionsdb
psql postgresql://postgres:postgres@localhost:5432/optionsdb -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
cp .env.example .env
./scripts/startup.sh --local-db
```

## Scripts

- `./scripts/startup.sh`
  Starts Docker Postgres when `DB_TYPE=postgres` unless `--local-db` is used.
- `./scripts/shutdown.sh`
  Stops the local app and stops the Docker Postgres container without removing volumes when the script started it.
- `./scripts/restart.sh`
  Preserves the same startup flow and restarts cleanly.
- `./scripts/migrate_sqlite_to_postgres.py --resume`
  Migrates current SQLite data in batches using `psql \copy`.

## Backup and restore

Docker or local PostgreSQL:

```bash
pg_dump "$DATABASE_URL" > hedgehub-postgres-backup.sql
psql "$DATABASE_URL" < hedgehub-postgres-backup.sql
```

SQLite fallback:

```bash
cp data/hedgehub.db data/hedgehub.db.backup
```

## Troubleshooting

- `psql: command not found`
  Install PostgreSQL client tools locally or use Docker mode.
- Postgres starts but Timescale extension fails
  Verify the database is Timescale-enabled and that you are using PostgreSQL 16-compatible Timescale binaries.
- App still needs SQLite compatibility
  Set `DB_TYPE=sqlite` and point `SQLITE_DB_PATH` at the existing database file.

## Tuning assumptions

- single-node only
- no replicas or clustering
- default Timescale chunking left implicit for now because the codebase does not yet ingest the large options-history tables
- indexes added only for observed app queries and the new planned time-series access patterns
