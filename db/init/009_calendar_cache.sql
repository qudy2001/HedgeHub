CREATE TABLE IF NOT EXISTS calendar_cache (
    cache_key   TEXT PRIMARY KEY,
    payload_json JSONB NOT NULL,
    fetched_date DATE NOT NULL DEFAULT CURRENT_DATE
);
