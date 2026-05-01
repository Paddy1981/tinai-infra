-- Migration 013: workloads table
-- Unified compute abstraction: services, functions, jobs, and static sites.

CREATE TABLE IF NOT EXISTS workloads (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  type             TEXT        NOT NULL CHECK (type IN ('service', 'function', 'job', 'static')),
  status           TEXT        NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','building','running','stopped','failed','crashed')),
  source_git_url   TEXT,
  source_ref       TEXT        DEFAULT 'main',
  image            TEXT,
  port             INTEGER,
  env              JSONB       DEFAULT '{}',
  replicas         INTEGER     DEFAULT 1,
  memory_limit     TEXT        DEFAULT '256Mi',
  cpu_limit        TEXT        DEFAULT '100m',
  domain           TEXT,
  last_deployed_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workloads_tenant_id ON workloads (tenant_id);
