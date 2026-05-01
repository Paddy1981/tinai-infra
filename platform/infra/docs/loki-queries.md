# Tinai Loki LogQL Reference

All tinai.cloud services ship logs via Promtail with `tenant_id`, `service`,
`level`, `platform`, `namespace`, `pod`, and `container` labels extracted.

---

## Query by tenant

```logql
{tenant_id="acme-corp"} |= ""
```

## All errors for a specific tenant

```logql
{tenant_id="acme-corp", level="error"} |= ""
```

## Function invocations for a tenant

```logql
{service="functions", tenant_id="acme-corp"} |= "invoked"
```

## Build failures across all tenants (last 1h)

```logql
{service="build-api"} |= "failed" | logfmt | level="error"
```

## Gateway API calls by tenant (rate)

```logql
sum by (tenant_id) (rate({service="gateway"}[5m]))
```

## Realtime WebSocket connections

```logql
{service="realtime"} |= "connected" | logfmt | tenant_id != ""
```

## All logs for a specific platform

```logql
{platform="tinai.cloud"} |= ""
```

## Logs for a specific pod

```logql
{pod="tinai-gateway-7d9f4b-xkqrz"} |= ""
```

## Top tenants by log volume (last 1h)

```logql
topk(10, sum by (tenant_id) (count_over_time({platform="tinai.cloud"}[1h])))
```

## Gateway quota exceeded events

```logql
{service="gateway"} |= "quota" |= "exceeded"
```

## Auth service failures by tenant

```logql
{service="auth", level="error"} | logfmt | tenant_id != ""
```

## Build-api — count builds per tenant (last 24h)

```logql
sum by (tenant_id) (count_over_time({service="build-api"} |= "build started" [24h]))
```

## Realtime hub — NATS publish errors

```logql
{service="realtime"} |= "nats publish error"
```

## Debug logs dropped counter (verify drop stage is working)

```logql
{__name__="promtail_custom_debug_dropped_total"}
```

---

## Label reference

| Label       | Source                                    | Example value         |
|-------------|-------------------------------------------|-----------------------|
| tenant_id   | Extracted from log line (regex/JSON)      | acme-corp             |
| service     | Derived from pod app label                | gateway, functions, realtime, build-api, auth |
| level       | Extracted from log line (regex/JSON)      | info, error, warn     |
| platform    | Static label added by Promtail            | tinai.cloud           |
| namespace   | Kubernetes pod namespace                  | tinai-production      |
| pod         | Kubernetes pod name                       | tinai-gateway-abc123  |
| container   | Kubernetes container name                 | tinai-gateway         |

---

## Notes

- The `tinai-services` Promtail scrape job targets all pods in namespaces
  matching `tinai.*`. The generic `kubernetes-pods` job remains as a catch-all
  for non-tinai workloads.
- Tenant extraction uses three strategies in order: JSON field `tenant_id`,
  key=value / colon format regex, and bracket format `[tenant:...]` regex.
  The first non-empty match wins because Promtail skips overwriting an already
  extracted label.
- Debug-level lines are dropped before ingestion to reduce Loki storage costs.
  The drop counter `debug_dropped` is exposed as a Promtail metric.
- Realtime hub channel names use the format `tenant:acme-corp:channel` — the
  regex `tenant[=:\s]+` will match the channel segment when it appears in a
  log line containing the channel name.
