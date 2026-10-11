CREATE TABLE IF NOT EXISTS options_shortlist_observations (
    id BIGSERIAL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    scanner_type TEXT,
    scanner_candidate_id BIGINT REFERENCES scanner_candidates(id) ON DELETE SET NULL,
    paper_order_id BIGINT REFERENCES paper_orders(id) ON DELETE SET NULL,
    contract_symbol TEXT NOT NULL,
    underlying_symbol TEXT,
    expiration DATE,
    strike NUMERIC(12, 4),
    option_type TEXT,
    bid NUMERIC(14, 4),
    ask NUMERIC(14, 4),
    mark NUMERIC(14, 4),
    bid_size BIGINT,
    ask_size BIGINT,
    last_trade_price NUMERIC(14, 4),
    last_trade_size BIGINT,
    open_interest BIGINT,
    volume BIGINT,
    quote_timestamp TIMESTAMPTZ,
    PRIMARY KEY (observed_at, id)
);

CREATE TABLE IF NOT EXISTS options_history_ingestion_runs (
    id BIGSERIAL PRIMARY KEY,
    dataset TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    requested_by TEXT,
    source_path TEXT,
    window_start DATE,
    window_end DATE,
    files_total INT NOT NULL DEFAULT 0,
    files_completed INT NOT NULL DEFAULT 0,
    rows_ingested BIGINT NOT NULL DEFAULT 0,
    details_json JSONB,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    error_text TEXT
);

CREATE TABLE IF NOT EXISTS option_minute_aggregates (
    time TIMESTAMPTZ NOT NULL,
    option_ticker TEXT NOT NULL,
    underlying_symbol TEXT NOT NULL,
    expiration_date DATE,
    strike NUMERIC(12, 4),
    option_type TEXT,
    open NUMERIC(14, 4),
    high NUMERIC(14, 4),
    low NUMERIC(14, 4),
    close NUMERIC(14, 4),
    volume BIGINT,
    transactions BIGINT,
    raw JSONB,
    PRIMARY KEY (time, option_ticker)
);

CREATE TABLE IF NOT EXISTS option_trade_ticks (
    time TIMESTAMPTZ NOT NULL,
    id BIGSERIAL,
    trade_key TEXT NOT NULL,
    option_ticker TEXT NOT NULL,
    underlying_symbol TEXT NOT NULL,
    expiration_date DATE,
    strike NUMERIC(12, 4),
    option_type TEXT,
    price NUMERIC(14, 4),
    size BIGINT,
    exchange_id TEXT,
    conditions_json JSONB,
    raw JSONB,
    PRIMARY KEY (time, id)
);

ALTER TABLE option_trade_ticks
    ADD COLUMN IF NOT EXISTS trade_key TEXT;

SELECT create_hypertable('options_shortlist_observations', 'observed_at', if_not_exists => TRUE);
SELECT create_hypertable('option_minute_aggregates', 'time', if_not_exists => TRUE);
SELECT create_hypertable('option_trade_ticks', 'time', if_not_exists => TRUE);

CREATE INDEX IF NOT EXISTS options_shortlist_observations_user_contract_idx
    ON options_shortlist_observations(user_id, contract_symbol, observed_at DESC);
CREATE INDEX IF NOT EXISTS options_shortlist_observations_order_idx
    ON options_shortlist_observations(paper_order_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS options_shortlist_observations_contract_idx
    ON options_shortlist_observations(contract_symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS options_history_ingestion_runs_status_requested_idx
    ON options_history_ingestion_runs(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS options_history_ingestion_runs_dataset_requested_idx
    ON options_history_ingestion_runs(dataset, requested_at DESC);

CREATE INDEX IF NOT EXISTS option_minute_aggregates_ticker_time_idx
    ON option_minute_aggregates(option_ticker, time DESC);
CREATE INDEX IF NOT EXISTS option_minute_aggregates_underlying_time_idx
    ON option_minute_aggregates(underlying_symbol, time DESC);

CREATE INDEX IF NOT EXISTS option_trade_ticks_ticker_time_idx
    ON option_trade_ticks(option_ticker, time DESC);
CREATE INDEX IF NOT EXISTS option_trade_ticks_underlying_time_idx
    ON option_trade_ticks(underlying_symbol, time DESC);
CREATE UNIQUE INDEX IF NOT EXISTS option_trade_ticks_trade_key_time_idx
    ON option_trade_ticks(trade_key, time);
