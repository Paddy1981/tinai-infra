-- Migration 029: environment-aware deployments for apps
-- Adds environment columns to apps, creates app_env_vars table for per-environment variables,
-- and tracks deployment history per environment.

-- ── 1. Extend the apps table with environment-awareness ─────────────────────
ALTER TABLE apps ADD COLUMN IF NOT EXISTS project_id   UUID REFERENCES projects(id) ON DELETE SET NULL;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS environment  VARCHAR(63) NOT NULL DEFAULT 'production';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS domain       TEXT;
ALTER TABLE apps ADD COLUMN IF NOT EXISTS framework    VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_apps_project_id   ON apps (project_id);
CREATE INDEX IF NOT EXISTS idx_apps_environment  ON apps (environment);

-- ── 2. Per-environment env vars for apps ────────────────────────────────────
CREATE TABLE IF NOT EXISTS app_env_vars (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name    VARCHAR(63)  NOT NULL,
  environment VARCHAR(63)  NOT NULL DEFAULT 'production',
  key         VARCHAR(255) NOT NULL,
  value       TEXT         NOT NULL,
  is_secret   BOOLEAN      NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (app_name, environment, key)
);

CREATE INDEX IF NOT EXISTS idx_app_env_vars_app_env ON app_env_vars (app_name, environment);

-- ── 3. Deployment history per app + environment ─────────────────────────────
CREATE TABLE IF NOT EXISTS app_deployments (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name    VARCHAR(63)  NOT NULL,
  environment VARCHAR(63)  NOT NULL,
  image       TEXT         NOT NULL,
  branch      VARCHAR(255),
  status      VARCHAR(20)  NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','deploying','running','failed','rolled_back')),
  triggered_by VARCHAR(63),
  promoted_from VARCHAR(63),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_app_deployments_app_env ON app_deployments (app_name, environment);
CREATE INDEX IF NOT EXISTS idx_app_deployments_created ON app_deployments (created_at DESC);
