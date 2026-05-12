# Scanner Architecture

## Shared lifecycle

Each scanner now follows the same lifecycle:

1. normalize request config
2. run scanner-specific discovery and pricing logic
3. enrich rows with shared intelligence
4. persist the run, candidates, and rank history
5. render a lean decision grid
6. open deeper analytics in the detail drawer

## Shared tables

- `scanner_presets`
  Reusable saved configs per user and scanner.
- `scanner_runs`
  One persisted execution of a scanner config.
- `scanner_candidates`
  Snapshot of each ranked row returned by a run.
- `candidate_rank_history`
  Historical score and rank movement for the same symbol and strategy.
- `scanner_promotions`
  Workflow bridge from scanner candidate to paper trade.
- `market_regime_daily`
  Daily regime banner snapshot shape for future backtesting and dashboard use.

## Current scanner coverage

- `tradingview-finder`
  Persists runs, candidate rows, rank drift, regime data, and paper-trade promotion events.
- `covered-income`
  Persists runs, candidate rows, rank drift, regime data, and portfolio-aware analytics.

## Design rules

- shared persistence first, scanner-specific logic second
- keep expensive analytics precomputed into persisted candidate payloads
- prefer structured columns for lookup and ranking, JSON for detail payloads
- main grid shows decision metrics only

