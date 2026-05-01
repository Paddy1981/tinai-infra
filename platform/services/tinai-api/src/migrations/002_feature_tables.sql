-- 002_feature_tables.sql
-- Run once before deploying routes: metrics, customDomains, databases, volumes, storage, auth
-- Apply with: psql $DATABASE_URL -f src/migrations/002_feature_tables.sql

-- ---------------------------------------------------------------------------
-- custom_domains
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS custom_domains (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name     VARCHAR(63) NOT NULL,
  domain       TEXT        NOT NULL UNIQUE,
  verified     BOOLEAN     NOT NULL DEFAULT false,
  cert_status  VARCHAR(20) NOT NULL DEFAULT 'pending',
  verify_token TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_domains_app ON custom_domains (app_name);

-- ---------------------------------------------------------------------------
-- app_databases
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_databases (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name      VARCHAR(63) NOT NULL UNIQUE,
  db_name       VARCHAR(63) NOT NULL UNIQUE,
  host          TEXT        NOT NULL DEFAULT 'postgresql.tinai-system.svc.cluster.local',
  port          INTEGER     NOT NULL DEFAULT 5432,
  username      VARCHAR(63) NOT NULL,
  password_hash TEXT        NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'provisioning',
  region        VARCHAR(5)  NOT NULL DEFAULT 'IN',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- app_volumes
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_volumes (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name      VARCHAR(63) NOT NULL,
  volume_name   VARCHAR(63) NOT NULL UNIQUE,
  mount_path    TEXT        NOT NULL,
  size_gi       INTEGER     NOT NULL DEFAULT 5,
  storage_class VARCHAR(63) NOT NULL DEFAULT 'local-path',
  status        VARCHAR(20) NOT NULL DEFAULT 'pending',
  region        VARCHAR(5)  NOT NULL DEFAULT 'IN',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_volumes_app ON app_volumes (app_name);

-- ---------------------------------------------------------------------------
-- storage_buckets
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage_buckets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  app_name      VARCHAR(63) NOT NULL,
  bucket_name   VARCHAR(63) NOT NULL UNIQUE,
  public        BOOLEAN     NOT NULL DEFAULT false,
  size_limit_mb INTEGER     NOT NULL DEFAULT 1000,
  region        VARCHAR(5)  NOT NULL DEFAULT 'IN',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_storage_buckets_app ON storage_buckets (app_name);

-- ---------------------------------------------------------------------------
-- users (auth)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'tenant',
  tenant_id     VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
  region        VARCHAR(5)  NOT NULL DEFAULT 'IN',
  magic_token   TEXT,
  magic_expires TIMESTAMPTZ,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed admin user.
-- IMPORTANT: password_hash below is a placeholder.
-- Generate a real hash before first login:
--   node -e "
--     const {pbkdf2Sync,randomBytes}=require('crypto');
--     const s=randomBytes(16).toString('hex');
--     const h=pbkdf2Sync('YOUR_PASSWORD',s,100000,64,'sha512').toString('hex');
--     console.log(s+':'+h);
--   "
-- Then UPDATE users SET password_hash='<output>' WHERE email='admin@tinai.cloud';
INSERT INTO users (email, password_hash, role, tenant_id)
VALUES ('admin@tinai.cloud', 'seed:changeme_run_reset_before_prod', 'admin', 'tinai-admin')
ON CONFLICT DO NOTHING;
