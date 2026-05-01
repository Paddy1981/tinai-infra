-- Migration 005: Make email and password_hash nullable
-- This allows for mobile-only authentication without fake email addresses.

ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
-- mobile already exists from 002, but ensure the unique constraint and index are solid.
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_mobile_key') THEN
        ALTER TABLE users ADD CONSTRAINT users_mobile_key UNIQUE (mobile);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_users_mobile ON users(mobile);
