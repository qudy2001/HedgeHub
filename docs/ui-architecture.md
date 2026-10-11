# UI Architecture

## Progressive disclosure

Scanner UI should avoid spreadsheet overload.

The rule is:

- main grid: decision metrics only
- selected detail area: deeper analytics and explainability
- separate dashboards: regime and portfolio monitoring

## Main grid goals

- roughly 12 to 15 columns max
- consistent cross-scanner vocabulary
- ranking, regime, liquidity, and portfolio warnings first

## Detail area goals

- score explainability
- volatility diagnostics
- portfolio impact
- workflow state
- payoff and scenario analysis

## Current rollout

- Covered Income grid now emphasizes expectancy, IV rank, liquidity, earnings risk, beta, sector overlap, allocation impact, and correlation cluster.
- TradingView Finder grid now emphasizes EV/BP, IV rank, liquidity, rank drift, regime fit, signal freshness, and portfolio impact.

