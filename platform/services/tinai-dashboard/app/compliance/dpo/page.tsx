'use client'

import { useState, useEffect } from 'react'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = ''

interface DpoRecord {
  region: string
  name: string
  email: string
  phone: string | null
  appointed_at: string | null
}

const REGIONS: { code: string; flag: string; name: string; law: string; requirement: string }[] = [
  {
    code: 'IN',
    flag: '🇮🇳',
    name: 'India',
    law: 'DPDP 2023',
    requirement: 'Required if organisation is designated as Significant Data Fiduciary (SDF) by MeitY.',
  },
  {
    code: 'QA',
    flag: '🇶🇦',
    name: 'Qatar',
    law: 'PDPPL 2016',
    requirement: 'Recommended for controllers processing sensitive personal data. Required for public bodies.',
  },
  {
    code: 'AE',
    flag: '🇦🇪',
    name: 'UAE',
    law: 'PDPL 2021',
    requirement: 'Required for all organisations processing personal data in the UAE at launch.',
  },
]

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    dateStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  })
}

function DpoCard({ region, dpo }: { region: typeof REGIONS[0]; dpo: DpoRecord | undefined }) {
  if (dpo) {
    return (
      <div className="rounded-lg border border-emerald-800 bg-emerald-950/20 p-4 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">{region.flag}</span>
            <div>
              <p className="text-sm font-medium text-slate-100">{region.name}</p>
              <p className="text-xs text-slate-500">{region.law}</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">
            &#10003; Registered
          </span>
        </div>
        <div className="text-xs text-slate-400 space-y-0.5 pl-8">
          <p>Name: <span className="text-slate-200">{dpo.name}</span></p>
          <p>Email: <span className="text-slate-200">{dpo.email}</span></p>
          {dpo.phone && <p>Phone: <span className="text-slate-200">{dpo.phone}</span></p>}
          {dpo.appointed_at && (
            <p>Appointed: <span className="text-slate-200">{formatDate(dpo.appointed_at)}</span></p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-800 bg-amber-950/20 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">{region.flag}</span>
          <div>
            <p className="text-sm font-medium text-slate-100">{region.name}</p>
            <p className="text-xs text-slate-500">{region.law}</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs border bg-amber-900/50 text-amber-400 border-amber-800">
          &#9888; DPO required
        </span>
      </div>
      <p className="text-xs text-amber-400/80 pl-8 leading-relaxed">{region.requirement}</p>
    </div>
  )
}

function DpoForm({ onSuccess }: { onSuccess: () => void }) {
  const [regionCode, setRegionCode] = useState('IN')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [apiComingSoon, setApiComingSoon] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setApiComingSoon(false)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/dpo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ region: regionCode, name, email, phone: phone || null }),
      })

      if (res.status === 404 || res.status === 501) {
        setApiComingSoon(true)
        return
      }
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setName('')
      setEmail('')
      setPhone('')
      onSuccess()
    } catch (err) {
      // Treat connection errors as "API coming soon" for stub environments
      setApiComingSoon(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-medium text-slate-400 mb-4">Register / Update DPO</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Region</label>
            <select
              value={regionCode}
              onChange={e => setRegionCode(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 focus:border-emerald-700 focus:outline-none"
            >
              {REGIONS.map(r => (
                <option key={r.code} value={r.code}>{r.flag} {r.name}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Full Name</label>
            <input
              type="text"
              required
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="DPO name"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="dpo@organisation.com"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Phone (optional)</label>
            <input
              type="tel"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              placeholder="+91 98765 43210"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {apiComingSoon && (
          <div className="rounded-md border border-amber-800 bg-amber-950/30 px-3 py-2 text-xs text-amber-400">
            API coming soon — DPO registration endpoint is not yet deployed.
          </div>
        )}

        <div>
          <button
            type="submit"
            disabled={loading || !name || !email}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Saving…' : 'Register DPO'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function DpoPage() {
  const [dpos, setDpos] = useState<DpoRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchDpos() {
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/dpo`)
      if (res.status === 404 || res.status === 501) {
        // API not yet implemented
        setDpos([])
        return
      }
      if (!res.ok) throw new Error(`Failed to fetch DPO records: ${res.status}`)
      const data = await res.json()
      setDpos(Array.isArray(data) ? data : [])
    } catch {
      // graceful — show empty state
      setDpos([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchDpos()
  }, [])

  const dpoByRegion = Object.fromEntries(dpos.map(d => [d.region, d]))

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
          <h1 className="text-xl font-semibold mt-2">Data Protection Officers</h1>
        </div>
        <div className="mt-6">
          <DownloadReportButton reportType="dpdpa" label="Download DPDPA Report" />
        </div>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-800/50 px-4 py-3 text-xs text-slate-400 leading-relaxed">
        Each active region requires a named DPO. The DPO is the primary contact for data subjects and regulators. Failure to appoint a DPO where required may result in regulatory action.
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {REGIONS.map(r => (
            <DpoCard key={r.code} region={r} dpo={dpoByRegion[r.code]} />
          ))}
        </div>
      )}

      <DpoForm onSuccess={() => { setLoading(true); fetchDpos() }} />
    </div>
  )
}
