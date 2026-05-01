# Tinai Platform Migration Plan
## From: Home Lab (tinai-node1 + ryzen-node) → Paid Cloud (India)

**Date:** 2026-04-25
**Author:** Padmanaban + Claude
**Target:** 8 vCPU / 16 GB RAM / 150 GB SSD — Ubuntu 24.04
**Cost:** ₹4,453/month (on-demand) or ₹2,672/month (36-month committed, 40% off)
**Region:** Delhi (IN)

---

## 1. Current State

| Metric | Value |
|--------|-------|
| Nodes | 2 (tinai-node1 control-plane + ryzen-node worker via WSL2) |
| K3s version | v1.34.6+k3s1 |
| Total pods | ~75 |
| Total memory used | ~3.1 GB of 7.8 GB available |
| Total disk used | 213 GB of 913 GB |
| PostgreSQL total | ~92 MB across 9 databases |
| Persistent volumes | 125 Gi allocated (postgres 20G, forgejo 20G, minio 50G, etc.) |
| Docker images | ~15 GB (many old versions to prune) |
| Public domains | 24 DNS records across tinai.cloud + laruneng.com |
| External IP | IPv6 only (Hetzner mail server at 89.167.77.88 for SMTP) |

---

## 2. Target Architecture

### Single-Node K3s on 8 vCPU / 16 GB / 150 GB SSD

```
┌─────────────────────────────────────────────────────────────┐
│  Cloud Node (Delhi) — 8 vCPU / 16 GB / 150 GB SSD          │
│                                                             │
│  K3s (single-node, control-plane + worker)                  │
│                                                             │
│  ┌─ tinai-system ──────────────────────────────────────┐    │
│  │ PostgreSQL (49Mi) · Redis (14Mi) · Auth (30Mi)      │    │
│  │ API (61Mi) · Gateway (20Mi) · Dashboard (75Mi)      │    │
│  │ Forgejo (174Mi) · MinIO (91Mi)                      │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ vault ─────────────────────────────────────────────┐    │
│  │ Vault (50Mi)                                        │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ tinai-apps ────────────────────────────────────────┐    │
│  │ laruneng.com (77Mi) · SafetyForge (60Mi)            │    │
│  │ COLL (59Mi) · AstroData (59Mi)                      │    │
│  │ Larun Space (50Mi) · SatTrack (50Mi)                │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ core ──────────────────────────────────────────────┐    │
│  │ Stalwart Mail (130Mi) · Tinai Mail UI (41Mi)        │    │
│  │ Roundcube (36Mi)                                    │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ monitoring ────────────────────────────────────────┐    │
│  │ Prometheus (60Mi) · Grafana (60Mi)                  │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ nats ──────────────────────────────────────────────┐    │
│  │ NATS (30Mi)                                         │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  Estimated total: ~1.3 GB (without Lago)                    │
│  With Lago billing: ~2.0 GB                                 │
│  Headroom: 14 GB free for growth                            │
└─────────────────────────────────────────────────────────────┘
```

### What NOT to migrate (save ~800 Mi)
- Lago billing stack (660 Mi) — add later when revenue starts
- Larun SE (123 Mi) — still in development
- Hello Tinai (17 Mi) — demo app
- Ops stack (build-deploy, rollback, incident-alerting) — manual deploy is fine
- Woodpecker CI — not needed at this scale
- DevPortal (45 Mi) — not publicly accessible

---

## 3. Pre-Migration Checklist

### 3.1 Cloud Provider Setup
- [ ] Launch Ubuntu 24.04 node (8 vCPU / 16 GB / 150 GB SSD)
- [ ] Enable VPC for internal security
- [ ] Assign reserved IPv4 (required for DNS A records)
- [ ] Configure security group:
  - Inbound: 22 (SSH), 80 (HTTP), 443 (HTTPS), 6443 (K3s API — your IP only)
  - Outbound: all
- [ ] Add SSH key (same `~/.ssh/id_ed25519.pub` from current setup)
- [ ] Disable password-based SSH login

