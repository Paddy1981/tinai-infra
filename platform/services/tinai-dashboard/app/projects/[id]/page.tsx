'use client'

import React, { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'

type EnvSlug = 'production' | 'staging' | 'development'

interface EnvironmentDeployment {
  environment: EnvSlug
  status: string
  ready_replicas: number
  replicas: number
  image: string
  domain: string | null
  branch: string | null
  deployed_at: string | null
}

interface Environment { id: string; name: string; slug: string; created_at: string }

interface ProjectApp {
  name: string
  repo_full_name: string
  environments: EnvironmentDeployment[]
}

interface ProjectSecret {
  key: string
  created_at: string
}

interface Project {
  id: string; name: string; slug: string; description?: string
  created_at: string; environment_count?: number
}

const ENV_BADGE_STYLES: Record<string, React.CSSProperties> = {
  production:  { color: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', borderColor: 'rgba(6,95,70,0.4)' },
  staging:     { color: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.1)', borderColor: 'rgba(146,64,14,0.4)' },
  development: { color: '#60a5fa', backgroundColor: 'rgba(96,165,250,0.1)', borderColor: 'rgba(30,64,175,0.4)' },
}

const ENV_DOT_STYLES: Record<string, React.CSSProperties> = {
  running:   { backgroundColor: '#34d399' },
  deploying: { backgroundColor: '#fbbf24', animation: 'pulse 2s cubic-bezier(0.4,0,0.6,1) infinite' },
  failed:    { backgroundColor: '#f87171' },
}

const ENV_DOT_FALLBACK: React.CSSProperties = { backgroundColor: '#475569' }

const ALLOWED_ENVS = ['production', 'staging', 'development', 'preview']

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [project, setProject] = useState<Project | null>(null)
  const [envs, setEnvs] = useState<Environment[]>([])
  const [apps, setApps] = useState<ProjectApp[]>([])
  const [secrets, setSecrets] = useState<ProjectSecret[]>([])
  const [loading, setLoading] = useState(true)
  const [newEnvName, setNewEnvName] = useState('development')
  const [creating, setCreating] = useState(false)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [pRes, eRes, aRes, sRes] = await Promise.all([
          fetch(`/api/v1/projects/${id}`),
          fetch(`/api/v1/projects/${id}/environments`),
          fetch(`/api/v1/projects/${id}/apps`),
          fetch(`/api/v1/projects/${id}/secrets`),
        ])
        if (pRes.ok) setProject(await pRes.json())
        if (eRes.ok) setEnvs(await eRes.json())
        if (aRes.ok) {
          const data = await aRes.json()
          setApps(Array.isArray(data) ? data : data.apps ?? [])
        }
        if (sRes.ok) {
          const data = await sRes.json()
          setSecrets(Array.isArray(data) ? data : [])
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [id])

  const createEnv = async () => {
    if (!newEnvName) return
    setCreating(true)
    await fetch(`/api/v1/projects/${id}/environments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
      body: JSON.stringify({ name: newEnvName }),
    })
    setNewEnvName('')
    setCreating(false)
    const eRes = await fetch(`/api/v1/projects/${id}/environments`)
    if (eRes.ok) setEnvs(await eRes.json())
  }

  const deleteEnv = async (envId: string, envName: string) => {
    if (!confirm(`Delete environment "${envName}"?`)) return
    await fetch(`/api/v1/projects/${id}/environments/${envId}`, {
      method: 'DELETE', headers: { 'x-tinai-csrf': '1' },
    })
    setEnvs(envs.filter(e => e.id !== envId))
  }

  const quickDeploy = async (appName: string, env: EnvSlug) => {
    const key = `${appName}:deploy:${env}`
    setActionLoading(key)
    try {
      const branch = env === 'production' ? 'main' : env === 'staging' ? 'staging' : 'develop'
      await fetch(`/api/v1/apps/${appName}/deploy/env`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ environment: env, branch }),
      })
      // Refresh apps
      const aRes = await fetch(`/api/v1/projects/${id}/apps`)
      if (aRes.ok) {
        const data = await aRes.json()
        setApps(Array.isArray(data) ? data : data.apps ?? [])
      }
    } finally {
      setActionLoading(null)
    }
  }

  const quickPromote = async (appName: string) => {
    const key = `${appName}:promote`
    if (!confirm(`Promote ${appName} from staging to production?`)) return
    setActionLoading(key)
    try {
      await fetch(`/api/v1/apps/${appName}/promote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ from: 'staging', to: 'production' }),
      })
      const aRes = await fetch(`/api/v1/projects/${id}/apps`)
      if (aRes.ok) {
        const data = await aRes.json()
        setApps(Array.isArray(data) ? data : data.apps ?? [])
      }
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return <div className="p-8 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading...</div>
  }

  if (!project) {
    return <div className="p-8 text-center text-sm text-red-400">Project not found</div>
  }

  const existingSlugs = envs.map(e => e.slug)
  const availableEnvs = ALLOWED_ENVS.filter(e => !existingSlugs.includes(e))

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm mb-6" style={{ color: 'var(--t-text-muted)' }}>
        <a href="/projects" className="hover:text-white transition-colors">Projects</a>
        <span>/</span>
        <span style={{ color: 'var(--t-text)' }}>{project.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>{project.name}</h1>
          <div className="flex items-center gap-3 mt-1">
            <code className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--t-surface-2)', color: 'var(--t-text-dim)' }}>
              {project.slug}
            </code>
            {project.description && (
              <span className="text-sm" style={{ color: 'var(--t-text-muted)' }}>{project.description}</span>
            )}
          </div>
        </div>
        <a href={`/projects/${id}/secrets`}
          className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors hover:border-[#F97316]/30"
          style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>key</span>
          Secrets ({secrets.length})
        </a>
      </div>

      {/* Apps with environment status */}
      <div className="rounded-xl border p-5 mb-6" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>Apps</h2>
          <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{apps.length} app{apps.length !== 1 ? 's' : ''}</span>
        </div>

        {apps.length === 0 ? (
          <p className="text-sm py-4 text-center" style={{ color: 'var(--t-text-dim)' }}>No apps linked to this project yet.</p>
        ) : (
          <div className="space-y-3">
            {apps.map(app => {
              const prodEnv = app.environments?.find(e => e.environment === 'production')
              const stagingEnv = app.environments?.find(e => e.environment === 'staging')
              const devEnv = app.environments?.find(e => e.environment === 'development')

              return (
                <div key={app.name} className="rounded-lg border p-4" style={{ borderColor: 'var(--t-border)', backgroundColor: 'var(--t-surface-2)' }}>
                  <div className="flex items-center justify-between mb-3">
                    <div>
                      <a href={`/apps/${app.name}`} className="text-sm font-medium hover:text-emerald-400 transition-colors" style={{ color: 'var(--t-text)' }}>
                        {app.name}
                      </a>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-dim)' }}>{app.repo_full_name}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {stagingEnv?.status === 'running' && (
                        <button
                          onClick={() => quickPromote(app.name)}
                          disabled={actionLoading === `${app.name}:promote`}
                          className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-emerald-800/50 bg-emerald-900/20 text-emerald-400 text-[11px] font-medium hover:bg-emerald-900/40 transition-colors disabled:opacity-50"
                        >
                          <span className="material-symbols-outlined" style={{ fontSize: 12 }}>arrow_upward</span>
                          {actionLoading === `${app.name}:promote` ? 'Promoting...' : 'Promote'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Environment status grid */}
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: 'Production', slug: 'production' as EnvSlug, env: prodEnv, dotColor: 'bg-emerald-400' },
                      { label: 'Staging', slug: 'staging' as EnvSlug, env: stagingEnv, dotColor: 'bg-amber-400' },
                      { label: 'Development', slug: 'development' as EnvSlug, env: devEnv, dotColor: 'bg-blue-400' },
                    ].map(({ label, slug, env, dotColor }) => (
                      <div key={slug} className="rounded-lg border px-3 py-2.5" style={{ borderColor: 'var(--t-border)' }}>
                        <div className="flex items-center justify-between mb-1.5">
                          <span className="text-[11px] font-medium" style={{ color: 'var(--t-text-muted)' }}>{label}</span>
                          {env && (
                            <span className="w-1.5 h-1.5 rounded-full" style={ENV_DOT_STYLES[env.status] ?? ENV_DOT_FALLBACK} />
                          )}
                        </div>
                        {env ? (
                          <div>
                            <p className="text-xs" style={{ color: 'var(--t-text)' }}>{env.status}</p>
                            <p className="text-[10px] font-mono mt-0.5" style={{ color: 'var(--t-text-dim)' }}>
                              {env.image.split('/').pop()?.substring(0, 30) ?? '--'}
                            </p>
                            {env.domain && (
                              <a href={`https://${env.domain}`} target="_blank" rel="noopener noreferrer"
                                className="text-[10px] text-emerald-400 hover:underline mt-0.5 block truncate">
                                {env.domain}
                              </a>
                            )}
                          </div>
                        ) : (
                          <div className="flex items-center justify-between">
                            <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>Not deployed</p>
                            <button
                              onClick={() => quickDeploy(app.name, slug)}
                              disabled={actionLoading === `${app.name}:deploy:${slug}`}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-slate-700 hover:border-emerald-700 hover:text-emerald-400 transition-colors disabled:opacity-50"
                              style={{ color: 'var(--t-text-dim)' }}
                            >
                              {actionLoading === `${app.name}:deploy:${slug}` ? '...' : 'Deploy'}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Environments */}
      <div className="rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>Environments</h2>
          <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{envs.length} total</span>
        </div>

        {envs.length === 0 ? (
          <p className="text-sm py-4 text-center" style={{ color: 'var(--t-text-dim)' }}>No environments yet</p>
        ) : (
          <div className="space-y-2 mb-4">
            {envs.map(env => (
              <div key={env.id} className="flex items-center justify-between px-4 py-3 rounded-lg border"
                style={{ borderColor: 'var(--t-border)', backgroundColor: 'var(--t-surface-2)' }}>
                <div className="flex items-center gap-3">
                  <span className="text-xs px-2.5 py-1 rounded-full border font-medium"
                    style={ENV_BADGE_STYLES[env.slug] ?? { color: '#94a3b8', backgroundColor: 'rgba(148,163,184,0.1)', borderColor: 'rgba(51,65,85,0.4)' }}>
                    {env.name}
                  </span>
                  <code className="text-xs font-mono" style={{ color: 'var(--t-text-dim)' }}>{env.slug}</code>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
                    {new Date(env.created_at).toLocaleDateString('en-IN')}
                  </span>
                  <button onClick={() => deleteEnv(env.id, env.name)}
                    className="text-xs text-red-400/60 hover:text-red-400 transition-colors">
                    <span className="material-symbols-outlined" style={{ fontSize: 14 }}>close</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Add environment */}
        {availableEnvs.length > 0 && (
          <div className="flex gap-2 pt-3 border-t" style={{ borderColor: 'var(--t-border)' }}>
            <select
              value={newEnvName}
              onChange={e => setNewEnvName(e.target.value)}
              className="flex-1 rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#F97316]/50"
              style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)', color: 'var(--t-text)' }}
            >
              {availableEnvs.map(e => (
                <option key={e} value={e}>{e.charAt(0).toUpperCase() + e.slice(1)}</option>
              ))}
            </select>
            <button onClick={createEnv} disabled={creating}
              className="px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A] transition-colors whitespace-nowrap">
              {creating ? 'Adding...' : 'Add Environment'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
