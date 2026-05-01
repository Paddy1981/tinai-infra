# TinAI Forge - White-Label Automation Service

Production-quality Go service that automates white-labeling of open-source tools (Forgejo, Grafana, Woodpecker, etc.) for the TinAI PaaS platform.

**Status**: Ready for Production

## Quick Start

### Build
```bash
make build
# Binary: bin/forge-server
```

### Run Locally
```bash
make run
# Requires: FORGE_DB_URL environment variable
```

### Deploy to Kubernetes
See [DEPLOYMENT.md](DEPLOYMENT.md) for complete instructions.

## Architecture

TinAI Forge consists of 7 core modules orchestrating a complete white-labeling pipeline:

```
GitHub API (Releases)
         ↓
    [WATCHER] → Detects upstream versions
         ↓
    [BUILDER] → Creates patched container images
         ↓
    [TESTER] → Smoke/Branding/Security tests
         ↓
   [ROLLOUT] → Orchestrates tenant deployments
```

### Modules

1. **Watcher** - Monitors 11 upstream products for version updates
2. **Patcher** - Applies TinAI branding overlays
3. **Builder** - Builds images with Kaniko in Kubernetes
4. **Tester** - Validates smoke, branding, and security
5. **Rollout** - Deploys updates with BigBang/Rolling/Canary strategies
6. **API** - REST interface for dashboard integration
7. **DB** - PostgreSQL schema for state management

## Features

### Upstream Monitoring
- GitHub Releases API integration
- 11 tracked products (Forgejo, Grafana, Prometheus, etc.)
- Version classification (patch/minor/major)
- 6-hour default check interval
- Pre-release/RC/alpha filtering

### Building
- Kaniko-based container builds
- Multi-stage Docker image generation
- TinAI branding overlay application
- Image caching and optimization
- Build log capture and archiving

### Testing
- **Smoke Tests**: Pod lifecycle, health endpoints
- **Branding Tests**: Content inspection, logo verification
- **Security Tests**: Trivy CVE scanning with severity categorization
- All tests report duration and detailed results

### Rollout Orchestration
- 3 strategies: BigBang (all at once), Rolling (batches), Canary (staged)
- Automatic strategy selection based on tenant count
- Prometheus metrics integration
- Error rate and latency monitoring
- Auto-rollback on thresholds (>1% error, 5+ crashes, 10s P99 latency)
- Manual pause/rollback capabilities

### REST API
14 endpoints for:
- Product monitoring
- Build history and logs
- Test results
- Rollout control
- Patch management

## Configuration

Set environment variables:

```bash
# Required
export FORGE_DB_URL="postgres://user:pass@host:5432/tinai_forge"

# Optional (with defaults)
export FORGE_KUBE_NAMESPACE=tinai-forge
export FORGE_TEST_NAMESPACE=tinai-forge-test
export FORGE_REGISTRY_HOST=registry.e2enetworks.net
export FORGE_REGISTRY_PROJECT=tinai
export FORGE_CHECK_INTERVAL_HOURS=6
export FORGE_AUTO_BUILD_PATCH=true
export FORGE_AUTO_BUILD_MINOR=false
export FORGE_API_PORT=8090
export FORGE_GITHUB_TOKEN=ghp_...  # Optional, higher rate limits
```

## API Endpoints

```
Products:
  GET    /api/forge/products
  GET    /api/forge/products/:id
  POST   /api/forge/products/:id/check

Builds:
  GET    /api/forge/builds
  GET    /api/forge/builds/:id
  POST   /api/forge/builds

Tests:
  GET    /api/forge/tests/:buildId

Rollouts:
  GET    /api/forge/rollouts
  POST   /api/forge/rollouts
  GET    /api/forge/rollouts/:id
  POST   /api/forge/rollouts/:id/pause
  POST   /api/forge/rollouts/:id/rollback

Patches:
  GET    /api/forge/patches
  GET    /api/forge/patches/:product

Health:
  GET    /health
```

## Database Schema

**5 Tables**:
- `forge_products` - Upstream tools being monitored
- `forge_builds` - Build attempts and results
- `forge_test_results` - Individual test outcomes
- `forge_rollouts` - Version rollout orchestration
- `forge_tenant_versions` - Per-tenant product versions

**7 Indexes** on common queries.

## Docker

Multi-stage production build:

```bash
docker build -t tinai/forge:latest .
docker run -e FORGE_DB_URL=... tinai/forge:latest
```

Health check at `http://localhost:8090/health`

## Production Features

- Graceful shutdown with context timeouts
- Structured logging (zap)
- Comprehensive error handling
- Non-root container user (forge:1000)
- Security scanning (Trivy CVE integration)
- Metrics collection (Prometheus compatible)
- Database connection pooling
- Kubernetes client integration
- RBAC and ServiceAccount support

## Code

**19 Go files** with **3,116+ lines** of production code:

| Component | Files | Lines |
|-----------|-------|-------|
| Core | 2 | 239 |
| Database | 2 | 205 |
| Watcher | 2 | 352 |
| Patching | 2 | 196 |
| Builder | 2 | 312 |
| Testing | 3 | 849 |
| Rollout | 2 | 505 |
| API | 1 | 410 |

All code is:
- ✓ Complete implementations (no stubs)
- ✓ Production-ready error handling
- ✓ Structured logging throughout
- ✓ Database integrated
- ✓ Kubernetes integrated
- ✓ Well organized into packages

## Documentation

- [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) - Complete architecture guide
- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment and configuration
- [CHECKLIST.md](CHECKLIST.md) - Implementation checklist

## Next Steps

1. Configure PostgreSQL database
2. Create Kubernetes namespace and resources
3. Build and push Docker image
4. Deploy to cluster
5. Create patch overlay directories
6. Monitor with Prometheus/Grafana

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions.

## Supported Products

Default products tracked (configurable):

1. Forgejo (Git hosting)
2. Woodpecker (CI/CD)
3. Grafana (Monitoring)
4. Prometheus (Metrics)
5. Loki (Logging)
6. MinIO (Object storage)
7. CloudNativePG (PostgreSQL)
8. cert-manager (TLS)
9. KEDA (Autoscaling)
10. Knative (Serverless)
11. ingress-nginx (Ingress)

## License

Copyright TinAI. All rights reserved.

## Support

For deployment help, see [DEPLOYMENT.md](DEPLOYMENT.md).
For architecture details, see [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md).
