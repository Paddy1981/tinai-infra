# Tinai Deployment Pipeline — Setup & Learnings

**Date:** 2026-04-05
**Status:** Working end-to-end

---

## Architecture

```
git push → Forgejo (git.tinai.cloud) → webhook → build-api → Kaniko build → Forgejo registry → deploy to staging
                                                                                                       ↓
                                                                                              "Promote" → production (tinai-apps)
```

## Components Deployed

| Service | Namespace | Image |
|---------|-----------|-------|
| build-api | tinai-system | tinai/build-api:v2 |
| Forgejo | tinai-system | tinai/forgejo-branded:v1 |

## Issues Found & Fixed During Setup

### 1. Init container network race condition
**Problem:** The `alpine/git` init container started `git clone` before the pod's network was fully ready, causing instant "Connection refused" errors.
**Fix:** Added `sleep 2 &&` before `git clone` in the init container command (`job.go` lines 116, 263).
**Root cause:** K3s pod networking initialization takes a brief moment; init containers that make network calls immediately on start can hit this.

### 2. NetworkPolicy blocking build → Forgejo traffic
**Problem:** `tinai-system` namespace had `default-deny-ingress`, and no policy allowed traffic from `tinai-build`.
**Fix:** Created `allow-ingress-from-tinai-build` NetworkPolicy in `tinai-system` allowing ports 3000, 8080, 5432 from `tinai-build` namespace. Also created egress policy in `tinai-build` allowing all outbound (needed for Docker Hub image pulls, DNS, and Forgejo access).

### 3. Kaniko registry authentication
**Problem:** Kaniko couldn't push to Forgejo's container registry — got 401 Unauthorized.
**Fix:** Created `kaniko-registry-creds` secret as a generic secret with key `config.json` containing Docker auth JSON (not as `docker-registry` type, since Kaniko reads `/kaniko/.docker/config.json`).

### 4. Kubelet can't resolve cluster DNS for image pulls
**Problem:** The kubelet runs outside the cluster network and can't resolve `forgejo.tinai-system.svc.cluster.local:3000` when pulling images.
**Fix:** Created `/etc/rancher/k3s/registries.yaml` that mirrors the internal registry name to the ClusterIP `10.43.69.14:3000` with auth credentials. Restarted k3s.
**Note:** If the Forgejo pod is rescheduled and gets a new ClusterIP, this will break. Consider using a NodePort or dedicated DNS entry for the registry.

### 5. Missing K8s resources
**Problem:** `tinai-build-sa` ServiceAccount, `tinai-staging` namespace, and `kaniko-registry-creds` secret didn't exist.
**Fix:** Created all three before deploying build-api.

### 6. Trivy scanner image not available
**Problem:** Trivy scan job fails with ErrImagePull (non-blocking — build and deploy still succeed).
**Fix:** TODO — either pre-pull the Trivy image or disable scanning with `SCAN_ENABLED=false`.

## K8s Resources Created

```bash
# Namespaces
tinai-staging

# Service Accounts
tinai-build-sa (tinai-build)
tinai-deploy-sa (tinai-system) + ClusterRoleBinding to cluster-admin

# Secrets
build-api-secrets (tinai-system) — webhook-secret + internal-token
kaniko-registry-creds (tinai-build) — Docker config.json for Forgejo registry

# Network Policies
allow-ingress-from-tinai-build (tinai-system)
allow-egress-to-tinai-system (tinai-build) — allows all egress

# Config Files
/etc/rancher/k3s/registries.yaml — mirrors Forgejo registry for kubelet
```

## Webhook Configuration

All 11 repos have Forgejo webhooks configured:
- URL: `http://build-api.tinai-system.svc.cluster.local:8080/webhook`
- Secret: stored in `build-api-secrets` K8s secret
- Events: `push`
- Signature: HMAC-SHA256 via `X-Gitea-Signature` header

## Credentials

| Credential | Location | Purpose |
|-----------|----------|---------|
| Webhook Secret | K8s secret `build-api-secrets` | Forgejo → build-api HMAC verification |
| Internal API Token | K8s secret `build-api-secrets` | Dashboard/CLI → build-api Bearer auth |
| Kaniko Registry Auth | K8s secret `kaniko-registry-creds` | Kaniko → Forgejo container registry push |
| Forgejo Admin Token | `.env` `FORGEJO_ADMIN_TOKEN` | API access + registry auth |

## TODO

1. **Fix Trivy image pull** — pre-pull or disable scanning
2. **Stable registry endpoint** — Use NodePort or ingress for Forgejo registry instead of ClusterIP (which can change)
3. **Promote endpoint** — Wire dashboard "Promote" button to `POST /api/v1/apps/{name}/promote`
4. **Forgejo webhook for real pushes** — Verify the actual Forgejo webhook fires (manual test confirmed, need to test real git push triggering the full chain)
5. **Add `INTERNAL_API_TOKEN` to dashboard** — So promote/rollback API calls are authenticated
6. **Rollback endpoint** — Wire dashboard "Rollback" button to `POST /api/v1/apps/{name}/rollback`
