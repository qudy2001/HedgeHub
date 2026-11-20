# Strategy Studio

The new workspace is at `/builder`. The classic dashboard remains at `/`.

- `/builder?demo=1`: interactive sample data, no account required. No provider or AI calls. Save layout persists demo settings/items in this browser. Demo scans support AAPL, MSFT and SPY and always use modeled pricing.
- `/builder/tracker`: full checklist with five sentiment filters, evidence, history and manual review.
- `/builder/backtests`: date and stock selection, independent accounts, equity curves and trade results.

Run the existing `npm run dev` command, then open `http://localhost:5173/builder`. For production, run `npm run build` and `npm start`. API routes use the existing HedgeHub login. Vite preview alone has no API server.

## Workspace

The compact tracking strip and scanned option results sit immediately below the payoff heatmap. Hover or focus a tracking chip for a summary; click it to edit evidence, status, scope and contribution. A result selection updates the stock, option legs, heatmap, research and calendars. Result filters, pagination, CSV export, column selection and expanded table are available.

The **Option chain** button in the results toolbar swaps the table for a broker-style chain of the selected stock: expiry tabs on top (weeklies marked W, with days to expiry), calls on the left, puts on the right, the strike in the middle and a divider at the scan-time spot, with in-the-money sides shaded. Each contract shows the results-table columns that make sense for a single contract (bid/ask price and size, breakeven, max profit and loss, EV/BP, IV rank, liquidity, debit, IV, open interest, earnings, data, score), evaluated as buying one contract at the ask with the strategy's per-contract fee, through the same position maths the scanner uses. Ann ret % is an income yield, so it stays blank for a bought contract. Symbol, Strategy, Hedge choices and Legs to trade describe a whole position and are not repeated; Expiry and DTE are the tabs. The chain opens on the selected result's expiry and outlines that result's legs; a contract's Score button selects the best scanned result that trades it, which updates the heatmap. Columns and Expand work as in the table, so the chain can stay inline above the other panels or fill the screen. It reads the same full-chain data as the distribution panels below, so it shares their one- or two-year horizon, ten-minute cache and Tiger loading time. When the provider returns no implied volatility, IV is implied from the bid/ask mid and marked with an asterisk.

Use Customize or a panel handle to hide, restore, collapse or reorder panels. Each analytics panel offers its supported metrics under + Item. Save layout saves the strategy definition and workspace for the signed-in user. New scans use the edited definition; existing results remain snapshots of their original inputs until rescanned.

Scans compare collars, protective puts, covered calls, cash-secured puts, put credit/debit spreads and stock-only positions. Backtests use the selected template. Supported underlyings are US stock/ETF symbols. Other asset classes are not implemented.

## Data and ratings

Market mode uses the existing market-data adapters and requires genuine bid/ask inputs and IV for option candidates. Buys use ask, sells use bid. No available contract means no option candidate; there is no silent modeled fallback. Details expose contract, source, timestamp, IV and OI. Modeled mode explicitly uses synthetic $1-rounded strikes, target calendar-day expiries and trailing 20-session realized volatility; OI is unknown.

The versioned score is a transparent heuristic, not probability of profit or a measured statistical correlation. Its weights are protection 35, option cost 25, upside capture 20 and bid/ask liquidity 20. Quote liquidity requires a provider live flag and a timestamp within 90 seconds of the scan. Missing liquidity yields a 20-point score range, excluded from exact-score ranking. Stock-only rows have no option spread penalty. Scores and quotes remain scan-time snapshots.

Tracked contributions are scoped to stock and template. A reviewed item may contribute -5 to +5 points (source URLs are optional); related event keys count once and total adjustment is capped at ±15. Unverified evidence, evidence older than thirty days and expired impact windows contribute zero. Resolution remains green until the item is removed, but its directional impact is reviewed separately. An event resolving does not necessarily benefit every hedge. Repeated scans never accumulate the same points.

