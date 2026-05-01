'use client'

import { useState, useEffect } from 'react'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = ''

interface NotificationDraft {
  subject: string
  body: string
  recommended_actions: string[]
}

interface BreachIncident {
  id: string
  tenant_id: string | null
  region: string
  detected_at: string
  description: string | null
  affected_categories: string[]
  affected_records: number
  status: string
  notification_draft: NotificationDraft | null
  regulator_notified_at: string | null
  principals_notified_at: string | null
  resolved_at: string | null
  hours_remaining: number
  deadline_passed: boolean
}

const REGIONS = ['IN', 'QA', 'AE']
const CATEGORY_OPTIONS = ['personal_data', 'financial_data', 'health_data', 'biometric_data', 'location_data', 'communications']

function StatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    detected: 'bg-amber-900/50 text-amber-400 border-amber-800',
    notified: 'bg-blue-900/50 text-blue-400 border-blue-800',
    investigating: 'bg-purple-900/50 text-purple-400 border-purple-800',
    closed: 'bg-emerald-900/50 text-emerald-400 border-emerald-800',
  }
  const cls = colours[status] ?? 'bg-slate-800 text-slate-400 border-slate-700'
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs border ${cls}`}>
      {status}
    </span>
  )
}

function HoursRemainingPill({ hours, resolved }: { hours: number; resolved: boolean }) {
  if (resolved) {
    return <span className="inline-block rounded px-2 py-0.5 text-xs border bg-slate-800 text-slate-500 border-slate-700">resolved</span>
  }
  if (hours <= 0) {
    return <span className="inline-block rounded px-2 py-0.5 text-xs border bg-red-900/50 text-red-400 border-red-800">overdue</span>
  }
  if (hours < 24) {
    return <span className="inline-block rounded px-2 py-0.5 text-xs border bg-red-900/50 text-red-400 border-red-800">{hours}h left</span>
  }
  if (hours < 48) {
    return <span className="inline-block rounded px-2 py-0.5 text-xs border bg-amber-900/50 text-amber-400 border-amber-800">{hours}h left</span>
  }
  return <span className="inline-block rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">{hours}h left</span>
}

function DraftView({ draft }: { draft: NotificationDraft }) {
  return (
    <div className="mt-3 rounded-md border border-slate-700 bg-slate-950 p-3 text-xs">
      <p className="text-slate-400 font-medium mb-1">Subject: <span className="text-slate-200">{draft.subject}</span></p>
      <pre className="text-slate-300 whitespace-pre-wrap leading-relaxed mb-3">{draft.body}</pre>
      {draft.recommended_actions.length > 0 && (
        <div>
          <p className="text-slate-500 mb-1">Recommended actions:</p>
          <ul className="list-disc list-inside text-slate-400 space-y-0.5">
            {draft.recommended_actions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function IncidentRow({ incident, onRefresh }: { incident: BreachIncident; onRefresh: () => void }) {
  const [showDraft, setShowDraft] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const detectedAt = new Date(incident.detected_at).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  })

  async function callAction(endpoint: string) {
    setActionLoading(true)
    setActionError(null)
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/breach/${incident.id}/${endpoint}`, {
        method: 'POST',
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      onRefresh()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Action failed')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <>
      <tr className="text-slate-300">
        <td className="py-2.5 text-xs text-slate-400">{detectedAt}</td>
        <td className="py-2.5 text-xs font-mono">{incident.region}</td>
        <td className="py-2.5"><StatusBadge status={incident.status} /></td>
        <td className="py-2.5 text-xs text-slate-400">{incident.affected_records.toLocaleString()}</td>
        <td className="py-2.5">
          <HoursRemainingPill hours={incident.hours_remaining} resolved={!!incident.resolved_at} />
        </td>
        <td className="py-2.5">
          <div className="flex flex-wrap gap-1">
            {incident.notification_draft && (
              <button
                onClick={() => setShowDraft(d => !d)}
                className="rounded px-2 py-0.5 text-xs border border-slate-700 text-slate-300 hover:border-slate-600 transition-colors"
              >
                {showDraft ? 'Hide Draft' : 'View Draft'}
              </button>
            )}
            {incident.status === 'detected' && (
              <button
                onClick={() => callAction('notify-regulator')}
                disabled={actionLoading}
                className="rounded px-2 py-0.5 text-xs border border-blue-800 text-blue-400 hover:bg-blue-900/30 disabled:opacity-40 transition-colors"
              >
                Mark Notified
              </button>
            )}
            {incident.status !== 'closed' && (
              <button
                onClick={() => callAction('resolve')}
                disabled={actionLoading}
                className="rounded px-2 py-0.5 text-xs border border-emerald-800 text-emerald-400 hover:bg-emerald-900/30 disabled:opacity-40 transition-colors"
              >
                Resolve
              </button>
            )}
          </div>
          {actionError && <p className="text-xs text-red-400 mt-1">{actionError}</p>}
        </td>
      </tr>
      {showDraft && incident.notification_draft && (
        <tr>
          <td colSpan={6} className="pb-3 px-0">
            <DraftView draft={incident.notification_draft} />
          </td>
        </tr>
      )}
    </>
  )
}

