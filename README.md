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

With the optional IBKR sidecar:

```bash
cp .env.compose.example .env
docker compose --profile ibkr up -d
```

With the optional single-container image that embeds IBKR Gateway:

```bash
cp .env.compose.example .env
docker compose -f deploy/docker-compose.ibkr-embedded.example.yml up -d
```

If you run on an existing external Docker network such as `nocodb_network`, a ready-made example lives at:

- `deploy/docker-compose.nocodb-ibkr.example.yml`
- `deploy/docker-compose.nocodb-ibkr-embedded.example.yml`

- app: `http://localhost:8787` by default, or the host port set in `.env`
- image source: set `HEDGEHUB_IMAGE` in `.env`, for example `ghcr.io/qudy2001/hedgehub-livedata:latest`
- `POLYGON_API_KEY` is optional and can be added to `.env` if you want live Polygon option-chain data
- `IBKR_CP_BASE_URL` defaults to `https://ibkr-gateway:5000/v1/api` for the optional Docker sidecar
- `IBKR_CP_ACCOUNT_ID` is optional if you want HedgeHub to pin a specific IBKR paper account
- `IBKR_CP_ALLOW_SELF_SIGNED=true` lets HedgeHub talk to the default self-signed local gateway certificate
- `IBKR_CP_REQUIRE_PAPER=true` keeps routing locked to IBKR paper sessions so live accounts are rejected
- `IBKR_SYNC_INTERVAL_MS` controls how often HedgeHub refreshes broker-backed paper orders
- `IBKR_GATEWAY_DIR` should point to the unzipped `clientportal.gw` bundle when you enable the `ibkr` profile
- `IBKR_GATEWAY_IMAGE` defaults to `ghcr.io/qudy2001/hedgehub-ibkr-gateway:latest`
- `HEDGEHUB_IBKR_IMAGE` defaults to `ghcr.io/qudy2001/hedgehub-livedata-ibkr:latest`
- `IBKR_GATEWAY_HOST_PORT` defaults to `5001`, so the NAS-hosted gateway login page is exposed on `https://<nas-host>:5001`
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
- `IBKR_GATEWAY_DIR`

GitHub image publishing:

- a GitHub Actions workflow at `.github/workflows/docker-publish.yml` builds multi-arch images for `linux/amd64` and `linux/arm64`
- pushes on `main`, `master`, `codex/livedata`, `codex/embedded-ibkr-gateway`, tags starting with `v`, and manual runs
- publishes to GitHub Container Registry as `ghcr.io/<owner>/<repo>`
- the `codex/livedata` and `codex/embedded-ibkr-gateway` branches publish a separate image line at `ghcr.io/qudy2001/hedgehub-livedata`
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
./scripts/publish-ibkr-image.sh
./scripts/publish-ibkr-image-fast.sh
```

The scripts write the PID file and application log under `logs/`.

Manual embedded-image publish:

```bash
./scripts/publish-ibkr-image.sh
./scripts/publish-ibkr-image-fast.sh
```

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

Local gateway:

1. Start the IBKR Client Portal Gateway locally and log into your paper session.
2. Keep the gateway reachable at `IBKR_CP_BASE_URL`, or override the env var if you use a different host or port.
3. Optionally set `IBKR_CP_ACCOUNT_ID` when the gateway exposes more than one account.
4. In the strategy calculator, switch the execution route from `Local paper` to `IBKR paper`.
5. Choose `Limit` or `Market`, set TIF and outside-RTH behavior, then create the order.

Docker / NAS sidecar:

1. Download and unzip the IBKR Client Portal Gateway bundle.
2. Place the extracted folder at `./vendor/clientportal.gw` in this repo, or point `IBKR_GATEWAY_DIR` at the extracted bundle in `.env`.
3. Start the stack with `docker compose --profile ibkr up -d`.
4. Open `https://<nas-host>:5001` in your browser and complete the IBKR paper login flow.
5. Keep HedgeHub pointed at `IBKR_CP_BASE_URL=https://ibkr-gateway:5000/v1/api`.

Notes:

- HedgeHub stores the strategy locally first, then submits the option legs to IBKR and syncs broker order state back into the paper-trading page.
- IBKR-backed open orders can be synced, cancelled, and sent to exit from the paper-trading workspace.
- The order moves to closed history after the IBKR exit order fills and HedgeHub syncs the execution.
- The Docker sidecar is a practical private-network deployment pattern, but IBKR still documents the Client Portal Gateway as a local/same-machine workflow and requires periodic browser reauthentication.
- Keep the gateway private to your LAN or VPN. Do not expose `5001` directly to the public internet.

Docker / NAS embedded gateway:

1. Download and unzip the IBKR Client Portal Gateway bundle.
2. Place the extracted folder at `./vendor/clientportal.gw`, or update `IBKR_GATEWAY_DIR` in `.env`.
3. Start the embedded image with `docker compose -f deploy/docker-compose.ibkr-embedded.example.yml up -d`.
4. Open `https://<nas-host>:5001` and complete the IBKR paper login flow.
5. The embedded image keeps HedgeHub pointed at `IBKR_CP_BASE_URL=https://127.0.0.1:5001/v1/api`, which avoids Docker bridge allowlist issues.

Notes:

- The embedded image publishes a separate image line: `ghcr.io/qudy2001/hedgehub-livedata-ibkr:latest`.
- This is the simplest NAS deployment path when the IBKR Gateway IP allowlist rejects sibling containers on a Docker bridge network.
- If the gateway still returns `403 Access Denied` after browser login, use `network_mode: host` on Linux NAS deployments so the browser login and HedgeHub API calls share the host network namespace.
- The sidecar deployment remains available if you prefer separate containers.

## Next upgrades

- expand IBKR execution coverage for more advanced combo pricing and broker-side position reconciliation
- persist editable strategy parameters in the UI
- add background jobs for recurring scans and alerting
