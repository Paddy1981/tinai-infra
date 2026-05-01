'use client'

import { useState, useEffect } from 'react'

const API_URL = ''

// ─── Types ────────────────────────────────────────────────────────────────────

interface Template {
  id: string
  name: string
  description: string
  stack: string
  tags: string[]
}

interface GeneratedFileInfo {
  path: string
  size: number
}

interface GenerateResult {
  jobId: string
  files: GeneratedFileInfo[]
  env_vars: Record<string, string>
  description: string
  requires_database: boolean
  download_url: string
}

interface DeployResult {
  repoUrl: string
  buildId: string
  appUrl: string
  push_warnings?: string[]
}

type Stack = 'nextjs' | 'node' | 'python-flask'

// ─── Stack options ─────────────────────────────────────────────────────────

const STACKS: { id: Stack; label: string; icon: string; sub: string }[] = [
  { id: 'nextjs', label: 'Next.js', icon: '▲', sub: 'App Router · TypeScript · Tailwind' },
  { id: 'node', label: 'Node.js', icon: '⬡', sub: 'Express · Postgres · Swagger' },
  { id: 'python-flask', label: 'Python Flask', icon: '🐍', sub: 'FastAPI-style · ML-ready' },
]

const REGIONS = [
  { id: 'IN', label: 'India (Mumbai)', flag: '🇮🇳' },
  { id: 'QA', label: 'Qatar (Doha)', flag: '🇶🇦' },
  { id: 'AE', label: 'UAE (Dubai)', flag: '🇦🇪' },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function descriptionToSlug(desc: string): string {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
    .replace(/-+/g, '-')
    .slice(0, 40) || 'my-app'
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SpinnerDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="animate-bounce" style={{ animationDelay: '0ms' }}>●</span>
      <span className="animate-bounce" style={{ animationDelay: '150ms' }}>●</span>
      <span className="animate-bounce" style={{ animationDelay: '300ms' }}>●</span>
    </span>
  )
}