function ReportForm({ onSuccess }: { onSuccess: () => void }) {
  const [description, setDescription] = useState('')
  const [selectedCategories, setSelectedCategories] = useState<string[]>([])
  const [affectedRecords, setAffectedRecords] = useState('')
  const [region, setRegion] = useState(REGIONS[0])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  function toggleCategory(cat: string) {
    setSelectedCategories(prev =>
      prev.includes(cat) ? prev.filter(c => c !== cat) : [...prev, cat]
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/breach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description,
          affected_categories: selectedCategories,
          affected_records: parseInt(affectedRecords, 10) || 0,
          region,
        }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      setSuccess(true)
      setDescription('')
      setSelectedCategories([])
      setAffectedRecords('')
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to report breach')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <h2 className="text-sm font-medium text-slate-400 mb-4">Report New Breach</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-slate-500">Description</label>
          <textarea
            rows={3}
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe the incident…"
            className="resize-none rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs text-slate-500">Affected Categories</label>
          <div className="flex flex-wrap gap-2">
            {CATEGORY_OPTIONS.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => toggleCategory(cat)}
                className={`rounded px-2 py-1 text-xs border transition-colors ${
                  selectedCategories.includes(cat)
                    ? 'bg-emerald-900/50 text-emerald-400 border-emerald-800'
                    : 'bg-slate-800 text-slate-400 border-slate-700 hover:border-slate-600'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-slate-500">Affected Records</label>
            <input
              type="number"
              min="0"
              value={affectedRecords}
              onChange={e => setAffectedRecords(e.target.value)}
              placeholder="0"
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none"
            />
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

        {error && <p className="text-xs text-red-400">{error}</p>}
        {success && <p className="text-xs text-emerald-400">Breach reported successfully. 72-hour notification clock started.</p>}

        <div>
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-red-700 px-4 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Reporting…' : 'Report Breach'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default function BreachPage() {
  const [incidents, setIncidents] = useState<BreachIncident[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function fetchIncidents() {
    try {
      const res = await fetch(`${API_URL}/api/v1/compliance/breach`)
      if (!res.ok) throw new Error(`Failed to fetch incidents: ${res.status}`)
      const data = await res.json()
      setIncidents(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load incidents')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchIncidents()
  }, [])

  const activeIncidents = incidents.filter(i => i.hours_remaining > 0 && !i.resolved_at)
  const deadlinePassed = incidents.filter(i => i.deadline_passed && !i.regulator_notified_at && !i.resolved_at)

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
          <h1 className="text-xl font-semibold mt-2">Breach Incidents</h1>
        </div>
        <div className="mt-6">
          <DownloadReportButton reportType="soc2" label="Download SOC 2 Report" />
        </div>
      </div>

      {activeIncidents.length > 0 && (
        <div className="rounded-lg border border-amber-800 bg-amber-950/30 px-4 py-3 flex items-center gap-2">
          <span className="text-amber-400">&#9888;</span>
          <p className="text-sm text-amber-300">
            {activeIncidents.length} active incident{activeIncidents.length !== 1 ? 's' : ''} — 72-hour notification window open
          </p>
        </div>
      )}

      {deadlinePassed.length > 0 && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 flex items-center gap-2">
          <span className="text-red-400">&#9888;</span>
          <p className="text-sm text-red-300">
            Notification deadline exceeded for {deadlinePassed.length} incident{deadlinePassed.length !== 1 ? 's' : ''} — regulatory action may be required
          </p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">
          Incidents
          <span className="ml-2 text-xs font-normal text-slate-600">({incidents.length})</span>
        </h2>

        {loading && <p className="text-sm text-slate-500">Loading…</p>}

        {!loading && incidents.length === 0 && !error && (
          <p className="text-sm text-slate-500">No breach incidents recorded.</p>
        )}

        {!loading && incidents.length > 0 && (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Detected</th>
                <th className="pb-2 font-medium">Region</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Affected Records</th>
                <th className="pb-2 font-medium">Time Remaining</th>
                <th className="pb-2 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {incidents.map(incident => (
                <IncidentRow key={incident.id} incident={incident} onRefresh={() => { setLoading(true); fetchIncidents() }} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <ReportForm onSuccess={() => { setLoading(true); fetchIncidents() }} />
    </div>
  )
}