### 3.2 Domain Preparation
- [ ] Note current Cloudflare DNS records for all 24 domains
- [ ] Prepare to update A records to new IPv4 after migration
- [ ] Set low TTL (60s) on all DNS records 24 hours before migration

### 3.3 Data Backup (from current cluster)
```bash
# PostgreSQL full dump
sudo kubectl exec -n tinai-system postgres-0 -- \
  pg_dumpall -U tinai > /home/padmanaban/backup/pg_dumpall_$(date +%Y%m%d).sql

# Forgejo data
sudo kubectl cp tinai-system/forgejo-598844d979-vthd6:/data \
  /home/padmanaban/backup/forgejo-data/

# MinIO data
sudo kubectl cp tinai-system/minio-564b8cbc55-c64s8:/data \
  /home/padmanaban/backup/minio-data/

# Vault data
sudo kubectl cp vault/vault-0:/vault/data \
  /home/padmanaban/backup/vault-data/

# Stalwart mail data
sudo kubectl cp core/stalwart-66ff858f7c-v9f88:/opt/stalwart-mail \
  /home/padmanaban/backup/stalwart-data/

# NATS JetStream data
sudo kubectl cp nats/nats-0:/data \
  /home/padmanaban/backup/nats-data/

# All K8s manifests
sudo kubectl get all,ingress,secrets,configmaps,pvc -A -o yaml \
  > /home/padmanaban/backup/k8s-manifests.yaml

# Vault secrets export
export VAULT_ADDR=http://vault.vault.svc.cluster.local:8200
export VAULT_TOKEN=<YOUR_VAULT_ROOT_TOKEN>
vault kv get -format=json secret/tinai > /home/padmanaban/backup/vault-secrets.json
```

### 3.4 Docker Images to Transfer
Only latest versions needed (~4.5 GB total):
```
tinai/safety-forge:v9     1.47 GB
laruneng/website:v5       390 MB
tinai/coll:v15            386 MB
tinai/dashboard:v26       309 MB
tinai/mail-ui:v4          300 MB
tinai/api:v12             281 MB
tinai/forgejo-branded:v1  240 MB
tinai/astro-data:v2       229 MB
tinai/forge:v2            136 MB
tinai/larun-space:v1      95.6 MB
tinai/sattrack:v1         97.4 MB
tinai/functions:v1        101 MB
tinai/build-api:v4        86.8 MB
tinai/auth:v2             36.2 MB
tinai/realtime:v2         26.4 MB
tinai/edge-agent:v1       24.6 MB
tinai/gateway:v2          18.5 MB
```

---

## 4. Migration Steps

### Phase 1: Setup New Node (Day 1, ~2 hours)

```bash
# SSH into new node
ssh root@<NEW_IP>

# Update system
apt update && apt upgrade -y

# Install K3s (single node, same version)
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.34.6+k3s1" \
  sh -s - --write-kubeconfig-mode 644

# Verify
kubectl get nodes

# Install Helm
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash

# Create namespaces
for ns in tinai-system tinai-apps core vault nats monitoring billing; do
  kubectl create namespace $ns
done

# Create persistent volume directories
mkdir -p /data/{postgres,forgejo,minio,redis,vault,nats,stalwart}
```

### Phase 2: Transfer Data (Day 1, ~1 hour)

```bash
# From OLD node — package everything
cd /home/padmanaban/backup
tar czf tinai-backup.tar.gz \
  pg_dumpall_*.sql forgejo-data/ minio-data/ vault-data/ stalwart-data/

# Transfer to new node
scp tinai-backup.tar.gz root@<NEW_IP>:/data/

# Transfer Docker images (from old node)
sudo docker save \
  tinai/safety-forge:v9 laruneng/website:v5 tinai/coll:v15 \
  tinai/dashboard:v26 tinai/api:v12 tinai/auth:v2 \
  tinai/gateway:v2 tinai/forgejo-branded:v1 tinai/astro-data:v2 \
  tinai/larun-space:v1 tinai/sattrack:v1 tinai/mail-ui:v4 \
  tinai/forge:v2 tinai/functions:v1 tinai/realtime:v2 \
  tinai/build-api:v4 tinai/edge-agent:v1 \
  | ssh root@<NEW_IP> 'sudo k3s ctr images import -'
```

