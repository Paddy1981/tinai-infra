CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti       TEXT PRIMARY KEY,
  user_id   UUID NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens(expires_at);
-- Cleanup job hint: DELETE FROM revoked_tokens WHERE expires_at < now();
