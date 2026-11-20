-- Monitored stocks per user
CREATE TABLE IF NOT EXISTS monitored_stocks (
    id BIGSERIAL PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    symbol TEXT NOT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, symbol)
);

-- Add max_monitored_stocks to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_monitored_stocks INT DEFAULT 5;

-- Index for quick lookups by user
CREATE INDEX IF NOT EXISTS idx_monitored_stocks_user_id ON monitored_stocks(user_id);
