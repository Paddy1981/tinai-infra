-- Migration 011: refresh_tokens
-- Stores hashed refresh tokens for session continuity (30-day sliding expiry).
-- Each row is single-use; on /auth/refresh the old row is deleted and a new one inserted.

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT        UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refresh_tokens_user_id_idx  ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx  ON refresh_tokens (expires_at);

-- Purge expired rows periodically:
-- DELETE FROM refresh_tokens WHERE expires_at < NOW();
