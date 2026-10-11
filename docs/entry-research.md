# Entry research and Tiger setup

Open **Covered Income → Research an entry**, or the same panel in **Threshold Hedge**. Enter a US symbol; select ETF where appropriate. Optional peers must be businesses you consider comparable (minimum three positive multiples). Set an entry fee per contract before comparing net put credits. Research can be viewed even when no scanner candidate is eligible.

Six views cover price structure, business quality, relative valuation, volatility, demand, and put entries. Save a snapshot to preserve the exact server-issued research you saw, including inputs, timestamps and version. The preview expires after 30 minutes. Compare it with a later review or another candidate. Saved routines collect at 15-minute intervals during US session hours, subject to dataset TTLs, failures and account quotas. Ten routines per user are allowed during the pilot. Quotes on an open page age visibly; press **Refresh market data** before reviewing an entry.

## Tiger subscriptions

Start with **OpenAPI US Options L1** and **OpenAPI US Stock L1**; ask Tiger to enable fundamental endpoints. Confirm historical IV and financial-history access with your own account before buying additional data. L1 stock data is Nasdaq Basic, not consolidated US NBBO. Defer Nasdaq L2 until depth is useful to your actual workflow. Prices depend on the signed-in API store; no subscription is purchased by this app.

References: [API purchasing](https://docs-en.itigerup.com/docs/fee), [coverage and quotas](https://docs-en.itigerup.com/docs/permission), [options / IV history](https://docs-en.itigerup.com/docs/quote-option), [fundamental permission](https://docs-en.itigerup.com/docs/faq).

## Local setup

The bridge uses Tiger's official Python SDK pinned to 3.8.0. Provision your SDK configuration directory using Tiger's official instructions; keep it outside the repository. Do not place keys in browser settings or Postman exports.

```sh
python3 -m venv .venv-tiger
.venv-tiger/bin/pip install -r tiger-bridge/requirements.txt
```

Configure these variables for the bridge process:

- `TIGER_CONFIG_DIR`: SDK configuration directory containing your Tiger ID, license and key configuration.
- `TIGER_BRIDGE_TOKEN`: a random private shared token, also supplied to HedgeHub.
- `TIGER_CLAIM_DEVICE=true`: only on the one server intended to own API quote access. Default is false; do not run multiple device owners.

Start the bridge with `.venv-tiger/bin/python tiger-bridge/app.py` (localhost port 8788). Configure the HedgeHub process with:

- `MARKET_DATA_PROVIDER=tiger`
- `TIGER_BRIDGE_URL=http://127.0.0.1:8788`
- `TIGER_BRIDGE_TOKEN`: the same private token.

Then start HedgeHub normally. Without `MARKET_DATA_PROVIDER=tiger`, current providers remain selected and Tiger-only research panels show missing coverage. No trading client is instantiated by the bridge. Do not expose its port publicly.

For Docker, use the overlay `deploy/docker-compose.tiger.example.yml` with the main compose file. Its bridge port is internal only. The SDK config mount is read-only; manage license-specific token renewal outside the container if your account requires it. The API permission check does not claim device access or buy a subscription.

## Data and limitations

- Persistence is isolated in `data/research.db` (`RESEARCH_DB_PATH` can override). Back it up alongside `hedgehub.db`, using SQLite's backup API or stopping the app first; copy WAL consistently. Existing trading data is not migrated.
- Rolling raw dataset observations are kept for 30 days, daily derived features for three years; saved decision snapshots are retained. Full backfilled bar/IV datasets remain in the latest dataset cache.
- Bars and financial datasets cache for six and 24 hours respectively; IV for six hours; events for one hour; chains and flow for 15 minutes; quote fetches for 15 seconds. Failures retain last-success timestamps and retry with exponential backoff. Manual refresh does not override a provider backoff.
- Historical IV is Tiger's composite underlying series. Contract IV, skew and near-ATM expiry estimates are separate. Local historical ranks need at least 60 observations; the sample count is displayed. Missing history is never synthesized.
- Financial comparisons use reporting dates and filing dates. Records without a known publication date are excluded from trends. No DCF or intrinsic-value target is inferred from a moving average. Revised vendor history is not guaranteed to be an original point-in-time vintage; immutable saved snapshots preserve observations from the collection date onward.
- Reference model Greeks exclude early exercise and discrete dividends and use a disclosed default rate. They are estimates, not Tiger's deprecated daily Greeks. Quotes are kept distinct from modeled prices. Option trade timestamps do not qualify as quote timestamps; the Tiger depth endpoint supplies quote event times. Depth permission failures leave candidates unverified.
- Strict scanner eligibility requires verified bid/ask, quote and underlying age at most 90 seconds, positive uncrossed markets, selected liquidity limits and known earnings coverage when exclusion is enabled. Therefore closed-market or undated scans can correctly return no actionable candidates.
- Earnings calendar absence is unknown; a known next report establishes coverage only through that report. Dividend data is collected where entitled; early assignment is not predicted from dividend yield alone. Income scanner premiums use bids before fees; the research comparison uses your entry fee.
- Capital estimates assume cash-secured puts and newly purchased shares for covered calls/strangles. Existing share lots/margin are not imported. Standard 100-share contracts only qualify in Covered Income.
- Flow is Tiger-classified order flow, not confirmed institutional buying. Sector comparisons require your selected ETF; selected symbols do not establish market-wide breadth. The old macro atlas is labeled illustrative and is not used as a research signal.
- Threshold charts report profitable scenario share and payoff at target. Touch-event results remain explicitly labeled conditional endpoint approximations. Missing exact markets cannot be valued with similar questions, and current spot cannot establish historical settlement.

## API and checks

Authenticated routes: `GET /api/settings/market-data`, `GET /api/research/permissions`, `GET /api/research/:symbol`, `GET /api/research/:symbol/history`, `GET /api/research/snapshots`, `GET /api/research/snapshots/:id`, `POST /api/research/:symbol/snapshots` with `researchId`, and GET/POST/DELETE research watchlist routes. Provider selection is deployment configuration, not an API mutation.

```sh
npm test
npm run build
.venv-tiger/bin/python -m unittest discover -s tiger-bridge -p 'test_*.py'
```

Before using Tiger for decisions, check permissions/quotas in the research panel, compare one stock/ETF quote and several option contracts with Tiger, confirm timestamp/unit semantics, IV history, earnings dates and financial-report access, then collect across several sessions. Live parity and longitudinal outcome validation require an entitled account and elapsed market sessions; fixture tests do not establish that validation.

## Events and sentiment checklist

The **Events & sentiment** tab uses a configurable 7–90-day lookback (default 30) and extends through **seven calendar days after the selected option expiry, inclusive**. Set the expiry in the research controls; it also requests that option expiry. Without a selected expiry, the window uses the scanner's 38-day outer range plus seven days. Expired routines require a new expiry. Snapshots preserve the event checklist and requested window.

The checklist separates economic releases, earnings/results, published statements, operating updates/announcements/regulatory dates, dividends, and social discussion. It shows recent past, through-expiry, post-expiry buffer, and undated events. Economic release times display in UTC; date-only company events remain date-only. Sources may return partial calendars and change schedules. A successful collection is never labeled complete event clearance. Entry quote/liquidity eligibility does **not** include a comprehensive catalyst-risk approval.

- Economic events use the existing TradingView calendar across the whole requested window, all available importance levels and countries. Filter country in the UI. Source errors preserve stale data and expose a gap.
- Earnings use the Tiger calendar or existing TradingView fallback, including the past window. TradingView past/future queries are separate because its row provides one release. Published financial statements come from filing-dated financial history; these are not treated as future earnings dates.
- Company operating updates, product launches, regulatory deadlines and industry releases are **not automatically discovered**. A source-backed supplemental JSON calendar can be configured with `RESEARCH_CATALYST_FILE` pointing to an absolute file outside the repository. Recheck original sources regularly. Reviews older than seven days or without a date are flagged as gaps. Unknown dates stay TBA; recurring patterns never become confirmed dates.

Example supplemental calendar format (illustrative only; replace every field with verified evidence):

```json
{
  "reviewedAt": "2026-10-04T12:00:00Z",
  "events": [{
    "id": "example-operating-update",
    "symbols": ["TSLA"],
    "title": "Regional vehicle registration release — date to verify",
    "category": "operating-update",
    "date": null,
    "dateStatus": "unconfirmed",
    "source": "ACEA",
    "sourceUrl": "https://www.acea.auto/press-release-calendar/",
    "verifiedAt": "2026-10-04T12:00:00Z",
    "note": "Industry registration statistics, not a Tesla earnings release. Verify geography, reporting period and publication date."
  }]
}
```

Categories: `operating-update`, `announcement`, `regulatory`. Date evidence: `confirmed`, `estimated`, `unconfirmed`. Use [Tesla investor relations](https://ir.tesla.com/) for issuer announcements and [ACEA's calendar](https://www.acea.auto/press-release-calendar/) for its European registration statistics; they are distinct publishers. The file is never edited or fetched from arbitrary URLs by the application. It must be maintained by a trusted local process/operator.

### Social access and remaining limitations

Social collection is off by default. Configure approved provider access outside the repository, then explicitly enable `RESEARCH_SOCIAL_ENABLED=true`:

- X: `X_BEARER_TOKEN`; recent search returns at most the last seven days. `X_RESEARCH_ARCHIVE=true` selects full-archive search for the requested lookback and requires the appropriate paid access. Each collection is capped at one request / 100 posts, cached for one hour. No automated pagination or subscription purchase.
- Reddit: `REDDIT_ACCESS_TOKEN` and a descriptive `REDDIT_USER_AGENT` from your approved API application. Token issuance/refresh remains external. Search is capped at 100 submissions; comments are excluded.

The adapters return source links, timestamps, source-specific access errors and capped-sample warnings. Topic counts use disclosed keyword groups over the last seven days; they are not measures of topic growth or institutional opinion. **Validated positive/negative sentiment scoring is not implemented**, and the checklist explicitly keeps that as a coverage gap. A connected feed does not establish representative sentiment. X cashtag-only and Reddit ticker search can miss relevant discussion or include ambiguous matches. Future sentiment cannot be collected; recent posts may discuss future scheduled catalysts.

No social API access was enabled or charged during implementation. See [X search coverage](https://docs.x.com/x-api/posts/search/introduction) and [Reddit API documentation](https://www.reddit.com/dev/api/). Missing company-event feeds and unconfigured social APIs remain visible rather than being filled with fabricated summaries.
