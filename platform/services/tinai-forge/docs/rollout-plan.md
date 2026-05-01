# TinAI Forge — Smooth Rollout Plan

> **Version:** 1.0 · **Date:** 2026-03-25
> **Author:** Padmanaban (TinAI Platform)
> **Scope:** Full integration and deployment of TinAI Forge into the live E2E Networks Kubernetes cluster

---

## Overview

TinAI Forge is the **automated white-label pipeline** that watches 11 upstream open-source releases (Forgejo, Grafana, Woodpecker, MinIO, etc.), applies TinAI brand patches, runs Compatibility Test Suite (CTS) validation, and rolls out to all tenants — without any manual Docker image hunting.

This document is the **single source of truth** for rolling out Forge into production.
Think of it as the Samsung Galaxy analogy: tenants see "TinAI Repos", "TinAI Insights", "TinAI Pipelines" — never the upstream brand.

---

## Pre-flight Checklist

Before starting any phase, verify these are ready:

| Item | Command | Expected |
|---|---|---|
| Cluster reachable | `kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml get nodes` | 4 nodes Ready |
| Registry login | `docker login registry.e2enetworks.net` | Login Succeeded |
| Forge namespace absent | `kubectl get ns tinai-forge` | NotFound (we create it) |
| tinai-api running | `kubectl get pods -n tinai-system -l app=tinai-api` | Running |
| Forge DB credentials | Check 1Password / env store | `FORGE_DB_URL`, `FORGE_API_KEY` ready |

---

## Phase 0 — Secrets & Infrastructure Setup

**Goal:** All K8s secrets and config in place before a single image is deployed.

```bash
# 1. Create namespace
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml apply -f \
  tinai-infra/k8s/forge/00-namespace.yaml

# 2. Apply RBAC
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml apply -f \
  tinai-infra/k8s/forge/01-rbac.yaml

# 3. Create Postgres secret (replace values)
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml create secret generic forge-db-secret \
  -n tinai-forge \
  --from-literal=url="postgres://forge_user:YOURPASSWORD@postgres-svc.tinai-forge.svc.cluster.local:5432/tinai_forge?sslmode=disable"

# 4. Create API key secret (generate a strong key)
FORGE_API_KEY=$(openssl rand -hex 32)
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml create secret generic forge-api-key \
  -n tinai-forge \
  --from-literal=key="$FORGE_API_KEY"
echo "Save this key: $FORGE_API_KEY"

# 5. Create registry secret for Kaniko image pushes
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml create secret docker-registry \
  kaniko-registry-secret \
  -n tinai-forge \
  --docker-server=registry.e2enetworks.net \
  --docker-username=YOUR_REGISTRY_USER \
  --docker-password=YOUR_REGISTRY_PASS

# 6. Create GitHub token secret (for upstream API calls — avoids 60 req/hr rate limit)
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml create secret generic forge-github-secret \
  -n tinai-forge \
  --from-literal=token="ghp_YOURTOKEN"
```

**Also update tinai-api secret** with the matching Forge API key:
```bash
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml patch secret tinai-api-secrets \
  -n tinai-system \
  --type=merge \
  -p '{"stringData":{"FORGE_API_KEY":"'$FORGE_API_KEY'","FORGE_API_URL":"http://tinai-forge-svc.tinai-forge.svc.cluster.local:8080"}}'
```

✅ **Done when:** All secrets exist in both `tinai-forge` and `tinai-system` namespaces.

---

## Phase 1 — Deploy Forge Engine

**Goal:** TinAI Forge Go service running and healthy in `tinai-forge` namespace.

```bash
# Build and push the forge image
cd /c/Dev/tinai-forge
./scripts/deploy.sh tinai-forge

# OR from tinai-infra:
cd /c/Dev/tinai-infra
./scripts/deploy.sh tinai-forge
```

**What this does:**
1. `docker build` the Go service from `/c/Dev/tinai-forge`
2. Tags as `registry.e2enetworks.net/tinai/tinai-forge:YYYYMMDD-HHMMSS-<sha>`
3. Pushes both versioned + `:latest` tags
4. `kubectl set image` patches the deployment
5. Waits for rollout

**Verify:**
```bash
# Health check
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  exec -n tinai-forge deploy/tinai-forge -- wget -qO- localhost:8080/healthz

# Should return: {"status":"ok","service":"tinai-forge"}

# Check logs
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  logs -n tinai-forge deploy/tinai-forge --tail=50

# Expect to see:
# "scheduler started" interval=6h
# "checking upstream versions for all products"
```

