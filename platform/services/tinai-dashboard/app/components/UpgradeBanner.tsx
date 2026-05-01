'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface PlanLimits {
  max_workloads: number
  max_databases: number
  max_functions: number
  storage_gb: number
  api_calls_month: number
}

interface Plan {
  id: string
  name: string
  price_inr: number
  limits: PlanLimits
}

interface Usage {
  workloads: number
  databases: number
  functions: number
}

interface PlanCurrentResponse {
  plan: Plan
  usage: Usage
}

type LimitedResource = {
  label: string
  current: number
  limit: number
}

/**
 * UpgradeBanner — shows a dismissible banner when the tenant has hit
 * any resource limit on their current plan.
 *
 * Usage: drop anywhere in a layout or page that is behind auth.
 *
 *   <UpgradeBanner />
 */
export default function UpgradeBanner() {
  const [exceeded, setExceeded] = useState<LimitedResource[]>([])
  const [planName, setPlanName] = useState<string>('Free')
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    async function fetchPlan() {
      try {
        const res = await fetch('/api/v1/plans/current')
        if (!res.ok) return

        const data: PlanCurrentResponse = await res.json()
        const { plan, usage } = data

        const hits: LimitedResource[] = []

        const checks: Array<{ key: keyof PlanLimits; usageKey: keyof Usage; label: string }> = [
          { key: 'max_workloads', usageKey: 'workloads', label: 'workloads' },
          { key: 'max_databases', usageKey: 'databases', label: 'databases' },
          { key: 'max_functions', usageKey: 'functions', label: 'functions' },
        ]

        for (const { key, usageKey, label } of checks) {
          const limit = plan.limits[key]
          const current = usage[usageKey]
          // -1 = unlimited (enterprise); skip
          if (limit !== -1 && current >= limit) {
            hits.push({ label, current, limit })
          }
        }

        setPlanName(plan.name)
        setExceeded(hits)
      } catch {
        // Silently ignore — banner is non-critical
      }
    }

    fetchPlan()
  }, [])

  if (dismissed || exceeded.length === 0) return null

  const resourceList = exceeded.map(r => `${r.label} (${r.current}/${r.limit})`).join(', ')

  return (
    <div className="relative flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-200">
      {/* Warning icon */}
      <span className="material-symbols-outlined shrink-0 text-yellow-400" style={{ fontSize: 20 }}>
        warning
      </span>

      <p className="flex-1">
        You&apos;ve reached your{' '}
        <span className="font-semibold text-yellow-100">{planName} plan</span> limit for{' '}
        <span className="font-semibold text-yellow-100">{resourceList}</span>.{' '}
        <Link
          href="/billing"
          className="underline decoration-yellow-400/60 underline-offset-2 hover:text-white"
        >
          Upgrade to Pro →
        </Link>
      </p>

      {/* Dismiss */}
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss upgrade banner"
        className="shrink-0 text-yellow-400/60 hover:text-yellow-200 transition-colors"
      >
        <span className="material-symbols-outlined" style={{ fontSize: 18 }}>close</span>
      </button>
    </div>
  )
}
