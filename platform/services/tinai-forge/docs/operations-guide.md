# TinAI Forge — Operations & Best Practices Guide

> **Audience:** Padmanaban (platform operator, one-man show)
> **Version:** 1.0 · **Cluster:** E2E Networks / K8s v1.32

---

## 1. Tool Interaction Map

Understanding how each tool talks to the others prevents confusion when debugging.

```
┌─────────────────────────────────────────────────────────┐
│                      YOU (operator)                     │
└────────────┬───────────────────────┬────────────────────┘
             │                       │
    tinai CLI (Go binary)    Dashboard (Next.js)
             │                       │
             └──────────┬────────────┘
                        │  JWT auth
                        ▼
                   tinai-api (Fastify)
                   /api/v1/forge/*
                        │  X-Forge-API-Key
                        ▼
                  tinai-forge (Go)           ◄── GitHub API
                  /api/forge/*                    (rate limited)
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
         PostgreSQL           Kubernetes
         (forge DB)           (Kaniko jobs,
                               tenant rollouts)
                        │
                        │ callback
                        ▼
                   tinai-api
                   /forge/callbacks/*
                   (audit log)
```

**Key rule:** The CLI and Dashboard NEVER talk directly to tinai-forge. They always go through tinai-api, which proxies the request using `X-Forge-API-Key`. This means:
- One place for JWT auth (tinai-api)
- One place for forge API key rotation (tinai-api env)
- forge service never exposed to the internet

---

## 2. Optimized Daily Operations

### Morning Check (30 seconds)

```bash
tinai forge status
```

Scan the STATUS column:
- `✓` — Up to date, nothing to do
- `UPDATE` — New version available, decide if you want to build now or wait
- `BUILD_PENDING` — Build queued, check `tinai forge builds`
- `ROLLING_OUT` — Rollout in progress, monitor with `tinai forge rollout status`

### Responding to an Upstream Update

When you see `UPDATE` in forge status:

```bash
# 1. Check what changed
tinai forge check forgejo        # forces a fresh GitHub check

# 2. Review the release (open in browser — forge can't do this for you)
# Check GitHub release notes for breaking changes

# 3. If patch release → safe to build immediately
tinai forge build forgejo

# 4. Watch build complete (takes 5-15 min)
tinai forge builds

# 5. Once build succeeds, start rollout
tinai forge rollout start forgejo

# 6. Monitor
tinai forge rollout status
```

### When Auto-Build is Enabled (FORGE_AUTO_BUILD_PATCH=true)

Steps 3–4 happen automatically for patch releases. You only need to:
```bash
# Check if auto-build worked
tinai forge builds

# Start the rollout (still manual by default for safety)
tinai forge rollout start forgejo
```

---

## 3. Forge Scheduler — Best Settings

The scheduler runs every 6 hours by default (`FORGE_CHECK_INTERVAL=6h`). Optimization guidance:

| Setting | Value | Why |
|---|---|---|
| `FORGE_CHECK_INTERVAL` | `6h` | GitHub unauthenticated: 60 req/hr. 11 products × 1 check = fine at 6h. |
| `FORGE_CHECK_INTERVAL` | `1h` | Use **only** with GitHub token. Authenticated limit: 5000 req/hr. |
| `FORGE_AUTO_BUILD_PATCH` | `true` | Safe for patch releases — semantic versioning guarantees backward compat |
| `FORGE_AUTO_BUILD_MINOR` | `false` | Keep false until you have 6+ months of CTS coverage proving reliability |
| GitHub token | **Always set** | Without it, 11 products checking every 6h = 44 req/day. Token gives 5000/hr. |

**Set GitHub token to avoid rate limiting:**
```bash
kubectl patch configmap forge-config -n tinai-forge \
  --type=merge \
  -p '{"data":{"FORGE_GITHUB_TOKEN":"ghp_yourtokenhere"}}'
kubectl rollout restart deploy/tinai-forge -n tinai-forge
```

---

## 4. Build System — Optimizing Kaniko Builds

Kaniko builds run as K8s Jobs in `tinai-forge` namespace. Each build:
- Uses `gcr.io/kaniko-project/executor:latest`
- Reads Dockerfile from `patches/<product>/Dockerfile`
- Pushes to `registry.e2enetworks.net/tinai/<product>:<version>-tinai`

**Speed up builds with a cache layer:**

The Dockerfile pattern that works best:

```dockerfile
# patches/forgejo/Dockerfile — OPTIMIZED PATTERN
FROM codeberg.org/forgejo/forgejo:1.22.6 AS upstream

# Stage: brand patches (these change rarely — cache-friendly)
FROM upstream AS branded
COPY public/css/tinai-theme.css /data/gitea/public/css/
COPY public/img/tinai-logo.svg /data/gitea/public/img/
COPY templates/ /data/gitea/templates/

# Stage: config (changes per deployment)
FROM branded AS final
COPY app.ini /etc/gitea/app.ini
```

