-- Migration 027: Observability Notebooks, Alerts & Web Analytics
-- Vercel Observability (Query, Notebooks, Alerts) + Analytics + Speed Insights

-- Saved observability queries (Vercel Observability > Query)
CREATE TABLE IF NOT EXISTS observability_queries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  query_type  text NOT NULL CHECK (query_type IN ('logs', 'metrics', 'traces')),
  query       text NOT NULL,       -- LogQL for Loki, PromQL for Prometheus
  time_range  text DEFAULT '1h',   -- e.g., '1h', '24h', '7d'
  visualization text DEFAULT 'table' CHECK (visualization IN ('table', 'line', 'bar', 'area', 'stat')),
  created_by  uuid REFERENCES users(id),
  is_shared   boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_obs_queries_tenant ON observability_queries(tenant_id);

-- Observability notebooks (Vercel Notebooks: collection of cells/queries)
CREATE TABLE IF NOT EXISTS observability_notebooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  title       text NOT NULL,
  description text,
  cells       jsonb NOT NULL DEFAULT '[]',
  -- cells: [{"type": "query", "query_id": "uuid", "title": "Error Rate"},
  --         {"type": "markdown", "content": "## Analysis"},
  --         {"type": "metric", "promql": "rate(http_requests_total[5m])"}]
  created_by  uuid REFERENCES users(id),
  is_shared   boolean DEFAULT false,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notebooks_tenant ON observability_notebooks(tenant_id);

-- Alert rules (Vercel Alerts Beta)
CREATE TABLE IF NOT EXISTS alert_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  condition   jsonb NOT NULL,
  -- condition: {"metric": "error_rate", "operator": ">", "threshold": 5, "window": "5m"}
  -- OR: {"type": "log_match", "query": "level=error AND status>=500", "count_threshold": 10, "window": "5m"}
  severity    text DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  channels    jsonb NOT NULL DEFAULT '[]',
  -- channels: [{"type": "email", "to": "team@company.com"},
  --            {"type": "webhook", "url": "https://..."},
  --            {"type": "slack", "webhook_url": "https://hooks.slack.com/..."}]
  cooldown_minutes integer DEFAULT 30,  -- don't re-fire within this window
  enabled     boolean DEFAULT true,
  last_fired  timestamptz,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_tenant ON alert_rules(tenant_id);

-- Alert incidents (history of fired alerts)
CREATE TABLE IF NOT EXISTS alert_incidents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id     uuid NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  status      text DEFAULT 'firing' CHECK (status IN ('firing', 'resolved', 'acknowledged')),
  details     jsonb DEFAULT '{}',
  resolved_at timestamptz,
  acknowledged_by uuid REFERENCES users(id),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_incidents ON alert_incidents(rule_id, created_at DESC);

-- Web Analytics (Vercel Analytics / Speed Insights equivalent)
-- Stores aggregated page view and performance data
CREATE TABLE IF NOT EXISTS web_analytics (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hour        timestamptz NOT NULL,
  path        text NOT NULL,
  page_views  bigint DEFAULT 0,
  unique_visitors bigint DEFAULT 0,
  avg_load_time_ms integer,
  avg_fcp_ms  integer,   -- First Contentful Paint
  avg_lcp_ms  integer,   -- Largest Contentful Paint
  avg_cls     numeric(5,3),  -- Cumulative Layout Shift
  avg_inp_ms  integer,   -- Interaction to Next Paint
  avg_ttfb_ms integer,   -- Time to First Byte
  referrer    text,
  country     text,
  device      text CHECK (device IN ('desktop', 'mobile', 'tablet')),
  browser     text,
  UNIQUE(tenant_id, project_id, hour, path, country, device)
);

CREATE INDEX IF NOT EXISTS idx_web_analytics_project ON web_analytics(tenant_id, project_id, hour DESC);
CREATE INDEX IF NOT EXISTS idx_web_analytics_path    ON web_analytics(project_id, path, hour DESC);
