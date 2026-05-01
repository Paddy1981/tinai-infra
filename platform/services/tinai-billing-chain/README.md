# Tinai Billing Chain

Four services that complete the billing automation pipeline after the metering bridge.

## Services

| Service | Type | Port | Trigger |
|---|---|---|---|
| `invoice-generator` | Deployment | 3101 | Lago webhook → PDF → email |
| `payment-webhook` | Deployment | 3102 | Razorpay / Stripe webhooks |
| `trial-lifecycle` | CronJob | — | Every 6h — checks all trial tenants |
| `plan-handler` | Deployment | 3103 | Control Plane API call |

## Full Billing Flow

```
Prometheus
  → metering-bridge           [every 15 min]
      → Lago (usage events)
          → Lago generates invoice
              → invoice-generator [Lago webhook]
                  → PDF generated
                  → Email sent to tenant
                  → NATS: tinai.billing.invoice.finalized

Razorpay/Stripe
  → payment-webhook
      → On success: receipt email + NATS event
      → On failure: retry emails → suspend namespace after 3 days

K8s CronJob (every 6h)
  → trial-lifecycle
      → Day 7/13: warning emails
      → Day 14: suspend namespace
      → Day 25: deletion warning
      → Day 30: delete namespace

Control Plane API
  → plan-handler
      → K8s ResourceQuota updated
      → Lago plan switched
      → Confirmation email
```

## Setup

### 1. Create secrets

```bash
kubectl create secret generic billing-chain-secrets \
  --from-literal=LAGO_API_KEY=your-lago-key \
  --from-literal=LAGO_WEBHOOK_SECRET=your-lago-webhook-secret \
  --from-literal=RAZORPAY_KEY_ID=rzp_live_xxx \
  --from-literal=RAZORPAY_KEY_SECRET=your-rzp-secret \
  --from-literal=RAZORPAY_WEBHOOK_SECRET=your-rzp-webhook-secret \
  --from-literal=STRIPE_SECRET_KEY=sk_live_xxx \
  --from-literal=STRIPE_WEBHOOK_SECRET=whsec_xxx \
  --from-literal=SMTP_USER=billing@tinai.cloud \
  --from-literal=SMTP_PASS=your-stalwart-smtp-pass \
  --from-literal=COMPANY_GSTIN=your-gstin \
  --from-literal=ADMIN_TOKEN=your-admin-token \
  --from-literal=DATABASE_URL=postgresql://... \
  -n billing
```

### 2. Deploy

```bash
kubectl apply -f k8s/billing-chain.yaml
kubectl rollout status deployment/invoice-generator -n billing
kubectl rollout status deployment/payment-webhook -n billing
kubectl rollout status deployment/plan-handler -n billing
```

### 3. Configure Lago webhook

In Lago UI → Settings → Webhooks:
- URL: `https://api.tinai.cloud/webhooks/lago`
- Events: `invoice.created`, `invoice.finalized`

### 4. Configure Razorpay webhook

In Razorpay Dashboard → Settings → Webhooks:
- URL: `https://api.tinai.cloud/webhooks/razorpay`
- Events: `subscription.charged`, `payment.failed`

### 5. Configure Stripe webhook (for Qatar/UAE tenants)

```bash
stripe listen --forward-to https://api.tinai.cloud/webhooks/stripe
```

Or in Stripe Dashboard → Developers → Webhooks.

## TODO before production

- [ ] Implement `fetchTenantEmail()` in `payment-webhook/src/index.js` (PostgreSQL query)
- [ ] Implement `fetchTrialTenants()` in `trial-lifecycle/src/index.js` (PostgreSQL query)
- [ ] Implement `updateTenantState()` in `trial-lifecycle/src/index.js`
- [ ] Move retry state from in-memory Map to Redis/PostgreSQL in payment-webhook
- [ ] Add Lago customer `external_id` → tenant email mapping to your tenants table

## NATS event reference

| Subject | Published by | Consumed by |
|---|---|---|
| `tinai.billing.invoice.finalized` | invoice-generator | MRR dashboard, compliance reporter |
| `tinai.billing.payment.success` | payment-webhook | MRR dashboard |
| `tinai.billing.payment.failed` | payment-webhook | Alertmanager, ops dashboard |
| `tinai.tenant.trial.expired` | trial-lifecycle | Ops dashboard |
| `tinai.tenant.plan.changed` | plan-handler | MRR dashboard |
| `tinai.tenant.namespace.suspended` | payment-webhook, trial-lifecycle | Ops dashboard |
| `tinai.billing.dlq` | all services | DLQ monitor (automation #23) |
| `tinai.billing.audit` | all services | Compliance reporter (automation #7) |
