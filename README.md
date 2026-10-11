# HedgeHub

HedgeHub is a personal hedge-strategy workstation with:

- a React frontend tuned for dense market monitoring
- an Express backend for live quote refresh and strategy analytics
- SQLite compatibility through `better-sqlite3`
- PostgreSQL 16 + TimescaleDB bootstrap for historical-data migration
- TradingView widgets for market context and calendars

## Run

```bash
npm install
npm run dev
```

- frontend: `http://localhost:5173`
- backend: `http://localhost:8787`

Production build:

```bash
npm run build
npm start
```

Service scripts:

```bash
./scripts/startup.sh
./scripts/startup.sh --local-db
./scripts/restart.sh
./scripts/shutdown.sh
```

Docker / NAS deployment:

```bash
cp .env.compose.example .env
docker compose pull
docker compose up -d
```

The default compose stack now includes:

- `postgres` using `timescale/timescaledb:latest-pg16`
- `web` for the Express API and built React frontend
- `scanner` for background refresh and scanner persistence jobs
- deterministic SQL bootstrap from `db/init/`
- persistent Postgres data in the `postgres_data` volume

- app: `http://localhost:8787` by default, or the host port set in `.env`
- frontend data flow: browser -> `web` API -> PostgreSQL
- scanner data flow: `scanner` worker -> PostgreSQL
- image source: set `HEDGEHUB_IMAGE` in `.env`, for example `ghcr.io/qudy2001/hedgehub-postgresql:latest`
- persistent data: `data/` for SQLite and `dashboards/` for saved layouts
- persistent PostgreSQL data: Docker volume `postgres_data`
- logs: use `docker compose logs -f hedgehub`
- default dashboard layouts are seeded automatically on first boot if the dashboards volume starts empty

If you want to keep your current local data when moving to the NAS, copy these folders with the project:

- `data/`
- `dashboards/`

For NAS setups that prefer absolute bind mounts, update these values in `.env`:

- `HEDGEHUB_IMAGE`
- `HEDGEHUB_DATA_DIR`
- `HEDGEHUB_DASHBOARDS_DIR`

GitHub image publishing:

- a GitHub Actions workflow at `.github/workflows/docker-publish.yml` builds multi-arch images for `linux/amd64` and `linux/arm64`
- pushes on `main`, `master`, `codex/livedata`, tags starting with `v`, and manual runs
- publishes to GitHub Container Registry as `ghcr.io/<owner>/<repo>`
- the `codex/livedata` branch still publishes the legacy `ghcr.io/qudy2001/hedgehub-livedata` line
- the `codex/postgresql` branch publishes the PostgreSQL line at `ghcr.io/qudy2001/hedgehub-postgresql`
- if the package stays private, the NAS must log in first with `docker login ghcr.io`

Nginx reverse proxy:

- a ready-to-copy example config lives at `deploy/nginx/hedgehub.conf.example`
- replace `hedgehub.example.com` with your real hostname
- replace `192.168.1.50:8787` with your NAS IP and exposed HedgeHub port
- replace the certificate paths with the certs already installed on your Nginx host
- test and reload on the Nginx host with:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

Service scripts:

```bash
./scripts/startup.sh
./scripts/restart.sh
./scripts/shutdown.sh
./scripts/publish-image.sh
./scripts/publish-image-fast.sh
```

The scripts write the PID file and application log under `logs/`.

## Database modes

App configuration is now environment-driven:

```env
HEDGEHUB_ROLE=web
HEDGEHUB_ENABLE_HTTP=true
HEDGEHUB_ENABLE_BACKGROUND_JOBS=false

DB_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=optionsdb
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/optionsdb

SQLITE_DATA_DIR=./data
SQLITE_DB_PATH=./data/hedgehub.db
```

Runtime roles:

- `web`
  Starts Express, serves `dist`, exposes `/api/*`, and keeps background jobs off by default.
- `scanner`
  Disables HTTP and runs background refresh / scanner persistence loops against PostgreSQL.

Local macOS PostgreSQL:

```bash
brew install postgresql@16
brew services start postgresql@16
createdb optionsdb
psql postgresql://postgres:postgres@localhost:5432/optionsdb -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
./scripts/startup.sh --local-db
```

SQLite fallback remains available:

```bash
DB_TYPE=sqlite ./scripts/startup.sh
```

SQLite-to-PostgreSQL migration:

```bash
./scripts/migrate_sqlite_to_postgres.py --resume
```

More detail lives in [docs/database.md](/Users/raylv/Developer/HedgeHub SQL/docs/database.md:1).

Manual PostgreSQL image publish:

```bash
./scripts/publish-image.sh
./scripts/publish-image-fast.sh
```

## What is implemented

- front page dashboard for US, UK, EU, commodities, bonds, crypto, forex, and global trade
- left strategy rail with the Bitcoin / IBIT example strategy
- live proxy quote tracking stored in SQLite
- P&L timeline for daily BTC-to-80k scenarios through March 31
- Greek-aware option model using delta, gamma, vega, and theta
- TradingView embeds for ticker tape, advanced chart, market overview, economic calendar, and events
- shared scanner persistence for TradingView Finder and Covered Income runs
- candidate rank history and paper-trade promotion tracking for scanner workflows
- regime-aware scanner payloads with IV rank, IV/HV spread, EV/BP, portfolio impact, and explainability data
- progressive-disclosure scanner UI with a lean decision grid and deeper analytics in the detail area

## Scanner intelligence

The scanner platform is moving from stateless tables to persistent strategy-intelligence workflows:

- shared run persistence and presets
- candidate rank drift tracking
- volatility regime classification
- portfolio overlap diagnostics
- explainable score breakdowns

Implementation notes live here:

- [docs/scanner-architecture.md](/Users/raylv/Developer/HedgeHub SQL/docs/scanner-architecture.md:1)
- [docs/scoring-system.md](/Users/raylv/Developer/HedgeHub SQL/docs/scoring-system.md:1)
- [docs/volatility-regime.md](/Users/raylv/Developer/HedgeHub SQL/docs/volatility-regime.md:1)
- [docs/ui-architecture.md](/Users/raylv/Developer/HedgeHub SQL/docs/ui-architecture.md:1)

## Current limits

- TradingView provides embeddable widgets but not a public general-purpose quote/options REST API for this use case
- Polymarket search is wired through the public Gamma API, but matching markets can be sparse depending on what is live
- options chain quotes currently fall back to modeled pricing when a public chain feed is not available

## Next upgrades

- persist editable strategy parameters in the UI
- add background jobs for recurring scans and alerting
