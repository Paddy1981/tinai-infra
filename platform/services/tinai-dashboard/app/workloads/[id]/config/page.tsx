'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import EnvVarEditor, { EnvVar } from '../../../components/EnvVarEditor'

type Tab = 'variables' | 'settings' | 'domains'

interface AppDeployment {
  image: string | null
  replicas: number
  ready_replicas: number
  status: 'running' | 'deploying'
}

interface AppDetail {
  id: string
  name: string
  owner: string
  repo_full_name?: string
  created_at: string
  deployment: AppDeployment | null
}

interface Domain {
  id: string
  hostname: string
  verified: boolean
  created_at: string
}

const inputStyle = {
  backgroundColor: 'var(--t-surface-2)',
  borderColor: 'var(--t-border)',
  color: 'var(--t-text)',
}

const STATUS_COLOR: Record<string, string> = {
  running:   'text-emerald-400 bg-emerald-400/10',
  deploying: 'text-yellow-400 bg-yellow-400/10',
  stopped:   'text-slate-500 bg-slate-500/10',
}

export default function WorkloadConfigPage() {
  const params = useParams()
  // The route param is [id], but for apps API this is the app name
  const appName = params.id as string

  const [tab, setTab] = useState<Tab>('variables')
  const [app, setApp] = useState<AppDetail | null>(null)
  const [envVars, setEnvVars] = useState<EnvVar[]>([])
  const [domains, setDomains] = useState<Domain[]>([])
  const [loadingApp, setLoadingApp] = useState(true)
  const [loadingEnv, setLoadingEnv] = useState(false)
  const [newDomain, setNewDomain] = useState('')
  const [addingDomain, setAddingDomain] = useState(false)

  const loadApp = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/apps/${appName}`)
      if (res.ok) {
        const data: AppDetail = await res.json()
        setApp(data)
      }
    } finally {
      setLoadingApp(false)
    }
  }, [appName])

  const loadEnv = useCallback(async () => {
    setLoadingEnv(true)
    try {
      const res = await fetch(`/api/v1/apps/${appName}/env`)
      if (res.ok) {
        const data = await res.json()
        // API returns a flat object { KEY: "value" }, convert to EnvVar[]
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const vars: EnvVar[] = Object.entries(data).map(([key, value]) => ({
            key,
            value: value as string,
            is_secret: false,
          }))
          setEnvVars(vars)
        } else if (Array.isArray(data)) {
          setEnvVars(data)
        } else {
          setEnvVars(data.vars ?? [])
        }
      }
    } finally {
      setLoadingEnv(false)
    }
  }, [appName])

  const loadDomains = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/custom-domains?app_name=${appName}`)
      if (res.ok) setDomains(await res.json())
    } catch {
      // domains endpoint may not exist yet
    }
  }, [appName])

  useEffect(() => {
    loadApp()
  }, [loadApp])

  useEffect(() => {
    if (tab === 'variables') loadEnv()
    if (tab === 'domains') loadDomains()
  }, [tab, loadEnv, loadDomains])

  // --- Env var handlers ---
  const handleAdd = async (v: EnvVar) => {
    const res = await fetch(`/api/v1/apps/${appName}/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
      body: JSON.stringify({ [v.key]: v.value }),
    })
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to add variable')
    await loadEnv()
  }

  const handleUpdate = async (key: string, patch: Partial<EnvVar>) => {
    // The apps env API uses POST with key-value pairs to upsert
    const value = patch.value ?? ''
    const res = await fetch(`/api/v1/apps/${appName}/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
      body: JSON.stringify({ [key]: value }),
    })
    if (!res.ok) throw new Error((await res.json()).error || 'Failed to update variable')
    await loadEnv()
  }

  const handleDelete = async (key: string) => {
    const res = await fetch(`/api/v1/apps/${appName}/env/${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: { 'x-tinai-csrf': '1' },
    })
    if (!res.ok) throw new Error('Failed to delete variable')
    await loadEnv()
  }

  const handleBulkSave = async (vars: EnvVar[]) => {
    // Convert EnvVar[] to flat object for the apps env API
    const envObj: Record<string, string> = {}
    for (const v of vars) {
      envObj[v.key] = v.value
    }
    const res = await fetch(`/api/v1/apps/${appName}/env`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
      body: JSON.stringify(envObj),
    })
    if (!res.ok) throw new Error((await res.json()).error || 'Bulk save failed')
    await loadEnv()
  }

  // --- Domain handlers ---
  const addDomain = async () => {
    if (!newDomain.trim()) return
    setAddingDomain(true)
    try {
      await fetch(`/api/v1/custom-domains`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ hostname: newDomain.trim(), app_name: appName }),
      })
      setNewDomain('')
      await loadDomains()
    } finally {
      setAddingDomain(false)
    }
  }

  const removeDomain = async (domainId: string) => {
    if (!confirm('Remove this domain?')) return
    await fetch(`/api/v1/custom-domains/${domainId}`, {
      method: 'DELETE',
      headers: { 'x-tinai-csrf': '1' },
    })
    await loadDomains()
  }

  const restartApp = async () => {
    await fetch(`/api/v1/apps/${appName}/deploy`, {
      method: 'POST',
      headers: { 'x-tinai-csrf': '1' },
    })
    await loadApp()
  }

  const TABS: { key: Tab; label: string; icon: string }[] = [
    { key: 'variables', label: 'Variables', icon: 'key' },
    { key: 'settings', label: 'Settings', icon: 'tune' },
    { key: 'domains', label: 'Domains', icon: 'language' },
  ]

  const getStatus = (): string => {
    if (!app?.deployment) return 'stopped'
    return app.deployment.status
  }

  if (loadingApp) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading...</div>
      </div>
    )
  }

  if (!app) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <div className="py-20 text-center text-sm text-red-400">App not found</div>
      </div>
    )
  }

  const status = getStatus()
  const dep = app.deployment

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Breadcrumb + header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3 text-xs" style={{ color: 'var(--t-text-dim)' }}>
          <Link href="/workloads" className="hover:text-[#F97316] transition-colors">Workloads</Link>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chevron_right</span>
          <span style={{ color: 'var(--t-text-muted)' }}>{app.name}</span>
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>chevron_right</span>
          <span style={{ color: 'var(--t-text)' }}>Configuration</span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>
              {app.name}
            </h1>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLOR[status] || 'text-slate-500 bg-slate-500/10'}`}>
              {status}
            </span>
            {dep && (
              <span className="text-xs font-mono" style={{ color: 'var(--t-text-dim)' }}>
                {dep.ready_replicas}/{dep.replicas} replicas
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={restartApp}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors"
              style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
              Restart
            </button>
            <Link
              href={`/apps/${appName}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors"
              style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' }}
            >
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>terminal</span>
              View Logs
            </Link>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-0.5 mb-6 border-b" style={{ borderColor: 'var(--t-border)' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.key
                ? 'text-[#F97316] border-[#F97316]'
                : 'border-transparent'
            }`}
            style={tab === t.key ? {} : { color: 'var(--t-text-muted)' }}
            onMouseEnter={e => { if (tab !== t.key) (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
            onMouseLeave={e => { if (tab !== t.key) (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab: Variables */}
      {tab === 'variables' && (
        <div>
          <div className="mb-5">
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--t-text)' }}>Environment Variables</h2>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
              Injected at runtime into your app container via ConfigMap. Changes trigger a rolling restart.
            </p>
          </div>
          <EnvVarEditor
            vars={envVars}
            onAdd={handleAdd}
            onUpdate={handleUpdate}
            onDelete={handleDelete}
            onBulkSave={handleBulkSave}
            loading={loadingEnv}
          />
        </div>
      )}

      {/* Tab: Settings */}
      {tab === 'settings' && (
        <div className="max-w-xl">
          <div className="mb-5">
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--t-text)' }}>App Info</h2>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
              Deployment details for this app.
            </p>
          </div>

          <div className="space-y-5 rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            {/* Name (read-only) */}
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--t-text-muted)' }}>
                App name
              </label>
              <input
                value={app.name}
                readOnly
                className="w-full rounded-lg px-3 py-2 text-sm outline-none border opacity-60"
                style={inputStyle}
              />
            </div>

            {/* Replicas (read-only from K8s) */}
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--t-text-muted)' }}>
                Replicas (from K8s deployment)
              </label>
              <div className="text-sm font-mono" style={{ color: 'var(--t-text)' }}>
                {dep ? `${dep.ready_replicas} ready / ${dep.replicas} desired` : 'No deployment'}
              </div>
            </div>

            {/* Image (read-only from K8s) */}
            {dep?.image && (
              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--t-text-muted)' }}>
                  Container image
                </label>
                <code className="text-xs font-mono break-all" style={{ color: 'var(--t-text-dim)' }}>
                  {dep.image}
                </code>
              </div>
            )}

            {/* Repo (read-only) */}
            {app.repo_full_name && (
              <div className="pt-1 border-t" style={{ borderColor: 'var(--t-border)' }}>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--t-text-muted)' }}>
                  Git repository
                </label>
                <code className="text-xs font-mono break-all" style={{ color: 'var(--t-text-dim)' }}>
                  {app.repo_full_name}
                </code>
              </div>
            )}

            {/* Created at */}
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--t-text-muted)' }}>
                Created
              </label>
              <span className="text-sm" style={{ color: 'var(--t-text)' }}>
                {new Date(app.created_at).toLocaleString('en-IN')}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Domains */}
      {tab === 'domains' && (
        <div>
          <div className="mb-5">
            <h2 className="text-base font-semibold mb-1" style={{ color: 'var(--t-text)' }}>Custom Domains</h2>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
              Add your own domain and point a CNAME record to your tinai app.
            </p>
          </div>

          {/* Add domain */}
          <div className="mb-4 flex gap-2">
            <input
              value={newDomain}
              onChange={e => setNewDomain(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') addDomain() }}
              className="flex-1 rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#F97316]/50"
              style={inputStyle}
              placeholder="api.yourdomain.com"
            />
            <button
              onClick={addDomain}
              disabled={addingDomain || !newDomain.trim()}
              className="px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A] transition-colors"
            >
              {addingDomain ? 'Adding...' : 'Add Domain'}
            </button>
          </div>

          {/* Domain list */}
          {domains.length > 0 ? (
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
              {domains.map((d, i) => (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-4 py-3 border-b last:border-b-0"
                  style={{ borderColor: 'var(--t-border)', backgroundColor: i % 2 === 0 ? 'var(--t-surface)' : 'var(--t-surface-2)' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: d.verified ? '#34d399' : '#F59E0B' }}>
                    {d.verified ? 'check_circle' : 'pending'}
                  </span>
                  <div className="flex-1 min-w-0">
                    <code className="text-sm font-mono" style={{ color: 'var(--t-text)' }}>{d.hostname}</code>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-dim)' }}>
                      {d.verified ? 'Verified and active' : 'Add a CNAME record pointing to your tinai domain'}
                    </p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${d.verified ? 'text-emerald-400 bg-emerald-400/10' : 'text-amber-400 bg-amber-400/10'}`}>
                    {d.verified ? 'verified' : 'pending'}
                  </span>
                  <button
                    onClick={() => removeDomain(d.id)}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(239,68,68,0.1)'; (e.currentTarget as HTMLElement).style.color = '#f87171' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
              <span className="material-symbols-outlined block mb-2" style={{ fontSize: 36, color: 'var(--t-text-dim)' }}>language</span>
              <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No custom domains yet</p>
              <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Add a domain above to get started</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
