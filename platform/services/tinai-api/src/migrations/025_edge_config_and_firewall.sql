-- Migration 025: Edge Config (key-value store) + WAF / Firewall Rules
-- Vercel Edge Config = ultra-low-latency key-value store read at the edge.
-- Tinai equivalent: per-project config store backed by Redis/PG with cache.

-- Edge Config Store (per-project key-value pairs)
CREATE TABLE IF NOT EXISTS edge_config (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  digest      text,  -- SHA256 of value for ETag / cache validation
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, project_id, key)
);

CREATE INDEX IF NOT EXISTS idx_edge_config_project ON edge_config(tenant_id, project_id);

-- Firewall / WAF Rules (Vercel Firewall equivalent)
CREATE TABLE IF NOT EXISTS firewall_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,  -- NULL = org-wide
  name        text NOT NULL,
  description text,
  priority    integer NOT NULL DEFAULT 100,
  action      text NOT NULL CHECK (action IN ('allow', 'deny', 'challenge', 'rate_limit', 'log')),
  conditions  jsonb NOT NULL DEFAULT '[]',
  -- conditions example: [{"field": "ip", "operator": "in", "value": ["1.2.3.4/24"]},
  --                      {"field": "path", "operator": "startsWith", "value": "/api"},
  --                      {"field": "country", "operator": "in", "value": ["CN", "RU"]},
  --                      {"field": "header", "operator": "contains", "key": "user-agent", "value": "bot"}]
  rate_limit  jsonb,  -- {"requests": 100, "window_seconds": 60}
  enabled     boolean DEFAULT true,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_firewall_rules_tenant  ON firewall_rules(tenant_id, priority);
CREATE INDEX IF NOT EXISTS idx_firewall_rules_project ON firewall_rules(project_id);

-- IP blocklist / allowlist (quick lookup table)
CREATE TABLE IF NOT EXISTS ip_rules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL,
  cidr        cidr NOT NULL,
  action      text NOT NULL CHECK (action IN ('allow', 'deny')),
  reason      text,
  expires_at  timestamptz,  -- NULL = permanent
  created_at  timestamptz DEFAULT now(),
  UNIQUE(tenant_id, cidr)
);

CREATE INDEX IF NOT EXISTS idx_ip_rules_tenant ON ip_rules(tenant_id);
