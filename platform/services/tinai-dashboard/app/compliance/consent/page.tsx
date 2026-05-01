'use client'

import { useState, useEffect } from 'react'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = ''

interface ConsentStatus {
  purpose: string
  granted: boolean
  granted_at: string
  withdrawn_at: string | null
}

const PURPOSES = ['account_processing', 'marketing', 'analytics', 'ai_copilot']
const LEGAL_BASES = ['consent', 'contract', 'legal_obligation', 'vital_interest']
const REGIONS = ['IN', 'QA', 'AE']

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  })
}

function GrantedBadge({ granted }: { granted: boolean }) {
  if (granted) {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">
        Granted
      </span>
    )
  }
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs border bg-red-900/50 text-red-400 border-red-800">
      Withdrawn
    </span>
  )
}

function GrantForm({ onSuccess }: { onSuccess: () => void }) {
  const [purpose, setPurpose] = useState(PURPOSES[0])
  const [legalBasis, setLegalBasis] = useState(LEGAL_BASES[0])
  const [region, setRegion] = useState(REGIONS[0])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tinai-admin',
          purpose,
          legal_basis: legalBasis,
          region,
          granted: true,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setSuccess(true)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to grant consent')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-medium text-slate-400 mb-4">Grant Consent</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Purpose</label>
            <select
              value={purpose}
              onChange={e => setPurpose(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-emerald-700 focus:outline-none"
            >
              {PURPOSES.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Legal Basis</label>
            <select
              value={legalBasis}
              onChange={e => setLegalBasis(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-emerald-700 focus:outline-none"
            >
              {LEGAL_BASES.map(b => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Region</label>
            <select
              value={region}
              onChange={e => setRegion(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-emerald-700 focus:outline-none"
            >
              {REGIONS.map(r => (
                <option key={r} value={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}
        {success && (
          <p className="text-xs text-emerald-400">Consent granted successfully.</p>
        )}

        <div>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Saving…' : 'Grant Consent'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function ConsentPage() {
  const [consents, setConsents] = useState<ConsentStatus[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchConsents() {
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/consent/status/tinai-admin`)
      if (!res.ok) throw new Error(`Failed to fetch consent status: ${res.status}`)
      const data = await res.json()
      setConsents(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load consent data')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchConsents()
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a
            href="/compliance"
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            &larr; Compliance
          </a>
          <h1 className="text-xl font-semibold mt-2">Consent Manager</h1>
        </div>
        <div className="mt-6">
          <DownloadReportButton reportType="dpdpa" label="Download DPDPA Report" />
        </div>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-800/50 px-4 py-3 text-xs text-slate-400 leading-relaxed">
        Tinai collects explicit consent for each processing purpose. The table below shows current consent status for the platform tenant.
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">Consent Records</h2>

        {loading && (
          <p className="text-sm text-slate-500">Loading…</p>
        )}

        {!loading && consents.length === 0 && !error && (
          <div className="rounded-md border border-amber-800 bg-amber-950/30 px-4 py-4">
            <p className="text-sm font-medium text-amber-300 mb-1">No consent records found</p>
            <p className="text-xs text-amber-400/80">
              Consent must be recorded for each processing purpose before tenants can be onboarded.
              Use the form below to grant initial consent records.
            </p>
          </div>
        )}

        {!loading && consents.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Purpose</th>
                <th className="pb-2 font-medium">Legal Basis</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Region</th>
                <th className="pb-2 font-medium">Granted At</th>
                <th className="pb-2 font-medium">Withdrawn At</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {consents.map((c, i) => (
                <tr key={i} className="text-slate-300">
                  <td className="py-2.5 text-xs font-mono">{c.purpose}</td>
                  <td className="py-2.5 text-xs text-slate-400">—</td>
                  <td className="py-2.5"><GrantedBadge granted={c.granted} /></td>
                  <td className="py-2.5 text-xs text-slate-400">—</td>
                  <td className="py-2.5 text-xs text-slate-400">
                    {c.granted_at ? formatDate(c.granted_at) : <span className="text-slate-600">—</span>}
                  </td>
                  <td className="py-2.5 text-xs text-slate-400">
                    {c.withdrawn_at ? formatDate(c.withdrawn_at) : <span className="text-slate-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <GrantForm onSuccess={() => { setLoading(true); fetchConsents() }} />
    </div>
  )
}