**Three-stage builds mean:** CSS/template changes don't re-download the upstream base.

**Kaniko cache:** Enable Kaniko's built-in layer cache to cut repeat build times from 10min → 2min:

```yaml
# In kaniko.go CreateBuildJob() — add to args:
args:
  - "--cache=true"
  - "--cache-repo=registry.e2enetworks.net/tinai/cache/forge-kaniko"
```

---

## 5. CTS Tests — What Each Test Validates

### Smoke Tests (`tests/forgejo/smoke_test.go`)
- HTTP 200 from service root
- Login page loads
- API `/api/v1/version` responds
- Response time < 3 seconds

**Run manually:**
```bash
# Point at a staging namespace
FORGE_TEST_URL=http://forgejo.tenant-staging.svc.cluster.local:3000 \
go test ./tests/forgejo/... -v -run TestSmoke
```

### Branding Tests (`tests/forgejo/branding_test.go`)
- Page title contains "TinAI" NOT "Forgejo"
- No "Forgejo" text visible in login page HTML
- Logo src points to TinAI asset, not Forgejo asset
- Footer shows TinAI copyright

**Most critical test.** If this fails, tenants see upstream branding. Stop the rollout immediately.

### Functional Tests (`tests/forgejo/functional_test.go`)
- Create repo via API
- Push a commit
- Create issue
- Verify webhook delivery

### Security Tests (`tests/forgejo/security_test.go`)
- Runs `trivy image registry.e2enetworks.net/tinai/forgejo:<version>-tinai`
- Fails if CRITICAL CVEs found
- Fails if HIGH CVEs exceed threshold (default: 5)

**Trivy must be installed on the node running the test job.** Add to your node setup:
```bash
apt-get install -y trivy
# OR use the Trivy K8s operator instead
```

---

## 6. Rollout Strategy Decision Guide

Forge auto-selects strategy based on tenant count, but you can override:

```bash
# Force a specific strategy
tinai forge rollout start forgejo --strategy=canary
tinai forge rollout start forgejo --strategy=rolling
tinai forge rollout start forgejo --strategy=bigbang
```

**When to override auto-selection:**

| Scenario | Strategy | Why |
|---|---|---|
| Testing with 5 tenants (dev/staging) | `bigbang` | Fast, tenant count is tiny |
| New major UI change | `canary` | Even with few tenants, test 1 before all |
| Urgent security patch | `bigbang` | Speed > caution for CVE patches |
| Feature rollout to 50 tenants | `rolling` | Reduces blast radius |

**Auto-rollback trigger:** Forge watches Prometheus for the tenant namespace. If `http_request_error_rate > 5%` for 5 minutes after rollout, it auto-rolls back and pauses the rollout. Check with `tinai forge rollout status`.

---

## 7. Database Access Patterns

The forge Postgres DB is separate from tinai-api's DB. Two databases, two connection strings.

```bash
# Access forge DB directly (for debugging)
kubectl exec -n tinai-forge deploy/postgres -- \
  psql -U forge_user -d tinai_forge

# Useful queries:

# What's the current state of all products?
SELECT name, current_version, latest_version, status, last_checked_at
FROM forge_products ORDER BY name;

# Recent builds
SELECT product_id, version, status, started_at, finished_at,
       EXTRACT(EPOCH FROM (finished_at - started_at))/60 AS duration_min
FROM forge_builds ORDER BY started_at DESC LIMIT 20;

# Which tenants are behind on which products?
SELECT tenant_id, product_id, current_version, target_version, status
FROM forge_tenant_versions
WHERE status != 'up_to_date'
ORDER BY tenant_id, product_id;

# Rollout history
SELECT id, product_id, from_version, to_version, strategy, status,
       started_at, completed_at
FROM forge_rollouts ORDER BY started_at DESC LIMIT 10;
```

---

## 8. API Key Management

The `X-Forge-API-Key` header authenticates service-to-service calls (tinai-api → tinai-forge).

**Rotation procedure** (zero-downtime):

```bash
# 1. Generate new key
NEW_KEY=$(openssl rand -hex 32)

# 2. Update tinai-forge secret (forge now accepts both old and new — NOT implemented yet,
#    so do this during low-traffic window)
kubectl patch secret forge-api-key -n tinai-forge \
  --type=merge -p '{"stringData":{"key":"'$NEW_KEY'"}}'

# 3. Update tinai-api env
kubectl patch secret tinai-api-secrets -n tinai-system \
  --type=merge -p '{"stringData":{"FORGE_API_KEY":"'$NEW_KEY'"}}'

# 4. Restart both services
kubectl rollout restart deploy/tinai-forge -n tinai-forge
kubectl rollout restart deploy/tinai-api -n tinai-system
```

**Best practice:** Rotate every 90 days, or immediately if the key appears in any logs.

