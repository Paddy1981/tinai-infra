'use client'

import { useEffect, useState, useCallback } from 'react'

interface ServiceHealth {
  name: string
  status: 'healthy' | 'unhealthy' | 'degraded'
  latency: number
  port: number
  error?: string
}

interface HealthData {
  overall: 'healthy' | 'unhealthy' | 'degraded'
  services: ServiceHealth[]
  checked_at: string
  summary: { healthy: number; unhealthy: number; total: number }
}

interface AppDeployment {
  image: string | null
  replicas: number
  ready_replicas: number
  status: 'running' | 'deploying'
}

interface TenantApp {
  id: string
  name: string
  deployment: AppDeployment | null
}

const STATUS_CONFIG = {
  healthy:   { color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-800/40', dot: 'bg-emerald-400', label: 'Healthy' },
  degraded:  { color: 'text-amber-400',   bg: 'bg-amber-400/10',   border: 'border-amber-800/40',   dot: 'bg-amber-400 animate-pulse', label: 'Degraded' },
  unhealthy: { color: 'text-red-400',     bg: 'bg-red-400/10',     border: 'border-red-800/40',     dot: 'bg-red-400', label: 'Unhealthy' },
}

const SERVICE_ICONS: Record<string, string> = {
  API: 'api', Auth: 'shield', Functions: 'functions', Gateway: 'router',
  Realtime: 'sync', Forge: 'build', Forgejo: 'code', Dashboard: 'dashboard',
  PostgreSQL: 'database', Redis: 'memory', MinIO: 'cloud_upload',
  Grafana: 'monitoring', Prometheus: 'query_stats', Alertmanager: 'notifications_active',
}

export default function AdminHealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [tenantApps, setTenantApps] = useState<TenantApp[]>([])
  const [appsLoading, setAppsLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/health')
      if (res.status === 403) { setError('Admin access required'); return }
      if (res.status === 401) { setError('Please log in'); return }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json())
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadApps = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/apps')
      if (res.ok) {
        const apps = await res.json()
        setTenantApps(Array.isArray(apps) ? apps : [])
      }
    } finally {
      setAppsLoading(false)
    }
  }, [])

  useEffect(() => { load(); loadApps() }, [load, loadApps])

  useEffect(() => {
    if (!autoRefresh) return
    const interval = setInterval(() => { load(); loadApps() }, 15000)
    return () => clearInterval(interval)
  }, [autoRefresh, load, loadApps])

  const overall = data?.overall ?? 'healthy'
  const overallCfg = STATUS_CONFIG[overall]

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>
            System Health
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
            Real-time status of all platform services
          </p>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: 'var(--t-text-muted)' }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={e => setAutoRefresh(e.target.checked)}
              className="accent-[#F97316]"
            />
            Auto-refresh (15s)
          </label>
          <button
            onClick={load}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:border-[#F97316]/30"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>refresh</span>
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-6">
          {error}
        </div>
      )}

      {loading && !data ? (
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Checking services...</div>
      ) : data && (
        <>
          {/* Overall status banner */}
          <div
            className={`rounded-xl border p-5 mb-6 flex items-center justify-between ${overallCfg.bg} ${overallCfg.border}`}
          >
            <div className="flex items-center gap-3">
              <span className={`h-3 w-3 rounded-full ${overallCfg.dot}`} />
              <div>
                <p className={`text-lg font-bold font-headline ${overallCfg.color}`}>
                  {overall === 'healthy' ? 'All Systems Operational' : overall === 'degraded' ? 'Degraded Performance' : 'Service Disruption'}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
                  {data.summary.healthy}/{data.summary.total} services healthy
                </p>
              </div>
            </div>
            <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
              Last checked: {new Date(data.checked_at).toLocaleTimeString('en-IN')}
            </p>
          </div>

          {/* Services grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {data.services.map(svc => {
              const cfg = STATUS_CONFIG[svc.status]
              return (
                <div
                  key={svc.name}
                  className="rounded-xl border p-4 transition-colors hover:border-[#F97316]/20"
                  style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--t-text-dim)' }}>
                        {SERVICE_ICONS[svc.name] ?? 'dns'}
                      </span>
                      <span className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>{svc.name}</span>
                    </div>
                    <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
                  </div>

                  <div className="flex items-center justify-between">
                    <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                      {cfg.label}
                    </span>
                    <div className="text-right">
                      {svc.latency > 0 && (
                        <p className="text-xs font-mono" style={{ color: 'var(--t-text-dim)' }}>{svc.latency}ms</p>
                      )}
                      <p className="text-[10px]" style={{ color: 'var(--t-text-dim)' }}>:{svc.port}</p>
                    </div>
                  </div>

                  {svc.error && (
                    <p className="mt-2 text-xs text-red-400 truncate" title={svc.error}>{svc.error}</p>
                  )}
                </div>
              )
            })}
          </div>

          {/* Tenant Apps Health (tinai-apps namespace) */}
          <div className="mt-8">
            <h2 className="text-lg font-bold font-headline mb-4" style={{ color: 'var(--t-text)' }}>
              Tenant App Health
              <span className="text-xs font-normal ml-2" style={{ color: 'var(--t-text-dim)' }}>tinai-apps namespace</span>
            </h2>

            {appsLoading ? (
              <div className="py-8 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading tenant apps...</div>
            ) : tenantApps.length === 0 ? (
              <div className="py-8 text-center text-sm rounded-xl border" style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
                No tenant apps found in tinai-apps namespace
              </div>
            ) : (
              <>
                {/* Tenant apps summary */}
                {(() => {
                  const appRunning = tenantApps.filter(a => a.deployment?.status === 'running' && a.deployment.ready_replicas > 0).length
                  const appDeploying = tenantApps.filter(a => a.deployment?.status === 'deploying').length
                  const appDown = tenantApps.filter(a => !a.deployment || (a.deployment.ready_replicas === 0)).length
                  const appOverall = appDown > 0 ? 'unhealthy' : appDeploying > 0 ? 'degraded' : 'healthy'
                  const appCfg = STATUS_CONFIG[appOverall]
                  return (
                    <div className={`rounded-xl border p-4 mb-4 flex items-center justify-between ${appCfg.bg} ${appCfg.border}`}>
                      <div className="flex items-center gap-3">
                        <span className={`h-3 w-3 rounded-full ${appCfg.dot}`} />
                        <div>
                          <p className={`text-sm font-bold ${appCfg.color}`}>
                            {appRunning}/{tenantApps.length} apps healthy
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
                            {appRunning} running &middot; {appDeploying} deploying &middot; {appDown} down
                          </p>
                        </div>
                      </div>
                    </div>
                  )
                })()}

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                  {tenantApps.map(app => {
                    const dep = app.deployment
                    const appStatus: 'healthy' | 'unhealthy' | 'degraded' = !dep
                      ? 'unhealthy'
                      : dep.status === 'running' && dep.ready_replicas > 0
                        ? 'healthy'
                        : dep.status === 'deploying'
                          ? 'degraded'
                          : 'unhealthy'
                    const cfg = STATUS_CONFIG[appStatus]
                    return (
                      <div
                        key={app.id}
                        className="rounded-xl border p-4 transition-colors hover:border-[#F97316]/20"
                        style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
                      >
                        <div className="flex items-center justify-between mb-3">
                          <div className="flex items-center gap-2.5">
                            <span className="material-symbols-outlined" style={{ fontSize: 18, color: 'var(--t-text-dim)' }}>
                              rocket_launch
                            </span>
                            <span className="text-sm font-semibold truncate" style={{ color: 'var(--t-text)' }}>{app.name}</span>
                          </div>
                          <span className={`h-2.5 w-2.5 rounded-full ${cfg.dot}`} />
                        </div>
                        <div className="flex items-center justify-between">
                          <span className={`text-xs px-2 py-0.5 rounded-full border font-medium ${cfg.color} ${cfg.bg} ${cfg.border}`}>
                            {cfg.label}
                          </span>
                          <div className="text-right">
                            <p className="text-xs font-mono" style={{ color: 'var(--t-text-dim)' }}>
                              {dep ? `${dep.ready_replicas}/${dep.replicas} pods` : 'No deployment'}
                            </p>
                          </div>
                        </div>
                        {dep?.image && (
                          <p className="mt-2 text-[10px] font-mono truncate" style={{ color: 'var(--t-text-dim)' }} title={dep.image}>
                            {dep.image.split('/').pop()}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </div>

          {/* Uptime note */}
          <div className="mt-6 text-center">
            <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
              tinai.cloud · tinai-node1 · {data.summary.total} platform services + {tenantApps.length} tenant apps monitored
            </p>
          </div>
        </>
      )}
    </div>
  )
}
