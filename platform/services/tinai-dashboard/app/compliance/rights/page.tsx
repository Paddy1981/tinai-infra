'use client'

import { useState, useEffect } from 'react'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = ''

interface ErasureRequest {
  id: string
  tenant_id: string
  requester_email: string
  data_categories: string[]
  full_erasure: boolean
  status: string
  requested_at: string
  completed_at: string | null
  sla_deadline: string
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'completed') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">
        completed
      </span>
    )
  }
  if (status === 'pending') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs border bg-amber-900/50 text-amber-400 border-amber-800">
        pending
      </span>
    )
  }
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs border bg-slate-800 text-slate-400 border-slate-700">
      {status}
    </span>
  )
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  })
}

function isOverdue(req: ErasureRequest) {
  return req.status === 'pending' && new Date(req.sla_deadline) < new Date()
}

function ErasureTable({ requests, onRefresh }: { requests: ErasureRequest[]; onRefresh: () => void }) {
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function completeRequest(id: string) {
    setActionLoading(id)
    setActionError(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/erasure/${id}/complete`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      onRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(null)
    }
  }

  const total = requests.length
  const pending = requests.filter(r => r.status === 'pending').length
  const completed = requests.filter(r => r.status === 'completed').length
  const overdue = requests.filter(isOverdue).length

  return (
    <div className="flex flex-col gap-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total', value: total, colour: 'text-slate-200' },
          { label: 'Pending', value: pending, colour: 'text-amber-400' },
          { label: 'Completed', value: completed, colour: 'text-emerald-400' },
          { label: 'Overdue', value: overdue, colour: overdue > 0 ? 'text-red-400' : 'text-slate-500' },
        ].map(s => (
          <div key={s.label} className="rounded-lg border border-slate-800 bg-slate-900 p-3">
            <p className="text-xs text-slate-500 mb-1">{s.label}</p>
            <p className={`text-xl font-mono font-semibold ${s.colour}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {actionError && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-2 text-xs text-red-400">
          {actionError}
        </div>
      )}

      {requests.length === 0 ? (
        <p className="text-sm text-slate-500">No erasure requests received yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
              <th className="pb-2 font-medium">Requester Email</th>
              <th className="pb-2 font-medium">Scope</th>
              <th className="pb-2 font-medium">Status</th>
              <th className="pb-2 font-medium">Requested</th>
              <th className="pb-2 font-medium">SLA Deadline</th>
              <th className="pb-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {requests.map(req => {
              const overdue = isOverdue(req)
              return (
                <tr key={req.id} className="text-slate-300">
                  <td className="py-2.5 text-xs">{req.requester_email}</td>
                  <td className="py-2.5 text-xs text-slate-400">
                    {req.full_erasure
                      ? <span className="text-red-400">Full erasure</span>
                      : req.data_categories.join(', ') || '—'}
                  </td>
                  <td className="py-2.5"><StatusBadge status={req.status} /></td>
                  <td className="py-2.5 text-xs text-slate-400">{formatDate(req.requested_at)}</td>
                  <td className={`py-2.5 text-xs ${overdue ? 'text-red-400 font-medium' : 'text-slate-400'}`}>
                    {formatDate(req.sla_deadline)}
                    {overdue && <span className="ml-1 text-[10px] text-red-500">(overdue)</span>}
                  </td>
                  <td className="py-2.5">
                    {req.status === 'pending' && (
                      <button
                        onClick={() => completeRequest(req.id)}
                        disabled={actionLoading === req.id}
                        className="rounded px-2 py-0.5 text-xs border border-emerald-800 text-emerald-400 hover:bg-emerald-900/30 disabled:opacity-40 transition-colors"
                      >
                        {actionLoading === req.id ? '…' : 'Complete'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

function ErasureRequestForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState('')
  const [categories, setCategories] = useState('')
  const [fullErasure, setFullErasure] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    const cats = categories.split(',').map(s => s.trim()).filter(Boolean)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/erasure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: 'tinai-admin',
          requester_email: email,
          data_categories: cats,
          full_erasure: fullErasure,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setSuccess(true)
      setEmail('')
      setCategories('')
      setFullErasure(false)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to submit request')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h3 className="text-sm font-medium text-slate-400 mb-4">Submit Erasure Request</h3>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Requester Email</label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Data Categories (comma-separated)</label>
            <input
              type="text"
              value={categories}
              onChange={e => setCategories(e.target.value)}
              placeholder="personal_data, financial_data"
              disabled={fullErasure}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none disabled:opacity-40"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
          <input
            type="checkbox"
            checked={fullErasure}
            onChange={e => setFullErasure(e.target.checked)}
            className="rounded border-slate-700 bg-slate-800 text-emerald-600"
          />
          Full erasure — delete all personal data across all categories
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {success && <p className="text-xs text-emerald-400">Erasure request submitted.</p>}

        <div>
          <button
            type="submit"
            disabled={loading || !email}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Submitting…' : 'Submit Request'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function RightsPage() {
  const [erasureRequests, setErasureRequests] = useState<ErasureRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'erasure' | 'access' | 'portability'>('erasure')

  async function fetchErasureRequests() {
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/erasure?tenant_id=tinai-admin`)
      if (!res.ok) throw new Error(`Failed to fetch erasure requests: ${res.status}`)
      const data = await res.json()
      setErasureRequests(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load erasure requests')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchErasureRequests()
  }, [])

  const tabs: { key: typeof activeTab; label: string }[] = [
    { key: 'erasure', label: 'Erasure Requests' },
    { key: 'access', label: 'Access Requests' },
    { key: 'portability', label: 'Portability Requests' },
  ]

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
          <h1 className="text-xl font-semibold mt-2">Data Subject Rights</h1>
        </div>
        <div className="mt-6">
          <DownloadReportButton reportType="dpdpa" label="Download DPDPA Report" />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-800">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === t.key
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'erasure' && (
        <>
          {error && (
            <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
            <h2 className="text-sm font-medium text-slate-400 mb-4">Erasure Requests</h2>
            {loading ? (
              <p className="text-sm text-slate-500">Loading…</p>
            ) : (
              <ErasureTable
                requests={erasureRequests}
                onRefresh={() => { setLoading(true); fetchErasureRequests() }}
              />
            )}
          </div>

          <ErasureRequestForm onSuccess={() => { setLoading(true); fetchErasureRequests() }} />
        </>
      )}

      {activeTab === 'access' && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center">
          <p className="text-slate-400 text-sm mb-1">Access Requests</p>
          <p className="text-slate-500 text-xs">Coming soon — data access request handling will be available in a future release.</p>
        </div>
      )}

      {activeTab === 'portability' && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center">
          <p className="text-slate-400 text-sm mb-1">Portability Requests</p>
          <p className="text-slate-500 text-xs">Coming soon — data portability (DSAR exports) will be available in a future release.</p>
        </div>
      )}
    </div>
  )
}
