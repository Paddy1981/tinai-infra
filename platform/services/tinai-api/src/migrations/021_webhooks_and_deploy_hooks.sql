-- Migration 021: Webhooks, Deploy Hooks & Integration Tokens
-- Brings parity with Vercel deploy hooks, Supabase webhooks, Railway webhooks.

-- Outbound webhooks (notify external systems on events)
CREATE TABLE IF NOT EXISTS webhooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  url         text NOT NULL,
  secret      text NOT NULL,  -- HMAC-SHA256 signing secret
  events      text[] NOT NULL DEFAULT '{}',  -- e.g., {'deploy.success','deploy.failure','domain.verified'}
  enabled     boolean DEFAULT true,
  last_status integer,       -- last HTTP status code
  last_sent   timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_tenant  ON webhooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhooks_project ON webhooks(project_id);

-- Webhook delivery log (for retry and debugging)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  webhook_id  uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event       text NOT NULL,
  payload     jsonb NOT NULL,
  status_code integer,
  response    text,
  duration_ms integer,
  attempt     integer DEFAULT 1,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- Deploy hooks (trigger deploys via unique URL, like Vercel deploy hooks)
CREATE TABLE IF NOT EXISTS deploy_hooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  environment text NOT NULL DEFAULT 'production',
  name        text NOT NULL,
  token       text NOT NULL UNIQUE,  -- unique trigger token
  branch      text DEFAULT 'main',
  last_used   timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deploy_hooks_tenant ON deploy_hooks(tenant_id);
CREATE INDEX IF NOT EXISTS idx_deploy_hooks_token  ON deploy_hooks(token);

-- Integration tokens (scoped tokens for CI/CD, like Vercel project tokens)
CREATE TABLE IF NOT EXISTS integration_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
  name        text NOT NULL,
  token_hash  text NOT NULL,
  token_prefix text NOT NULL,  -- first 8 chars for display
  scopes      text[] NOT NULL DEFAULT '{"read"}',  -- e.g., read, write, deploy, admin
  expires_at  timestamptz,
  last_used   timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_integration_tokens_tenant ON integration_tokens(tenant_id);
