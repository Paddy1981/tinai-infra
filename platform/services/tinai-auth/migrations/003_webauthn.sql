-- Migration 003: WebAuthn / passkeys support
-- Stores credential records and per-ceremony session state.

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        VARCHAR(63) NOT NULL,
  credential_id    BYTEA NOT NULL UNIQUE,
  public_key       BYTEA NOT NULL,
  sign_count       BIGINT NOT NULL DEFAULT 0,
  aaguid           UUID,
  display_name     TEXT NOT NULL DEFAULT 'My Passkey',
  transports       TEXT[] DEFAULT '{}',
  backed_up        BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_webauthn_tenant ON webauthn_credentials(tenant_id);

CREATE TABLE IF NOT EXISTS webauthn_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(63),
  challenge    TEXT NOT NULL UNIQUE,
  session_data JSONB NOT NULL,
  flow         VARCHAR(20) NOT NULL DEFAULT 'registration', -- 'registration' | 'authentication'
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
