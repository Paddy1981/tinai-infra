-- API keys for user-facing programmatic access
CREATE TABLE IF NOT EXISTS api_keys (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,
    name        VARCHAR(63) NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    key_prefix  VARCHAR(8) NOT NULL,  -- first 8 chars for display
    last_used   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id);
