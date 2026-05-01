package db

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"

	"go.uber.org/zap"
)

// InitSchema initializes the database schema
func InitSchema(db *sql.DB) error {
	// Read schema file
	schemaPath := filepath.Join("internal", "db", "schema.sql")

	// Try alternative paths
	if _, err := os.Stat(schemaPath); err != nil {
		// Try relative to working directory
		schemaPath = "schema.sql"
		if _, err := os.Stat(schemaPath); err != nil {
			// Try embedded or skip if not found
			return initSchemaFallback(db)
		}
	}

	schema, err := os.ReadFile(schemaPath)
	if err != nil {
		// Fallback to inline schema
		return initSchemaFallback(db)
	}

	// Execute schema
	_, err = db.Exec(string(schema))
	if err != nil {
		return fmt.Errorf("failed to execute schema: %w", err)
	}

	return nil
}

// initSchemaFallback creates tables with inline SQL
func initSchemaFallback(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS forge_products (
			id VARCHAR(50) PRIMARY KEY,
			name VARCHAR(100) NOT NULL,
			repo VARCHAR(200) NOT NULL,
			current_version VARCHAR(50) NOT NULL,
			latest_version VARCHAR(50),
			patch_version VARCHAR(30),
			last_checked_at TIMESTAMP,
			status VARCHAR(30) DEFAULT 'current'
		)`,
		`CREATE TABLE IF NOT EXISTS forge_builds (
			id SERIAL PRIMARY KEY,
			product_id VARCHAR(50) REFERENCES forge_products(id),
			upstream_version VARCHAR(50) NOT NULL,
			patch_version VARCHAR(30) NOT NULL,
			image_tag VARCHAR(200),
			status VARCHAR(30) NOT NULL,
			build_log TEXT,
			started_at TIMESTAMP,
			completed_at TIMESTAMP,
			triggered_by VARCHAR(50)
		)`,
		`CREATE TABLE IF NOT EXISTS forge_test_results (
			id SERIAL PRIMARY KEY,
			build_id INTEGER REFERENCES forge_builds(id),
			test_category VARCHAR(50),
			test_name VARCHAR(200),
			passed BOOLEAN,
			message TEXT,
			duration_ms INTEGER,
			run_at TIMESTAMP DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS forge_rollouts (
			id SERIAL PRIMARY KEY,
			product_id VARCHAR(50) REFERENCES forge_products(id),
			build_id INTEGER REFERENCES forge_builds(id),
			from_version VARCHAR(50),
			to_version VARCHAR(50),
			strategy VARCHAR(20),
			status VARCHAR(20) DEFAULT 'pending',
			started_at TIMESTAMP,
			completed_at TIMESTAMP,
			affected_tenants INTEGER,
			error_count INTEGER DEFAULT 0,
			rollback_reason TEXT
		)`,
		`CREATE TABLE IF NOT EXISTS forge_tenant_versions (
			tenant_id VARCHAR(50),
			product_id VARCHAR(50),
			current_version VARCHAR(50),
			target_version VARCHAR(50),
			upgrade_status VARCHAR(20) DEFAULT 'current',
			upgraded_at TIMESTAMP,
			PRIMARY KEY (tenant_id, product_id),
			FOREIGN KEY (product_id) REFERENCES forge_products(id)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_builds_product ON forge_builds(product_id)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_builds_status ON forge_builds(status)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_test_results_build ON forge_test_results(build_id)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_rollouts_product ON forge_rollouts(product_id)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_rollouts_status ON forge_rollouts(status)`,
		`CREATE INDEX IF NOT EXISTS idx_forge_tenant_versions_product ON forge_tenant_versions(product_id)`,
	}

	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("failed to execute statement: %w", err)
		}
	}

	return nil
}

// MigrateData performs any necessary data migrations
func MigrateData(db *sql.DB, logger *zap.Logger) error {
	logger.Info("checking for required migrations")

	// Add any migration logic here as the schema evolves
	// For example:
	// ALTER TABLE forge_builds ADD COLUMN IF NOT EXISTS ...

	return nil
}