function FileTree({ files }: { files: GeneratedFileInfo[] }) {
  const [open, setOpen] = useState(true)

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 transition-colors"
      >
        <span className="flex items-center gap-2">
          <span className="text-emerald-400">📁</span>
          Generated files
          <span className="text-xs text-slate-500 font-normal">({files.length} files)</span>
        </span>
        <span className="text-slate-500 text-xs">{open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <ul className="px-4 pb-3 space-y-1">
          {files.map(f => (
            <li key={f.path} className="flex items-center justify-between gap-2 font-mono text-xs py-0.5">
              <span className="text-slate-300 truncate">
                <span className="text-slate-600 mr-1">├─</span>
                {f.path}
              </span>
              <span className="text-slate-500 shrink-0">{formatBytes(f.size)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function EnvVarsPanel({
  envVars,
  requiresDatabase,
}: {
  envVars: Record<string, string>
  requiresDatabase: boolean
}) {
  const entries = Object.entries(envVars)
  if (entries.length === 0 && !requiresDatabase) return null

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900 p-4 space-y-3">
      <h3 className="text-sm font-medium text-slate-300 flex items-center gap-2">
        <span className="text-amber-400">⚙</span> Environment &amp; Dependencies
      </h3>
      {requiresDatabase && (
        <div className="flex items-center gap-2 rounded-md bg-blue-900/30 border border-blue-700 px-3 py-1.5 text-xs text-blue-300">
          <span>🐘</span> Requires PostgreSQL — Tinai will provision and inject DATABASE_URL automatically
        </div>
      )}
      {entries.length > 0 && (
        <div className="space-y-1">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-start gap-2 font-mono text-xs">
              <span className="text-emerald-400 shrink-0">{k}</span>
              <span className="text-slate-500">=</span>
              <span className="text-slate-400 break-all">{v || '(will be set by platform)'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function GeneratePage() {
  const [description, setDescription] = useState('')
  const [stack, setStack] = useState<Stack>('nextjs')
  const [appName, setAppName] = useState('')
  const [region, setRegion] = useState('IN')

  const [templates, setTemplates] = useState<Template[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(true)

  const [generating, setGenerating] = useState(false)
  const [generateProgress, setGenerateProgress] = useState<string[]>([])
  const [generateResult, setGenerateResult] = useState<GenerateResult | null>(null)
  const [generateError, setGenerateError] = useState<string | null>(null)

  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<DeployResult | null>(null)
  const [deployError, setDeployError] = useState<string | null>(null)

  // Fetch templates on mount
  useEffect(() => {
    fetch(`${API_URL}/api/v1/codegen/templates`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(data => setTemplates(data as Template[]))
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false))
  }, [])

  // Auto-derive app name from description
  useEffect(() => {
    if (description.trim()) {
      setAppName(descriptionToSlug(description))
    }
  }, [description])

  function applyTemplate(t: Template) {
    setDescription(t.description)
    setStack(t.stack === 'python' ? 'python-flask' : (t.stack as Stack))
    setAppName(t.id)
  }

  async function handleGenerate() {
    if (!description.trim() || generating) return

    setGenerating(true)
    setGenerateError(null)
    setGenerateResult(null)
    setDeployResult(null)
    setDeployError(null)
    setGenerateProgress(['Sending request to Claude Sonnet...'])

    // Simulate progress polling every 2 s while waiting
    const PROGRESS_STEPS = [
      'Analysing requirements...',
      'Designing application architecture...',
      'Generating source files...',
      'Building Dockerfile...',
      'Finalising environment config...',
      'Creating zip archive...',
      'Storing artefact in MinIO...',
    ]
    let stepIdx = 0
    const pollInterval = setInterval(() => {
      if (stepIdx < PROGRESS_STEPS.length) {
        setGenerateProgress(prev => [...prev, PROGRESS_STEPS[stepIdx]])
        stepIdx++
      }
    }, 2000)

    try {
      const token = document.cookie.match(/tinai_token=([^;]+)/)?.[1] ?? ''
      const res = await fetch(`${API_URL}/api/v1/codegen/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ description, stack, appName: appName || descriptionToSlug(description) }),
      })

      clearInterval(pollInterval)

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as GenerateResult
      setGenerateProgress(prev => [...prev, 'Done — code ready.'])
      setGenerateResult(data)
      setAppName(data.jobId ? appName : descriptionToSlug(description))
    } catch (err: unknown) {
      clearInterval(pollInterval)
      setGenerateError(err instanceof Error ? err.message : String(err))
      setGenerateProgress(prev => [...prev, 'Generation failed.'])
    } finally {
      setGenerating(false)
    }
  }

  async function handleDeploy() {
    if (!generateResult || deploying) return

    setDeploying(true)
    setDeployError(null)
    setDeployResult(null)

    try {
      const token = document.cookie.match(/tinai_token=([^;]+)/)?.[1] ?? ''
      const res = await fetch(`${API_URL}/api/v1/codegen/deploy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jobId: generateResult.jobId, appName }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }

      const data = await res.json() as DeployResult
      setDeployResult(data)
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : String(err))
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="space-y-8 pb-16">
      {/* Hero */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Generate App</h1>
        <p className="text-sm text-slate-400 mt-1">
          Describe what you want to build — Claude will generate a complete, deployable app.
        </p>
      </div>

      {/* Templates grid */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">Starter Templates</h2>
        {templatesLoading ? (
          <p className="text-sm text-slate-500">Loading templates...</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {templates.map(t => (
              <button
                key={t.id}
                onClick={() => applyTemplate(t)}
                className="text-left rounded-lg border border-slate-700 bg-slate-800/60 px-3 py-2.5 hover:border-emerald-700 hover:bg-slate-800 transition-colors group"
              >
                <div className="text-xs font-semibold text-slate-200 group-hover:text-emerald-400 transition-colors">
                  {t.name}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 leading-snug">{t.description}</div>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {t.tags.map(tag => (
                    <span key={tag} className="rounded px-1 py-0.5 bg-slate-700 text-[10px] text-slate-400">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Description textarea */}
      <section className="space-y-2">
        <label className="text-sm font-medium text-slate-300" htmlFor="description">
          Describe your app
        </label>
        <textarea
          id="description"
          rows={4}
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="A SaaS dashboard for satellite operators with real-time tracking, user auth, and Razorpay billing..."
          className="w-full resize-none rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-600 focus:outline-none transition-colors"
        />
      </section>

      {/* Stack selector */}
      <section className="space-y-2">
        <h2 className="text-sm font-medium text-slate-300">Stack</h2>
        <div className="flex gap-3">
          {STACKS.map(s => (
            <button
              key={s.id}
              onClick={() => setStack(s.id)}
              className={`flex-1 rounded-lg border px-4 py-3 text-left transition-colors ${
                stack === s.id
                  ? 'border-emerald-600 bg-emerald-900/30 text-emerald-300'
                  : 'border-slate-700 bg-slate-800/60 text-slate-300 hover:border-slate-500'
              }`}
            >
              <div className="text-lg mb-0.5">{s.icon}</div>
              <div className="text-sm font-semibold">{s.label}</div>
              <div className="text-[11px] text-slate-500">{s.sub}</div>
            </button>
          ))}
        </div>
      </section>

      {/* Generate button */}
      <button
        onClick={handleGenerate}
        disabled={!description.trim() || generating}
        className="w-full rounded-lg bg-emerald-700 py-3 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {generating ? (
          <span className="flex items-center justify-center gap-2">
            <SpinnerDots /> Generating...
          </span>
        ) : (
          'Generate with Claude'
        )}
      </button>

      {/* Progress log */}
      {generateProgress.length > 0 && (
        <div className="rounded-lg border border-slate-800 bg-slate-950 px-4 py-3 font-mono text-xs space-y-0.5">
          {generateProgress.map((line, i) => (
            <div key={i} className="text-slate-400">
              <span className="text-slate-600 mr-2">{String(i + 1).padStart(2, '0')}</span>
              {line}
            </div>
          ))}
          {generating && (
            <div className="text-emerald-400">
              <span className="text-slate-600 mr-2">{String(generateProgress.length + 1).padStart(2, '0')}</span>
              <SpinnerDots />
            </div>
          )}
        </div>
      )}

      {/* Generation error */}
      {generateError && (
        <div className="rounded-lg border border-red-700 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {generateError}
        </div>
      )}

      {/* Generation result */}
      {generateResult && (
        <section className="space-y-4">
          <div className="rounded-lg border border-emerald-800 bg-emerald-900/10 px-4 py-3 text-sm text-emerald-300">
            {generateResult.description}
          </div>

          <FileTree files={generateResult.files} />

          <EnvVarsPanel
            envVars={generateResult.env_vars}
            requiresDatabase={generateResult.requires_database}
          />

          {/* File preview — show first 3 files */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">File Preview</h3>
            {generateResult.files.slice(0, 3).map(f => (
              <div key={f.path} className="rounded-lg border border-slate-800 overflow-hidden">
                <div className="flex items-center gap-2 bg-slate-900 px-3 py-1.5 text-xs text-slate-500 font-mono border-b border-slate-800">
                  <span className="text-emerald-500">●</span>
                  {f.path}
                  <span className="ml-auto text-slate-600">{formatBytes(f.size)}</span>
                </div>
                <pre className="language-typescript p-3 text-xs text-slate-300 overflow-x-auto bg-slate-950 max-h-48">
                  <code className="whitespace-pre-wrap break-words">
                    (content stored in job — {formatBytes(f.size)} — deploy to see full source)
                  </code>
                </pre>
              </div>
            ))}
          </div>

          {/* Deploy panel */}
          <div className="rounded-xl border border-slate-700 bg-slate-900 p-5 space-y-4">
            <h2 className="text-sm font-semibold text-slate-200">Deploy to Tinai Cloud</h2>

            {/* App name */}
            <div className="space-y-1">
              <label className="text-xs text-slate-400" htmlFor="appName">App name</label>
              <input
                id="appName"
                type="text"
                value={appName}
                onChange={e => setAppName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 font-mono focus:border-emerald-600 focus:outline-none"
              />
              <p className="text-[11px] text-slate-500">
                Will be live at{' '}
                <span className="text-emerald-500">https://{appName || 'your-app'}.apps.tinai.cloud</span>
              </p>
            </div>

            {/* Region */}
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Region</label>
              <div className="flex gap-2">
                {REGIONS.map(r => (
                  <button
                    key={r.id}
                    onClick={() => setRegion(r.id)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                      region === r.id
                        ? 'border-emerald-600 bg-emerald-900/30 text-emerald-300'
                        : 'border-slate-700 bg-slate-800 text-slate-400 hover:border-slate-500'
                    }`}
                  >
                    {r.flag} {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Deploy button */}
            {!deployResult ? (
              <button
                onClick={handleDeploy}
                disabled={deploying || !appName.trim()}
                className="w-full rounded-lg bg-emerald-700 py-2.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {deploying ? (
                  <span className="flex items-center justify-center gap-2">
                    <SpinnerDots /> Deploying...
                  </span>
                ) : (
                  'Deploy to Tinai'
                )}
              </button>
            ) : null}

            {/* Deploy error */}
            {deployError && (
              <div className="rounded-lg border border-red-700 bg-red-900/20 px-4 py-3 text-sm text-red-400">
                {deployError}
              </div>
            )}

            {/* Deploy success */}
            {deployResult && (
              <div className="rounded-lg border border-emerald-700 bg-emerald-900/20 p-4 space-y-2">
                <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
                  <span>✓</span> Deployed successfully
                </div>
                <div className="space-y-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 w-20">Live URL</span>
                    <a
                      href={deployResult.appUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-emerald-400 hover:underline font-mono"
                    >
                      {deployResult.appUrl}
                    </a>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 w-20">Build ID</span>
                    <span className="text-slate-300 font-mono">{deployResult.buildId}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-500 w-20">Repo</span>
                    <a
                      href={deployResult.repoUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-slate-300 hover:underline font-mono truncate"
                    >
                      {deployResult.repoUrl}
                    </a>
                  </div>
                </div>
                {deployResult.push_warnings && deployResult.push_warnings.length > 0 && (
                  <details className="text-xs">
                    <summary className="text-amber-400 cursor-pointer">
                      {deployResult.push_warnings.length} file push warning(s)
                    </summary>
                    <ul className="mt-1 space-y-0.5 pl-2 text-slate-400">
                      {deployResult.push_warnings.map((w, i) => (
                        <li key={i}>{w}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
