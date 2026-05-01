# Tinai Maintenance Suite

7 maintenance automations covering certs, backups, image updates, storage, secrets, self-healing, and log rotation.

## Services & Schedule

| Service | Type | Schedule | Action |
|---|---|---|---|
| `cert-renewal` | CronJob | Daily 05:00 | Monitor cert-manager certs, alert on expiry |
| `db-backup` | CronJob | Daily 02:00 | pgBackRest full backup → MinIO |
| `db-backup/verify` | CronJob | Sunday 03:00 | Restore to temp pod, verify tables |
| `image-updater` | CronJob | Daily 04:00 | Scan Harbor, open Gitea issues for updates |
| `storage-cleanup` | CronJob | Sunday 04:00 | Tag orphaned PVCs, delete after 7-day grace |
| `secret-rotation` | CronJob | Monthly 1st 01:00 | Rotate DB creds via Vault, restart pods |
| `log-rotation` | CronJob | Sunday 02:00 | Archive Loki logs → MinIO cold storage |
| `self-healing` | Deployment | Every 5 min | Fix crashloops, cordon pressure nodes, clean evicted pods |

## Setup

```bash
kubectl create secret generic maintenance-secrets \
  --from-literal=SMTP_USER=ops@tinai.cloud \
  --from-literal=SMTP_PASS=your-stalwart-pass \
  --from-literal=ADMIN_EMAIL=padmanaban@tinai.cloud \
  --from-literal=HARBOR_USER=admin \
  --from-literal=HARBOR_PASS=your-harbor-pass \
  --from-literal=GITEA_TOKEN=your-gitea-token \
  --from-literal=VAULT_TOKEN=your-vault-token \
  --from-literal=MINIO_ACCESS_KEY=your-minio-key \
  --from-literal=MINIO_SECRET_KEY=your-minio-secret \
  -n maintenance

kubectl apply -f k8s/maintenance.yaml
```

## Key design decisions

**cert-renewal** — cert-manager does the actual renewal; this adds alerting and daily digest.

**db-backup** — Uses pgBackRest via `kubectl exec` into the postgres pod. WAL archiving is continuous (configured in pgBackRest); this triggers scheduled base backups. Weekly verify job actually restores and queries the DB — the only real proof backups work.

**image-updater** — Opens Gitea issues (not auto-merges) for image updates. You review and merge; Woodpecker CI builds and deploys. Semi-automated by design for production safety.

**storage-cleanup** — Never deletes immediately. Tags orphaned PVCs with timestamp annotation; deletes only after `ORPHAN_GRACE_DAYS` (default 7). Set `DRY_RUN=true` to audit without deleting.

**secret-rotation** — `backoffLimit: 0` — never retries on failure. A partial rotation is worse than no rotation. Fix the issue and re-run manually.

**self-healing** — Supplements K8s built-in restart policy. Handles: CrashLoopBackOff force-delete (resets exponential backoff), node pressure cordoning, evicted pod cleanup, long-pending pod alerts.

**log-rotation** — Loki retention handles deletion automatically. This adds archival to MinIO before deletion (compliance) and weekly volume stats.

## TODOs for Claude Code

- [ ] `secret-rotation/index.js` — implement `verifyDBCredentials()` with real `pg` connection
- [ ] `log-rotation/index.js` — implement `buildMinIOAuth()` with AWS Signature V4 (or use `@aws-sdk/client-s3`)
- [ ] `image-updater/index.js` — test `getLatestTag()` against your Harbor registry tag format
- [ ] `db-backup/verify.js` — configure `backup-verify` namespace with a restore-ready PostgreSQL pod

## Automation scorecard

**Completed: 17/28**
- Billing chain:    5 ✅
- Reporting suite:  5 ✅  
- Maintenance:      7 ✅
- Operations:       0 / 7 → next batch
- Security:         0 / 4 → final batch
