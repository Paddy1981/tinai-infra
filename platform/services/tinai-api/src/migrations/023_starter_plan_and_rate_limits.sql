-- Migration 023: Add missing Starter plan + per-plan rate limits
-- Fills the gap between Free (0 INR) and Pro (2999 INR).
-- Adds rate limiting metadata per plan (like Railway/Vercel).

-- Add Starter plan
INSERT INTO plans VALUES
  ('starter', 'Starter', 999, '{"max_workloads":10,"max_databases":3,"max_functions":20,"storage_gb":10,"api_calls_month":100000,"build_minutes_month":300,"bandwidth_gb":50,"rate_limit_rpm":600}')
ON CONFLICT (id) DO UPDATE SET
  price_inr = EXCLUDED.price_inr,
  limits = EXCLUDED.limits;

-- Update existing plans with rate limiting and new limits
UPDATE plans SET limits = '{"max_workloads":3,"max_databases":1,"max_functions":5,"storage_gb":1,"api_calls_month":10000,"build_minutes_month":100,"bandwidth_gb":10,"rate_limit_rpm":60}'
WHERE id = 'free';

UPDATE plans SET limits = '{"max_workloads":20,"max_databases":5,"max_functions":50,"storage_gb":50,"api_calls_month":500000,"build_minutes_month":1000,"bandwidth_gb":200,"rate_limit_rpm":3000}'
WHERE id = 'pro';

UPDATE plans SET limits = '{"max_workloads":-1,"max_databases":-1,"max_functions":-1,"storage_gb":-1,"api_calls_month":-1,"build_minutes_month":-1,"bandwidth_gb":-1,"rate_limit_rpm":-1}'
WHERE id = 'enterprise';

-- Add email_verified column to users (needed for proper signup flow)
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified boolean DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_expires timestamptz;

-- Password reset tokens
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires timestamptz;
