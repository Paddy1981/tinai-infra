# Tinai Platform — Comprehensive Audit Report
**Date:** 2026-04-04 | **Server:** tinai-node1 | **Pods:** 23 running

---

## CRITICAL (7)

| # | Issue | Location |
|---|-------|----------|
| C1 | Hardcoded JWT_SECRET in plaintext | safetyforge.yaml |
| C2 | Hardcoded DB password in plaintext | safetyforge.yaml |
| C3 | Hardcoded Grafana password in plaintext | monitoring.yaml |
| C4 | .env files with live credentials on disk | larun/.env, coll/.env.local, safety-forge/.env, astro-data/.env.local |
| C5 | Weak database password (`tinai_local_pass`) | Used everywhere |
| C6 | Default MinIO credentials (`minioadmin/minioadmin`) | K8s secret |
| C7 | SSL disabled for all DB connections (`sslmode=disable`) | DATABASE_URL |

## HIGH (11)

| # | Issue | Impact |
|---|-------|--------|
| H1 | No NetworkPolicies | Any pod can reach any service |
| H2 | Redis has no authentication | Any pod can read/write |
| H3 | All app pods run as root | Container escape = root on host |
| H4 | tinai-realtime BROKEN | DNS resolution fails to PostgreSQL |
| H5 | Forgejo API returns 404 | Git operations may fail |
| H6 | Docker daemon wasting 188MB RAM + 69GB disk | Should be stopped |
| H7 | No automated backups | Single manual backup from day 1 |
| H8 | K8s API (6443) exposed on all interfaces | Should be localhost only |
| H9 | MinIO console exposed via ingress with default creds | Public access risk |
| H10 | Weak/predictable secrets | `local-forge-api-key`, `local-webhook-secret` |
| H11 | larun-se NextAuth UntrustedHost errors | Auth broken |

## MEDIUM (9)

| # | Issue |
|---|-------|
| M1 | `:latest` tags on Grafana, Prometheus, MinIO, node-exporter |
| M2 | Prometheus uses emptyDir — data lost on restart |
| M3 | Shared DB user/password for all apps (no isolation) |
| M4 | No TLS between internal services |
| M5 | Prometheus can't scrape tinai-api (401) and tinai-forge (404) |
| M6 | hostPort on every service causes rolling update issues |
| M7 | PVs reference Docker volume paths (fragile if Docker removed) |
| M8 | Empty API keys in tinai-api-secrets (ANTHROPIC, FORGEJO_ADMIN_TOKEN) |
| M9 | Forgejo major-version-only tag (:9) |

## LOW (6)

| # | Issue |
|---|-------|
| L1 | No dashboards provisioned in Grafana |
| L2 | tinai-gateway missing optional API keys (SARVAM, pgvector) |
| L3 | Coll realtime features stubbed (no WebSocket replacement) |
| L4 | Swap not verified as encrypted |
| L5 | kube-system pods (traefik, local-path) lack resource limits |
| L6 | Stale v1 images in K3s (waste space) |

---

## FUNCTIONALITY STATUS

| Service | Status | Issue |
|---------|--------|-------|
| tinai-api | WORKING | /metrics needs auth bypass for Prometheus |
| tinai-auth | WORKING | — |
| tinai-gateway | WORKING | Missing optional API keys |
| tinai-dashboard | WORKING | — |
| tinai-functions | WORKING | — |
| **tinai-realtime** | **BROKEN** | DNS resolution fails to PostgreSQL |
| tinai-forge | WORKING | No /metrics endpoint |
| Forgejo | PARTIAL | Web UI works, API 404 |
| PostgreSQL | WORKING | 8 DBs, 60MB total, 9 connections |
| Redis | WORKING | 1MB / 256MB |
| MinIO | WORKING | Default creds |
| Prometheus | PARTIAL | 4/6 targets up |
| Grafana | WORKING | No dashboards |
| laruneng-com | WORKING | 0 errors, 0 restarts |
| safety-forge | WORKING | 0 errors, 28 tables |
| sattrack | WORKING | Static nginx |
| astro-data | WORKING | 0 errors |
| coll | WORKING | 0 errors, auth migrated |
| **larun-se** | **PARTIAL** | NextAuth UntrustedHost errors |
| larun-space | WORKING | Static nginx |

**Score: 18/20 working, 1 partial, 1 broken**

---

## RESOURCE STATUS

| Resource | Used | Available | Headroom |
|----------|------|-----------|----------|
| RAM | 3.6 GB | 4.1 GB | 54% free |
| CPU | 0.9 load | 8 cores | ~87% idle |
| Disk | 83 GB | 784 GB | 86% free |
| DB total | 60 MB | — | Tiny |
| Connections | 9 | ~91 free | Plenty |
| Pods | 23 | ~26 more | Moderate |

**Top memory consumers:** Grafana 98Mi, larun-se 97Mi, Forgejo 88Mi, MinIO 79Mi, Dashboard 71Mi

**Docker waste:** 69GB in images (can reclaim with `docker system prune`)

---

## PRIORITY FIX ORDER

### Immediate (today)
1. Stop Docker daemon → frees RAM + we can prune 69GB later
2. Fix tinai-realtime DNS → broken service
3. Delete .env files with old secrets
4. Move hardcoded secrets to K8s Secrets (safetyforge.yaml, monitoring.yaml)

### This week
5. Set up automated daily pg_dump backup CronJob
6. Change PostgreSQL password to strong random value
7. Change MinIO credentials from default
8. Add Redis password
9. Fix larun-se NEXTAUTH_URL
10. Fix Forgejo API config

### Next sprint
11. Add NetworkPolicies (isolate tinai-apps from tinai-system)
12. Add securityContext (runAsNonRoot) to all pods
13. Pin image tags (no :latest)
14. Add Prometheus persistent storage
15. Provision Grafana dashboards