✅ **Done when:** `/healthz` returns 200, logs show scheduler running.

---

## Phase 2 — Deploy Updated tinai-api

**Goal:** tinai-api now proxies `/api/v1/forge/*` to the Forge service, with callback endpoints live.

**Changes being deployed:**
- `src/routes/forge.ts` — Fastify plugin (proxy to forge, graceful degradation)
- `src/server.ts` — forge routes registered, callback paths JWT-exempt
- `src/routes/provisioner.ts` — new tenants auto-registered in forge

```bash
cd /c/Dev/tinai-api
./scripts/deploy.sh tinai-api

# Verify forge proxy is wired
curl -H "Authorization: Bearer $YOUR_JWT" \
  https://api.tinai.cloud/api/v1/forge/summary

# If forge is running: returns real data
# If forge unreachable: returns {"forge_status":"not_deployed"} — graceful degradation ✓
```

**Rollback safety:** If forge is not reachable, tinai-api returns a stub response — it does NOT crash or throw 500. Zero risk to existing tenants.

✅ **Done when:** `/api/v1/forge/summary` returns 200 (either real or stub data).

---

## Phase 3 — Deploy Updated Dashboard

**Goal:** Admin dashboard has the Forge section, and all `/api/forge/*` browser calls are properly proxied.

**Changes being deployed:**
- `next.config.ts` — `rewrites()` block added (critical: routes `/api/v1/*` and `/api/forge/*` to tinai-api)
- `app/admin/forge/` — Version matrix, builds, rollouts, patches, per-product pages

```bash
cd /c/Dev/tinai-dashboard
./scripts/deploy.sh tinai-dashboard

# Verify rewrites work
curl https://dash.tinai.cloud/api/forge/summary
# Should proxy through to tinai-api → forge
```

**Test dashboard UI:**
1. Login as admin at `https://dash.tinai.cloud`
2. Navigate to **Admin → Forge**
3. Expect the version matrix table showing 11 products
4. If forge not yet fully seeded: mock data fallback shows (intentional)

✅ **Done when:** Dashboard loads Forge section without errors.

---

## Phase 4 — CLI Update

**Goal:** `tinai forge` command group available in the CLI.

```bash
# Rebuild tinai CLI
cd /c/Dev/tinai-cli
go build -o tinai.exe ./cmd/tinai

# Test forge commands
./tinai.exe forge status
./tinai.exe forge --help
```

**Expected output of `tinai forge status`:**
```
TinAI Forge — Platform Version Matrix
┌─────────────────────┬──────────────┬──────────────┬────────┬──────────────────────┐
│ PRODUCT             │ CURRENT      │ LATEST       │ STATUS │ LAST CHECKED         │
├─────────────────────┼──────────────┼──────────────┼────────┼──────────────────────┤
│ TinAI Repos         │ v1.22.6      │ v1.22.6      │ ✓      │ 2026-03-25 06:00 UTC │
│ TinAI Pipelines     │ v2.7.3       │ v2.7.3       │ ✓      │ 2026-03-25 06:00 UTC │
│ TinAI Insights      │ v11.3.0      │ v11.4.0      │ UPDATE │ 2026-03-25 06:00 UTC │
│ ...                 │              │              │        │                      │
└─────────────────────┴──────────────┴──────────────┴────────┴──────────────────────┘
```

✅ **Done when:** `tinai forge status` returns data from live forge service.

---

## Phase 5 — First Version Check

**Goal:** Forge has checked all 11 upstream products and populated its database.

This happens **automatically** on startup (Phase 1 already triggered it). Verify:

```bash
# Via CLI
tinai forge status

# Via direct DB check (if you have access)
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  exec -n tinai-forge deploy/postgres -- \
  psql -U forge_user -d tinai_forge \
  -c "SELECT name, current_version, latest_version, status FROM forge_products;"
```

If some products show `update_available`, that's real data — upstream has released new versions.

✅ **Done when:** All 11 products appear in the table.

---

## Phase 6 — First Test Build (Staging)

**Goal:** Validate the full build pipeline before enabling automation. Use Forgejo as the guinea pig.

