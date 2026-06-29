-- Migration 006: Three-tier role model
-- Converts legacy 2-role system (admin, tenant) to 3-tier:
--   platform_admin — global access
--   tenant_admin   — manages their tenant org
--   member         — regular user within a tenant

-- Migrate existing rows
UPDATE users SET role = 'platform_admin' WHERE role = 'admin';
UPDATE users SET role = 'member' WHERE role = 'tenant';

-- Update default
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'member';

-- Add check constraint for valid roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('platform_admin', 'tenant_admin', 'member'));
