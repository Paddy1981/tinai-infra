import { cookies } from 'next/headers'

const API_INTERNAL = process.env['API_URL'] ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ModelUsageRow {
  model: string
  requests: number
  input_tokens: number
  output_tokens: number
  cost_paise: number
  cache_hits: number
}

interface DailySpend {
  date: string          // YYYY-MM-DD
  model: string
  cost_paise: number
}

interface GatewayUsage {
  month_total_paise: number
  quota_paise: number
  cache_saved_paise: number
  cache_hit_rate: number
  models: ModelUsageRow[]
  daily: DailySpend[]
  preferred_model?: string
}

const EMPTY_USAGE: GatewayUsage = {
  month_total_paise: 0,
  quota_paise: 100_000,
  cache_saved_paise: 0,
  cache_hit_rate: 0,
  models: [],
  daily: [],
}

// ---------------------------------------------------------------------------
// Data fetch — via tinai-api (same auth pattern as all other pages)
// ---------------------------------------------------------------------------
async function fetchGatewayUsage(): Promise<GatewayUsage> {
  try {
    const token = (await cookies()).get('tinai_token')?.value
    if (!token) return EMPTY_USAGE
    const res = await fetch(`${API_INTERNAL}/api/v1/gateway/usage`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!res.ok) return EMPTY_USAGE
    return res.json()
  } catch {
    return EMPTY_USAGE
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function inr(paise: number) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })
}

function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return String(n)
}

