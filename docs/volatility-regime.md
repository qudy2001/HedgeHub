# Volatility Regime

## Shared metrics

The shared scanner intelligence layer computes or surfaces:

- `iv30`
- `ivRank52w`
- `ivPercentile`
- `hv20`
- `hv60`
- `hv252`
- `ivHvSpread`
- `termStructureSlope`
- `putCallSkew`

## Classification

The current banner uses a lightweight single-node classification:

- `High IV`
  Higher VIX or elevated average IV rank across returned candidates.
- `Low IV`
  Lower VIX or depressed average IV rank.
- `Backwardation`
  Negative term-structure proxy.
- `Contango`
  Positive or flat term-structure proxy.
- `Trend Regime`
  Used when IV is not meaningfully rich versus realized volatility.
- `Mean Reversion`
  Used when IV is rich versus realized volatility.

## Why lightweight

This layer is intentionally approximate for now:

- no fake precision
- no extra services
- no heavy Monte Carlo dependency
- no duplicated per-scanner regime logic

It is designed to be upgraded later with persisted IV history and materialized analytics without changing the API contract.

