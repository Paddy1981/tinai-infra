# TinAI CLI — Forge Command Reference

> `tinai forge <command> [flags]`
> All commands require a valid JWT session (`tinai login` first).
> Forge commands proxy through `tinai-api → tinai-forge`.

---

## Global Flags

| Flag | Default | Description |
|---|---|---|
| `--output json` | table | Output format: `table` or `json` |
| `--quiet` | false | Suppress progress output |

---

## `tinai forge status`

Show the current version matrix for all 11 platform products.

```bash
tinai forge status
tinai forge status --output json
```

**Output columns:**
- **PRODUCT** — TinAI brand name (e.g., "TinAI Repos" not "Forgejo")
- **CURRENT** — Version currently deployed across tenants
- **LATEST** — Latest upstream version detected by forge scheduler
- **STATUS** — `✓` up-to-date | `UPDATE` available | `BUILDING` | `ROLLING_OUT` | `FAILED`
- **LAST CHECKED** — When forge last queried GitHub

**When to use:** Every morning, and before starting any build/rollout.

---

## `tinai forge check [product]`

Force an immediate upstream version check (bypasses scheduler interval).

```bash
tinai forge check             # check all 11 products
tinai forge check forgejo     # check one product
tinai forge check grafana
```

**When to use:**
- You saw a GitHub release notification and want forge to pick it up immediately
- After adding a new product to `DefaultProducts`
- Debugging "why isn't forge seeing the new version?"

**Note:** GitHub API rate limit applies. With a token (5000/hr), you can run this freely. Without a token (60/hr), use sparingly.

---

## `tinai forge build <product>`

Trigger a brand patch build for a specific product. Creates a Kaniko K8s Job.

```bash
tinai forge build forgejo
tinai forge build grafana
tinai forge build woodpecker
```

**What happens:**
1. Forge creates `forge-build-<product>-<version>` Job in `tinai-forge` namespace
2. Kaniko builds from `patches/<product>/Dockerfile`
3. Pushes `registry.e2enetworks.net/tinai/<product>:<version>-tinai`
4. CTS tests run automatically after build

**Expected duration:** 5–15 minutes (depends on image size and registry speed)

**Best practice:** Always run `tinai forge builds` to monitor, don't assume it succeeded.

---

## `tinai forge builds`

List recent build history with status.

```bash
tinai forge builds
tinai forge builds --output json
```

**Output:**
```
ID    PRODUCT     VERSION   STATUS    STARTED         DURATION
b-42  forgejo     v1.22.7   success   10 min ago      8m 32s
b-41  grafana     v11.4.0   building  2 min ago       -
b-40  woodpecker  v2.8.0    failed    1 hour ago      3m 11s
```

**When to use:** After triggering a build, check this every 2–3 minutes until `success`.

**If build shows `failed`:**
```bash
# Check Kaniko job logs
kubectl logs -n tinai-forge -l job-name=forge-build-<product>-<version>
```

---

## `tinai forge rollout start <product>`

Start a rollout of the latest built image to all tenant namespaces.

```bash
tinai forge rollout start forgejo
tinai forge rollout start forgejo --strategy=canary
tinai forge rollout start forgejo --strategy=rolling
tinai forge rollout start forgejo --strategy=bigbang
```

**Flags:**
| Flag | Default | Description |
|---|---|---|
| `--strategy` | auto | `auto` \| `bigbang` \| `rolling` \| `canary` |
| `--dry-run` | false | Show what would happen without doing it |

**Auto strategy selection:**
- `< 10 tenants` → bigbang
- `10–100 tenants` → rolling
- `> 100 tenants` → canary

**Prerequisite:** A successful build must exist. Forge won't roll out a failed build.

---

## `tinai forge rollout status [rollout-id]`

Show rollout progress.

```bash
tinai forge rollout status           # show all active rollouts
tinai forge rollout status r-17      # show specific rollout details
```

**Output:**
```
Rollout r-17: forgejo v1.22.6 → v1.22.7 [rolling]
Progress: 23/47 tenants (48%) · Strategy: rolling · Batch 3/5

TENANT          STATUS      DURATION    HEALTH
tenant-alpha    ✓ updated   2m 14s      200 OK
tenant-beta     ✓ updated   2m 31s      200 OK
tenant-gamma    ⟳ updating  0m 45s      -
tenant-delta    ● pending   -           -
...
```

---

## `tinai forge rollout pause <rollout-id>`

Pause an in-progress rollout (remaining tenants not updated).

```bash
tinai forge rollout pause r-17
```

**When to use:**
- You see error spikes in Prometheus during rollout
- A tenant reports issues
- You want to inspect the canary tenants before proceeding

**Note:** Pause does NOT roll back already-updated tenants. Use `rollback` for that.

---

## `tinai forge rollout rollback <rollout-id>`

Roll back ALL tenants in a rollout to their previous version.

```bash
tinai forge rollout rollback r-17
```

**What happens:** Forge re-patches every tenant namespace that was updated, reverting to the previous image tag.

**When to use:**
- Build passed CTS but production behavior is wrong
- Branding issue slipped through tests
- Auto-rollback was triggered (check `tinai forge rollout status` for reason)

---

## `tinai forge deploy`

Deploy (or redeploy) the forge engine itself to the cluster.

```bash
tinai forge deploy
```

**What this does:** Equivalent to `./scripts/deploy.sh tinai-forge`. Builds the Go service image, pushes it, and patches the K8s deployment in `tinai-forge` namespace.

**When to use:**
- After modifying forge source code (`internal/`, `cmd/`, `config/`)
- After updating patch files
- After changing the ConfigMap/secrets

---

## Quick Decision Tree

```
Something is outdated → tinai forge status
                              ↓
                      See UPDATE in status
                              ↓
                   Check release notes (GitHub)
                    Patch? → tinai forge build <product>
                    Minor/Major? → Manual review first
                              ↓
                      tinai forge builds
                      (wait for success)
                              ↓
                   tinai forge rollout start <product>
                              ↓
                   tinai forge rollout status
                    All good? → Done ✓
                    Issues?   → tinai forge rollout pause <id>
                                tinai forge rollout rollback <id>
```

---

## Product Name Reference

| CLI Name | TinAI Brand | Upstream |
|---|---|---|
| `forgejo` | TinAI Repos | Forgejo |
| `woodpecker` | TinAI Pipelines | Woodpecker CI |
| `grafana` | TinAI Insights | Grafana |
| `prometheus` | TinAI Metrics | Prometheus |
| `loki` | TinAI Logs | Grafana Loki |
| `minio` | TinAI Storage | MinIO |
| `cloudnativepg` | TinAI Database | CloudNativePG |
| `cert-manager` | TinAI Certs | cert-manager |
| `keda` | TinAI Scale | KEDA |
| `knative` | TinAI Functions | Knative |
| `ingress-nginx` | TinAI Gateway | ingress-nginx |
