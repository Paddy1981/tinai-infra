-- Migration 017: Workload env vars + project secrets
-- Run as superuser for a clean first-deploy; server.ts applies these best-effort at startup.

-- Workload env vars (per-workload key/value store, like Railway service variables / Vercel env vars)
CREATE TABLE IF NOT EXISTS workload_env_vars (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workload_id UUID         NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
  tenant_id   VARCHAR(63)  NOT NULL,
  key         VARCHAR(255) NOT NULL,
  value       TEXT         NOT NULL,
  is_secret   BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (workload_id, key)
);
CREATE INDEX IF NOT EXISTS idx_wenv_workload ON workload_env_vars (workload_id);

-- Project secrets (shared across workloads in a project, like Supabase project secrets)
CREATE TABLE IF NOT EXISTS project_secrets (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tenant_id   VARCHAR(63)  NOT NULL,
  key         VARCHAR(255) NOT NULL,
  value       TEXT         NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (project_id, key)
);
CREATE INDEX IF NOT EXISTS idx_psecret_project ON project_secrets (project_id);
