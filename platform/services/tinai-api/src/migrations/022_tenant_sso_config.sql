-- Migration 022: Per-Tenant SSO Configuration
-- Currently SSO is global (one set of env vars). This enables per-tenant OIDC
-- like Vercel Enterprise SSO, Supabase SSO, and Railway team SSO.

CREATE TABLE IF NOT EXISTS tenant_sso_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  team_id         uuid REFERENCES teams(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('azure', 'google', 'okta', 'github', 'custom')),
  display_name    text NOT NULL,
  client_id       text NOT NULL,
  client_secret   text NOT NULL,  -- encrypted at rest
  issuer_url      text NOT NULL,  -- OIDC discovery URL
  redirect_url    text NOT NULL,
  scopes          text[] DEFAULT '{"openid", "email", "profile"}',
  auto_provision  boolean DEFAULT true,  -- auto-create users on first login
  default_role    text DEFAULT 'member',
  domain_hint     text,           -- e.g., 'company.com' for auto-routing
  enabled         boolean DEFAULT true,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now(),
  UNIQUE(tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_tenant_sso_tenant     ON tenant_sso_configs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_sso_domain     ON tenant_sso_configs(domain_hint);

-- Login sessions for SSO state tracking
CREATE TABLE IF NOT EXISTS sso_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id   uuid NOT NULL REFERENCES tenant_sso_configs(id) ON DELETE CASCADE,
  state       text NOT NULL UNIQUE,
  nonce       text NOT NULL,
  redirect_to text,  -- where to redirect after auth
  ip_address  inet,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '10 minutes'),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sso_sessions_state ON sso_sessions(state);
