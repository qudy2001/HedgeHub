CREATE TABLE IF NOT EXISTS market_topics (
    id BIGSERIAL PRIMARY KEY,
    title TEXT NOT NULL,
    weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 100),
    bullish_score INTEGER NOT NULL CHECK (bullish_score BETWEEN 0 AND 100),
    bearish_score INTEGER NOT NULL CHECK (bearish_score BETWEEN 0 AND 100),
    summary TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT NOT NULL DEFAULT 'agent',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analysis_task_definitions (
    id BIGSERIAL PRIMARY KEY,
    topic_id BIGINT REFERENCES market_topics(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'agent',
    cadence TEXT,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS analysis_tasks (
    id BIGSERIAL PRIMARY KEY,
    definition_id BIGINT REFERENCES analysis_task_definitions(id) ON DELETE SET NULL,
    topic_id BIGINT REFERENCES market_topics(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    scheduled_for TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    result TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analysis_tasks_pending
    ON analysis_tasks (scheduled_for) WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_analysis_task_definitions_due
    ON analysis_task_definitions (next_run_at) WHERE active = TRUE;
