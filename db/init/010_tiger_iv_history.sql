-- Shared (not per-user) Tiger IV/HV history, keyed by symbol. Filled nightly after
-- US close for the union of every user's monitored_stocks.
CREATE TABLE IF NOT EXISTS tiger_iv_history (
    symbol TEXT NOT NULL,
    date DATE NOT NULL,
    implied_vol NUMERIC(10, 6),
    his_volatility NUMERIC(10, 6),
    -- Tiger's rank/percentile on a 0-100 scale, relative to the 3-year window requested.
    provider_rank NUMERIC(10, 6),
    provider_percentile NUMERIC(10, 6),
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS iv_refresh_runs (
    run_date DATE PRIMARY KEY,
    status TEXT NOT NULL,
    symbols_total INTEGER NOT NULL DEFAULT 0,
    symbols_ok INTEGER NOT NULL DEFAULT 0,
    failed_symbols TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    finished_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
