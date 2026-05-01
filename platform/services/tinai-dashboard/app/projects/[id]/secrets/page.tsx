'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

interface Secret {
  id: string
  key: string
  created_at: string
  updated_at?: string
}

interface Project {
  id: string
  name: string
  slug: string
}

const inputStyle = {
  backgroundColor: 'var(--t-surface-2)',
  borderColor: 'var(--t-border)',
  color: 'var(--t-text)',
}

function maskKey(key: string): string {
  if (key.length <= 6) return '••••••••'
  return key.slice(0, 4) + '•'.repeat(Math.min(key.length - 4, 14)) + key.slice(-2)
}

export default function ProjectSecretsPage() {
  const params = useParams()
  const id = params.id as string

  const [project, setProject] = useState<Project | null>(null)
  const [secrets, setSecrets] = useState<Secret[]>([])
  const [loadingProject, setLoadingProject] = useState(true)
  const [loadingSecrets, setLoadingSecrets] = useState(true)
  const [revealed, setRevealed] = useState<Record<string, string>>({})
  const [revealing, setRevealing] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState<Secret | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState('')
  const [showNewValue, setShowNewValue] = useState(false)

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/projects/${id}`)
      if (res.ok) setProject(await res.json())
    } finally {
      setLoadingProject(false)
    }
  }, [id])

  const loadSecrets = useCallback(async () => {
    setLoadingSecrets(true)
    try {
      const res = await fetch(`/api/v1/projects/${id}/secrets`)
      if (res.ok) {
        const data = await res.json()
        setSecrets(Array.isArray(data) ? data : data.secrets ?? [])
      }
    } finally {
      setLoadingSecrets(false)
    }
  }, [id])

  useEffect(() => {
    loadProject()
    loadSecrets()
  }, [loadProject, loadSecrets])

  const revealSecret = async (secretId: string) => {
    if (revealed[secretId]) {
      setRevealed(prev => { const next = { ...prev }; delete next[secretId]; return next })
      return
    }
    setRevealing(prev => new Set(prev).add(secretId))
    try {
      const res = await fetch(`/api/v1/projects/${id}/secrets/${secretId}/reveal`)
      if (res.ok) {
        const data = await res.json()
        setRevealed(prev => ({ ...prev, [secretId]: data.value ?? '' }))
      }
    } finally {
      setRevealing(prev => { const next = new Set(prev); next.delete(secretId); return next })
    }
  }

  const copySecret = async (secretId: string, key: string) => {
    let value = revealed[secretId]
    if (!value) {
      const res = await fetch(`/api/v1/projects/${id}/secrets/${secretId}/reveal`)
      if (res.ok) value = (await res.json()).value ?? ''
    }
    if (value) {
      await navigator.clipboard.writeText(value)
    }
  }

  const handleAdd = async () => {
    if (!newKey.trim()) { setAddError('Key is required'); return }
    if (secrets.some(s => s.key === newKey.trim())) { setAddError('Key already exists'); return }
    setAddLoading(true)
    setAddError('')
    try {
      const res = await fetch(`/api/v1/projects/${id}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ key: newKey.trim(), value: newValue }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to add secret')
      setNewKey('')
      setNewValue('')
      setShowAdd(false)
      await loadSecrets()
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed to add')
    } finally {
      setAddLoading(false)
    }
  }

  const handleDelete = async (secret: Secret) => {
    await fetch(`/api/v1/projects/${id}/secrets/${secret.id}`, {
      method: 'DELETE',
      headers: { 'x-tinai-csrf': '1' },
    })
    setConfirmDelete(null)
    setRevealed(prev => { const next = { ...prev }; delete next[secret.id]; return next })
    await loadSecrets()
  }

  if (loadingProject) {
    return (
      <div className="p-8 max-w-4xl mx-auto">
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading…</div>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-6 text-xs" style={{ color: 'var(--t-text-dim)' }}>
        <Link href="/projects" className="hover:text-[#F97316] transition-colors">Projects</Link>
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chevron_right</span>
        <span style={{ color: 'var(--t-text-muted)' }}>{project?.name ?? id}</span>
        <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chevron_right</span>
        <span style={{ color: 'var(--t-text)' }}>Secrets</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline mb-1" style={{ color: 'var(--t-text)' }}>
            Project Secrets
          </h1>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            Encrypted at rest. Available to all workloads in <span className="text-[#F97316]">{project?.name ?? id}</span>.
          </p>
        </div>
        <button
          onClick={() => { setShowAdd(true); setAddError('') }}
          className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors shadow-[0_0_16px_rgba(249,115,22,0.25)]"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          New Secret
        </button>
      </div>

      {/* Info banner */}
      <div className="mb-6 flex items-start gap-3 px-4 py-3 rounded-xl border" style={{ backgroundColor: 'rgba(249,115,22,0.05)', borderColor: 'rgba(249,115,22,0.2)' }}>
        <span className="material-symbols-outlined text-[#F97316] mt-0.5 shrink-0" style={{ fontSize: 16 }}>shield</span>
        <p className="text-xs" style={{ color: 'var(--t-text-muted)' }}>
          Secrets are stored encrypted (AES-256) in tinai Vault. Values are only shown once after creation or when explicitly revealed.
          Use project secrets for shared credentials across environments; use workload env vars for per-service configuration.
        </p>
      </div>

      {/* Add secret modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-md mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h2 className="text-base font-bold mb-1" style={{ color: 'var(--t-text)' }}>New Secret</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-muted)' }}>
              The secret value is encrypted and stored securely. You can reveal it later.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--t-text-muted)' }}>Key name</label>
                <input
                  autoFocus
                  value={newKey}
                  onChange={e => { setNewKey(e.target.value); setAddError('') }}
                  onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                  className="w-full rounded-lg px-3 py-2 text-sm font-mono outline-none border focus:border-[#F97316]/50"
                  style={inputStyle}
                  placeholder="DATABASE_URL"
                />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--t-text-muted)' }}>Value</label>
                <div className="relative">
                  <input
                    type={showNewValue ? 'text' : 'password'}
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd() }}
                    className="w-full rounded-lg px-3 py-2 pr-10 text-sm font-mono outline-none border focus:border-[#F97316]/50"
                    style={inputStyle}
                    placeholder="postgres://user:pass@host:5432/db"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewValue(s => !s)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2"
                    style={{ color: 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      {showNewValue ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                </div>
              </div>
              {addError && <p className="text-xs text-red-400">{addError}</p>}
            </div>
            <div className="flex gap-3 mt-5">
              <button
                onClick={() => { setShowAdd(false); setNewKey(''); setNewValue(''); setAddError('') }}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={addLoading || !newKey.trim()}
                className="flex-1 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A] transition-colors"
              >
                {addLoading ? 'Saving…' : 'Save Secret'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-sm mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-base font-bold mb-2" style={{ color: 'var(--t-text)' }}>Delete secret?</h3>
            <p className="text-sm mb-1" style={{ color: 'var(--t-text-muted)' }}>This will permanently remove:</p>
            <code className="text-sm font-mono text-red-400 block mb-2">{confirmDelete.key}</code>
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-dim)' }}>
              Any workload that references this secret will fail to start until the reference is removed.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg text-sm font-semibold hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Secrets table */}
      {loadingSecrets ? (
        <div className="py-12 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading secrets…</div>
      ) : secrets.length === 0 ? (
        <div className="py-16 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>lock</span>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No secrets yet</p>
          <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>
            Add database URLs, API keys, and other sensitive values
          </p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
          {/* Table header */}
          <div
            className="grid grid-cols-[auto_1fr_auto_auto] gap-4 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b"
            style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)', color: 'var(--t-text-dim)' }}
          >
            <span></span>
            <span>Key</span>
            <span>Last updated</span>
            <span className="text-right">Actions</span>
          </div>

          {secrets.map((s, i) => {
            const isRevealed = !!revealed[s.id]
            const isRevealing = revealing.has(s.id)
            return (
              <div
                key={s.id}
                className="grid grid-cols-[auto_1fr_auto_auto] gap-4 items-center px-4 py-3.5 border-b last:border-b-0"
                style={{
                  borderColor: 'var(--t-border)',
                  backgroundColor: i % 2 === 0 ? 'var(--t-surface)' : 'var(--t-surface-2)',
                }}
              >
                {/* Lock icon */}
                <span className="material-symbols-outlined text-amber-400" style={{ fontSize: 16 }}>lock</span>

                {/* Key + value */}
                <div className="min-w-0">
                  <div className="flex items-center gap-3">
                    <code className="text-sm font-mono font-semibold" style={{ color: 'var(--t-text)' }}>{s.key}</code>
                  </div>
                  <div className="mt-0.5">
                    <code className="text-xs font-mono" style={{ color: 'var(--t-text-dim)' }}>
                      {isRevealed ? revealed[s.id] : maskKey(s.key)}
                    </code>
                  </div>
                </div>

                {/* Date */}
                <span className="text-xs shrink-0" style={{ color: 'var(--t-text-dim)' }}>
                  {new Date(s.updated_at ?? s.created_at).toLocaleDateString('en-IN')}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-0.5 shrink-0">
                  <button
                    onClick={() => revealSecret(s.id)}
                    disabled={isRevealing}
                    title={isRevealed ? 'Hide' : 'Reveal value'}
                    className="p-1.5 rounded-md transition-colors disabled:opacity-50"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      {isRevealing ? 'hourglass_empty' : isRevealed ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                  <button
                    onClick={() => copySecret(s.id, s.key)}
                    title="Copy value"
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>content_copy</span>
                  </button>
                  <button
                    onClick={() => setConfirmDelete(s)}
                    title="Delete secret"
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(239,68,68,0.1)'; (e.currentTarget as HTMLElement).style.color = '#f87171' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
