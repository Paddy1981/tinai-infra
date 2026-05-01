-- Plan catalog
CREATE TABLE IF NOT EXISTS plans (
  id          VARCHAR(20) PRIMARY KEY,   -- 'free', 'pro', 'enterprise'
  name        VARCHAR(50) NOT NULL,
  price_inr   INTEGER NOT NULL DEFAULT 0, -- monthly INR
  limits      JSONB NOT NULL DEFAULT '{}' -- { max_workloads, max_databases, max_functions, storage_gb, api_calls_month }
);

INSERT INTO plans VALUES
  ('free',       'Free',       0,      '{"max_workloads":3,"max_databases":1,"max_functions":5,"storage_gb":1,"api_calls_month":10000}'),
  ('pro',        'Pro',        2999,   '{"max_workloads":20,"max_databases":5,"max_functions":50,"storage_gb":50,"api_calls_month":500000}'),
  ('enterprise', 'Enterprise', 19999,  '{"max_workloads":-1,"max_databases":-1,"max_functions":-1,"storage_gb":-1,"api_calls_month":-1}')
ON CONFLICT DO NOTHING;

-- Tenant -> Plan assignment
CREATE TABLE IF NOT EXISTS tenant_plans (
  tenant_id       VARCHAR(63) PRIMARY KEY,
  plan_id         VARCHAR(20) NOT NULL REFERENCES plans(id) DEFAULT 'free',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,  -- NULL = no expiry
  override_limits JSONB         -- per-tenant overrides (enterprise custom)
);
