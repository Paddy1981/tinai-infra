# Tinai Reporting Suite

Five reporting automations covering usage, compliance, GST filing, and business metrics.

## Services & Schedule

| Service | Type | Schedule / Trigger | Port |
|---|---|---|---|
| `usage-report` | CronJob | 1st of month, 06:00 | — |
| `compliance-report` | CronJob + Deployment | Quarterly + on-demand | 3201 |
| `gst-export` | CronJob | 5th of month, 07:00 | — |
| `mrr-dashboard` | Deployment | Always-on API | 3202 |
| `daily-digest` | CronJob | Daily 07:00 (Qatar) | — |

## What each service generates

### usage-report
Monthly PDF per tenant showing: compute (core·hours), memory (GB·hours),
storage (GB·hours), egress (GB), build time. Cost breakdown + invoice reference.
Emailed automatically on 1st of month.

### compliance-report
Quarterly PDF certifying data residency under:
- India: DPDP Act 2023
- Qatar: PDPPL Law No. 13/2016  
- UAE: Federal Decree-Law No. 45/2021

Evidence: K8s node topology + Prometheus egress metrics.
Emailed quarterly. On-demand via `POST /compliance-report/:tenantId`.

### gst-export
GSTR-1 compatible CSV of all INR invoices from previous month.
Emailed to you on 5th for CA submission (due 11th).
Columns: GSTIN, Invoice No/Date, Value, IGST/CGST/SGST, HSN/SAC.

### mrr-dashboard
REST API serving live business metrics from Lago analytics:
- `GET /api/summary` — all metrics in one call
- `GET /api/mrr`     — MRR + trend (12 months)
- `GET /api/revenue` — gross revenue by month
- `GET /api/tenants` — active, trial, churn counts
- `GET /api/arpu`    — average revenue per user

30-minute in-memory cache. Force refresh with `?refresh=true`.

### daily-digest
07:00 Qatar time email to you: MRR, active tenants, ARPU, churn.
Triggered by a CronJob that POSTs to the MRR dashboard service.

## Setup

```bash
# Create secrets
kubectl create secret generic reporting-secrets \
  --from-literal=LAGO_API_KEY=your-lago-key \
  --from-literal=SMTP_USER=billing@tinai.cloud \
  --from-literal=SMTP_PASS=your-stalwart-pass \
  --from-literal=COMPANY_GSTIN=your-gstin \
  --from-literal=ADMIN_TOKEN=your-admin-token \
  --from-literal=ADMIN_EMAIL=padmanaban@tinai.cloud \
  --from-literal=DATABASE_URL=postgresql://... \
  -n reporting

# Deploy
kubectl apply -f k8s/reporting.yaml

# Test MRR API
curl https://api.tinai.cloud/api/summary \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq

# Trigger on-demand compliance report
curl -X POST https://api.tinai.cloud/compliance-report/acme-corp \
  -H "x-admin-token: $ADMIN_TOKEN" \
  -H "Accept: application/pdf" \
  -o compliance-acme.pdf
```

## Automation score after this batch

| # | Automation | Status |
|---|---|---|
| 1 | Usage metering bridge | ✅ Built |
| 2 | Auto invoice generation | ✅ Built |
| 3 | Payment collection & retry | ✅ Built |
| 4 | Trial expiry lifecycle | ✅ Built |
| 5 | Plan upgrade/downgrade | ✅ Built |
| 6 | Monthly usage report | ✅ Built |
| 7 | Data residency compliance report | ✅ Built |
| 8 | Platform health digest | ✅ Built (daily-digest) |
| 9 | MRR & churn dashboard | ✅ Built |
| 10 | GST filing data export | ✅ Built |
| 11–28 | Maintenance, ops, security | Next batch |

## Shared modules

All services share `shared/`:
- `config.js`     — all env vars
- `lago.js`       — Lago REST API client
- `nats.js`       — NATS publish helpers
- `mailer.js`     — Stalwart SMTP sender
- `pdf-base.js`   — PDF layout utilities
- `prometheus.js` — Prometheus query helpers
