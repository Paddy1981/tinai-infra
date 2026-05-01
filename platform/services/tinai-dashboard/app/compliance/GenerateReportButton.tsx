'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function GenerateReportButton() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/compliance/residency-report', {
        method: 'POST',
        headers: { 'x-tinai-csrf': '1' },
      })
      if (!res.ok) throw new Error(`Failed to generate report: ${res.status}`)
      router.refresh()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to generate report')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 flex flex-col gap-3">
      <p className="text-xs text-slate-400">
        No residency snapshot has been generated yet. Generate one to verify that all data and compute stays within the required jurisdiction.
      </p>
      {error && (
        <p className="text-xs text-red-400">{error}</p>
      )}
      <button
        onClick={handleGenerate}
        disabled={loading}
        className="self-start rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? 'Generating…' : 'Generate Residency Report'}
      </button>
    </div>
  )
}
