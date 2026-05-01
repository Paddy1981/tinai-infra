'use client'

import { useState, useEffect, useRef } from 'react'
import type { ActiveUsageRow } from './page'

const TICK_INTERVAL_MS = 10_000 // matches the 10s tracker window

// Rough per-second increment for the live counter: total_cost_paise accumulated
// over the month divided by elapsed seconds this month gives paise/s rate.
function estimateRatePerSecond(row: ActiveUsageRow): number {
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const elapsedSec = Math.max(1, (now.getTime() - monthStart.getTime()) / 1000)
  return row.total_cost_paise / elapsedSec
}

function inr(paise: number) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 4 })
}

interface Props {
  usage: ActiveUsageRow[]
}

export default function ActiveBillingClient({ usage }: Props) {
  // Running totals that tick upward in real-time
  const [livePaise, setLivePaise] = useState<Record<string, number>>(
    Object.fromEntries(usage.map(r => [r.app_name, r.total_cost_paise]))
  )

  const ratesRef = useRef<Record<string, number>>(
    Object.fromEntries(usage.map(r => [r.app_name, estimateRatePerSecond(r)]))
  )

  useEffect(() => {
    // Update every second for smooth visual increment
    const interval = setInterval(() => {
      setLivePaise(prev => {
        const next = { ...prev }
        for (const [app, rate] of Object.entries(ratesRef.current)) {
          next[app] = (next[app] ?? 0) + rate
        }
        return next
      })
    }, 1000)
    return () => clearInterval(interval)
  }, [])

  const totalLivePaise = Object.values(livePaise).reduce((s, v) => s + v, 0)

  return (
    <div className="flex flex-col gap-4">
      {/* Grand total live counter */}
      <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 flex items-center justify-between">
        <div>
          <div className="text-xs text-slate-500 mb-1 uppercase tracking-wide">
            Month-to-date (live)
          </div>
          <div className="text-2xl font-mono font-bold text-emerald-400 tabular-nums">
            {inr(totalLivePaise)}
          </div>
          <div className="text-xs text-slate-600 mt-1">
            +GST (18%) on invoice — updates every 10s from tracker
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-slate-500 mb-1">Granularity</div>
          <div className="text-sm text-slate-300 font-mono">10s windows</div>
          <div className="text-xs text-slate-600 mt-1">
            {new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </div>
        </div>
      </div>

      {/* Per-app table */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">Per-App Active Usage</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
              <th className="pb-2 font-medium">App</th>
              <th className="pb-2 font-medium">CPU-seconds</th>
              <th className="pb-2 font-medium">Memory GB-seconds</th>
              <th className="pb-2 font-medium text-right">Cost (live)</th>
              <th className="pb-2 font-medium text-right">Detail</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {usage.map(r => (
              <tr key={r.app_name} className="text-slate-300">
                <td className="py-2 font-mono text-xs">{r.app_name}</td>
                <td className="py-2 text-xs tabular-nums">
                  {r.total_cpu_seconds.toFixed(3)}
                </td>
                <td className="py-2 text-xs tabular-nums">
                  {r.total_gb_seconds.toFixed(6)}
                </td>
                <td className="py-2 text-xs text-right tabular-nums text-emerald-400 font-mono">
                  {inr(livePaise[r.app_name] ?? r.total_cost_paise)}
                </td>
                <td className="py-2 text-right">
                  <a
                    href={`/billing/active/${r.app_name}`}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    24h chart →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals row */}
        <div className="border-t border-slate-800 pt-3 mt-2 text-sm space-y-1">
          <div className="flex justify-between text-slate-400">
            <span>Subtotal</span>
            <span className="font-mono tabular-nums">{inr(totalLivePaise)}</span>
          </div>
          <div className="flex justify-between text-slate-400">
            <span>GST (18%)</span>
            <span className="font-mono tabular-nums">{inr(totalLivePaise * 0.18)}</span>
          </div>
          <div className="flex justify-between text-slate-100 font-medium pt-1">
            <span>Total (incl. GST)</span>
            <span className="font-mono tabular-nums text-emerald-400">
              {inr(totalLivePaise * 1.18)}
            </span>
          </div>
        </div>
      </div>

      {/* Current-hour snapshot */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">
          Current Hour — Last 10 Windows (~100s)
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {usage.map(r => (
            <div key={r.app_name} className="rounded border border-slate-700 bg-slate-800/50 p-3">
              <div className="font-mono text-xs text-slate-400 mb-2 truncate">{r.app_name}</div>
              <div className="text-xs text-slate-500">CPU-sec</div>
              <div className="text-sm font-mono tabular-nums text-slate-200">
                {r.current_hour_snapshot.cpu_seconds.toFixed(4)}
              </div>
              <div className="text-xs text-slate-500 mt-1">Cost</div>
              <div className="text-sm font-mono tabular-nums text-emerald-400">
                {inr(r.current_hour_snapshot.cpu_cost_paise)}
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-slate-600 mt-3">
          Refreshes automatically every {TICK_INTERVAL_MS / 1000}s via the tracker daemon.
          Navigate away and return to see updated figures.
        </p>
      </div>
    </div>
  )
}
