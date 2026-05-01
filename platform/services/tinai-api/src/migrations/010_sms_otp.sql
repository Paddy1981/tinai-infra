-- 010_sms_otp.sql
-- Stores hashed SMS OTPs for mobile-based authentication.
-- Apply with: psql $DATABASE_URL -f src/migrations/010_sms_otp.sql

CREATE TABLE IF NOT EXISTS sms_otps (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mobile     VARCHAR(15) NOT NULL,
  otp_hash   TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used       BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sms_otps_mobile ON sms_otps(mobile);
