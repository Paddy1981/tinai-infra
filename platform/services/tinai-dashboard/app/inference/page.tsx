'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  listModels,
  listEndpoints,
  createEndpoint,
  patchEndpoint,
  deleteEndpoint,
  getEndpointUsage,
  InferenceModel,
  InferenceEndpoint,
  InferenceUsageDay,
} from '@/lib/inference-api'

// ── Provider helpers ──────────────────────────────────────────────────────────

const PROVIDER_CONFIG: Record<string, { label: string; initials: string; bg: string; text: string }> = {
  anthropic: { label: 'Anthropic', initials: 'A',  bg: 'bg-indigo-900/40',  text: 'text-indigo-300' },
  sarvam:    { label: 'Sarvam',    initials: 'S',  bg: 'bg-orange-900/40',  text: 'text-orange-300' },
  krutrim:   { label: 'Krutrim',   initials: 'K',  bg: 'bg-green-900/40',   text: 'text-green-300'  },
  gemini:    { label: 'Gemini',    initials: 'G',  bg: 'bg-blue-900/40',    text: 'text-blue-300'   },
  openai:    { label: 'OpenAI',    initials: 'O',  bg: 'bg-slate-700/60',   text: 'text-slate-300'  },
}

function providerCfg(provider: string) {
  return PROVIDER_CONFIG[provider.toLowerCase()] ?? {
    label: provider,
    initials: provider.slice(0, 1).toUpperCase(),
    bg: 'bg-slate-700/60',
    text: 'text-slate-300',
  }
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string }> = {
    active: { label: 'Active', className: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
    paused: { label: 'Paused', className: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30' },
  }
  const { label, className } = map[status] ?? map.paused
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}

// ── Rupees formatter ──────────────────────────────────────────────────────────

function paiseToRupees(paise: number): string {
  return `₹${(paise / 100).toFixed(2)}`
}

// ── Confirm delete dialog ─────────────────────────────────────────────────────

function ConfirmDeleteDialog({
  name,
  onConfirm,
  onCancel,
  busy,
}: {
  name: string
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl w-full max-w-sm">
        <h3 className="text-base font-semibold text-slate-100 mb-2">Delete &ldquo;{name}&rdquo;?</h3>
        <p className="text-sm text-slate-400 mb-5">This will immediately revoke the API key for this endpoint.</p>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="rounded-lg bg-red-700 hover:bg-red-600 disabled:bg-red-900 disabled:text-red-700 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {busy ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Endpoint card ─────────────────────────────────────────────────────────────

function EndpointCard({
  endpoint,
  todayUsage,
  onToggle,
  onDelete,
  toggling,
}: {
  endpoint: InferenceEndpoint
  todayUsage: InferenceUsageDay | null
  onToggle: () => void
  onDelete: () => void
  toggling: boolean
}) {
  const cfg = providerCfg(endpoint.provider)
  const todayCost = todayUsage ? paiseToRupees(todayUsage.cost_paise) : '₹0.00'
  const todayReqs = todayUsage?.request_count ?? 0

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5 flex flex-col gap-4 hover:border-slate-700 transition-colors">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold ${cfg.bg} ${cfg.text}`}>
          {cfg.initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-semibold text-slate-100 text-sm truncate">{endpoint.name}</p>
            <StatusBadge status={endpoint.status} />
          </div>
          <p className="text-xs text-slate-500 mt-0.5 truncate">
            {cfg.label} · {endpoint.model_name ?? endpoint.model}
          </p>
        </div>
      </div>

      {/* Rate limits */}
      <div className="flex gap-2 flex-wrap">
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 border border-slate-700">
          {endpoint.rpm_limit} RPM
        </span>
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 border border-slate-700">
          {endpoint.tpm_limit.toLocaleString()} TPM
        </span>
        {endpoint.monthly_budget_paise > 0 && (
          <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-mono bg-slate-800 text-slate-400 border border-slate-700">
            {paiseToRupees(endpoint.monthly_budget_paise)}/mo cap
          </span>
        )}
      </div>

      {/* Today's usage */}
      <div className="rounded-lg bg-slate-800/60 border border-slate-700/50 px-3 py-2 flex items-center justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500 mb-0.5">Today&rsquo;s requests</p>
          <p className="text-sm font-semibold text-slate-200">{todayReqs.toLocaleString()}</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500 mb-0.5">Today&rsquo;s cost</p>
          <p className="text-sm font-semibold text-emerald-400">{todayCost}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1 border-t border-slate-800">
        <button
          onClick={onToggle}
          disabled={toggling}
          className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
            endpoint.status === 'active'
              ? 'border-yellow-700 text-yellow-400 hover:bg-yellow-900/20'
              : 'border-emerald-700 text-emerald-400 hover:bg-emerald-900/20'
          }`}
        >
          {toggling ? '…' : endpoint.status === 'active' ? 'Pause' : 'Resume'}
        </button>
        <button
          onClick={onDelete}
          className="rounded-lg border border-red-800 text-red-400 hover:bg-red-900/20 px-3 py-1.5 text-xs font-medium transition-colors"
        >
          Delete
        </button>
      </div>
    </div>
  )
}

// ── New endpoint form ─────────────────────────────────────────────────────────

function NewEndpointForm({
  models,
  onCreated,
  onCancel,
}: {
  models: InferenceModel[]
  onCreated: (ep: InferenceEndpoint) => void
  onCancel: () => void
}) {
  const providers = Array.from(new Set(models.map((m) => m.provider)))
  const [provider, setProvider] = useState(providers[0] ?? '')
  const [modelId, setModelId] = useState('')
  const [name, setName] = useState('')
  const [rpm, setRpm] = useState(60)
  const [tpm, setTpm] = useState(100000)
  const [budgetRupees, setBudgetRupees] = useState(0)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const providerModels = models.filter((m) => m.provider === provider)

  // Auto-suggest name when model changes
  useEffect(() => {
    if (modelId) {
      const slug = modelId.replace(/[^a-z0-9]/gi, '-').toLowerCase()
      setName(`${slug}-prod`)
    }
  }, [modelId])

  // Reset model when provider changes
  useEffect(() => {
    setModelId(providerModels[0]?.model_id ?? '')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setError(null)
    try {
      const ep = await createEndpoint({
        name,
        provider,
        model: modelId,
        rpm_limit: rpm,
        tpm_limit: tpm,
        monthly_budget_paise: Math.round(budgetRupees * 100),
      })
      onCreated(ep)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-slate-700 bg-slate-900/80 p-5 mb-6 space-y-4"
    >
      <h3 className="text-sm font-semibold text-slate-200">New Inference Endpoint</h3>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Provider</label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
          >
            {providers.map((p) => (
              <option key={p} value={p}>{providerCfg(p).label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Model</label>
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
          >
            {providerModels.map((m) => (
              <option key={m.model_id} value={m.model_id}>{m.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">Endpoint Name</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. claude-3-haiku-prod"
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">RPM Limit</label>
          <input
            type="number"
            min={1}
            max={10000}
            value={rpm}
            onChange={(e) => setRpm(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
          />
          <p className="text-xs text-slate-500 mt-1">Requests per minute</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">TPM Limit</label>
          <input
            type="number"
            min={1000}
            max={10000000}
            step={1000}
            value={tpm}
            onChange={(e) => setTpm(Number(e.target.value))}
            className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
          />
          <p className="text-xs text-slate-500 mt-1">Tokens per minute</p>
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-slate-400 mb-1">
          Monthly Budget (₹) — <span className="text-slate-500">0 = unlimited</span>
        </label>
        <input
          type="number"
          min={0}
          step={100}
          value={budgetRupees}
          onChange={(e) => setBudgetRupees(Number(e.target.value))}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
        />
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="flex gap-3 pt-1">
        <button
          type="submit"
          disabled={creating || !name.trim() || !modelId}
          className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
        >
          {creating ? 'Creating…' : 'Create Endpoint'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  )
}

// ── Usage table ───────────────────────────────────────────────────────────────

function UsageTable({ usageMap }: { usageMap: Map<string, InferenceUsageDay[]> }) {
  // Aggregate all endpoints' usage by day
  const aggregated = new Map<string, { request_count: number; input_tokens: number; output_tokens: number; cost_paise: number }>()
  usageMap.forEach((days) => {
    days.forEach((d) => {
      const existing = aggregated.get(d.day) ?? { request_count: 0, input_tokens: 0, output_tokens: 0, cost_paise: 0 }
      aggregated.set(d.day, {
        request_count: existing.request_count + d.request_count,
        input_tokens: existing.input_tokens + d.input_tokens,
        output_tokens: existing.output_tokens + d.output_tokens,
        cost_paise: existing.cost_paise + d.cost_paise,
      })
    })
  })

  const rows = Array.from(aggregated.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 30)

  const totalCostPaise = rows.reduce((sum, [, v]) => sum + v.cost_paise, 0)

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-8 py-10 text-center">
        <p className="text-slate-400 text-sm">No usage data yet.</p>
        <p className="text-slate-600 text-xs mt-1">Usage will appear here once endpoints receive requests.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="flex items-baseline gap-3 mb-4">
        <p className="text-sm text-slate-400">Total cost this month</p>
        <p className="text-2xl font-bold text-emerald-400">{paiseToRupees(totalCostPaise)}</p>
      </div>

      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/60">
              <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Date</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Requests</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Input tokens</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Output tokens</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-slate-400 uppercase tracking-wider">Cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800">
            {rows.map(([day, v]) => (
              <tr key={day} className="bg-slate-900 hover:bg-slate-800/60 transition-colors">
                <td className="px-4 py-3 text-slate-300 font-mono text-xs">{day}</td>
                <td className="px-4 py-3 text-right text-slate-300">{v.request_count.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-slate-400 text-xs">{v.input_tokens.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-slate-400 text-xs">{v.output_tokens.toLocaleString()}</td>
                <td className="px-4 py-3 text-right text-emerald-400 font-medium">{paiseToRupees(v.cost_paise)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function InferencePage() {
  const [models, setModels] = useState<InferenceModel[]>([])
  const [endpoints, setEndpoints] = useState<InferenceEndpoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Usage per endpoint id → array of days
  const [usageMap, setUsageMap] = useState<Map<string, InferenceUsageDay[]>>(new Map())
  const [usageLoading, setUsageLoading] = useState(false)

  // Form / delete state
  const [showForm, setShowForm] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<InferenceEndpoint | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([listModels(), listEndpoints()])
      .then(([m, e]) => { setModels(m); setEndpoints(e) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  // Fetch usage for all endpoints
  useEffect(() => {
    if (endpoints.length === 0) return
    setUsageLoading(true)
    const today = new Date().toISOString().slice(0, 10)
    Promise.all(
      endpoints.map((ep) =>
        getEndpointUsage(ep.id, 30)
          .then((days) => [ep.id, days] as const)
          .catch(() => [ep.id, []] as const)
      )
    ).then((results) => {
      const map = new Map<string, InferenceUsageDay[]>()
      results.forEach(([id, days]) => map.set(id, days as InferenceUsageDay[]))
      setUsageMap(map)
    }).finally(() => setUsageLoading(false))
  }, [endpoints])

  // Today's usage lookup helper
  function todayUsage(endpointId: string): InferenceUsageDay | null {
    const today = new Date().toISOString().slice(0, 10)
    return usageMap.get(endpointId)?.find((d) => d.day === today) ?? null
  }

  async function handleToggle(ep: InferenceEndpoint) {
    setTogglingId(ep.id)
    try {
      const updated = await patchEndpoint(ep.id, {
        status: ep.status === 'active' ? 'paused' : 'active',
      })
      setEndpoints((prev) => prev.map((e) => (e.id === ep.id ? updated : e)))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteEndpoint(deleteTarget.id)
      setEndpoints((prev) => prev.filter((e) => e.id !== deleteTarget.id))
      setUsageMap((prev) => { const next = new Map(prev); next.delete(deleteTarget.id); return next })
      setDeleteTarget(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  function handleCreated(ep: InferenceEndpoint) {
    setEndpoints((prev) => [...prev, ep])
    setShowForm(false)
  }

  return (
    <div>
      {deleteTarget && (
        <ConfirmDeleteDialog
          name={deleteTarget.name}
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
          busy={deleting}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Inference</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Managed AI model endpoints with rate limiting and spend caps
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Endpoint
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-5">
          {error}
          <button
            onClick={() => setError(null)}
            className="ml-3 underline text-red-300 hover:text-red-200 text-xs"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* New endpoint inline form */}
      {showForm && !loading && (
        <NewEndpointForm
          models={models}
          onCreated={handleCreated}
          onCancel={() => setShowForm(false)}
        />
      )}

      {/* Endpoint cards */}
      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-slate-800 bg-slate-900 h-52 animate-pulse" />
          ))}
        </div>
      ) : endpoints.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-8 py-14 text-center mb-8">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800">
            <svg className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
            </svg>
          </div>
          <p className="text-slate-300 font-medium mb-1">No endpoints yet</p>
          <p className="text-slate-500 text-sm mb-4">Create a managed inference endpoint to get an API key and rate-limited proxy</p>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            Create your first endpoint →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
          {endpoints.map((ep) => (
            <EndpointCard
              key={ep.id}
              endpoint={ep}
              todayUsage={usageLoading ? null : todayUsage(ep.id)}
              onToggle={() => handleToggle(ep)}
              onDelete={() => setDeleteTarget(ep)}
              toggling={togglingId === ep.id}
            />
          ))}
        </div>
      )}

      {/* Usage section */}
      {endpoints.length > 0 && (
        <section>
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-semibold text-slate-200">30-Day Usage</h2>
            <span className="text-xs text-slate-500">aggregated across all endpoints</span>
            {usageLoading && (
              <svg className="h-4 w-4 animate-spin text-slate-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
          </div>
          {!usageLoading && <UsageTable usageMap={usageMap} />}
        </section>
      )}
    </div>
  )
}
