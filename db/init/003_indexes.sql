CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx
    ON user_sessions(user_id);

CREATE INDEX IF NOT EXISTS user_sessions_expires_at_idx
    ON user_sessions(expires_at);

CREATE INDEX IF NOT EXISTS strategy_runs_user_created_idx
    ON strategy_runs(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS scanner_presets_user_type_updated_idx
    ON scanner_presets(user_id, scanner_type, updated_at DESC);

CREATE INDEX IF NOT EXISTS scanner_runs_user_type_created_idx
    ON scanner_runs(user_id, scanner_type, created_at DESC);

CREATE INDEX IF NOT EXISTS scanner_candidates_run_rank_idx
    ON scanner_candidates(scanner_run_id, rank_position ASC);

CREATE INDEX IF NOT EXISTS scanner_candidates_type_symbol_created_idx
    ON scanner_candidates(scanner_type, symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS candidate_rank_history_user_lookup_idx
    ON candidate_rank_history(user_id, scanner_type, symbol, created_at DESC);

CREATE INDEX IF NOT EXISTS candidate_rank_history_run_idx
    ON candidate_rank_history(scanner_run_id, rank_position ASC);

CREATE INDEX IF NOT EXISTS scanner_promotions_user_type_created_idx
    ON scanner_promotions(user_id, scanner_type, created_at DESC);

CREATE INDEX IF NOT EXISTS paper_orders_user_updated_idx
    ON paper_orders(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS strategy_watchlist_user_created_idx
    ON strategy_watchlist(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_api_keys_user_created_idx
    ON user_api_keys(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS user_api_keys_active_token_idx
    ON user_api_keys(token_hash)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS setup_watchlist_user_created_idx
    ON setup_watchlist(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS paper_order_snapshots_order_captured_idx
    ON paper_order_snapshots(order_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS paper_calculator_snapshots_order_created_idx
    ON paper_calculator_snapshots(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS macro_dashboard_snapshots_refreshed_idx
    ON macro_dashboard_snapshots(refreshed_at DESC);

CREATE INDEX IF NOT EXISTS market_snapshots_symbol_captured_idx
    ON market_snapshots(symbol, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS market_snapshots_group_label_idx
    ON market_snapshots(group_name, label);

CREATE INDEX IF NOT EXISTS option_contracts_underlying_expiry_idx
    ON option_contracts(underlying_symbol, expiration_date);

CREATE INDEX IF NOT EXISTS option_chain_snapshots_symbol_time_idx
    ON option_chain_snapshots(underlying_symbol, time DESC);

CREATE INDEX IF NOT EXISTS option_chain_snapshots_symbol_expiry_time_idx
    ON option_chain_snapshots(underlying_symbol, expiration_date, time DESC);

CREATE INDEX IF NOT EXISTS option_chain_snapshots_ticker_time_idx
    ON option_chain_snapshots(option_ticker, time DESC);

CREATE INDEX IF NOT EXISTS underlying_prices_symbol_time_idx
    ON underlying_prices(symbol, time DESC);

CREATE INDEX IF NOT EXISTS iv30_history_symbol_date_idx
    ON iv30_history(symbol, date DESC);

CREATE INDEX IF NOT EXISTS iv_rank_daily_symbol_date_idx
    ON iv_rank_daily(symbol, date DESC);

CREATE INDEX IF NOT EXISTS market_regime_daily_date_idx
    ON market_regime_daily(date DESC);
