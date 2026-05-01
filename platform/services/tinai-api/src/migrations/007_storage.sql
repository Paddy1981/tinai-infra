-- Migration 007: Storage product tables
-- Object storage buckets (backed by MinIO) and managed Postgres databases (backed by CloudNativePG)

-- Object storage buckets (backed by MinIO)
CREATE TABLE storage_buckets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  name          TEXT NOT NULL,
  region        TEXT NOT NULL DEFAULT 'in',       -- in | qa | ae
  quota_gb      INT  NOT NULL DEFAULT 10,
  used_bytes    BIGINT NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'provisioning'
                  CHECK (status IN ('provisioning','active','suspended','deleting','deleted')),
  access_key    TEXT,                              -- written by provisioner
  endpoint_url  TEXT,                             -- e.g. https://minio.tinai.cloud
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

-- Managed Postgres databases (backed by CloudNativePG)
CREATE TABLE storage_databases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL,
  name            TEXT NOT NULL,
  pg_version      TEXT NOT NULL DEFAULT '16',
  storage_gb      INT  NOT NULL DEFAULT 10,
  status          TEXT NOT NULL DEFAULT 'provisioning'
                    CHECK (status IN ('provisioning','running','stopping','stopped','error')),
  connection_string TEXT,                          -- written by provisioner
  host            TEXT,
  port            INT  DEFAULT 5432,
  db_user         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, name)
);

CREATE INDEX ON storage_buckets(tenant_id);
CREATE INDEX ON storage_databases(tenant_id);
