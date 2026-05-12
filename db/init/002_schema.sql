CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS user_ibkr_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    config_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_profiles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    asset_label TEXT NOT NULL,
    description TEXT NOT NULL,
    config_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_watchlist (
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS setup_watchlist (
    user_id TEXT NOT NULL DEFAULT 'legacy',
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    combination_id TEXT NOT NULL,
    title TEXT NOT NULL,
    payload_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, id)
);

CREATE TABLE IF NOT EXISTS strategy_runs (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    scenario_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scanner_presets (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    name TEXT NOT NULL,
    config_json JSONB NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, scanner_type, name)
);

CREATE TABLE IF NOT EXISTS scanner_runs (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    strategy_id TEXT,
    preset_id BIGINT REFERENCES scanner_presets(id) ON DELETE SET NULL,
    config_json JSONB NOT NULL,
    summary_json JSONB NOT NULL,
    market_regime_json JSONB,
    candidate_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scanner_candidates (
    id BIGSERIAL PRIMARY KEY,
    scanner_run_id BIGINT NOT NULL REFERENCES scanner_runs(id) ON DELETE CASCADE,
    scanner_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    rank_position INT,
    score NUMERIC(10, 4),
    payload_json JSONB NOT NULL,
    explanation_data JSONB,
    risk_flags JSONB,
    portfolio_impact_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scanner_promotions (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    scanner_run_id BIGINT REFERENCES scanner_runs(id) ON DELETE SET NULL,
    scanner_candidate_id BIGINT REFERENCES scanner_candidates(id) ON DELETE SET NULL,
    paper_order_id BIGINT REFERENCES paper_orders(id) ON DELETE SET NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    promotion_status TEXT NOT NULL DEFAULT 'paper_trade',
    notes_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS candidate_rank_history (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    scanner_type TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy_type TEXT,
    scanner_candidate_id BIGINT REFERENCES scanner_candidates(id) ON DELETE SET NULL,
    scanner_run_id BIGINT REFERENCES scanner_runs(id) ON DELETE CASCADE,
    score NUMERIC(10, 4),
    rank_position INT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_orders (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'legacy',
    strategy_id TEXT NOT NULL,
    combination_id TEXT NOT NULL,
    position_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS paper_order_snapshots (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES paper_orders(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    current_holding_value DOUBLE PRECISION NOT NULL,
    net_marked_value DOUBLE PRECISION NOT NULL,
    profit_loss_value DOUBLE PRECISION NOT NULL,
    profit_loss_percent DOUBLE PRECISION,
    captured_at TIMESTAMPTZ NOT NULL,
    UNIQUE (order_id, captured_at)
);

CREATE TABLE IF NOT EXISTS paper_calculator_snapshots (
    id BIGSERIAL PRIMARY KEY,
    order_id BIGINT NOT NULL REFERENCES paper_orders(id) ON DELETE CASCADE,
    snapshot_name TEXT NOT NULL,
    snapshot_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS market_snapshots (
    id BIGSERIAL,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    symbol TEXT NOT NULL,
    label TEXT NOT NULL,
    group_name TEXT NOT NULL,
    provider TEXT NOT NULL,
    price DOUBLE PRECISION,
    change_percent DOUBLE PRECISION,
    currency TEXT,
    PRIMARY KEY (captured_at, id)
);

CREATE TABLE IF NOT EXISTS macro_dashboard_snapshots (
    id BIGSERIAL PRIMARY KEY,
    payload_json JSONB NOT NULL,
    refreshed_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS strategy_asset_mappings (
    id TEXT PRIMARY KEY,
    mapping_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delta_hedge_scanner_symbols (
    symbol TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS underlyings (
    id BIGSERIAL PRIMARY KEY,
    symbol TEXT NOT NULL UNIQUE,
    asset_type TEXT,
    name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS option_contracts (
    id BIGSERIAL PRIMARY KEY,
    underlying_symbol TEXT NOT NULL,
    option_ticker TEXT NOT NULL UNIQUE,
    expiration_date DATE NOT NULL,
    strike NUMERIC(12, 4) NOT NULL,
    option_type TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS option_chain_snapshots (
    time TIMESTAMPTZ NOT NULL,
    underlying_symbol TEXT NOT NULL,
    option_ticker TEXT NOT NULL,
    expiration_date DATE NOT NULL,
    strike NUMERIC(12, 4) NOT NULL,
    option_type TEXT NOT NULL,
    underlying_price NUMERIC(14, 4),
    bid NUMERIC(14, 4),
    ask NUMERIC(14, 4),
    mid NUMERIC(14, 4),
    last_price NUMERIC(14, 4),
    implied_volatility NUMERIC(10, 6),
    delta NUMERIC(10, 6),
    gamma NUMERIC(14, 10),
    theta NUMERIC(14, 10),
    vega NUMERIC(14, 10),
    open_interest BIGINT,
    volume BIGINT,
    raw JSONB,
    PRIMARY KEY (time, option_ticker)
);

CREATE TABLE IF NOT EXISTS underlying_prices (
    time TIMESTAMPTZ NOT NULL,
    symbol TEXT NOT NULL,
    open NUMERIC(14, 4),
    high NUMERIC(14, 4),
    low NUMERIC(14, 4),
    close NUMERIC(14, 4),
    volume BIGINT,
    PRIMARY KEY (time, symbol)
);

CREATE TABLE IF NOT EXISTS iv30_history (
    date DATE NOT NULL,
    symbol TEXT NOT NULL,
    underlying_price NUMERIC(14, 4),
    iv30 NUMERIC(10, 6),
    atm_call_iv NUMERIC(10, 6),
    atm_put_iv NUMERIC(10, 6),
    near_expiry DATE,
    far_expiry DATE,
    near_dte INTEGER,
    far_dte INTEGER,
    option_volume BIGINT,
    open_interest BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (date, symbol)
);

CREATE TABLE IF NOT EXISTS iv_rank_daily (
    date DATE NOT NULL,
    symbol TEXT NOT NULL,
    iv30 NUMERIC(10, 6),
    iv30_min_52w NUMERIC(10, 6),
    iv30_max_52w NUMERIC(10, 6),
    iv_rank_52w NUMERIC(10, 6),
    iv_percentile_52w NUMERIC(10, 6),
    hv20 NUMERIC(10, 6),
    hv252 NUMERIC(10, 6),
    PRIMARY KEY (date, symbol)
);

CREATE TABLE IF NOT EXISTS market_regime_daily (
    date DATE PRIMARY KEY,
    market_regime TEXT,
    volatility_regime TEXT,
    trend_regime TEXT,
    liquidity_regime TEXT,
    notes JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

SELECT create_hypertable('market_snapshots', 'captured_at', if_not_exists => TRUE);
SELECT create_hypertable('option_chain_snapshots', 'time', if_not_exists => TRUE);
SELECT create_hypertable('underlying_prices', 'time', if_not_exists => TRUE);
