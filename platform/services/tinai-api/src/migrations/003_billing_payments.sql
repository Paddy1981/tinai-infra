-- 003_billing_payments.sql
-- Adds Razorpay payment tracking columns to the invoices table.
-- Apply with: psql $DATABASE_URL -f src/migrations/003_billing_payments.sql

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS razorpay_order_id   TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_status      VARCHAR(20) DEFAULT 'pending';
