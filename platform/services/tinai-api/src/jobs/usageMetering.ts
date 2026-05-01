import * as k8s from '@kubernetes/client-node'
import cron from 'node-cron'
import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// K8s client — prefers in-cluster SA token, falls back to kubeconfig for dev
// ---------------------------------------------------------------------------
const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const coreV1 = kc.makeApiClient(k8s.CoreV1Api)

const TENANT_NAMESPACE = 'tinai-system'
const TENANT_LABEL = 'tinai.cloud/tenant-id'

// ---------------------------------------------------------------------------
// Parse a k8s CPU quantity string into millicores (integer)
//   "100m"  → 100
//   "0.5"   → 500
//   "2"     → 2000
//   ""      → 100  (default)
// ---------------------------------------------------------------------------
function parseCpuMillicores(cpu: string | undefined): number {
  if (!cpu) return 100
  const trimmed = cpu.trim()
  if (trimmed.endsWith('m')) {
    const val = parseInt(trimmed.slice(0, -1), 10)
    return isNaN(val) ? 100 : val
  }
  const val = parseFloat(trimmed)
  if (isNaN(val)) return 100
  return Math.round(val * 1000)
}

// ---------------------------------------------------------------------------
// Core metering tick — called every 60 s
// ---------------------------------------------------------------------------
async function runMeteringTick(app: FastifyInstance): Promise<void> {
  let podList: k8s.V1Pod[]
  try {
    const { body } = await coreV1.listNamespacedPod(
      TENANT_NAMESPACE,
      undefined, // pretty
      undefined, // allowWatchBookmarks
      undefined, // _continue
      undefined, // fieldSelector
      TENANT_LABEL, // labelSelector — only tenant pods
    )
    podList = body.items ?? []
  } catch (err: any) {
    app.log.warn({ err: err?.message }, 'usageMetering: failed to list pods — skipping tick')
    return
  }

  if (podList.length === 0) return

  // Group running pods by tenant
  const tenantMap = new Map<string, { pods: string[]; totalCpu: number }>()

  for (const pod of podList) {
    const phase = pod.status?.phase
    if (phase !== 'Running') continue

    const tenantId = pod.metadata?.labels?.[TENANT_LABEL]
    if (!tenantId) continue

    const podName = pod.metadata?.name ?? 'unknown'
    const namespace = pod.metadata?.namespace ?? TENANT_NAMESPACE

    // Sum CPU millicores across all containers in the pod
    const cpuMillicores = (pod.spec?.containers ?? []).reduce((sum, container) => {
      return sum + parseCpuMillicores(container.resources?.requests?.cpu)
    }, 0)

    // Insert into cpu_seconds_log
    try {
      await app.pg.query(
        `INSERT INTO cpu_seconds_log (tenant_id, pod_name, namespace, cpu_millicores, recorded_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [tenantId, podName, namespace, cpuMillicores],
      )
    } catch (err: any) {
      app.log.warn({ err: err?.message, tenantId, podName }, 'usageMetering: failed to insert cpu_seconds_log row')
    }

    // Accumulate per-tenant totals for usage_snapshots
    const existing = tenantMap.get(tenantId)
    if (existing) {
      existing.pods.push(podName)
      existing.totalCpu += cpuMillicores
    } else {
      tenantMap.set(tenantId, { pods: [podName], totalCpu: cpuMillicores })
    }
  }

  // Upsert per-tenant usage_snapshots row for this tick
  for (const [tenantId, { pods, totalCpu }] of tenantMap) {
    try {
      await app.pg.query(
        `INSERT INTO usage_snapshots (tenant_id, snapshot_at, running_pods, total_cpu_millicores)
         VALUES ($1, NOW(), $2, $3)
         ON CONFLICT (tenant_id, snapshot_at)
         DO UPDATE SET running_pods = EXCLUDED.running_pods,
                       total_cpu_millicores = EXCLUDED.total_cpu_millicores`,
        [tenantId, pods.length, totalCpu],
      )
    } catch (err: any) {
      app.log.warn({ err: err?.message, tenantId }, 'usageMetering: failed to upsert usage_snapshots row')
    }
  }

  app.log.debug({ tenants: tenantMap.size, pods: podList.length }, 'usageMetering: tick complete')
}

// ---------------------------------------------------------------------------
// Register the cron job — called once from server.ts after app.ready()
// ---------------------------------------------------------------------------
export function registerUsageMeteringJob(app: FastifyInstance): void {
  // Run every 60 seconds
  cron.schedule('* * * * *', () => {
    runMeteringTick(app).catch(err => {
      app.log.error({ err: err?.message }, 'usageMetering: unhandled error in tick')
    })
  })

  app.log.info('usageMetering: cron job registered (every 60s)')
}
