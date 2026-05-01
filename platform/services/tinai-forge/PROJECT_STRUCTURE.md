# TinAI Forge - Project Structure

Complete production-quality Go service for automating white-labeling of open-source tools for the TinAI PaaS platform.

## Core Files

### Entry Point
- **cmd/server/main.go** (121 lines)
  - Application entry point
  - Initializes logger, database, watcher
  - Starts HTTP API server on :8090
  - Implements graceful shutdown

### Configuration
- **config/config.go** (118 lines)
  - Environment-based configuration loading
  - Database, Kubernetes, Registry, GitHub settings
  - Auto-build policies (patch, minor, major versions)
  - Validation and defaults

### Database
- **internal/db/schema.sql** (78 lines)
  - Complete PostgreSQL schema
  - Tables: products, builds, test_results, rollouts, tenant_versions
  - Indexes for common queries

- **internal/db/init.go** (90 lines)
  - Schema initialization
  - Fallback inline SQL if schema file not found
  - Migration support for future schema changes

## Upstream Watcher

### GitHub Monitoring
- **internal/watcher/github.go** (145 lines)
  - GitHub API v3 client
  - GetLatestRelease() - fetch stable releases (skips RCs, alphas, betas)
  - GetReleasesSince() - get new versions since current
  - Configurable GitHub token for higher rate limits

### Version Scheduler
- **internal/watcher/scheduler.go** (207 lines)
  - Cron-based periodic checks (default: 6 hours)
  - Monitors 11 default upstream products (Forgejo, Grafana, Prometheus, etc.)
  - CheckProduct() - check single product for updates
  - ClassifyUpgrade() - determine patch/minor/major
  - Database integration

## Patching & Building

### Overlay Patcher
- **internal/patcher/overlay.go** (107 lines)
  - Generates multi-stage Dockerfile with TinAI patches
  - Supports Forgejo/Gitea, Grafana, Prometheus templates
  - Handles custom branding overlays
  - Integrates with Kaniko builder

### Conflict Resolver
- **internal/patcher/resolver.go** (89 lines)
  - Detects conflicts between patches and upstream versions
  - Tracks file moves, deletions, content changes
  - Categorizes conflicts by severity
  - Validates patch compatibility

### Kaniko Builder
- **internal/builder/kaniko.go** (225 lines)
  - Kubernetes Job management for container builds
  - Uses gcr.io/kaniko-project/executor
  - Configurable caching and resource limits
  - Job monitoring and log retrieval
  - Automatic cleanup

### Registry Manager
- **internal/builder/registry.go** (92 lines)
  - Docker image tag generation
  - Maps products to upstream registries (Codeberg, GHCR, Docker Hub)
  - Latest tag references
  - Cache repository management

## Testing

### Smoke Tests
- **internal/tester/smoke.go** (250+ lines)
  - Deploy ephemeral test pods
  - Verify pod reaches Ready state (timeout: 60s)
  - Check health endpoints
  - Validate logs for errors
  - Automatic cleanup

### Branding Tests
- **internal/tester/branding.go** (280+ lines)
  - Verify TinAI branding present
  - Verify upstream tool names removed
  - Check favicon/logo accessibility
  - Validate page titles safe
  - HTML content inspection

### Security Tests
- **internal/tester/security.go** (310+ lines)
  - Trivy CVE scanning
  - Creates Kubernetes Jobs for scanning
  - Parses JSON vulnerability results
  - Blocks promotion if CRITICAL CVEs found
  - Categorizes by severity (CRITICAL, HIGH, MEDIUM)

## Rollout Engine

### Strategy & Orchestration
- **internal/rollout/strategy.go** (260+ lines)
  - Rollout strategy selection (BigBang, Rolling, Canary)
  - Auto-selects based on tenant count (<10, <100, 100+)
  - RolloutPlan and RolloutStatus tracking
  - Start, pause, rollback operations
  - Database-backed state management

### Monitoring
- **internal/rollout/monitor.go** (200+ lines)
  - Prometheus integration for metrics
  - Error rate queries
  - P99 latency monitoring
  - Pod crash detection
  - Auto-rollback triggers (>1% error, 5+ crashes, 10s latency)

## REST API

### Handlers
- **internal/api/handlers.go** (350+ lines)
  - Complete REST API implementation
  - 14 endpoints for products, builds, tests, rollouts, patches
  - JSON request/response handling
  - Database queries with proper error handling