### Phase 3: Deploy Core Services (Day 1, ~2 hours)

Deploy in order (dependencies first):

```
1. PostgreSQL + Redis
2. Vault (unseal with existing key)
3. External Secrets Operator
4. NATS
5. Tinai Auth
6. Tinai API + Gateway
7. Tinai Dashboard
8. Forgejo + MinIO
```

For each service:
```bash
# Copy K8s manifests from current cluster
# Located at: /home/padmanaban/tinai/platform/infra/k8s/

# Apply in order:
kubectl apply -f postgres/
kubectl apply -f redis/
kubectl apply -f vault/
# ... etc
```

### Phase 4: Restore Data (Day 1, ~30 min)

```bash
# Restore PostgreSQL
kubectl exec -i -n tinai-system postgres-0 -- \
  psql -U tinai < /data/pg_dumpall_*.sql

# Restore Forgejo data
kubectl cp /data/forgejo-data/ tinai-system/<forgejo-pod>:/data/

# Restore MinIO data
kubectl cp /data/minio-data/ tinai-system/<minio-pod>:/data/

# Unseal Vault
kubectl exec -n vault vault-0 -- vault operator unseal \
  <YOUR_VAULT_UNSEAL_KEY>
```

### Phase 5: Deploy Apps (Day 1, ~1 hour)

```bash
# Apply app deployments
kubectl apply -f apps/laruneng-com/
kubectl apply -f apps/safetyforge/
kubectl apply -f apps/coll/
kubectl apply -f apps/astrodata/
kubectl apply -f apps/larun-space/
kubectl apply -f apps/sattrack/

# Apply mail stack
kubectl apply -f core/stalwart/
kubectl apply -f core/tinai-mail/
kubectl apply -f core/roundcube/

# Apply monitoring
kubectl apply -f monitoring/prometheus/
kubectl apply -f monitoring/grafana/
```

### Phase 6: TLS + Ingress (Day 1, ~30 min)

```bash
# Install cert-manager
kubectl apply -f https://github.com/cert-manager/cert-manager/releases/download/v1.17.2/cert-manager.yaml

# Apply ClusterIssuer for Let's Encrypt
kubectl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@tinai.cloud
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
    - http01:
        ingress:
          class: traefik
EOF

# Apply all ingress manifests (same as current, with TLS annotation)
kubectl apply -f ingress/
```

### Phase 7: DNS Cutover (Day 2, ~15 min)

In Cloudflare, update A records for all domains to `<NEW_IPv4>`:

**Priority 1 (customer-facing):**
```
laruneng.com          → <NEW_IP>
www.laruneng.com      → <NEW_IP>
safetyforge.laruneng.com → <NEW_IP>
coll.laruneng.com     → <NEW_IP>
tinai.cloud           → <NEW_IP>
```

**Priority 2 (other apps):**
```
astrodata.laruneng.com → <NEW_IP>
larun.space            → <NEW_IP>
space.laruneng.com     → <NEW_IP>
sattrack.laruneng.com  → <NEW_IP>
mail.tinai.cloud       → <NEW_IP>
```

**Priority 3 (platform services):**
```
api.tinai.cloud        → <NEW_IP>
auth.tinai.cloud       → <NEW_IP>
git.tinai.cloud        → <NEW_IP>
gateway.tinai.cloud    → <NEW_IP>
gw.tinai.cloud         → <NEW_IP>
minio.tinai.cloud      → <NEW_IP>
ws.tinai.cloud         → <NEW_IP>
build.tinai.cloud      → <NEW_IP>
forge.tinai.cloud      → <NEW_IP>
registry.tinai.cloud   → <NEW_IP>
dev.tinai.cloud        → <NEW_IP>
```

### Phase 8: Verification (Day 2, ~1 hour)