// ---------------------------------------------------------------------------
// SVG bar chart (daily spend, last 30 days)
// ---------------------------------------------------------------------------
function DailySpendChart({ daily }: { daily: DailySpend[] }) {
  // Aggregate by date across models
  const byDate = new Map<string, number>()
  for (const d of daily) {
    byDate.set(d.date, (byDate.get(d.date) ?? 0) + d.cost_paise)
  }

  // Last 30 days sorted
  const sorted = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-30)

  if (sorted.length === 0) {
    return <p className="text-sm text-slate-500">No daily data available.</p>
  }

  const maxVal = Math.max(...sorted.map(([, v]) => v), 1)
  const W = 600
  const H = 120
  const barW = Math.floor((W - 40) / sorted.length) - 2
  const chartLeft = 40

  return (
    <svg viewBox={`0 0 ${W} ${H + 30}`} className="w-full" aria-label="Daily spend chart">
      {/* Y axis labels */}
      {[0, 0.5, 1].map(frac => {
        const y = H - frac * H
        return (
          <g key={frac}>
            <line x1={chartLeft - 4} y1={y} x2={W} y2={y} stroke="#1e293b" strokeWidth={1} />
            <text x={chartLeft - 6} y={y + 4} fill="#64748b" fontSize={9} textAnchor="end">
              {inr(Math.round(maxVal * frac))}
            </text>
          </g>
        )
      })}

      {/* Bars */}
      {sorted.map(([date, val], i) => {
        const barH = Math.max(2, (val / maxVal) * H)
        const x = chartLeft + i * (barW + 2)
        const y = H - barH
        return (
          <g key={date}>
            <rect x={x} y={y} width={barW} height={barH} fill="#10b981" opacity={0.75} rx={1} />
            {/* Date label every 5 bars */}
            {i % 5 === 0 && (
              <text x={x + barW / 2} y={H + 14} fill="#475569" fontSize={8} textAnchor="middle">
                {date.slice(5)}
              </text>
            )}
          </g>
        )
      })}
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Model selector (client island would be needed for POST — using a plain form here)
// ---------------------------------------------------------------------------
function ModelSelector({ current }: { current?: string }) {
  const models = [
    'gpt-4o',
    'gpt-4o-mini',
    'claude-sonnet-4-5',
    'claude-haiku-3-5',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
  ]
  return (
    <form
      method="POST"
      action={`${API_INTERNAL}/api/v1/gateway/preferred-model`}
      className="flex items-end gap-3"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="preferred_model" className="text-xs text-slate-400 font-medium">
          Preferred model
        </label>
        <select
          id="preferred_model"
          name="model"
          defaultValue={current}
          className="rounded border border-slate-700 px-3 py-2 text-sm bg-slate-950 text-slate-200
            focus:border-emerald-500 outline-none transition-colors"
        >
          {models.map(m => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>
      <button
        type="submit"
        className="px-4 py-2 rounded bg-emerald-600 hover:bg-emerald-500 text-sm font-medium
          text-white transition-colors"
      >
        Save
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default async function GatewayPage() {
  const data = await fetchGatewayUsage()

  const spendPct = Math.min(100, Math.round((data.month_total_paise / (data.quota_paise || 1)) * 100))

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">AI Gateway</h1>

      {/* Top spend banner */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-slate-300 font-medium">
            Monthly spend: <strong className="text-slate-100">{inr(data.month_total_paise)}</strong>
          </span>
          <span className="text-xs text-slate-500">
            Quota: {inr(data.quota_paise)}
          </span>
        </div>
        <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              spendPct >= 90 ? 'bg-red-500' : spendPct >= 70 ? 'bg-yellow-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${spendPct}%` }}
          />
        </div>
        <p className="text-xs text-slate-500">{spendPct}% of monthly quota used</p>
      </div>

      {/* Cache savings */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 text-sm text-slate-300">
        Saved{' '}
        <strong className="text-emerald-400">{inr(data.cache_saved_paise)}</strong> this month via
        prompt cache &nbsp;·&nbsp;{' '}
        <strong className="text-emerald-400">{(data.cache_hit_rate * 100).toFixed(1)}%</strong>{' '}
        cache hit rate
      </div>

      {/* Model usage table */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">Model Usage</h2>
        {data.models.length === 0 ? (
          <p className="text-sm text-slate-500">No model usage recorded yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium">Requests</th>
                <th className="pb-2 font-medium">Input tokens</th>
                <th className="pb-2 font-medium">Output tokens</th>
                <th className="pb-2 font-medium">Cache hits</th>
                <th className="pb-2 font-medium text-right">Cost (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {data.models.map(row => (
                <tr key={row.model} className="text-slate-300">
                  <td className="py-2 font-mono text-xs">{row.model}</td>
                  <td className="py-2 text-xs">{fmtNum(row.requests)}</td>
                  <td className="py-2 text-xs">{fmtNum(row.input_tokens)}</td>
                  <td className="py-2 text-xs">{fmtNum(row.output_tokens)}</td>
                  <td className="py-2 text-xs">{fmtNum(row.cache_hits)}</td>
                  <td className="py-2 text-xs text-right">{inr(row.cost_paise)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-slate-700 text-slate-100 font-medium text-xs">
                <td className="pt-2">Total</td>
                <td className="pt-2">{fmtNum(data.models.reduce((s, r) => s + r.requests, 0))}</td>
                <td className="pt-2">{fmtNum(data.models.reduce((s, r) => s + r.input_tokens, 0))}</td>
                <td className="pt-2">{fmtNum(data.models.reduce((s, r) => s + r.output_tokens, 0))}</td>
                <td className="pt-2">{fmtNum(data.models.reduce((s, r) => s + r.cache_hits, 0))}</td>
                <td className="pt-2 text-right">{inr(data.month_total_paise)}</td>
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Daily spend chart */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-4">Daily Spend (last 30 days)</h2>
        <DailySpendChart daily={data.daily} />
      </div>

      {/* Model selector */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 flex flex-col gap-4">
        <h2 className="text-sm font-medium text-slate-400">Model Preference</h2>
        <p className="text-xs text-slate-500">
          Set the default model for tenant inference requests. Individual API calls may override this.
        </p>
        <ModelSelector current={data.preferred_model} />
      </div>
    </div>
  )
}
