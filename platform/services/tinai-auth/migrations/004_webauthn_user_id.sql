-- Migration 004: Add user_id to webauthn_credentials
-- Ensures credentials are scoped per-user, not just per-tenant.

ALTER TABLE webauthn_credentials ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials(user_id);