Option P&L uses the shared European pricing model, with entry fees. It does not model American early assignment or dividends. Catalyst scores do not change contractual payoff. Historical event panels show previous-session to next-session close moves, with partial provider coverage. Future events have user-entered price scenarios, not automatic price forecasts. Windows are 30/60/180/365 days; a future event after the selected expiry requires a longer-dated result. Historical IV and IV rank depend on existing research-provider coverage.

## Optional TradingAgents connection

Run the included TradingAgents project separately using its own documented deployment. Configure these variables on the **HedgeHub server process**, then restart it:

```text
TRADINGAGENTS_URL=http://127.0.0.1:8000
TRADINGAGENTS_TOKEN=<optional TradingAgents API token with read and write access>
BUILDER_DB_PATH=/absolute/path/to/data/builder.db
```

The URL is the service base URL, including a deployment prefix if applicable, **without** `/api`. The port above is an example; use the deployed service address. `TRADINGAGENTS_TOKEN` is optional — only `TRADINGAGENTS_URL` is required to enable the connection; leave the token unset if the deployed TradingAgents instance does not require authentication. When a token is set, it never enters browser code and is sent only as a bearer header on server-to-server requests. The adapter uses the included project's `/api/runs` endpoints; model/provider configuration stays in TradingAgents. No service or model credentials are supplied by this change.

When Daily discovery is enabled on a saved strategy, the running HedgeHub server starts research once per 24 hours and polls progress. At most the first ten symbols are researched. This can consume the configured service's model credits. Discovery uses TradingAgents report checkpoints, including its market/news research; it is not a separate exhaustive global news feed. Suggestions must be added to the strategy to persist. Matching subsequent checkpoints attach new evidence notices to saved items. AI completion claims never silently mark evidence verified or change saved impact. Review status and sources in the tracker. Removing an item does not disable daily discovery.

## Backtests and persistence

Backtests use historical OHLC data, trailing volatility and previous-close decisions filled at the next session's open. They include entry/exit fees and configurable stock/option slippage, stops, targets, expiry and rolling. Each symbol has independent capital; this is not a combined portfolio simulation. They do not use today's catalyst labels or option chain in historical decisions. Synthetic options, constant configured interest rate, provider-adjusted stock history, no dividend cashflows and no early assignment are explicit assumptions. Insufficient history or warm-up coverage is reported per symbol. Calendar-day expiries are synthetic and may fall on weekends. Historical option fills are not claimed.

Saved strategies, checklist history and job snapshots use a separate SQLite database (`data/builder.db` by default). Backtests run in worker threads. Two jobs can run at once; cancellation stops subsequent work and worker computation. An in-flight provider request may finish before cancellation releases its slot. Jobs interrupted by a restart are marked interrupted. There is currently no automatic history retention cleanup. Back up the database using normal SQLite backup practices.

## Verification

`npm test` covers payoff boundaries, contract selection, catalyst eligibility, user isolation, persistence, job cancellation and backtest timing/cost/capital constraints. `npm run build` validates frontend production compilation. Browser checks cover the sample workspace, result selection, tracker drawers, backtests, filtering, layout settings, dark mode and narrow screens. Live provider and TradingAgents access require your configured services.

## Open-interest and volume distributions

The two distribution panels show calls above the baseline and puts below it (both counts are positive). Switch between strike price and expiry views. Automatic expiry grouping uses exact dates for up to 12 expiries, weeks for up to 24 distinct expiry weeks, otherwise months. Manual date/week/month selection is also available. Hover, keyboard-focus or tap a bar to see its five largest expiry groups, sorted by combined call/put counts, with each group's share of that bar. Expiry-view tooltips break the selected group into actual expiration dates. Summary percentages compare ≤30, 31–90 and >90 days to expiry. More than 48 strikes are merged into adjacent labeled strike ranges.

