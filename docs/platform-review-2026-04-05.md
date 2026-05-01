# Tinai Platform -- Complete Code Review Report

**Date:** 2026-04-05
**Scope:** All platform services, infrastructure, SDK, CLI, and dashboard
**Services reviewed:** 18 components across Go, TypeScript, Python, Docker, and CI/CD

---

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 12 |
| HIGH | 45 |
| MEDIUM | 47 |
| LOW | 34 |
| **Total** | **138** |

The platform has solid foundations (multi-stage Docker builds, K8s-native, modular services) but has significant security gaps that need immediate attention -- primarily around **hardcoded secrets**, **missing auth checks**, **broken functionality**, and **exposed ports bypassing the firewall**.

---

## CRITICAL Findings (Fix Immediately)

### 1. Hardcoded secrets in source code and .env
- **tinai-tle** `main.go:20` -- Database password `SpaceDBPass123` hardcoded in `defaultDatabaseURL`
- **platform/.env** -- JWT secret, Postgres password (`tinai_local_pass`), Grafana password all in plaintext
- **docker-compose.yml** -- MinIO credentials hardcoded as `minioadmin/minioadmin`

### 2. Broken password change (tinai-api)
- **`settings.ts:95-98`** -- Password hash format is `pbkdf2:salt:hash` but code does `split(':')` into only 2 vars, making password changes ALWAYS fail

### 3. Auth bypass when API keys are unset
- **tinai-api** `forge.ts:229` -- Forge callback auth skipped when `FORGE_API_KEY` is empty
- **tinai-forge** `handlers.go:38` -- All endpoints open when `FORGE_API_KEY` is unset
- **tinai-functions** `middleware.go:17` -- All routes open when `JWT_SECRET` is unset
- **tinai-build-api** `handler.go:26` -- All `/api/v1/*` routes open when `INTERNAL_API_TOKEN` is unset

### 4. Missing tenant ownership check (tinai-api)
- **`customDomains.ts:94-105`** -- Any authenticated user can list/add/delete custom domains on ANY app

### 5. Caller-controlled tenant_id on registration (tinai-api)
- **`auth.ts:234`** -- Users can register with any `tenant_id`, potentially impersonating other tenants

### 6. Dashboard JWT_SECRET not injected in K8s
- **`k8s/deployment.yaml:24-31`** -- Missing `JWT_SECRET` env var means middleware can't verify tokens

### 7. Dashboard CSRF headers missing on critical endpoints
- **`sql/page.tsx:81`** -- SQL editor POST missing `x-tinai-csrf`
- **`InvoicesClient.tsx:62`** -- Payment endpoint missing `x-tinai-csrf`
- **`GenerateReportButton.tsx:15`** -- Hits wrong endpoint AND missing CSRF

### 8. WebAuthn credentials loaded by tenant, not user (tinai-auth)
- **`webauthn/handler.go:133`** -- Any passkey in a tenant can authenticate as ANY user in that tenant

### 9. OTP generation has modulo bias (tinai-auth)
- **`password.go:52`** -- Charset length 31 doesn't divide 256 evenly, reducing effective keyspace

### 10. SQL/LIKE injection in tinai-guard
- **`events.py:137`** -- `plate_text` not escaped for LIKE wildcards (`%`, `_`)

### 11. LogQL injection (tinai-api)
- **`workloads.ts:261`** -- `workloadName` from DB interpolated directly into LogQL query

### 12. SSRF via PostgREST proxy (tinai-api)
- **`databases.ts:347`** -- App name used to construct internal hostname, could target arbitrary internal services

---

## HIGH Findings (Fix This Sprint)

