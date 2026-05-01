-- Migration 012: database_branches table
-- Stores metadata for CNPG Point-in-Time Recovery branch clusters.

CREATE TABLE IF NOT EXISTS database_branches (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID         NOT NULL,   -- references app_databases.id (logical FK, no constraint for portability)
  tenant_id       VARCHAR(63)  NOT NULL,
  name            VARCHAR(63)  NOT NULL,
  restore_to      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status          VARCHAR(20)  NOT NULL DEFAULT 'provisioning',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (parent_id, name)
);

CREATE INDEX IF NOT EXISTS idx_database_branches_parent ON database_branches (parent_id);
CREATE INDEX IF NOT EXISTS idx_database_branches_tenant ON database_branches (tenant_id);
