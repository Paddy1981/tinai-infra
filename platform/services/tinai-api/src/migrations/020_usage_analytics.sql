-- Migration 020: Usage Analytics & Cost Projections
-- Hourly rollups for dashboard graphs and cost forecasting.
-- Equivalent to Vercel's Usage tab, Railway's metrics, Supabase's usage page.

CREATE TABLE IF NOT EXISTS usage_hourly (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE SET NULL,
  hour        timestamptz NOT NULL,  -- truncated to hour
  cpu_seconds double precision DEFAULT 0,
  memory_gb_seconds double precision DEFAULT 0,
  bandwidth_bytes bigint DEFAULT 0,
  request_count bigint DEFAULT 0,
  build_minutes double precision DEFAULT 0,
  storage_bytes bigint DEFAULT 0,
  ai_tokens_in  bigint DEFAULT 0,
  ai_tokens_out bigint DEFAULT 0,
  UNIQUE(tenant_id, project_id, hour)
);

CREATE INDEX IF NOT EXISTS idx_usage_hourly_tenant_hour ON usage_hourly(tenant_id, hour DESC);

-- Daily cost estimates
CREATE TABLE IF NOT EXISTS cost_daily (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL,
  day         date NOT NULL,
  compute_inr numeric(12,2) DEFAULT 0,
  storage_inr numeric(12,2) DEFAULT 0,
  bandwidth_inr numeric(12,2) DEFAULT 0,
  ai_inr      numeric(12,2) DEFAULT 0,
  total_inr   numeric(12,2) GENERATED ALWAYS AS (compute_inr + storage_inr + bandwidth_inr + ai_inr) STORED,
  UNIQUE(tenant_id, day)
);

CREATE INDEX IF NOT EXISTS idx_cost_daily_tenant ON cost_daily(tenant_id, day DESC);

-- Spending alerts/budgets per tenant
CREATE TABLE IF NOT EXISTS spending_alerts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       text NOT NULL,
  threshold_inr   numeric(12,2) NOT NULL,
  period          text NOT NULL DEFAULT 'monthly' CHECK (period IN ('daily', 'weekly', 'monthly')),
  notify_email    boolean DEFAULT true,
  notify_webhook  text,  -- optional webhook URL
  last_triggered  timestamptz,
  enabled         boolean DEFAULT true,
  created_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spending_alerts_tenant ON spending_alerts(tenant_id);
