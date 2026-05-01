-- 001_compliance_tables.sql
-- Run once against the tinai database before deploying compliance routes.

-- Add region + tenant isolation to existing tables
ALTER TABLE apps ADD COLUMN IF NOT EXISTS region VARCHAR(5) NOT NULL DEFAULT 'IN';
ALTER TABLE apps ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(63) NOT NULL DEFAULT 'tinai-admin';
ALTER TABLE usage_snapshots ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(63) NOT NULL DEFAULT 'tinai-admin';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS region VARCHAR(5) NOT NULL DEFAULT 'IN';
ALTER TABLE residency_reports ADD COLUMN IF NOT EXISTS region VARCHAR(5) NOT NULL DEFAULT 'IN';

-- Consent records
CREATE TABLE IF NOT EXISTS consent_records (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(63) NOT NULL,
  purpose      VARCHAR(63) NOT NULL,
  legal_basis  VARCHAR(63) NOT NULL DEFAULT 'consent',
  granted      BOOLEAN NOT NULL DEFAULT true,
  ip_address   TEXT,
  user_agent   TEXT,
  notice_version VARCHAR(20) NOT NULL DEFAULT '1.0',
  region       VARCHAR(5) NOT NULL DEFAULT 'IN',
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  withdrawn_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_consent_tenant ON consent_records (tenant_id, purpose, granted);

-- Records of Processing Activities
CREATE TABLE IF NOT EXISTS processing_activities (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        VARCHAR(63) NOT NULL,
  activity_name    VARCHAR(255) NOT NULL,
  purpose          TEXT NOT NULL,
  legal_basis      VARCHAR(63) NOT NULL,
  data_categories  TEXT[] NOT NULL DEFAULT '{}',
  data_subjects    TEXT[] NOT NULL DEFAULT '{}',
  retention_days   INTEGER DEFAULT 365,
  processors       TEXT[] DEFAULT '{}',
  transfer_regions TEXT[] DEFAULT '{}',
  is_marketing     BOOLEAN DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_processing_tenant ON processing_activities (tenant_id);

-- Breach incidents
CREATE TABLE IF NOT EXISTS breach_incidents (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 VARCHAR(63),
  region                    VARCHAR(5) NOT NULL DEFAULT 'IN',
  detected_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  description               TEXT,
  affected_categories       TEXT[] DEFAULT '{}',
  affected_records          INTEGER DEFAULT 0,
  status                    VARCHAR(20) NOT NULL DEFAULT 'detected',
  notification_draft        JSONB,
  regulator_notified_at     TIMESTAMPTZ,
  principals_notified_at    TIMESTAMPTZ,
  resolved_at               TIMESTAMPTZ,
  created_by                VARCHAR(63) NOT NULL DEFAULT 'system'
);

-- Data retention policies
CREATE TABLE IF NOT EXISTS retention_policies (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      VARCHAR(63) NOT NULL,
  data_category  VARCHAR(63) NOT NULL,
  retain_days    INTEGER NOT NULL DEFAULT 365,
  region         VARCHAR(5) NOT NULL DEFAULT 'IN',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, data_category)
);

-- Erasure requests (data subject rights)
CREATE TABLE IF NOT EXISTS erasure_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(63) NOT NULL,
  requester_email TEXT NOT NULL,
  data_categories TEXT[] DEFAULT '{}',
  full_erasure    BOOLEAN DEFAULT false,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  sla_deadline    TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

-- Data Processing Agreements
CREATE TABLE IF NOT EXISTS dpa_records (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       VARCHAR(63) NOT NULL,
  jurisdiction    VARCHAR(5) NOT NULL,
  version         VARCHAR(20) NOT NULL DEFAULT '1.0',
  signatory_name  TEXT NOT NULL,
  signatory_email TEXT NOT NULL,
  signed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pdf_hash        TEXT,
  pdf_path        TEXT,
  UNIQUE (tenant_id, jurisdiction, version)
);

-- Audit events (append-only — application enforces INSERT-only)
CREATE TABLE IF NOT EXISTS audit_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
  actor        VARCHAR(255) NOT NULL DEFAULT 'system',
  action       VARCHAR(63) NOT NULL,
  resource     VARCHAR(63) NOT NULL,
  resource_id  TEXT,
  ip_address   TEXT,
  region       VARCHAR(5) DEFAULT 'IN',
  metadata     JSONB DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_time ON audit_events (tenant_id, created_at DESC);

-- Enforce append-only at database level (application comment is insufficient)
CREATE RULE no_delete_audit AS ON DELETE TO audit_events DO INSTEAD NOTHING;
CREATE RULE no_update_audit AS ON UPDATE TO audit_events DO INSTEAD NOTHING;

-- DPO registry
CREATE TABLE IF NOT EXISTS dpo_registry (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region       VARCHAR(5) NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT,
  appointed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- DPIA assessments
CREATE TABLE IF NOT EXISTS dpia_assessments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     VARCHAR(63) NOT NULL,
  region        VARCHAR(5) NOT NULL DEFAULT 'IN',
  status        VARCHAR(20) NOT NULL DEFAULT 'in_progress',
  responses     JSONB NOT NULL DEFAULT '{}',
  risk_level    VARCHAR(10),
  pdf_path      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  reviewed_at   TIMESTAMPTZ
);

-- Seed Tinai's own processing activities (as Data Controller)
INSERT INTO processing_activities (tenant_id, activity_name, purpose, legal_basis, data_categories, data_subjects, retention_days, processors, transfer_regions)
VALUES
  ('tinai-admin', 'Tenant Account Management', 'Manage platform accounts and authentication', 'contract', ARRAY['name','email','company'], ARRAY['tenants'], 730, ARRAY['PostgreSQL (in-cluster)'], ARRAY[]::TEXT[]),
  ('tinai-admin', 'Usage Metering & Billing', 'Calculate resource consumption and generate invoices', 'contract', ARRAY['usage_metrics','billing_data'], ARRAY['tenants'], 2555, ARRAY['PostgreSQL (in-cluster)', 'Razorpay'], ARRAY[]::TEXT[]),
  ('tinai-admin', 'Platform Audit Logging', 'Security and compliance audit trail', 'legal_obligation', ARRAY['access_logs','ip_addresses'], ARRAY['tenants','operators'], 365, ARRAY['PostgreSQL (in-cluster)'], ARRAY[]::TEXT[]),
  ('tinai-admin', 'AI Copilot Platform Context', 'Provide AI-assisted platform management', 'consent', ARRAY['app_names','usage_metrics'], ARRAY['tenants'], 90, ARRAY['Anthropic Claude API'], ARRAY['US'])
ON CONFLICT DO NOTHING;