```bash
# Health check all endpoints
for url in \
  https://laruneng.com \
  https://safetyforge.laruneng.com \
  https://coll.laruneng.com \
  https://astrodata.laruneng.com \
  https://larun.space \
  https://sattrack.laruneng.com \
  https://tinai.cloud \
  https://mail.tinai.cloud \
  https://git.tinai.cloud \
  https://api.tinai.cloud/health; do
  echo "$url → $(curl -so /dev/null -w '%{http_code}' $url)"
done

# Check PostgreSQL data
kubectl exec -n tinai-system postgres-0 -- \
  psql -U tinai -c "SELECT datname, pg_size_pretty(pg_database_size(datname)) FROM pg_database;"

# Check pods
kubectl get pods -A | grep -v Completed

# Check TLS certs
kubectl get certificate -A
```

---

## 5. Rollback Plan

If anything fails, the old cluster is untouched:
1. Revert DNS records to old IP (Cloudflare, instant propagation)
2. Old cluster continues serving traffic
3. Debug new cluster at leisure

**Zero-downtime window**: Keep old cluster running for 48 hours after cutover. Only decommission after all verification passes.

---

## 6. Post-Migration Tasks

- [ ] Prune old Docker images on new node (`k3s ctr images prune`)
- [ ] Set up automated PostgreSQL backups (CronJob, same as current `pg-backup`)
- [ ] Configure Cloudflare proxy (orange cloud) for DDoS protection
- [ ] Enable cloud provider backups (recommended — ₹ extra)
- [ ] Update Vault `VAULT_ADDR` in all ExternalSecrets
- [ ] Update `.ssh/config` on your local machine with new IP
- [ ] Test mail delivery (port 25 — check if cloud provider blocks it)
- [ ] Monitor resource usage for 1 week before adding Lago billing stack
- [ ] Decommission old home lab nodes after 1 week stable

---

## 7. Cost Summary

| Item | Monthly Cost |
|------|-------------|
| Cloud node (8 vCPU / 16 GB / 150 GB) | ₹4,453 (on-demand) |
| Cloud node (36-month committed) | ₹2,672 (40% off) |
| Hetzner mail server (existing) | ~€4.5 (~₹420) |
| Cloudflare (free plan) | ₹0 |
| Domain renewals (annual, amortized) | ~₹200 |
| **Total (on-demand)** | **~₹5,073/month** |
| **Total (36-month committed)** | **~₹3,292/month** |

### Resource Headroom
- **RAM**: 1.3 GB used / 16 GB available = 81% free
- **CPU**: 8 vCPU, current usage ~1 core = 87% free
- **Disk**: ~30 GB data / 150 GB = 80% free
- Room to add Lago, Larun SE, Woodpecker CI, and 10+ more tenant apps

---

## 8. Timeline

| Day | Task | Duration | Risk |
|-----|------|----------|------|
| Day 0 (prep) | Backup all data, lower DNS TTL, provision cloud node | 2 hours | Low |
| Day 1 (morning) | Install K3s, transfer data + images | 3 hours | Low |
| Day 1 (afternoon) | Deploy core services, restore databases | 2 hours | Medium |
| Day 1 (evening) | Deploy apps, configure TLS | 1.5 hours | Low |
| Day 2 (morning) | DNS cutover, full verification | 1 hour | Low |
| Day 2–9 | Parallel monitoring, old cluster as fallback | ongoing | None |
| Day 10 | Decommission old cluster | 30 min | None |

**Total estimated downtime: 5–15 minutes** (during DNS propagation)

---

## 9. Recommendation on Provider Plan

You showed the **C3 (CPU Intensive 3rd Gen)** plan:
- 8 vCPU / 16 GB / 150 GB SSD — ₹4,453/month

**This is a good fit.** Your workload is mostly web apps (Next.js SSR), not memory-heavy databases. The 16 GB gives 12x headroom over current usage. 150 GB SSD is tight if MinIO grows — consider attaching an extra volume later.

**Committed plan recommendation**: Start with **3-month committed (₹11,858 = ₹3,953/month)** to test stability. Switch to 36-month (₹2,672/month) once confirmed.

**Alternative**: If you want to save more, the **E1 (Extensive)** plan with 4 vCPU / 8 GB at ~₹2,200/month would still work for your current load (3.1 GB used), but leaves less headroom for growth.
