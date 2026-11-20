-- Which tab of the Builder's "AI suggestions" view a market topic belongs in, and which tickers it is about.
-- Existing topics become 'general' with no tickers; clients that do not send these fields keep working.
ALTER TABLE market_topics
    ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'general'
        CHECK (category IN ('general', 'commodity', 'forex', 'ticker', 'social')),
    ADD COLUMN IF NOT EXISTS symbols TEXT[] NOT NULL DEFAULT '{}';
