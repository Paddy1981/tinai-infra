'use client'

import { useState, useEffect } from 'react'
import { use } from 'react'

const API_URL = ''

interface ServiceTemplate {
  id: string
  name: string
  category: string
  description: string
  icon: string
  image: string
  port: number
  env: Record<string, string>
  requires_volume: boolean
}

function randomSuffix() {
  return Math.random().toString(36).slice(2, 6)
}

export default function DeployTemplatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)

  const [template, setTemplate] = useState<ServiceTemplate | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [appName, setAppName] = useState('')
  const [envValues, setEnvValues] = useState<Record<string, string>>({})
  const [region, setRegion] = useState('IN')
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState<string | null>(null)
  const [deployedApp, setDeployedApp] = useState<string | null>(null)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${API_URL}/api/v1/templates/${id}`)
        if (!res.ok) throw new Error(`Template not found: ${res.status}`)
        const t: ServiceTemplate = await res.json()
        setTemplate(t)
        setAppName(`${t.id}-${randomSuffix()}`)
        setEnvValues(Object.fromEntries(Object.entries(t.env).map(([k, v]) => [k, v])))
      } catch (e: unknown) {
        setLoadError((e as Error).message)
      }
    }
    load()
  }, [id])

  async function handleDeploy(e: React.FormEvent) {
    e.preventDefault()
    if (!template) return
    setDeployError(null)
    setDeploying(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/apps/from-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_id: template.id,
          app_name: appName,
          env: envValues,
          region,
        }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail ?? data?.message ?? `Deploy failed: ${res.status}`)
      }
      setDeployedApp(appName)
    } catch (e: unknown) {
      setDeployError((e as Error).message)
    } finally {
      setDeploying(false)
    }
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <a href="/templates" className="hover:text-slate-300">Templates</a>
          <span>/</span>
          <span className="text-slate-200">{id}</span>
          <span>/</span>
          <span>Deploy</span>
        </div>
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {loadError}
        </div>
      </div>
    )
  }

  if (!template) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-500 animate-pulse">Loading template…</p>
      </div>
    )
  }

  if (deployedApp) {
    return (
      <div className="flex flex-col gap-6 max-w-lg">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <a href="/templates" className="hover:text-slate-300">Templates</a>
          <span>/</span>
          <span className="text-slate-200">{template.name}</span>
        </div>
        <div className="rounded-lg border border-emerald-800 bg-emerald-900/20 p-6 flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-emerald-400 text-xl">&#10003;</span>
            <p className="text-slate-100 font-medium">Deployment started</p>
          </div>
          <p className="text-sm text-slate-400">
            <span className="font-mono text-slate-200">{deployedApp}</span> is being deployed from the{' '}
            <strong className="text-slate-200">{template.name}</strong> template.
          </p>
          <a
            href={`/apps/${deployedApp}`}
            className="inline-block rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 transition-colors text-center"
          >
            View App
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6 max-w-lg">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <a href="/templates" className="hover:text-slate-300">Templates</a>
        <span>/</span>
        <span className="text-slate-200">{template.name}</span>
        <span>/</span>
        <span>Deploy</span>
      </div>

      <div className="flex items-center gap-3">
        <span className="text-3xl">{template.icon}</span>
        <div>
          <h1 className="text-xl font-semibold">{template.name}</h1>
          <p className="text-sm text-slate-400">{template.description}</p>
        </div>
      </div>

      <form onSubmit={handleDeploy} className="flex flex-col gap-5">
        {/* App name */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5" htmlFor="app-name">
            App Name
          </label>
          <input
            id="app-name"
            type="text"
            required
            value={appName}
            onChange={e => setAppName(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none font-mono"
          />
        </div>

        {/* Region */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5" htmlFor="region">
            Region
          </label>
          <select
            id="region"
            value={region}
            onChange={e => setRegion(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-700 focus:outline-none"
          >
            <option value="IN">IN — India (Mumbai)</option>
            <option value="QA">QA — Qatar (Doha)</option>
            <option value="AE">AE — UAE (Abu Dhabi)</option>
          </select>
        </div>

        {/* Env vars */}
        {Object.keys(envValues).length > 0 && (
          <div>
            <p className="text-xs text-slate-400 mb-2">Environment Variables</p>
            <div className="flex flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900/50 p-3">
              {Object.entries(envValues).map(([key, val]) => (
                <div key={key} className="flex items-center gap-2">
                  <span className="text-xs font-mono text-slate-400 w-40 shrink-0">{key}</span>
                  <input
                    type="text"
                    value={val}
                    onChange={e => setEnvValues(prev => ({ ...prev, [key]: e.target.value }))}
                    className="flex-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-xs text-slate-100 font-mono focus:border-emerald-700 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {deployError && (
          <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
            {deployError}
          </div>
        )}

        <button
          type="submit"
          disabled={deploying}
          className="w-full rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {deploying ? 'Deploying…' : 'Deploy'}
        </button>
      </form>
    </div>
  )
}
