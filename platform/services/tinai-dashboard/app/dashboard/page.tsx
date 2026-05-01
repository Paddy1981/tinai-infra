'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useProject } from '../context/ProjectContext'

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

interface Bucket {
  id: string
  name: string
  status: string
}

interface Database {
  id: string
  name: string
  status: string
}

const STATUS_DOT: Record<string, string> = {
  running:   'bg-emerald-400',
  deploying: 'bg-amber-400 animate-pulse',
  stopped:   'bg-slate-500',
}

const QUICK_ACTIONS = [
  { href: '/workloads',  icon: 'rocket_launch', label: 'Deploy App',    color: 'text-[#F97316]' },
  { href: '/templates',  icon: 'workspaces',    label: 'Templates',     color: 'text-violet-400' },
  { href: '/storage',    icon: 'database',      label: 'New Database',  color: 'text-sky-400' },
  { href: '/instances',  icon: 'dns',           label: 'Launch GPU',    color: 'text-emerald-400' },
]

export default function DashboardPage() {
  const { activeProject, activeEnv, projects } = useProject()
  const [apps, setApps]           = useState<App[]>([])
  const [databases, setDatabases] = useState<Database[]>([])
  const [buckets, setBuckets]     = useState<Bucket[]>([])
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const [appsRes, dbRes, bucketsRes] = await Promise.all([
          fetch('/api/v1/apps'),
          fetch('/api/v1/storage/databases'),
          fetch('/api/v1/storage/buckets'),
        ])

        if (appsRes.ok) {
          const data = await appsRes.json()
          if (Array.isArray(data)) setApps(data)
        }
        if (dbRes.ok) {
          const data = await dbRes.json()
          if (Array.isArray(data)) setDatabases(data)
        }
        if (bucketsRes.ok) {
          const data = await bucketsRes.json()
          if (Array.isArray(data)) setBuckets(data)
        }
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [activeEnv])

  const running = apps.filter(a => a.deployment?.status === 'running').length
  const failing = apps.filter(a => !a.deployment).length

  // Platform health: green = all running, yellow = some down, red = majority down
  const healthLevel: 'green' | 'yellow' | 'red' = (() => {
    if (loading || apps.length === 0) return 'green'
    if (failing === 0) return 'green'
    if (failing <= Math.floor(apps.length / 2)) return 'yellow'
    return 'red'
  })()

  const HEALTH_CONFIG = {
    green:  { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'All systems operational', bg: 'bg-emerald-400/10' },
    yellow: { dot: 'bg-amber-400 animate-pulse', text: 'text-amber-400', label: 'Degraded performance', bg: 'bg-amber-400/10' },
    red:    { dot: 'bg-red-400', text: 'text-red-400', label: 'Service disruption', bg: 'bg-red-400/10' },
  }
  const healthCfg = HEALTH_CONFIG[healthLevel]

  const getAppStatus = (app: App): string => {
    if (!app.deployment) return 'stopped'
    return app.deployment.status
  }

  return (
    <div className="p-8 max-w-5xl mx-auto space-y-8">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>
            Dashboard
          </h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
            {activeProject?.name ?? 'Default'} &middot; {activeEnv ?? 'production'}
          </p>
        </div>
        <Link
          href="/workloads"
          className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors shadow-[0_0_16px_rgba(249,115,22,0.2)]"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>rocket_launch</span>
          Deploy
        </Link>
      </div>

      {/* Platform health banner */}
      {!loading && (
        <div className={`rounded-xl border p-4 flex items-center gap-3 ${healthCfg.bg}`} style={{ borderColor: 'var(--t-border)' }}>
          <span className={`h-3 w-3 rounded-full shrink-0 ${healthCfg.dot}`} />
          <div className="flex-1">
            <p className={`text-sm font-semibold ${healthCfg.text}`}>{healthCfg.label}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
              {running}/{apps.length} apps running &middot; {databases.length} databases &middot; {buckets.length} buckets
            </p>
          </div>
          <Link href="/admin/health" className="text-xs text-[#F97316] hover:text-[#FDBA74] shrink-0">
            View details &rarr;
          </Link>
        </div>
      )}

      {/* Stats row */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          {
            label: 'Total Apps',
            value: loading ? '--' : apps.length,
            sub: `${running} running`,
            icon: 'rocket_launch',
            color: 'text-[#F97316]',
            href: '/workloads',
          },
          {
            label: 'Running Apps',
            value: loading ? '--' : running,
            sub: apps.length > 0 ? `${Math.round((running / apps.length) * 100)}% of ${apps.length}` : 'No apps',
            icon: 'play_circle',
            color: 'text-emerald-400',
            href: '/workloads',
          },
          {
            label: 'Databases',
            value: loading ? '--' : databases.length,
            sub: `${databases.filter(d => d.status === 'ready' || d.status === 'running').length} active`,
            icon: 'database',
            color: 'text-sky-400',
            href: '/storage',
          },
          {
            label: 'Buckets',
            value: loading ? '--' : buckets.length,
            sub: `${buckets.filter(b => b.status === 'ready' || b.status === 'active').length} active`,
            icon: 'cloud',
            color: 'text-violet-400',
            href: '/storage',
          },
        ].map(stat => (
          <Link
            key={stat.label}
            href={stat.href}
            className="rounded-xl border p-4 transition-colors hover:border-[#F97316]/20 cursor-pointer"
            style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-medium" style={{ color: 'var(--t-text-muted)' }}>{stat.label}</span>
              <span className={`material-symbols-outlined ${stat.color}`} style={{ fontSize: 18 }}>{stat.icon}</span>
            </div>
            <p className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>{stat.value}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>{stat.sub}</p>
          </Link>
        ))}
      </div>

      {/* Quick actions + recent apps */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* Quick actions */}
        <div className="rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--t-text)' }}>Quick Actions</h2>
          <div className="grid grid-cols-2 gap-2">
            {QUICK_ACTIONS.map(a => (
              <Link
                key={a.href}
                href={a.href}
                className="flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-colors hover:border-[#F97316]/30"
                style={{ borderColor: 'var(--t-border)', backgroundColor: 'var(--t-surface-2)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
              >
                <span className={`material-symbols-outlined ${a.color}`} style={{ fontSize: 22 }}>{a.icon}</span>
                <span className="text-xs font-medium" style={{ color: 'var(--t-text-muted)' }}>{a.label}</span>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent apps */}
        <div className="lg:col-span-2 rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>Recent Apps</h2>
            <Link href="/workloads" className="text-xs text-[#F97316] hover:text-[#FDBA74]">View all &rarr;</Link>
          </div>

          {loading ? (
            <div className="py-6 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading...</div>
          ) : apps.length === 0 ? (
            <div className="py-8 text-center">
              <span className="material-symbols-outlined block mb-2" style={{ fontSize: 32, color: 'var(--t-text-dim)' }}>rocket_launch</span>
              <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No apps yet</p>
              <Link href="/workloads" className="mt-3 inline-flex items-center gap-1 text-xs text-[#F97316] hover:text-[#FDBA74]">
                Deploy your first app &rarr;
              </Link>
            </div>
          ) : (
            <div className="space-y-2">
              {apps.slice(0, 5).map(a => {
                const status = getAppStatus(a)
                const dep = a.deployment
                return (
                  <Link key={a.id} href={`/apps/${a.name}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg transition-colors hover:border-[#F97316]/20"
                    style={{ backgroundColor: 'var(--t-surface-2)' }}>
                    <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[status] ?? 'bg-slate-500'}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate" style={{ color: 'var(--t-text)' }}>{a.name}</p>
                      <p className="text-xs truncate" style={{ color: 'var(--t-text-dim)' }}>
                        {dep ? `${dep.ready_replicas}/${dep.replicas} replicas` : 'No deployment'}
                        {dep?.image ? ` -- ${dep.image.split('/').pop()}` : ''}
                      </p>
                    </div>
                    <span className="text-xs shrink-0" style={{ color: 'var(--t-text-dim)' }}>
                      {new Date(a.created_at).toLocaleDateString('en-IN')}
                    </span>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* Resource summary */}
      {!loading && (apps.length > 0 || databases.length > 0 || buckets.length > 0) && (
        <div className="rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
          <h2 className="text-sm font-semibold mb-4" style={{ color: 'var(--t-text)' }}>Resource Summary</h2>
          <div className="grid grid-cols-3 gap-4">
            {[
              { label: 'Apps', count: apps.length, active: running, icon: 'rocket_launch' },
              { label: 'Databases', count: databases.length, active: databases.filter(d => d.status === 'ready' || d.status === 'running').length, icon: 'database' },
              { label: 'Buckets', count: buckets.length, active: buckets.filter(b => b.status === 'ready' || b.status === 'active').length, icon: 'cloud' },
            ].map(r => (
              <div key={r.label} className="text-center">
                <span className="material-symbols-outlined text-[#F97316] block mb-1" style={{ fontSize: 20 }}>{r.icon}</span>
                <p className="text-lg font-bold font-headline" style={{ color: 'var(--t-text)' }}>{r.count}</p>
                <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{r.active} active</p>
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