These panels fetch distribution data separately from the scanner's near-expiry candidates. With `MARKET_DATA_PROVIDER=tiger`, the existing Tiger bridge calls `get_option_expirations` and then `get_option_chain` for each expiry in the selected one- or two-year horizon, retaining all returned strikes. Set up `TIGER_BRIDGE_URL`, `TIGER_BRIDGE_TOKEN` and the bridge's existing Tiger credentials/market-data access. The API contract is documented in [Tiger's option documentation](https://docs-en.itigerup.com/docs/quote-option). One rolling-quota retry waits 61 seconds rather than silently skipping later expiries. Results are cached for ten minutes; initial full-chain loading can take longer than a scanner request.

### Unusual volume

Both panels mark unusual option volume in purple. A contract is flagged when its session volume is at least 500 and at least 1.25× its open interest, and, where the chain returns a price, its estimated premium (volume × last price × multiplier) is at least $100K. The defaults are `UNUSUAL_DEFAULTS` in `shared/optionDistribution.js`. On the Volume panel the purple segment is the flagged part of each bar. On the Open interest panel the narrow purple bar is that same volume on the OI scale, not a share of OI. Every flagged side also gets a dot, because the segment can be under a pixel next to the largest bar. The tooltip lists the three largest flagged contracts in the bar with expiry, strike, volume, OI and estimated premium.

The chain reports totals only, so the highlight shows size, not whether the volume was bought or sold. In the live view the tooltip's "Last print" column says where the latest trade sat inside the current quote, which is a hint about one trade and nothing more. Open interest is the prior session's count, so flags are sparse early in the session and most reliable near or after the close.

When a saved snapshot is open and a later market day is also saved, each flagged contract is compared with its open interest on that later day, taken from a chain saved after the 09:30 New York open. A filled dot means the flagged contracts' open interest was higher, so positions stayed open; a hollow dot means it was not. The summary row counts how many flagged contracts rose, and the tooltip column becomes the change in open interest. If days are missing between the two snapshots the change covers all of them.

## Stock volume by closing-price range

The Volume distribution panel includes an optional **Stock volume layer**, enabled by default. Bar intervals are 1 minute, 15 minutes, 30 minutes, 1 hour (default), 4 hours and daily. Lookbacks are 1 day, 1 week, 1 month (default), 6 months, 1 year or a custom 1–365 calendar days. Save layout persists these settings. Each stock bar's entire volume is assigned to the option-strike range containing its closing price. This is a close-based volume distribution, not tick-level volume at price. The stock layer has its own shares scale; option bars retain their contracts scale. Hover details show stock shares, bar counts and price ranges. Volume outside the displayed strike ranges is reported separately. Expiry view hides this layer because stocks have no expiry.

Live history uses the existing Tiger bridge with native bar intervals, regular trading hours and unadjusted prices. Restart the HedgeHub server and Tiger bridge after updating. Historical intraday access depends on account entitlements and provider coverage. Minute history is requested one weekday at a time using Tiger's date query; other intervals use monthly windows. A cold one-year minute request can take several minutes under provider quotas. Collection runs in a background job with progress and cancellation. Completed windows remain cached when canceled. Missing or invalid data is reported; live requests never substitute sample bars. The latest bar may still be forming. Lookbacks end on the latest New York weekday after market open; holidays can produce empty-window coverage notes.

Bars are stored locally as compressed chunks in `data/stock-volume.db` (override with `STOCK_VOLUME_DB_PATH`), keyed by symbol, interval and date range. Recent windows refresh after 60 seconds; older windows are reused across requests and server restarts. Aggregation runs in a worker and sends only compact price-range totals to the browser. Changing strike ranges reuses cached bars. Historical unadjusted prices can fall outside today's strikes after a split. The cache has no automatic retention cleanup. Demo aggregation uses a browser worker and explicitly synthetic interval bars, conserving each sample day's volume.

Authenticated job routes are `POST /api/builder/stock-volume`, `GET /api/builder/stock-volume/:id` and `POST /api/builder/stock-volume/:id/cancel`. Jobs are owner-isolated, limited to two active requests, and do not survive server restart; cached history does. Tests cover interval validation, volume conservation, range boundaries, normalization, real worker aggregation, persistent cache reuse and cancellation. Bridge tests check the pinned Tiger SDK interval/session/adjustment arguments.
