# TinAI Forge - File Index & Quick Reference

## Documentation Start Here

1. **README.md** - Quick start and feature overview (start here)
2. **PROJECT_STRUCTURE.md** - Complete architecture and design
3. **DEPLOYMENT.md** - Deployment instructions and configuration
4. **CHECKLIST.md** - Implementation checklist and verification
5. **INDEX.md** - This file

## Core Application

```
cmd/server/main.go              Entry point, graceful shutdown, server startup
config/config.go                Configuration from environment variables
```

## Database Layer

```
internal/db/schema.sql          PostgreSQL schema (5 tables, 7 indexes)
internal/db/init.go             Schema initialization and migrations
```

## Upstream Monitoring

```
internal/watcher/github.go       GitHub Releases API client
internal/watcher/scheduler.go    Cron scheduler (6-hour default)
```

## Patching & Conflict Detection

```
internal/patcher/overlay.go      Dockerfile generation with overlays
internal/patcher/resolver.go     Patch conflict detection
```

## Build Orchestration

```
internal/builder/kaniko.go       Kubernetes Job builder (Kaniko)
internal/builder/registry.go     Docker registry tag management
```

## Testing Suite

```
internal/tester/smoke.go         Pod lifecycle and health tests
internal/tester/branding.go      TinAI branding verification
internal/tester/security.go      Trivy CVE scanning
```

## Rollout Engine

```
internal/rollout/strategy.go     Rollout strategies (BigBang/Rolling/Canary)
internal/rollout/monitor.go      Prometheus metrics and auto-rollback
```

## REST API

```
internal/api/handlers.go         14 REST endpoints
```

## Build & Deployment

```
go.mod                           Go 1.22 module with dependencies
go.sum                           Dependency checksums
Dockerfile                       Multi-stage production build
Makefile                         Build targets (build, test, docker, etc.)
```

## Project Configuration

```
.gitignore                       Git ignore rules
```

## Quick Commands

```bash
# Build locally
make build

# Run locally
make run

# Docker build
make docker

# Tests
make test

# Code formatting
make fmt

# Run linter
make lint
```

## Environment Variables

Key variables needed:

```bash
FORGE_DB_URL=postgres://...     # PostgreSQL connection (required)
FORGE_API_PORT=8090              # API port (default: 8090)
FORGE_CHECK_INTERVAL_HOURS=6     # Watcher interval (default: 6)
```

See DEPLOYMENT.md for complete list.

## API Endpoints Reference

```
/health                          Health check
/api/forge/products              List products
/api/forge/products/:id          Get product detail
/api/forge/builds                List builds
/api/forge/tests/:buildId        Get test results
/api/forge/rollouts              List rollouts
/api/forge/rollouts/:id/pause    Pause rollout
```

See README.md for complete endpoint list.

## Key Features

- Automatic upstream version detection via GitHub API
- Containerized builds with Kaniko in Kubernetes
- Multi-level testing (smoke, branding, security)
- Smart rollout strategies (BigBang, Rolling, Canary)
- Prometheus metrics integration
- Auto-rollback on error thresholds
- PostgreSQL state management

## Tracked Products

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

## Database Tables

- `forge_products` - Upstream tools
- `forge_builds` - Build attempts
- `forge_test_results` - Test results
- `forge_rollouts` - Rollout history
- `forge_tenant_versions` - Per-tenant versions

## Code Statistics

| Category | Files | Lines |
|----------|-------|-------|
| Core | 2 | 239 |
| Database | 2 | 205 |
| Watcher | 2 | 352 |
| Patching | 2 | 196 |
| Builder | 2 | 312 |
| Testing | 3 | 849 |
| Rollout | 2 | 505 |
| API | 1 | 410 |
| **Total** | **19** | **3,116** |

## File Tree

```
tinai-forge/
├── cmd/
│   └── server/
│       └── main.go
├── config/
│   └── config.go
├── internal/
│   ├── api/
│   │   └── handlers.go
│   ├── builder/
│   │   ├── kaniko.go
│   │   └── registry.go
│   ├── db/
│   │   ├── init.go
│   │   └── schema.sql
│   ├── patcher/
│   │   ├── overlay.go
│   │   └── resolver.go
│   ├── rollout/
│   │   ├── monitor.go
│   │   └── strategy.go
│   ├── tester/
│   │   ├── branding.go
│   │   ├── security.go
│   │   └── smoke.go
│   └── watcher/
│       ├── github.go
│       └── scheduler.go
├── Dockerfile
├── Makefile
├── go.mod
├── go.sum
├── .gitignore
├── README.md
├── PROJECT_STRUCTURE.md
├── DEPLOYMENT.md
├── CHECKLIST.md
└── INDEX.md
```

## Getting Started

1. **Read**: README.md
2. **Understand**: PROJECT_STRUCTURE.md
3. **Deploy**: DEPLOYMENT.md
4. **Build**: `make build`
5. **Test**: `make test`
6. **Containerize**: `make docker`
7. **Deploy to K8s**: Follow DEPLOYMENT.md

## Support Documents

- **README.md** - Overview and quick start
- **PROJECT_STRUCTURE.md** - Architecture deep-dive
- **DEPLOYMENT.md** - Complete deployment guide
- **CHECKLIST.md** - Verification checklist
- **FILES_CREATED.txt** - Detailed file listing
- **INDEX.md** - This reference guide

## Production Ready

All components are production-ready:
- ✓ Error handling
- ✓ Logging
- ✓ Database integration
- ✓ Kubernetes support
- ✓ Security scanning
- ✓ Metrics collection
- ✓ Health checks
- ✓ Graceful shutdown

## Questions?

Refer to the appropriate documentation:
- Architecture questions → PROJECT_STRUCTURE.md
- Deployment questions → DEPLOYMENT.md
- Feature details → README.md
- Implementation details → Source code files
