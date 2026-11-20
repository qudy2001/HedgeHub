# Momentum edition

A separate presentation layer for HedgeHub at `/momentum`. The existing classic `/` and Studio `/builder` interfaces remain available.

Preview: `/momentum?demo=1`. Each subroute also accepts `?demo=1`:

- `/momentum`: payoff heatmap, compact tracking, results and strategy inspector.
- `/momentum/scanner`: searchable/filterable option results and rating contributions.
- `/momentum/analytics`: underlying-stock and options analytics.
- `/momentum/distributions`: OI and volume by strike/expiry, stock-volume layer and local history cache.
- `/momentum/events`: past price reactions and upcoming scenarios.
- `/momentum/tracker`: compact catalyst list, sentiment filters, suggestions and evidence drawers.
- `/momentum/backtests`: existing date/stock backtest workflow.

`MomentumApp.jsx` loads official `@momentum-design/fonts` (Inter) and `@momentum-design/tokens` (Webex light/dark) resources. `MomentumWorkspace.jsx` owns the navigation and presentation. `momentum.css` scopes the design to this edition. Controls are native React/HTML, styled with Momentum resources; this is not a wholesale migration to Momentum web components.

The optional presentation interface in `BuilderApp` shares existing state, authentication, calculations, API calls, workers, panels and dialogs. No pricing or scoring implementation is copied. Real missing liquidity continues to produce rating ranges rather than invented exact scores. Demo data is labeled and uses its own `hedgehub-momentum-demo` local-storage key. Live strategies and saved layouts are shared with Studio for the same account; no database migration or duplicate live portfolio is introduced. Panel order applies within each view, while the inspector and navigation remain fixed. Hide/collapse and metric settings are shared through the existing customization controls.

The frontend is lazy-loaded only on `/momentum` routes. No new backend endpoints or credentials are required. Live data still requires the existing HedgeHub server and configured providers. The route uses the existing production SPA fallback.

Validation: `npm test`, `npm run build`, and browser checks for routes, filters, result selection, evidence drawers, stock-volume controls, theme and narrow-screen layout. This UI does not submit trades.
