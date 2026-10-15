-- Every analysis the AI writes for a topic is kept. A topic with no update for 30 days is archived; an archived
-- topic is deleted (with its history) after 180 days. A new update reactivates an archived topic.
ALTER TABLE market_topics ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS market_topic_history (
    id BIGSERIAL PRIMARY KEY,
    topic_id BIGINT NOT NULL REFERENCES market_topics(id) ON DELETE CASCADE,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    weight INTEGER NOT NULL,
    bullish_score INTEGER NOT NULL,
    bearish_score INTEGER NOT NULL,
    summary TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    symbols TEXT[] NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_market_topic_history_topic ON market_topic_history (topic_id, recorded_at DESC);

-- One-off backfill: topics that existed before history was kept start with their current analysis.
INSERT INTO market_topic_history (topic_id, recorded_at, weight, bullish_score, bearish_score, summary, category, symbols)
SELECT t.id, t.updated_at, t.weight, t.bullish_score, t.bearish_score, t.summary, t.category, t.symbols
FROM market_topics t
WHERE NOT EXISTS (SELECT 1 FROM market_topic_history h WHERE h.topic_id = t.id);
