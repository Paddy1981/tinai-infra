# TinAI Forge — API Integration Reference

> **Base URL (via tinai-api proxy):** `https://api.tinai.cloud/api/v1/forge`
> **Base URL (direct, internal only):** `http://tinai-forge-svc.tinai-forge.svc.cluster.local:8080/api/forge`
>
> All external calls require: `Authorization: Bearer <jwt>`
> All internal calls require: `X-Forge-API-Key: <forge-api-key>`

---

## Authentication

### External (Dashboard / CLI)

Calls go through tinai-api which handles JWT validation, then proxies to forge with the API key:

```
Client → (JWT) → tinai-api → (X-Forge-API-Key) → tinai-forge
```

```http
GET /api/v1/forge/summary
Authorization: Bearer eyJhbGciOiJIUzI1NiJ9...
```

### Internal (Service-to-Service)

Direct calls from within the cluster skip tinai-api:

```http
GET /api/forge/products
X-Forge-API-Key: a3f8d2c1...
```

### Callback Endpoints (JWT-Exempt)

tinai-forge calls these on tinai-api. They are whitelisted from JWT validation but still require API key:

```
POST /api/v1/forge/callbacks/build-complete
POST /api/v1/forge/callbacks/rollout-complete
X-Forge-API-Key: <forge-api-key>
```

---

## Endpoints

### GET /api/forge/summary

High-level status summary. Used by Dashboard home widget and CLI `tinai forge status`.

**Response:**
```json
{
  "total_products": 11,
  "up_to_date": 9,
  "updates_available": 2,
  "builds_in_progress": 0,
  "rollouts_in_progress": 1,
  "last_check": "2026-03-25T06:00:00Z"
}
```

**Graceful degradation** (when forge unreachable, tinai-api returns):
```json
{
  "forge_status": "not_deployed",
  "message": "Forge service is not available"
}
```

---

### GET /api/forge/products

List all tracked products with version status.

**Response:**
```json
[
  {
    "id": "forgejo",
    "name": "forgejo",
    "repo": "forgejo/forgejo",
    "current_version": "v1.22.6",
    "latest_version": "v1.22.7",
    "status": "update_available",
    "last_checked_at": "2026-03-25T06:00:00Z"
  },
  {
    "id": "grafana",
    "name": "grafana",
    "repo": "grafana/grafana",
    "current_version": "v11.3.0",
    "latest_version": "v11.3.0",
    "status": "up_to_date",
    "last_checked_at": "2026-03-25T06:00:00Z"
  }
]
```

---

### POST /api/forge/products/:id/check

Force an immediate upstream version check for one product.

```http
POST /api/forge/products/forgejo/check
```

**Response:**
```json
{
  "product": "forgejo",
  "previous_version": "v1.22.6",
  "latest_version": "v1.22.7",
  "update_available": true,
  "upgrade_type": "patch"
}
```

---

### POST /api/forge/products/:id/build

Trigger a brand patch build for a product. Creates a Kaniko K8s Job.

```http
POST /api/forge/products/forgejo/build
Content-Type: application/json

{}
```

**Response:**
```json
{
  "build_id": "b-42",
  "product": "forgejo",
  "version": "v1.22.7",
  "job_name": "forge-build-forgejo-v1.22.7",
  "status": "queued",
  "image": "registry.e2enetworks.net/tinai/forgejo:v1.22.7-tinai"
}
```

---

### GET /api/forge/builds

List recent build history.

**Query params:**
- `?limit=20` — number of results (default: 20, max: 100)
- `?product=forgejo` — filter by product
- `?status=failed` — filter by status: `queued` | `building` | `success` | `failed`

**Response:**
```json
[
  {
    "id": "b-42",
    "product_id": "forgejo",
    "version": "v1.22.7",
    "status": "success",
    "image": "registry.e2enetworks.net/tinai/forgejo:v1.22.7-tinai",
    "started_at": "2026-03-25T08:00:00Z",
    "finished_at": "2026-03-25T08:08:32Z",
    "duration_seconds": 512,
    "cts_passed": true,
    "log_url": "/api/forge/builds/b-42/logs"
  }
]
```

---

### GET /api/forge/builds/:id/logs

Get build logs for a specific build.

```http
GET /api/forge/builds/b-42/logs
```

**Response:**
```json
{
  "build_id": "b-42",
  "logs": "INFO[0000] Unpacking rootfs...\nINFO[0004] FROM codeberg.org/forgejo/forgejo:1.22.7 AS upstream\n..."
}
```

---

### POST /api/forge/rollouts

Start a rollout for a product.

```http
POST /api/forge/rollouts
Content-Type: application/json

{
  "product_id": "forgejo",
  "strategy": "auto"
}
```

**Strategy values:** `auto` | `bigbang` | `rolling` | `canary`

**Response:**
```json
{
  "rollout_id": "r-17",
  "product_id": "forgejo",
  "from_version": "v1.22.6",
  "to_version": "v1.22.7",
  "strategy": "rolling",
  "status": "in_progress",
  "total_tenants": 47,
  "completed_tenants": 0,
  "started_at": "2026-03-25T10:00:00Z"
}
```

