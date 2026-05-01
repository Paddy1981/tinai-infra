-- Migration 024: Feature Flags (Vercel Flags / Edge Config equivalent)
-- Per-project feature flag management with percentage rollout and targeting.

CREATE TABLE IF NOT EXISTS feature_flags (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  key         text NOT NULL,           -- e.g., 'new-checkout-flow'
  name        text NOT NULL,           -- human-readable name
  description text,
  kind        text NOT NULL DEFAULT 'boolean' CHECK (kind IN ('boolean', 'string', 'number', 'json')),
  default_value jsonb NOT NULL DEFAULT 'false',
  enabled     boolean DEFAULT false,
  environments text[] DEFAULT '{"production", "staging", "development"}',
  rollout_pct integer DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  targeting   jsonb DEFAULT '[]',      -- [{ "attribute": "email", "operator": "contains", "value": "@tinai.cloud", "variation": true }]
  metadata    jsonb DEFAULT '{}',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_tenant  ON feature_flags(tenant_id);
CREATE INDEX IF NOT EXISTS idx_feature_flags_project ON feature_flags(project_id);
CREATE INDEX IF NOT EXISTS idx_feature_flags_key     ON feature_flags(tenant_id, key);

-- Flag override history (who changed what, when)
CREATE TABLE IF NOT EXISTS feature_flag_history (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  flag_id   uuid NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
  actor_id  uuid REFERENCES users(id),
  action    text NOT NULL,  -- 'created', 'enabled', 'disabled', 'updated', 'deleted'
  old_value jsonb,
  new_value jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flag_history_flag ON feature_flag_history(flag_id, created_at DESC);