```bash
# Trigger a manual build for forgejo
tinai forge build forgejo

# Watch build logs
tinai forge builds

# Or watch the Kaniko job directly
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  get jobs -n tinai-forge -w
```

**What happens:**
1. Forge creates a Kaniko K8s Job in `tinai-forge` namespace
2. Kaniko reads the `patches/forgejo/Dockerfile`
3. Builds branded image: `registry.e2enetworks.net/tinai/forgejo:v1.22.6-tinai`
4. CTS smoke tests run in a test pod
5. Branding tests assert "TinAI" visible, "Forgejo" hidden
6. Security scan via Trivy Job

**Expected build duration:** 5–15 minutes for first build (layer cache cold).

✅ **Done when:** Build shows `status: success`, image pushed to registry.

---

## Phase 7 — First Rollout (Canary to 1 Tenant)

**Goal:** Push the newly branded image to one tenant namespace as a canary.

```bash
# Start rollout — forge auto-selects strategy based on tenant count
# With few tenants: BigBang strategy
tinai forge rollout start forgejo

# Monitor
tinai forge rollout status

# If something looks wrong:
tinai forge rollout pause <rollout-id>
tinai forge rollout rollback <rollout-id>
```

**Rollout strategy auto-selection:**
- `< 10 tenants` → BigBang (all at once, fast)
- `10–100 tenants` → Rolling (batch by batch, ~10% per wave)
- `> 100 tenants` → Canary (1% → 5% → 25% → 100%)

✅ **Done when:** All tenant namespaces running the new branded image.

---

## Phase 8 — Enable Automation

**Goal:** Forge now auto-builds and auto-deploys patch releases without manual intervention.

Update the forge ConfigMap:

```bash
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  patch configmap forge-config -n tinai-forge \
  --type=merge \
  -p '{"data":{"FORGE_AUTO_BUILD_PATCH":"true","FORGE_AUTO_BUILD_MINOR":"false"}}'

# Restart forge to pick up config
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  rollout restart deploy/tinai-forge -n tinai-forge
```

**Automation matrix:**

| Update Type | Auto-Build | Auto-Rollout | Example |
|---|---|---|---|
| Patch | ✅ Yes | ✅ Yes (after CTS pass) | v1.22.6 → v1.22.7 |
| Minor | ❌ No | ❌ No | v1.22.x → v1.23.0 |
| Major | ❌ No | ❌ No | v1.x → v2.0.0 |

Minor and major updates: forge creates the notification, you trigger manually via CLI or dashboard.

✅ **Done when:** ConfigMap updated, forge restarted.

---

## Rollback Procedures

### Rollback a Forge Rollout

```bash
tinai forge rollout rollback <rollout-id>
# Forge re-patches all tenant deployments back to previous image
```

### Rollback tinai-forge Service Itself

```bash
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  rollout undo deployment/tinai-forge -n tinai-forge
```

### Emergency: Disable Forge Completely

If forge misbehaves, tinai-api gracefully degrades (stub responses). You can stop forge without any user impact:

```bash
kubectl --kubeconfig ~/Downloads/tinai-in-kubeconfig.yaml \
  scale deployment tinai-forge -n tinai-forge --replicas=0
```

The dashboard Forge section will show "Forge not deployed" — users are unaffected.

---

## Go-Live Summary

| Phase | Action | Risk | Duration |
|---|---|---|---|
| 0 | Secrets & infrastructure | None (infra only) | 10 min |
| 1 | Deploy forge engine | None (new service) | 5 min |
| 2 | Deploy tinai-api update | Low (graceful degradation) | 5 min |
| 3 | Deploy dashboard update | Low (UI only) | 5 min |
| 4 | CLI update | None (local binary) | 2 min |
| 5 | First version check | None (read-only) | Auto |
| 6 | First test build | None (staging only) | 15 min |
| 7 | First canary rollout | Low (1 tenant) | 10 min |
| 8 | Enable automation | Medium (test in dev first) | 2 min |

**Total estimated time to full production:** ~55 minutes of active work.

---

## What Tenants Experience

Throughout this entire rollout, tenants see **zero downtime** and **zero brand exposure**:

- Their existing services (Forgejo, Grafana, etc.) keep running on current versions
- When a new branded image rolls out, Kubernetes does a rolling update (0 downtime)
- The new UI shows "TinAI Repos" not "Forgejo" — branding is applied at image build time
- Prometheus metrics trigger auto-rollback if error rate spikes during rollout