---

### GET /api/forge/rollouts

List rollout history.

**Query params:**
- `?active=true` — only show in-progress rollouts
- `?product=forgejo` — filter by product
- `?limit=10` — number of results

---

### GET /api/forge/rollouts/:id

Get detailed rollout status including per-tenant progress.

**Response:**
```json
{
  "rollout_id": "r-17",
  "product_id": "forgejo",
  "from_version": "v1.22.6",
  "to_version": "v1.22.7",
  "strategy": "rolling",
  "status": "in_progress",
  "total_tenants": 47,
  "completed_tenants": 23,
  "failed_tenants": 0,
  "started_at": "2026-03-25T10:00:00Z",
  "tenant_statuses": [
    {"tenant_id": "tenant-alpha", "status": "updated", "updated_at": "2026-03-25T10:02:14Z"},
    {"tenant_id": "tenant-beta", "status": "updating"},
    {"tenant_id": "tenant-gamma", "status": "pending"}
  ]
}
```

---

### POST /api/forge/rollouts/:id/pause

Pause an in-progress rollout.

```http
POST /api/forge/rollouts/r-17/pause
```

**Response:** `{"rollout_id": "r-17", "status": "paused"}`

---

### POST /api/forge/rollouts/:id/resume

Resume a paused rollout.

```http
POST /api/forge/rollouts/r-17/resume
```

---

### POST /api/forge/rollouts/:id/rollback

Roll back all updated tenants to previous version.

```http
POST /api/forge/rollouts/r-17/rollback
```

**Response:**
```json
{
  "rollout_id": "r-17",
  "status": "rolling_back",
  "tenants_to_rollback": 23
}
```

---

### POST /api/forge/tenants/register

Register a new tenant in forge (called by provisioner, not operators directly).

```http
POST /api/forge/tenants/register
X-Forge-API-Key: <forge-api-key>
Content-Type: application/json

{
  "tenant_id": "tenant-new",
  "namespace": "tenant-new",
  "plan": "starter"
}
```

**Response:**
```json
{
  "tenant_id": "tenant-new",
  "products_registered": 11,
  "message": "Tenant registered for all forge products"
}
```

---

### GET /api/forge/tenants

List all registered tenants and their version status.

**Response:**
```json
[
  {
    "tenant_id": "tenant-alpha",
    "products": [
      {"product_id": "forgejo", "current_version": "v1.22.7", "status": "up_to_date"},
      {"product_id": "grafana", "current_version": "v11.3.0", "status": "up_to_date"}
    ]
  }
]
```

---

### GET /healthz

Health check endpoint (no auth required).

```http
GET /healthz
```

**Response (200):**
```json
{"status": "ok", "service": "tinai-forge"}
```

---

## Callback Endpoints (forge → tinai-api)

These are called BY forge, not by operators. Documented for completeness.

### POST /api/v1/forge/callbacks/build-complete

```json
{
  "build_id": "b-42",
  "product": "forgejo",
  "version": "v1.22.7",
  "status": "success",
  "image": "registry.e2enetworks.net/tinai/forgejo:v1.22.7-tinai",
  "cts_passed": true,
  "duration_seconds": 512
}
```

tinai-api writes this to the `audit_log` table and can trigger notifications.

### POST /api/v1/forge/callbacks/rollout-complete

```json
{
  "rollout_id": "r-17",
  "product": "forgejo",
  "from_version": "v1.22.6",
  "to_version": "v1.22.7",
  "status": "completed",
  "tenants_updated": 47,
  "tenants_failed": 0,
  "duration_seconds": 840
}
```

---

## Error Responses

All endpoints return standard error format:

```json
{
  "error": "build not found",
  "code": "NOT_FOUND"
}
```

| HTTP Status | Meaning |
|---|---|
| 200 | Success |
| 201 | Created (new build/rollout) |
| 400 | Bad request (invalid product, missing fields) |
| 401 | Missing or invalid API key / JWT |
| 404 | Product / build / rollout not found |
| 409 | Conflict (build already in progress, rollout already active) |
| 503 | Forge service unavailable (tinai-api graceful degradation) |

---

## SDK Usage (tinai-cli client.go)

If you need to add new forge endpoints to the CLI, follow this pattern from `tinai-cli/internal/api/client.go`:

```go
// ForgeCheckProduct forces an upstream version check for one product
func (c *Client) ForgeCheckProduct(productID string) (*ForgeProduct, error) {
    var result ForgeProduct
    err := c.post(fmt.Sprintf("/api/v1/forge/products/%s/check", productID), nil, &result)
    return &result, err
}

// The generic post() helper handles JWT auth header automatically
func (c *Client) post(path string, body interface{}, result interface{}) error {
    // JWT set in c.token, applied to all requests
    // Returns unmarshalled JSON into result
}
```

All forge types (`ForgeProduct`, `ForgeBuild`, `ForgeRollout`, etc.) are defined in `client.go`.