### Infrastructure & Secrets
| # | Finding | Location |
|---|---------|----------|
| 1 | PostgreSQL port 5432 exposed to 0.0.0.0, Docker bypasses UFW | `docker-compose.yml:28` |
| 2 | Redis exposed without authentication on port 6379 | `docker-compose.yml:47` |
| 3 | All microservice ports exposed to host network | `docker-compose.yml` multiple |
| 4 | Monitoring (Prometheus, Alertmanager, cAdvisor) exposed without auth | `docker-compose.monitoring.yml` |
| 5 | Alertmanager email non-functional (empty password, no TLS) | `alertmanager.yml:23` |
| 6 | cAdvisor runs privileged | `docker-compose.monitoring.yml:78` |
| 7 | Docker bypasses UFW firewall rules | `setup-tinai-node.sh` |
| 8 | Grafana password hardcoded in start.sh | `start.sh:92` |

### tinai-gateway
| # | Finding | Location |
|---|---------|----------|
| 9 | Google Gemini API key leaked in URL query parameter | `google.go:115` |
| 10 | SSE usage writer buffer grows unbounded (memory leak) | `handler.go:271` |

### tinai-api
| # | Finding | Location |
|---|---------|----------|
| 11 | Server imports 9 non-existent route modules (won't compile) | `server.ts:35-43` |
| 12 | Password verification timing side-channel | `settings.ts:95` |
| 13 | New PG connection pool created per SQL query request | `databases.ts:276` |

### tinai-auth
| # | Finding | Location |
|---|---------|----------|
| 14 | No JWT revocation -- tokens valid 7 days, logout is a no-op | `config.go:32` |
| 15 | No email format validation on registration | `handlers.go:71` |
| 16 | Rate limiting is IP-only, not per-account | `limiter.go:99` |
| 17 | http.Server missing ReadHeaderTimeout (Slowloris DoS) | `main.go:152` |
| 18 | Ingress has no TLS configuration | `deployment.yaml:87` |

### tinai-guard
| # | Finding | Location |
|---|---------|----------|
| 19 | Features endpoint has no authentication | `features.py:9` |
| 20 | Wildcard CORS with credentials in debug mode | `main.py:32` |
| 21 | MinIO storage uses blocking sync calls inside async handlers | `storage.py:22` |
| 22 | Headscale client has no HTTP error checking | `headscale.py:12` |
| 23 | Deterrence controller (sirens/lights) has no authentication | `main.py:113` |
| 24 | Celery tasks use deprecated `get_event_loop().run_until_complete()` | `tasks.py:24` |

### tinai-forge
| # | Finding | Location |
|---|---------|----------|
| 25 | API key comparison not constant-time (timing attack) | `handlers.go:51` |
| 26 | PromQL injection in rollout monitor | `monitor.go:107` |
| 27 | JSON merge patch injection risk | `engine.go:270` |
| 28 | `parseQuantitySimple` undefined -- code won't compile | `security.go:155` |

### tinai-dashboard
| # | Finding | Location |
|---|---------|----------|
| 29 | CSP blocks Razorpay checkout script (payments broken) | `next.config.ts:12` |
| 30 | Rate limiter memory leak in auth session endpoint | `session/route.ts:7` |
| 31 | Admin routes not gated by role in middleware | `middleware.ts:36` |
| 32 | Login flow broken (proxy requires auth, user has no token yet) | `login/page.tsx:61` |
| 33 | Verbose token logging in production | `lib/api.ts:14` |

### Utility Services
| # | Finding | Location |
|---|---------|----------|
| 34 | tinai-cli: No HTTP client timeout | `root.go:150` |
| 35 | tinai-cli: YAML injection in tenant create | `tenant.go:124` |
| 36 | tinai-js: JWT token in WebSocket URL query parameter | `realtime.ts:172` |
| 37 | tinai-edge-agent: No HTTP timeout on pushgateway | `main.go:124` |
| 38 | tinai-storage-provisioner: Nil dynClient crash on error | `main.go:51` |
| 39 | tinai-usage: No HTTP timeout for Prometheus queries | `main.go:46` |
| 40 | tinai-tle: No HTTP timeout for Celestrak fetch | `main.go:53` |
| 41 | tinai-build-api: `--insecure` + `--skip-tls-verify` on nixpacks Kaniko | `nixpacks.go:158` |
| 42 | tinai-build-api: PR webhook missing body size limit | `pr_handler.go:31` |
| 43 | tinai-backup: pg_dump password visible in /proc | `main.go:216` |
| 44 | tinai-functions: No request body size limit on function upload | `handlers.go:119` |
| 45 | tinai-functions: JWT bypass when secret is unset | `middleware.go:17` |

---

## Top 10 Recommended Actions (Priority Order)

### 1. Rotate ALL secrets immediately
Generate strong random values for `POSTGRES_PASSWORD`, `JWT_SECRET`, `MINIO_ROOT_PASSWORD`, `FORGE_API_KEY`, `FORGEJO_WEBHOOK_SECRET`, `GRAFANA_PASSWORD`. Remove the hardcoded password from `tinai-tle/main.go`.

### 2. Stop exposing database and monitoring ports
Bind Postgres, Redis, Prometheus, Alertmanager, and all exporters to `127.0.0.1` or remove port mappings entirely. Fix Docker/UFW bypass with `"iptables": false` in daemon.json.

### 3. Add Redis authentication
Add `--requirepass` to Redis and update all `REDIS_URL` values.

### 4. Fix auth bypass on empty API keys
Make startup fatal when `FORGE_API_KEY`, `JWT_SECRET`, or `INTERNAL_API_TOKEN` are unset in production across tinai-api, tinai-forge, tinai-functions, and tinai-build-api.

### 5. Fix tenant isolation bugs
- Add tenant ownership check to custom domains routes
- Remove caller-controlled `tenant_id` from registration
- Fix WebAuthn credential lookup to filter by user_id

### 6. Fix broken dashboard flows
- Add `JWT_SECRET` to K8s deployment manifest
- Add `x-tinai-csrf` headers to SQL editor, billing, and compliance endpoints
- Whitelist `checkout.razorpay.com` in CSP
- Fix login flow to bypass proxy for auth endpoints

### 7. Fix broken password change in tinai-api settings
Update `split(':')` destructuring to handle the 3-part `pbkdf2:salt:hash` format.

### 8. Add HTTP client timeouts everywhere
Add timeouts to all services using `http.DefaultClient`: tinai-cli, tinai-edge-agent, tinai-usage, tinai-tle. Add `ReadHeaderTimeout` to tinai-auth server.

### 9. Fix injection vulnerabilities
- Move Gemini API key to `x-goog-api-key` header
- Escape LIKE wildcards in tinai-guard event search
- Sanitize LogQL inputs in tinai-api workloads route
- Use `json.Marshal` for k8s patches in tinai-forge
- Use constant-time comparison for API keys in tinai-forge

### 10. Fix alerting and monitoring
- Configure working SMTP in Alertmanager
- Add scrape targets for tinai-functions, tinai-realtime
- Add alerts for TLS cert expiry, HTTP 5xx rates, backup failures

---

## Services With Clean Results

- **tinai-instances** -- Well implemented with proper signal handling, DB checks, and K8s fallback
- **tinai-tenant-operator** -- Uses controller-runtime correctly with leader election and health probes

---

## Architecture Observations

- **Duplicate directories**: tinai-forge has nested `internal/internal/`, `cmd/cmd/` duplicates; tinai-realtime has identical files in two locations; tinai-dashboard exists in both `platform/` and `platform/services/`
- **No structured logging**: Most Go services use `log.Printf` instead of `slog`/`zap`
- **No graceful shutdown**: tinai-gateway, tinai-api, tinai-edge-agent lack signal handling
- **No integration tests in CI**: All pipelines go straight from build to deploy with no smoke tests
- **No rollback mechanism**: Failed deploys leave bad images running with no auto-rollback
- **No vulnerability scanning**: No trivy/grype in any pipeline

---

*Report generated by Claude Code reviewing 18 platform components across ~150 source files.*
