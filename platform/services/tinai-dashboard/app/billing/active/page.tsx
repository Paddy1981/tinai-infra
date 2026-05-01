import ActiveBillingClient from './ActiveBillingClient'
import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

export interface ActiveUsageRow {
  app_name: string
  total_cpu_seconds: number
  cpu_cost_paise: number
  total_gb_seconds: number
  memory_cost_paise: number
  total_cost_paise: number
  total_cost_inr: string
  current_hour_snapshot: {
    cpu_seconds: number
    cpu_cost_paise: number
    gb_seconds: number
  }
}

async function getActiveUsage(): Promise<ActiveUsageRow[]> {
  const token = (await cookies()).get('tinai_token')?.value
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(`${API_URL}/api/v1/billing/active-usage`, {
    cache: 'no-store',
    headers,
  })
  if (!res.ok) throw new Error(`active-usage: ${res.status}`)
  return res.json()
}

export default async function ActiveBillingPage() {
  let usage: ActiveUsageRow[] = []
  try {
    usage = await getActiveUsage()
  } catch {
    /* no data yet — tracker not running or table is empty */
  }

  const totalCostPaise  = usage.reduce((s, r) => s + r.total_cost_paise, 0)
  const allocatedPaise  = usage.reduce((s, r) => s + r.cpu_cost_paise, 0) * 3.6 // rough allocated equiv
  const savingsPct      = allocatedPaise > 0
    ? Math.round((1 - totalCostPaise / allocatedPaise) * 100)
    : 0

  function inr(paise: number) {
    return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 4 })
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Active CPU Billing</h1>
          <p className="text-sm text-slate-400 mt-1">
            Per-second metering — sampled every 10s via cAdvisor metrics
          </p>
        </div>
        <a
          href="/billing"
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          ← Back to Billing
        </a>
      </div>

      {/* Savings banner */}
      {savingsPct > 0 && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 flex items-center gap-3">
          <span className="text-emerald-400 text-lg font-bold">{savingsPct}% saved</span>
          <span className="text-sm text-emerald-300">
            vs allocated (flat) billing — you only pay for CPU you actually used
          </span>
        </div>
      )}

      {/* Live counter + table */}
      {usage.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-6 text-center">
          <p className="text-slate-400 text-sm">
            No active-billing data yet. Deploy the usage tracker with{' '}
            <code className="font-mono text-xs bg-slate-800 px-1 rounded">
              ACTIVE_CPU_TRACKING=true
            </code>{' '}
            to start per-second metering.
          </p>
        </div>
      ) : (
        <ActiveBillingClient usage={usage} />
      )}

      {/* Rate card */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">Active Billing Rate Card</h2>
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-xs text-slate-500 max-w-md">
          <span className="text-slate-400">CPU per second</span>
          <span>₹0.0014  <span className="text-slate-600">(= ₹5.04 / CPU-hour)</span></span>
          <span className="text-slate-400">Memory per GB-second</span>
          <span>₹0.000007  <span className="text-slate-600">(= ₹0.025 / GB-hour)</span></span>
          <span className="text-slate-400">Billing granularity</span>
          <span>10-second windows</span>
          <span className="text-slate-400">GST</span>
          <span>18% IGST added on invoice</span>
        </div>
        <p className="text-xs text-slate-600 mt-3">
          Costs shown in paise (100 paise = ₹1). Active billing charges only for CPU actually
          consumed, not reserved capacity.
        </p>
      </div>
    </div>
  )
}
