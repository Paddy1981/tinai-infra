-- TinAI Forge database schema

-- Products table: tracks upstream tools being monitored
CREATE TABLE IF NOT EXISTS forge_products (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    repo VARCHAR(200) NOT NULL,
    current_version VARCHAR(50) NOT NULL,
    latest_version VARCHAR(50),
    patch_version VARCHAR(30),
    last_checked_at TIMESTAMP,
    status VARCHAR(30) DEFAULT 'current' -- current, update_available, building, tested, staged, promoted
);

-- Builds table: tracks all build attempts for products
CREATE TABLE IF NOT EXISTS forge_builds (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(50) REFERENCES forge_products(id),
    upstream_version VARCHAR(50) NOT NULL,
    patch_version VARCHAR(30) NOT NULL,
    image_tag VARCHAR(200),
    status VARCHAR(30) NOT NULL, -- queued, building, built, testing, passed, failed, promoted
    build_log TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    triggered_by VARCHAR(50) -- 'auto', 'manual', 'scheduled'
);

-- Test results table: detailed test results for each build
CREATE TABLE IF NOT EXISTS forge_test_results (
    id SERIAL PRIMARY KEY,
    build_id INTEGER REFERENCES forge_builds(id),
    test_category VARCHAR(50), -- smoke, branding, functional, security
    test_name VARCHAR(200),
    passed BOOLEAN,
    message TEXT,
    duration_ms INTEGER,
    run_at TIMESTAMP DEFAULT NOW()
);

-- Rollouts table: tracks version rollouts across tenants
CREATE TABLE IF NOT EXISTS forge_rollouts (
    id SERIAL PRIMARY KEY,
    product_id VARCHAR(50) REFERENCES forge_products(id),
    build_id INTEGER REFERENCES forge_builds(id),
    from_version VARCHAR(50),
    to_version VARCHAR(50),
    strategy VARCHAR(20), -- bigbang, rolling, canary, choice
    status VARCHAR(20) DEFAULT 'pending', -- pending, in_progress, paused, completed, rolled_back
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    affected_tenants INTEGER,
    error_count INTEGER DEFAULT 0,
    rollback_reason TEXT,
    total_tenants INTEGER DEFAULT 0,
    completed_tenants INTEGER DEFAULT 0,
    failed_tenants INTEGER DEFAULT 0,
    duration_seconds INTEGER
);

-- Tenant versions table: tracks each tenant's product version
CREATE TABLE IF NOT EXISTS forge_tenant_versions (
    tenant_id VARCHAR(50),
    product_id VARCHAR(50),
    namespace TEXT NOT NULL DEFAULT '',
    plan TEXT NOT NULL DEFAULT 'starter',
    current_version VARCHAR(50),
    target_version VARCHAR(50),
    upgrade_status VARCHAR(20) DEFAULT 'current', -- current, scheduled, in_progress, completed, failed
    upgraded_at TIMESTAMP,
    PRIMARY KEY (tenant_id, product_id),
    FOREIGN KEY (product_id) REFERENCES forge_products(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_forge_builds_product ON forge_builds(product_id);
CREATE INDEX IF NOT EXISTS idx_forge_builds_status ON forge_builds(status);
CREATE INDEX IF NOT EXISTS idx_forge_builds_created ON forge_builds(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_forge_test_results_build ON forge_test_results(build_id);
CREATE INDEX IF NOT EXISTS idx_forge_rollouts_product ON forge_rollouts(product_id);
CREATE INDEX IF NOT EXISTS idx_forge_rollouts_status ON forge_rollouts(status);
CREATE INDEX IF NOT EXISTS idx_forge_rollouts_created ON forge_rollouts(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_forge_tenant_versions_product ON forge_tenant_versions(product_id);
CREATE INDEX IF NOT EXISTS idx_forge_tenant_versions_status ON forge_tenant_versions(upgrade_status);
CREATE INDEX IF NOT EXISTS idx_forge_tenant_versions_namespace ON forge_tenant_versions(namespace);
