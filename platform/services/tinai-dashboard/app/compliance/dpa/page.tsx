'use client'

import { useState, useEffect } from 'react'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = ''

interface JurisdictionStatus {
  signed: boolean
  signed_at: string | null
  version: string | null
}

interface DpaStatus {
  IN: JurisdictionStatus
  QA: JurisdictionStatus
  AE: JurisdictionStatus
}

const JURISDICTIONS: { code: keyof DpaStatus; flag: string; name: string; law: string }[] = [
  { code: 'IN', flag: '🇮🇳', name: 'India', law: 'DPDP 2023' },
  { code: 'QA', flag: '🇶🇦', name: 'Qatar', law: 'PDPPL 2016' },
  { code: 'AE', flag: '🇦🇪', name: 'UAE', law: 'PDPL 2021' },
]

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  })
}

function JurisdictionCard({ j, status }: { j: typeof JURISDICTIONS[0]; status: JurisdictionStatus | undefined }) {
  const signed = status?.signed ?? false

  return (
    <div className={`rounded-lg border p-4 flex flex-col gap-3 ${
      signed ? 'border-emerald-800 bg-emerald-950/20' : 'border-amber-800 bg-amber-950/20'
    }`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">{j.flag}</span>
          <div>
            <p className="text-sm font-medium text-slate-100">{j.name}</p>
            <p className="text-xs text-slate-500">{j.law}</p>
          </div>
        </div>
        {signed ? (
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">
            <span>&#10003;</span> Signed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs border bg-amber-900/50 text-amber-400 border-amber-800">
            &#9888; Unsigned
          </span>
        )}
      </div>

      {signed && status?.signed_at && (
        <div className="text-xs text-slate-400 space-y-0.5">
          <p>Signed: <span className="text-slate-300">{formatDate(status.signed_at)}</span></p>
          {status.version && (
            <p>Version: <span className="text-slate-300 font-mono">{status.version}</span></p>
          )}
        </div>
      )}

      <div>
        <span className="text-xs text-slate-500 cursor-pointer hover:text-slate-300 transition-colors">
          View Template &rarr;
        </span>
      </div>
    </div>
  )
}

function SignForm({ onSuccess }: { onSuccess: (ref: string) => void }) {
  const [jurisdiction, setJurisdiction] = useState<string>('IN')
  const [signatoryName, setSignatoryName] = useState('')
  const [signatoryEmail, setSignatoryEmail] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!confirmed) return
    setLoading(true)
    setError(null)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/dpa/sign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tinai-admin',
          region: jurisdiction,
          signatory_name: signatoryName,
          signatory_email: signatoryEmail,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const data = await res.json()
      onSuccess(data.reference_id ?? data.id ?? 'DPA signed')
      setSignatoryName('')
      setSignatoryEmail('')
      setConfirmed(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to sign DPA')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-medium text-slate-400 mb-4">Sign DPA</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Jurisdiction</label>
            <select
              value={jurisdiction}
              onChange={e => setJurisdiction(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-emerald-700 focus:outline-none"
            >
              {JURISDICTIONS.map(j => (
                <option key={j.code} value={j.code}>{j.flag} {j.name} ({j.law})</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Signatory Name</label>
            <input
              type="text"
              required
              value={signatoryName}
              onChange={e => setSignatoryName(e.target.value)}
              placeholder="Full name"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Signatory Email</label>
            <input
              type="email"
              required
              value={signatoryEmail}
              onChange={e => setSignatoryEmail(e.target.value)}
              placeholder="legal@organisation.com"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>
        </div>

        <label className="flex items-start gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={e => setConfirmed(e.target.checked)}
            className="mt-0.5 rounded border-slate-700 bg-slate-800 text-emerald-600"
          />
          I confirm I have authority to sign this DPA on behalf of my organisation and agree to the terms of the Data Processing Agreement.
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div>
          <button
            type="submit"
            disabled={loading || !confirmed || !signatoryName || !signatoryEmail}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Signing…' : 'Sign DPA'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function DpaPage() {
  const [dpaStatus, setDpaStatus] = useState<DpaStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signedRef, setSignedRef] = useState<string | null>(null)

  async function fetchDpaStatus() {
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/dpa/status/tinai-admin`)
      if (!res.ok) throw new Error(`Failed to fetch DPA status: ${res.status}`)
      const data = await res.json()
      setDpaStatus(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load DPA status')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDpaStatus()
  }, [])

  function handleSignSuccess(ref: string) {
    setSignedRef(ref)
    setLoading(true)
    fetchDpaStatus()
  }

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
          <h1 className="text-xl font-semibold mt-2">Data Processing Agreements</h1>
        </div>
        <div className="mt-6">
          <DownloadReportButton reportType="soc2" label="Download SOC 2 Report" />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {signedRef && (
        <div className="rounded-lg border border-emerald-800 bg-emerald-950/30 px-4 py-3 text-sm text-emerald-300">
          DPA signed successfully. Reference: <span className="font-mono">{signedRef}</span>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {JURISDICTIONS.map(j => (
            <JurisdictionCard
              key={j.code}
              j={j}
              status={dpaStatus?.[j.code]}
            />
          ))}
        </div>
      )}

      <SignForm onSuccess={handleSignSuccess} />
    </div>
  )
}
