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
- image source: set `HEDGEHUB_IMAGE` in `.env`, for example `ghcr.io/qudy2001/hedgehub:latest`
- `POLYGON_API_KEY` is optional and can be added to `.env` if you want live Polygon option-chain data
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
- pushes on `main`, `master`, tags starting with `v`, and manual runs
- publishes to GitHub Container Registry as `ghcr.io/<owner>/<repo>`
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

## Next upgrades

- plug in a broker or options data provider for live chains and Greeks
- persist editable strategy parameters in the UI
- add background jobs for recurring scans and alerting