---

## 9. Monitoring & Alerting

### What to Watch

| Metric | Alert Threshold | Meaning |
|---|---|---|
| `forge_scheduler_check_duration_seconds` | > 30s | GitHub API slow / rate limited |
| `forge_build_failures_total` | > 2 in 1hr | Dockerfile or registry issue |
| `forge_rollout_rollback_total` | > 0 | Auto-rollback triggered — investigate |
| `forge_cts_test_failures_total` | > 0 | Branding or functional test failed |

### Log Patterns to Watch

```bash
# Watch forge logs in real-time
kubectl logs -n tinai-forge deploy/tinai-forge -f

# Critical patterns:
# ERROR  — always investigate
# "rate limit" — add/rotate GitHub token
# "build failed" — check Kaniko job logs
# "CTS FAILED: branding" — upstream leaked through patches, stop rollout
# "auto-rollback triggered" — check tenant error rate in Prometheus
```

### Kaniko Job Logs (when a build fails)

```bash
# Find the failed job
kubectl get jobs -n tinai-forge | grep forge-build

# Get pod name
kubectl get pods -n tinai-forge -l job-name=forge-build-forgejo-v1.22.7

# Read logs
kubectl logs -n tinai-forge <pod-name>
```

---

## 10. Common Issues & Fixes

### "rate limit exceeded" in forge logs

**Cause:** GitHub unauthenticated API limit hit (60 req/hr across all IPs).
**Fix:** Add `FORGE_GITHUB_TOKEN` to forge ConfigMap (section 3).

### Build stuck at "pending" for > 5 minutes

**Cause:** Kaniko executor image pull taking long, or registry unreachable.
```bash
kubectl describe job forge-build-<product>-<version> -n tinai-forge
kubectl describe pod <kaniko-pod> -n tinai-forge
# Look for: ImagePullBackOff, RegistryUnavailable
```

### CTS branding test fails after build

**Cause:** Upstream template changed structure, patch doesn't apply cleanly.
**Fix:** Update the patch template in `patches/<product>/templates/`, rebuild.

### `tinai forge status` returns empty table

**Cause:** tinai-api cannot reach tinai-forge (graceful degradation returns stub).
```bash
# Check forge service
kubectl get svc -n tinai-forge
kubectl get pods -n tinai-forge

# Check tinai-api can reach forge
kubectl exec -n tinai-system deploy/tinai-api -- \
  wget -qO- http://tinai-forge-svc.tinai-forge.svc.cluster.local:8080/healthz
```

### Dashboard shows "Forge not deployed"

**Cause:** `/api/forge/*` rewrite in `next.config.ts` not working, or tinai-api not reaching forge.
Same debug steps as above. Also check dashboard env:
```bash
kubectl exec -n tinai-system deploy/tinai-dashboard -- \
  env | grep TINAI_API_URL
# Should be: TINAI_API_URL=http://tinai-api-svc.tinai-system.svc.cluster.local:3001
```

---

## 11. Adding a New Product to Watch

When you want to add a new upstream tool (e.g., Keycloak):

**Step 1:** Add to `DefaultProducts` in `internal/watcher/scheduler.go`:
```go
{Name: "keycloak", Repo: "keycloak/keycloak", CurrentVersion: "v26.0.0", WatchMethod: "github_releases"},
```

**Step 2:** Add brand name mapping to `patches/manifest.yaml`:
```yaml
- upstream: keycloak
  tinai_name: "TinAI Identity"
  tinai_description: "Single sign-on and identity management"
```

**Step 3:** Create patch files:
```
patches/keycloak/
  Dockerfile
  themes/tinai/         # Keycloak theme directory
  realm-config.json     # Optional: default realm settings
```

**Step 4:** Add CTS tests:
```
tests/keycloak/
  smoke_test.go
  branding_test.go
```

**Step 5:** Redeploy forge:
```bash
./scripts/deploy.sh tinai-forge
```

---

## 12. Pending Items (Known Gaps)

These are intentionally not yet implemented and need attention:

| Gap | Priority | Fix |
|---|---|---|
| `forge_tenant_versions` missing `namespace` column | **HIGH** | Add `namespace TEXT` to schema; rollout engine needs it to patch K8s deployments |
| forge doesn't call tinai-api callbacks | **HIGH** | Add `notifyBuildComplete()` and `notifyRolloutComplete()` calls in Go service |
| Trivy not installed on cluster nodes | **MEDIUM** | Add Trivy K8s operator or DaemonSet to `tinai-forge` namespace |
| API key rotation is not zero-downtime | **MEDIUM** | Add support for accepting both old and new key during rotation window |
| Minor version auto-build | **LOW** | Enable after 6 months of CTS coverage proving reliability |
| Cloudflare wildcard TLS cert | **HIGH** | DNS-01 challenge still needs Cloudflare API token in cert-manager secret |
