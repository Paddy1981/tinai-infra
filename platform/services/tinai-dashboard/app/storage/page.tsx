'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  listBuckets,
  createBucket,
  deleteBucket,
  listDatabases,
  createDatabase,
  deleteDatabase,
  StorageBucket,
  StorageDatabase,
} from '@/lib/storage-api'

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; className: string; pulse?: boolean }> = {
    provisioning: { label: 'Provisioning', className: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30', pulse: true },
    active:       { label: 'Active',       className: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
    suspended:    { label: 'Suspended',    className: 'bg-orange-500/10 text-orange-400 border border-orange-500/30' },
    deleting:     { label: 'Deleting',     className: 'bg-red-500/10 text-red-400 border border-red-500/30', pulse: true },
  }
  const { label, className, pulse } = map[status] ?? map.active
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className} ${pulse ? 'animate-pulse' : ''}`}>
      {label}
    </span>
  )
}

// ── Region badge ──────────────────────────────────────────────────────────────

function RegionBadge({ region }: { region: string }) {
  const map: Record<string, { label: string; className: string }> = {
    in: { label: 'India',  className: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
    qa: { label: 'Qatar',  className: 'bg-blue-500/10 text-blue-400 border border-blue-500/30' },
    ae: { label: 'UAE',    className: 'bg-purple-500/10 text-purple-400 border border-purple-500/30' },
  }
  const { label, className } = map[region] ?? { label: region.toUpperCase(), className: 'bg-slate-500/10 text-slate-400 border border-slate-500/30' }
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}

// ── Used bytes formatter ──────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
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
        <p className="text-sm text-slate-400 mb-5">
          This action is irreversible. All data will be permanently deleted.
        </p>
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

// ── Object Storage tab ────────────────────────────────────────────────────────

function BucketsTab() {
  const [buckets, setBuckets] = useState<StorageBucket[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // New bucket form state
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formRegion, setFormRegion] = useState('in')
  const [formQuota, setFormQuota] = useState(50)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<StorageBucket | null>(null)
  const [deleting, setDeleting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    listBuckets()
      .then(setBuckets)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const bucket = await createBucket({ name: formName, region: formRegion, quota_gb: formQuota })
      setBuckets((prev) => [...prev, bucket])
      setShowForm(false)
      setFormName('')
      setFormRegion('in')
      setFormQuota(50)
    } catch (e) {
      setCreateError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteBucket(deleteTarget.id)
      setBuckets((prev) => prev.filter((b) => b.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
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

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">S3-compatible object storage — served from Indian data centres</p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Bucket
        </button>
      </div>

      {/* ── Inline create form ──────────────────────────────────────────── */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-slate-700 bg-slate-900/80 p-5 mb-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-200">Create Object Bucket</h3>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Bucket Name</label>
            <input
              type="text"
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. my-dataset"
              pattern="[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1">DNS label: lowercase letters, numbers and hyphens; 3–63 chars</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Region</label>
            <select
              value={formRegion}
              onChange={(e) => setFormRegion(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
            >
              <option value="in">India (Mumbai)</option>
              <option value="qa">Qatar (Doha)</option>
              <option value="ae">UAE (Abu Dhabi)</option>
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-400">Quota</label>
              <span className="text-xs font-semibold text-emerald-400">{formQuota} GB</span>
            </div>
            <input
              type="range"
              min={5}
              max={500}
              step={5}
              value={formQuota}
              onChange={(e) => setFormQuota(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-slate-600 mt-0.5">
              <span>5 GB</span>
              <span>500 GB</span>
            </div>
          </div>

          {createError && (
            <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
              {createError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={creating || !formName.trim()}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
            >
              {creating ? 'Creating…' : 'Create Bucket'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setCreateError(null) }}
              className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-slate-800 bg-slate-900 h-14 animate-pulse" />
          ))}
        </div>
      ) : buckets.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-8 py-14 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800">
            <svg className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5M10 11.25h4M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
            </svg>
          </div>
          <p className="text-slate-300 font-medium mb-1">No buckets yet</p>
          <p className="text-slate-500 text-sm">Create your first S3-compatible object bucket above</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60">
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Region</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Quota</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider w-48">Used</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Endpoint</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {buckets.map((b) => {
                const usedGb = b.used_bytes / (1024 * 1024 * 1024)
                const pct = Math.min(100, (usedGb / b.quota_gb) * 100)
                return (
                  <tr key={b.id} className="bg-slate-900 hover:bg-slate-800/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{b.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{b.id.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <RegionBadge region={b.region} />
                    </td>
                    <td className="px-4 py-3 text-slate-300">{b.quota_gb} GB</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-slate-700 min-w-[60px]">
                          <div
                            className={`h-1.5 rounded-full transition-all ${pct > 85 ? 'bg-red-500' : pct > 60 ? 'bg-yellow-500' : 'bg-emerald-500'}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-xs text-slate-400 whitespace-nowrap">{formatBytes(b.used_bytes)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={b.status} />
                    </td>
                    <td className="px-4 py-3">
                      {b.endpoint_url ? (
                        <span className="text-xs text-slate-400 font-mono truncate max-w-[160px] block" title={b.endpoint_url}>
                          {b.endpoint_url.replace(/^https?:\/\//, '').slice(0, 32)}{b.endpoint_url.length > 40 ? '…' : ''}
                        </span>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setDeleteTarget(b)}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors border border-red-800 hover:border-red-700 rounded px-2 py-0.5"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Databases tab ─────────────────────────────────────────────────────────────

function DatabasesTab() {
  const [databases, setDatabases] = useState<StorageDatabase[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // New database form state
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formPgVersion, setFormPgVersion] = useState('16')
  const [formStorage, setFormStorage] = useState(50)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // Delete confirm state
  const [deleteTarget, setDeleteTarget] = useState<StorageDatabase | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Revealed connection strings
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState<string | null>(null)

  const load = useCallback(() => {
    setLoading(true)
    listDatabases()
      .then(setDatabases)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setCreating(true)
    setCreateError(null)
    try {
      const db = await createDatabase({ name: formName, pg_version: formPgVersion, storage_gb: formStorage })
      setDatabases((prev) => [...prev, db])
      setShowForm(false)
      setFormName('')
      setFormPgVersion('16')
      setFormStorage(50)
    } catch (e) {
      setCreateError((e as Error).message)
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteDatabase(deleteTarget.id)
      setDatabases((prev) => prev.filter((d) => d.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setDeleting(false)
    }
  }

  function toggleReveal(id: string) {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function copyConnString(id: string, connStr: string) {
    await navigator.clipboard.writeText(connStr)
    setCopied(id)
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000)
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

      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-slate-400">Managed PostgreSQL databases with automatic backups</p>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          New Database
        </button>
      </div>

      {/* ── Inline create form ──────────────────────────────────────────── */}
      {showForm && (
        <form
          onSubmit={handleCreate}
          className="rounded-lg border border-slate-700 bg-slate-900/80 p-5 mb-5 space-y-4"
        >
          <h3 className="text-sm font-semibold text-slate-200">Create PostgreSQL Database</h3>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Database Name</label>
            <input
              type="text"
              required
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. myapp-db"
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
            />
            <p className="text-xs text-slate-500 mt-1">Lowercase letters, numbers and hyphens</p>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">PostgreSQL Version</label>
            <select
              value={formPgVersion}
              onChange={(e) => setFormPgVersion(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none focus:ring-1 focus:ring-emerald-500 transition-colors"
            >
              <option value="16">PostgreSQL 16 (recommended)</option>
              <option value="15">PostgreSQL 15</option>
              <option value="14">PostgreSQL 14</option>
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-400">Storage</label>
              <span className="text-xs font-semibold text-emerald-400">{formStorage} GB</span>
            </div>
            <input
              type="range"
              min={10}
              max={500}
              step={10}
              value={formStorage}
              onChange={(e) => setFormStorage(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
            <div className="flex justify-between text-xs text-slate-600 mt-0.5">
              <span>10 GB</span>
              <span>500 GB</span>
            </div>
          </div>

          {createError && (
            <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
              {createError}
            </div>
          )}

          <div className="flex gap-3 pt-1">
            <button
              type="submit"
              disabled={creating || !formName.trim()}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-900 disabled:text-emerald-700 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white transition-colors"
            >
              {creating ? 'Creating…' : 'Create Database'}
            </button>
            <button
              type="button"
              onClick={() => { setShowForm(false); setCreateError(null) }}
              className="rounded-lg border border-slate-700 bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-lg border border-slate-800 bg-slate-900 h-14 animate-pulse" />
          ))}
        </div>
      ) : databases.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-8 py-14 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800">
            <svg className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375m16.5 2.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125" />
            </svg>
          </div>
          <p className="text-slate-300 font-medium mb-1">No databases yet</p>
          <p className="text-slate-500 text-sm">Create a managed PostgreSQL database above</p>
        </div>
      ) : (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60">
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">PG Version</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Storage</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Connection</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Host:Port</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {databases.map((db) => {
                const isRevealed = revealed.has(db.id)
                const isCopied = copied === db.id
                return (
                  <tr key={db.id} className="bg-slate-900 hover:bg-slate-800/60 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{db.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{db.id.slice(0, 8)}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/30">
                        PG {db.pg_version}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-300">{db.storage_gb} GB</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={db.status} />
                    </td>
                    <td className="px-4 py-3 max-w-[260px]">
                      {db.connection_string ? (
                        <div className="flex items-center gap-2">
                          <code
                            className={`text-xs font-mono rounded px-2 py-0.5 truncate max-w-[180px] block transition-all ${
                              isRevealed
                                ? 'bg-slate-800 text-slate-300'
                                : 'bg-slate-800 text-transparent select-none blur-[4px]'
                            }`}
                            title={isRevealed ? db.connection_string : ''}
                          >
                            {db.connection_string}
                          </code>
                          <button
                            onClick={() => toggleReveal(db.id)}
                            className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
                            title={isRevealed ? 'Hide' : 'Reveal'}
                          >
                            {isRevealed ? (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                              </svg>
                            ) : (
                              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                              </svg>
                            )}
                          </button>
                          {isRevealed && (
                            <button
                              onClick={() => copyConnString(db.id, db.connection_string!)}
                              className="shrink-0 text-slate-500 hover:text-emerald-400 transition-colors"
                              title="Copy"
                            >
                              {isCopied ? (
                                <svg className="h-4 w-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                              ) : (
                                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-600 text-xs">Provisioning…</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {db.host ? (
                        <code className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono">
                          {db.host}:{db.port}
                        </code>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setDeleteTarget(db)}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors border border-red-800 hover:border-red-700 rounded px-2 py-0.5"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

type Tab = 'buckets' | 'databases'

const TABS: { value: Tab; label: string }[] = [
  { value: 'buckets',   label: 'Object Storage' },
  { value: 'databases', label: 'Databases' },
]

export default function StoragePage() {
  const [activeTab, setActiveTab] = useState<Tab>('buckets')

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Storage</h1>
          <p className="text-sm text-slate-500 mt-0.5">Object buckets and managed databases — data stays in India</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-slate-800">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setActiveTab(tab.value)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.value
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'buckets'   && <BucketsTab />}
      {activeTab === 'databases' && <DatabasesTab />}
    </div>
  )
}
