-- 016_user_profile.sql
-- Adds profile fields and notification preferences to users table

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS display_name     VARCHAR(120),
  ADD COLUMN IF NOT EXISTS mobile           VARCHAR(20),
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{
    "deploy_success": true,
    "deploy_failure": true,
    "billing_threshold": "1000",
    "compliance_deadline": true
  }'::jsonb;
