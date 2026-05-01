package db

import (
	"database/sql"

	"go.uber.org/zap"
)

// RunMigrations applies any pending schema migrations.
// Safe to run on every startup — uses IF NOT EXISTS patterns.
func RunMigrations(db *sql.DB, logger *zap.Logger) error {
	migrations := []struct {
		name string
		sql  string
	}{
		{
			name: "add_namespace_to_forge_tenant_versions",
			sql:  `ALTER TABLE forge_tenant_versions ADD COLUMN IF NOT EXISTS namespace TEXT NOT NULL DEFAULT '';`,
		},
		{
			name: "add_plan_to_forge_tenant_versions",
			sql:  `ALTER TABLE forge_tenant_versions ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'starter';`,
		},
		{
			name: "add_idx_forge_tenant_versions_namespace",
			sql:  `CREATE INDEX IF NOT EXISTS idx_forge_tenant_versions_namespace ON forge_tenant_versions(namespace);`,
		},
		{
			name: "add_status_to_forge_tenant_versions",
			sql:  `ALTER TABLE forge_tenant_versions ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'current';`,
		},
		{
			name: "add_updated_at_to_forge_tenant_versions",
			sql:  `ALTER TABLE forge_tenant_versions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`,
		},
		{
			name: "add_rollout_engine_columns",
			sql:  `ALTER TABLE forge_rollouts ADD COLUMN IF NOT EXISTS total_tenants INTEGER DEFAULT 0;`,
		},
		{
			name: "add_completed_tenants_column",
			sql:  `ALTER TABLE forge_rollouts ADD COLUMN IF NOT EXISTS completed_tenants INTEGER DEFAULT 0;`,
		},
		{
			name: "add_failed_tenants_column",
			sql:  `ALTER TABLE forge_rollouts ADD COLUMN IF NOT EXISTS failed_tenants INTEGER DEFAULT 0;`,
		},
		{
			name: "add_duration_seconds_column",
			sql:  `ALTER TABLE forge_rollouts ADD COLUMN IF NOT EXISTS duration_seconds INTEGER;`,
		},
	}

	for _, m := range migrations {
		logger.Info("applying migration", zap.String("name", m.name))
		if _, err := db.Exec(m.sql); err != nil {
			logger.Error("migration failed", zap.String("name", m.name), zap.Error(err))
			return err
		}
	}
	return nil
}
