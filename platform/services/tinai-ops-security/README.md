# Tinai Ops & Security Suite

11 automations covering the full operations and security surface area.

## Services

| # | Service | Type | Trigger/Schedule |
|---|---|---|---|
| 18 | `namespace-provisioner` | Deployment | POST /provision from Control Plane |
| 19 | `build-deploy` | Deployment | Gitea webhook on git push |
| 20 | `rollback-controller` | Deployment | NATS: tinai.build.success |
| 21 | `hpa-scaler` | Deployment + CronJob | NATS: provisioned + daily reconcile |
| 22 | `incident-alerting` | Deployment | Alertmanager webhook |
| 23 | `dlq-monitor` | Deployment | NATS DLQ subscriptions |
| 24 | `onboarding-sequence` | Deployment | NATS: tinai.tenant.provisioned |
| 25 | `cve-scanner` | CronJob | Weekly Sunday 03:00 |
| 26 | `network-policy` | CronJob | Daily 05:30 |
| 27 | `egress-anomaly` | Deployment | Every 5 min poll |
| 28 | `audit-log-export` | CronJob | Daily 01:00 |

## Setup

```bash
kubectl create secret generic ops-secrets \
  --from-literal=SMTP_USER=ops@tinai.cloud \
  --from-literal=SMTP_PASS=your-stalwart-pass \
  --from-literal=ADMIN_EMAIL=padmanaban@tinai.cloud \
  --from-literal=ADMIN_TOKEN=your-admin-token \
  --from-literal=LAGO_API_KEY=your-lago-key \
  --from-literal=HARBOR_PASS=your-harbor-pass \
  --from-literal=GITEA_TOKEN=your-gitea-token \
  --from-literal=GITEA_WEBHOOK_SECRET=your-webhook-secret \
  --from-literal=VAULT_TOKEN=your-vault-token \
  --from-literal=PAGERDUTY_KEY=your-pd-key \
  --from-literal=MINIO_ACCESS_KEY=your-minio-key \
  --from-literal=MINIO_SECRET_KEY=your-minio-secret \
  -n ops

kubectl apply -f k8s/ops-security.yaml
```

## NATS event map (full platform)

```
tinai.tenant.signup              → namespace-provisioner
tinai.tenant.provisioned         → onboarding-sequence, hpa-scaler
tinai.build.started              → (dashboard display)
tinai.build.success              → rollback-controller
tinai.build.failed               → (dashboard display)
tinai.ops.deployment.stable      → (dashboard display)
tinai.ops.deployment.rollback    → (ops alert)
tinai.ops.alert                  → (dashboard display)
tinai.billing.invoice.finalized  → mrr-dashboard
tinai.billing.payment.success    → mrr-dashboard
tinai.billing.payment.failed     → ops-dashboard
tinai.tenant.trial.expired       → ops-dashboard
tinai.tenant.plan.changed        → mrr-dashboard
tinai.tenant.namespace.suspended → ops-dashboard
tinai.security.egress.anomaly    → ops-dashboard
tinai.security.cve.scan          → ops-dashboard
tinai.*.dlq                      → dlq-monitor
tinai.*.audit                    → compliance-reporter
```

## ✅ COMPLETE AUTOMATION SCORECARD — 28/28

### Billing (5/5)
- [x] 1. Usage metering bridge
- [x] 2. Auto invoice generation
- [x] 3. Payment collection & retry
- [x] 4. Trial expiry lifecycle
- [x] 5. Plan upgrade/downgrade

### Reporting (5/5)
- [x] 6. Monthly usage report
- [x] 7. Data residency compliance report
- [x] 8. Platform health digest
- [x] 9. MRR & churn dashboard
- [x] 10. GST filing data export

### Maintenance (7/7)
- [x] 11. TLS cert renewal monitor
- [x] 12. Database backup + weekly verify
- [x] 13. Container image updater
- [x] 14. Orphaned storage cleanup
- [x] 15. Secret rotation via Vault
- [x] 16. Log rotation + MinIO archival
- [x] 17. Self-healing monitor

### Operations (7/7)
- [x] 18. Tenant namespace provisioner
- [x] 19. Build & deploy pipeline
- [x] 20. Deployment rollback controller
- [x] 21. HPA + KEDA autoscaling
- [x] 22. Incident alerting (P1/P2/P3)
- [x] 23. NATS DLQ monitor + replay
- [x] 24. Tenant onboarding sequence

### Security (4/4)
- [x] 25. CVE scanning (Trivy)
- [x] 26. Network policy enforcement
- [x] 27. Egress anomaly detection
- [x] 28. Audit log export → MinIO
