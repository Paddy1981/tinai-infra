# TinAI Forge — Documentation Index

> Automated white-label pipeline for TinAI platform components.
> One-man operation guide for Padmanaban.

---

## Documents in This Folder

| Document | Purpose | When to Read |
|---|---|---|
| [rollout-plan.md](./rollout-plan.md) | Phase-by-phase production rollout guide | **Start here** when deploying forge to production |
| [operations-guide.md](./operations-guide.md) | Day-to-day operations, best practices, troubleshooting | Reference during ongoing operations |
| [cli-reference.md](./cli-reference.md) | `tinai forge` command quick-reference with decision tree | When using the CLI |
| [api-reference.md](./api-reference.md) | All REST endpoints with request/response examples | When integrating new services or debugging |

---

## The 5-Minute Mental Model

```
Upstream GitHub → Forge Scheduler (every 6h)
                        ↓ new version detected
               Forge DB: status = "update_available"
                        ↓ you run: tinai forge build <product>
               Kaniko Job builds branded image
                        ↓ CTS tests pass
               Image: registry.e2enetworks.net/tinai/<product>:<ver>-tinai
                        ↓ you run: tinai forge rollout start <product>
               K8s rolling update across all tenant namespaces
                        ↓ Prometheus monitors error rate
               Auto-rollback if errors spike
```

**The Samsung Galaxy analogy:** Tenants see "TinAI Repos", never "Forgejo". Brand patches are applied at image build time, not at runtime.

---

## Quick Commands

```bash
# Morning check
tinai forge status

# Respond to an update
tinai forge build forgejo
tinai forge builds                    # watch until success
tinai forge rollout start forgejo
tinai forge rollout status

# Emergency stop
tinai forge rollout pause <id>
tinai forge rollout rollback <id>
```

---

## Service Map

| Service | Namespace | Port | Purpose |
|---|---|---|---|
| `tinai-forge` | `tinai-forge` | 8080 | Core forge engine (Go) |
| `postgres` | `tinai-forge` | 5432 | Forge database (separate from tinai-api DB) |
| `tinai-api` | `tinai-system` | 3001 | Proxies forge API, JWT auth layer |
| `tinai-dashboard` | `tinai-system` | 3000 | Admin UI for forge |

---

## Known Gaps (Fix Before Full Automation)

1. **`forge_tenant_versions` needs `namespace` column** — rollout engine can't patch tenant K8s deployments without it
2. **forge Go service doesn't call tinai-api callbacks** — audit log won't have build/rollout events
3. **Trivy not installed on cluster nodes** — security CTS tests will fail
4. **Cloudflare API token** — needed for wildcard TLS cert (DNS-01 challenge)
