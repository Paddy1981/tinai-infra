-- Migration 002: SMS OTP support
-- Tracks per-mobile OTP send state for rate limiting and expiry enforcement.

CREATE TABLE IF NOT EXISTS sms_otp_requests (
    mobile        VARCHAR(15) PRIMARY KEY,
    sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at    TIMESTAMPTZ NOT NULL,
    attempt_count INT         NOT NULL DEFAULT 0
);

-- Add mobile login columns to the existing users table.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile          VARCHAR(15) UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_verified BOOLEAN NOT NULL DEFAULT false;
