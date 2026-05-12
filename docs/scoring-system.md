# Scoring System

## Shared philosophy

The platform is moving away from single-metric ranking like POP or max profit. Ranking should reflect:

- expected value relative to buying power
- liquidity quality
- volatility regime fit
- portfolio concentration impact
- explicit risk penalties

## Current shared fields

- `intelligence.ev.evPerBuyingPower`
- `intelligence.ev.evAnnualized`
- `intelligence.volatility.ivRank52w`
- `intelligence.portfolioImpact`
- `intelligence.riskFlags`
- `intelligence.explanationData.scoreBreakdown`

## Covered Income

Covered Income keeps its existing sub-scores and adds a second intelligence layer:

- EV annualized
- IV rank / IV-HV spread
- sector overlap
- correlation cluster
- net vega impact

## TradingView Finder

TradingView Finder now adds:

- EV/BP from TradingView average payoff vs max loss
- signal freshness and repeat appearances
- rank drift
- regime fit proxy from IV rank
- portfolio overlap context

## Explainability

Each persisted candidate can carry:

- score breakdown
- risk flags
- portfolio impact

This is the data source for score explainability drawers and future audit trails.

