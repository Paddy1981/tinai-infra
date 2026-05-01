'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface AppDeployment {
  image: string | null
  replicas: number
  ready_replicas: number
  status: 'running' | 'deploying'
}

interface App {
  id: string
  name: string
  owner: string
  repo_full_name?: string
  created_at: string
  deployment: AppDeployment | null
}

const STATUS_COLOR: Record<string, string> = {
  running:   'text-emerald-400 bg-emerald-400/10',
  deploying: 'text-yellow-400 bg-yellow-400/10',
  stopped:   'text-slate-500 bg-slate-500/10',
}

export default function WorkloadsPage() {
  const [apps, setApps] = useState<App[]>([])
  const [loading, setLoading] = useState(true)
  const [restarting, setRestarting] = useState<string | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/apps')
      if (!res.ok) throw new Error(`Failed to load apps (${res.status})`)
      const data = await res.json()
      setApps(Array.isArray(data) ? data : [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load apps')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const restart = async (name: string) => {
    setRestarting(name)
    try {
      await fetch(`/api/v1/apps/${name}/deploy`, {
        method: 'POST',
        headers: { 'x-tinai-csrf': '1' },
      })
      await load()
    } finally {
      setRestarting(null)
    }
  }

  const remove = async (name: string) => {
    if (!confirm(`Delete app "${name}"? This cannot be undone.`)) return
    await fetch(`/api/v1/apps/${name}`, {
      method: 'DELETE',
      headers: { 'x-tinai-csrf': '1' },
    })
    await load()
  }

  const getStatus = (app: App): string => {
    if (!app.deployment) return 'stopped'
    return app.deployment.status
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>Workloads</h1>
          </div>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            K8s deployments in the tinai-apps namespace
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
            Refresh
          </button>
          <Link
            href="/apps/new"
            className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors shadow-[0_0_16px_rgba(249,115,22,0.25)]"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
            Deploy
          </Link>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mb-6 p-4 rounded-lg border border-red-500/30 bg-red-500/10 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="text-center py-20" style={{ color: 'var(--t-text-muted)' }}>Loading...</div>
      ) : apps.length === 0 ? (
        <div className="text-center py-20 border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>rocket_launch</span>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No workloads yet</p>
          <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Deploy an app to get started</p>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_auto_auto_auto_1fr_auto] gap-4 px-4 py-2 text-xs font-semibold uppercase tracking-wide"
            style={{ color: 'var(--t-text-dim)' }}>
            <span>Name</span>
            <span>Status</span>
            <span>Replicas</span>
            <span>Image</span>
            <span>Created</span>
            <span>Actions</span>
          </div>

          {apps.map(a => {
            const status = getStatus(a)
            const dep = a.deployment
            return (
              <div key={a.id} className="grid grid-cols-[1fr_auto_auto_auto_1fr_auto] gap-4 items-center p-4 rounded-lg border hover:border-[#F97316]/20 transition-colors"
                style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>

                {/* Name + repo */}
                <div className="min-w-0">
                  <Link href={`/apps/${a.name}`} className="text-sm font-semibold hover:text-[#F97316] transition-colors" style={{ color: 'var(--t-text)' }}>
                    {a.name}
                  </Link>
                  {a.repo_full_name && (
                    <p className="text-xs truncate" style={{ color: 'var(--t-text-dim)' }}>{a.repo_full_name}</p>
                  )}
                </div>

                {/* Status */}
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[status] || 'text-slate-500 bg-slate-500/10'}`}>
                  {status}
                </span>

                {/* Replicas */}
                <span className="text-xs font-mono" style={{ color: 'var(--t-text-muted)' }}>
                  {dep ? `${dep.ready_replicas}/${dep.replicas}` : '--'}
                </span>

                {/* Image */}
                <span className="text-xs font-mono truncate max-w-[200px]" style={{ color: 'var(--t-text-dim)' }} title={dep?.image ?? ''}>
                  {dep?.image ? dep.image.split('/').pop()?.split(':').join(':') ?? dep.image : '--'}
                </span>

                {/* Created */}
                <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
                  {new Date(a.created_at).toLocaleDateString('en-IN')}
                </span>

                {/* Actions */}
                <div className="flex gap-1">
                  <button
                    onClick={() => restart(a.name)}
                    disabled={restarting === a.name}
                    title="Restart deployment"
                    className="p-1.5 rounded-md transition-colors hover:text-[#F97316] disabled:opacity-50"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                      {restarting === a.name ? 'hourglass_empty' : 'refresh'}
                    </span>
                  </button>
                  <Link href={`/apps/${a.name}`} title="View details / logs"
                    className="p-1.5 rounded-md transition-colors hover:text-[#F97316]"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>terminal</span>
                  </Link>
                  <Link href={`/apps/${a.name}/config`} title="Configure"
                    className="p-1.5 rounded-md transition-colors hover:text-[#F97316]"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>tune</span>
                  </Link>
                  <button onClick={() => remove(a.name)} title="Delete"
                    className="p-1.5 rounded-md transition-colors hover:text-red-400"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}>
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
