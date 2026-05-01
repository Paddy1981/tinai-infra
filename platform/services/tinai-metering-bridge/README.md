# Tinai Metering Bridge

Collects per-tenant resource usage from Prometheus every 15 minutes and
forwards it to the Lago billing engine as structured usage events.

```
Prometheus ──→ Collector ──→ Transformer ──→ Lago API
                                    │
                                    └──→ NATS audit/DLQ
```

## Architecture

| File | Purpose |
|---|---|
| `src/index.js` | Entry point, scheduler, graceful shutdown |
| `src/metering-runner.js` | Orchestrates one full collection cycle |
| `src/collectors/prometheus.js` | Queries Prometheus for per-namespace metrics |
| `src/transformers/lago.js` | Converts metrics → Lago event format |
| `src/publishers/lago.js` | Posts events to Lago with retry + DLQ |
| `src/health/server.js` | Fastify HTTP health/metrics server |
| `config/index.js` | All configuration from env vars |

## Lago Setup (do this first)

Before deploying, create these billable metrics in Lago UI:

| Code | Name | Aggregation | Unit |
|---|---|---|---|
| `compute_seconds` | Compute (CPU seconds) | SUM | seconds |
| `memory_gb_seconds` | Memory (GB·seconds) | SUM | GB·s |
| `storage_gb_hours` | Storage (GB·hours) | SUM | GB·h |
| `egress_bytes` | Network egress | SUM | bytes |
| `build_seconds` | Build time | SUM | seconds |

Then create a **Plan** in Lago that references these metrics as
**Usage Charges** with your pricing per unit.

Each tenant needs a **Subscription** in Lago with:
- `external_customer_id` matching your tenant ID
- `external_id` matching `{tenant-namespace-without-prefix}`
  e.g. namespace `tenant-acme-corp` → `external_id: acme-corp`

## Local Development

```bash
# Install
npm install

# Copy env
cp .env.example .env
# Edit .env with your values

# Port-forward cluster services (in separate terminals)
kubectl port-forward svc/prometheus-server 9090:9090 -n monitoring
kubectl port-forward svc/lago-api 3000:3000 -n billing
kubectl port-forward svc/nats 4222:4222 -n core

# Start (with file watching)
npm run dev

# Check health
curl http://localhost:3100/health | jq
curl http://localhost:3100/metrics | jq

# Trigger manual run
curl -X POST http://localhost:3100/run \
  -H "x-admin-token: dev-token-unsafe"
```

## Running Tests

```bash
npm test
```

## Deploying to K3s

```bash
# Create the secret first
kubectl create secret generic metering-bridge-secrets \
  --from-literal=LAGO_API_KEY=your-lago-api-key \
  --from-literal=ADMIN_TOKEN=your-admin-token \
  -n billing

# Apply manifests
kubectl apply -f k8s/metering-bridge.yaml

# Watch rollout
kubectl rollout status deployment/metering-bridge -n billing

# Check logs
kubectl logs -f deployment/metering-bridge -n billing
```

## Operational Runbook

### Checking last run result
```bash
curl http://metering-bridge.billing.svc.cluster.local:3100/metrics | jq .lastRun
```

### Triggering a catch-up run after downtime
```bash
# Set METERING_LOOKBACK_MS env var to cover the downtime period
# then restart the pod — it will collect from lookback on startup
kubectl rollout restart deployment/metering-bridge -n billing
```

### Investigating DLQ events
```bash
# Subscribe to DLQ subject in NATS
nats sub tinai.metering.dlq --server nats://nats.core.svc.cluster.local:4222
```

### Checking Lago received events
```bash
# List events via Lago API
curl https://lago.tinai.cloud/api/v1/events \
  -H "Authorization: Bearer $LAGO_API_KEY" | jq '.events[] | {code, timestamp, value: .properties.value}'
```

## Idempotency

The bridge is safe to run multiple times for the same window.
`transaction_id` is deterministic: `sha256(namespace:metricCode:windowStart:windowEnd)`.
Lago will deduplicate on `transaction_id` and ignore duplicate submissions.

## Scaling

Run **exactly 1 replica**. Multiple replicas would submit duplicate events.
The K8s Deployment uses `strategy: Recreate` to prevent overlap during rollouts.