**API Endpoints:**
```
GET    /api/forge/products
GET    /api/forge/products/:id
POST   /api/forge/products/:id/check
GET    /api/forge/builds
GET    /api/forge/builds/:id
POST   /api/forge/builds
GET    /api/forge/tests/:buildId
GET    /api/forge/rollouts
POST   /api/forge/rollouts
GET    /api/forge/rollouts/:id
POST   /api/forge/rollouts/:id/pause
POST   /api/forge/rollouts/:id/rollback
GET    /api/forge/patches
GET    /api/forge/patches/:product
```

## Build & Deployment

### Dockerfile (48 lines)
- Multi-stage build (Go 1.22 -> Alpine 3.19)
- Non-root user (forge:1000)
- Health check endpoint
- Minimal final image

### Makefile
- `make build` - Build binary
- `make test` - Run tests
- `make run` - Run locally
- `make docker` - Build Docker image
- `make lint` - Run linter
- `make fmt` - Format code

### Dependencies (go.mod)

**Core:**
- github.com/robfig/cron/v3 - Scheduling
- github.com/google/go-github/v60 - GitHub API
- go.uber.org/zap - Logging
- github.com/gin-gonic/gin - HTTP framework
- github.com/lib/pq - PostgreSQL driver
- k8s.io/client-go v0.29.0 - Kubernetes client
- github.com/aquasecurity/trivy v0.46.0 - CVE scanning

## Database Schema

**Tables:**
1. **forge_products** - Upstream tools (id, name, repo, versions, status)
2. **forge_builds** - Build attempts (product, versions, image_tag, status, logs)
3. **forge_test_results** - Test details (category, name, passed, duration)
4. **forge_rollouts** - Version rollouts (product, versions, strategy, status, tenants)
5. **forge_tenant_versions** - Per-tenant state (tenant_id, product_id, versions, status)

**Indexes:** product_id, status, created times for optimal query performance

## Tracked Products (Default)

1. **Forgejo** (codeberg.org/forgejo/forgejo)
2. **Woodpecker** (woodpecker-ci/woodpecker)
3. **Grafana** (grafana/grafana)
4. **Prometheus** (prometheus/prometheus)
5. **Loki** (grafana/loki)
6. **MinIO** (minio/minio)
7. **CloudNativePG** (cloudnative-pg/cloudnative-pg)
8. **cert-manager** (cert-manager/cert-manager)
9. **KEDA** (kedacore/keda)
10. **Knative** (knative/serving)
11. **ingress-nginx** (kubernetes/ingress-nginx)

## Environment Variables

```bash
# Database
FORGE_DB_URL                      # PostgreSQL connection
PGUSER, PGPASSWORD, PGHOST, etc.  # Alternative (uses defaults)

# Kubernetes
FORGE_KUBE_NAMESPACE=tinai-forge
FORGE_TEST_NAMESPACE=tinai-forge-test
KUBECONFIG                        # Optional, uses in-cluster config if empty

# Registry
FORGE_REGISTRY_HOST=registry.e2enetworks.net
FORGE_REGISTRY_PROJECT=tinai

# GitHub
FORGE_GITHUB_TOKEN                # Optional, for higher rate limits

# Prometheus
FORGE_PROMETHEUS_URL              # Default: http://kube-prometheus-stack-prometheus.monitoring:9090

# Watcher
FORGE_CHECK_INTERVAL_HOURS=6      # Default: 6
FORGE_AUTO_BUILD_PATCH=true       # Default: true
FORGE_AUTO_BUILD_MINOR=false      # Default: false

# API
FORGE_API_PORT=8090               # Default: 8090
FORGE_API_KEY                     # Optional API key for auth
```

## Code Statistics

- **Total Lines:** ~1,100+ in core logic
- **Go Files:** 19 core modules
- **Packages:** 7 (watcher, patcher, builder, tester, rollout, api, db, config)
- **Main Entry Points:** 1 (cmd/server/main.go)

## Production Readiness Features

✓ Graceful shutdown with context timeouts
✓ Structured logging (zap)
✓ Comprehensive error handling
✓ Database connection pooling
✓ Kubernetes client integration
✓ HTTP health checks
✓ Non-root container user
✓ Multi-stage Docker build
✓ Security scanning (Trivy)
✓ Metrics collection (Prometheus)
✓ Rollback capabilities
✓ Configurable via environment

## Testing Architecture

- Smoke tests: Pod lifecycle, health checks
- Branding tests: Content inspection, CSS validation
- Security tests: CVE scanning, vulnerability analysis
- All tests return TestResult with duration and detailed messages

## Next Steps for Deployment

1. Configure PostgreSQL database
2. Create Kubernetes namespace: `kubectl create namespace tinai-forge`
3. Set environment variables
4. Build Docker image: `docker build -t registry/tinai/forge:latest .`
5. Deploy to Kubernetes with ConfigMap for patches
6. Initialize database schema
7. Start watcher and API server
