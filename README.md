# HedgeHub

HedgeHub is a personal hedge-strategy workstation with:

- a React frontend tuned for dense market monitoring
- an Express backend for live quote refresh and strategy analytics
- SQLite storage through `better-sqlite3`
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

Docker / NAS deployment:

```bash
cp .env.compose.example .env
docker compose pull
docker compose up -d
```

- app: `http://localhost:8787` by default, or the host port set in `.env`
- image source: set `HEDGEHUB_IMAGE` in `.env`, for example `ghcr.io/qudy2001/hedgehub-livedata:latest`
- `POLYGON_API_KEY` is optional and can be added to `.env` if you want live Polygon option-chain data
- `IBKR_CP_BASE_URL` defaults to `https://127.0.0.1:5000/v1/api` for the local IBKR Client Portal Gateway
- `IBKR_CP_ACCOUNT_ID` is optional if you want HedgeHub to pin a specific IBKR paper account
- `IBKR_CP_ALLOW_SELF_SIGNED=true` lets HedgeHub talk to the default self-signed local gateway certificate
- `IBKR_CP_REQUIRE_PAPER=true` keeps routing locked to IBKR paper sessions so live accounts are rejected
- `IBKR_SYNC_INTERVAL_MS` controls how often HedgeHub refreshes broker-backed paper orders
- persistent data: `data/` for SQLite and `dashboards/` for saved layouts
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
- the `codex/livedata` branch publishes a separate image line at `ghcr.io/qudy2001/hedgehub-livedata`
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
```

The scripts write the PID file and application log under `logs/`.

## What is implemented

- front page dashboard for US, UK, EU, commodities, bonds, crypto, forex, and global trade
- left strategy rail with the Bitcoin / IBIT example strategy
- live proxy quote tracking stored in SQLite
- P&L timeline for daily BTC-to-80k scenarios through March 31
- Greek-aware option model using delta, gamma, vega, and theta
- TradingView embeds for ticker tape, advanced chart, market overview, economic calendar, and events

## Current limits

- TradingView provides embeddable widgets but not a public general-purpose quote/options REST API for this use case
- Polymarket search is wired through the public Gamma API, but matching markets can be sparse depending on what is live
- options chain quotes currently fall back to modeled pricing when a public chain feed is not available
- IBKR routing currently uses the Client Portal Gateway session, so the local gateway must be running and authenticated in paper mode
- IBKR option routing targets option legs only; Polymarket legs remain local paper legs inside HedgeHub

## IBKR paper trading

1. Start the IBKR Client Portal Gateway locally and log into your paper session.
2. Keep the gateway reachable at `IBKR_CP_BASE_URL`, or override the env var if you use a different host or port.
3. Optionally set `IBKR_CP_ACCOUNT_ID` when the gateway exposes more than one account.
4. In the strategy calculator, switch the execution route from `Local paper` to `IBKR paper`.
5. Choose `Limit` or `Market`, set TIF and outside-RTH behavior, then create the order.

Notes:

- HedgeHub stores the strategy locally first, then submits the option legs to IBKR and syncs broker order state back into the paper-trading page.
- IBKR-backed open orders can be synced, cancelled, and sent to exit from the paper-trading workspace.
- The order moves to closed history after the IBKR exit order fills and HedgeHub syncs the execution.

## Next upgrades

- expand IBKR execution coverage for more advanced combo pricing and broker-side position reconciliation
- persist editable strategy parameters in the UI
- add background jobs for recurring scans and alerting
