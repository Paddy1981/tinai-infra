-- Migration 019: Immutable Audit Log
-- Every significant tenant action is recorded for compliance and debugging.
-- Matches Vercel's audit log and Supabase's auth.audit_log_entries.

CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   text NOT NULL,
  team_id     uuid REFERENCES teams(id) ON DELETE SET NULL,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_email text,
  action      text NOT NULL,  -- e.g., 'workload.create', 'team.invite', 'domain.verify'
  resource    text,           -- e.g., 'workload:abc-123', 'team:my-team'
  metadata    jsonb DEFAULT '{}',
  ip_address  inet,
  user_agent  text,
  created_at  timestamptz DEFAULT now()
);

-- Partition-ready index for time-range queries
CREATE INDEX IF NOT EXISTS idx_audit_log_tenant_time ON audit_log(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_team_time   ON audit_log(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor       ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_action      ON audit_log(action);

-- Prevent UPDATE/DELETE on audit_log (immutable)
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is immutable: % not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS no_update_audit ON audit_log;
CREATE TRIGGER no_update_audit
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();
