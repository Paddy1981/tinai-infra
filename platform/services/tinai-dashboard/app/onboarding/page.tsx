'use client'

import { useState } from 'react'

type Product = 'instances' | 'storage' | 'inference'

const PRODUCTS: { id: Product; label: string; desc: string; icon: string }[] = [
  {
    id: 'instances',
    label: 'GPU Instances',
    desc: 'Run ML workloads on RTX 4090, A100, H100',
    icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18',
  },
  {
    id: 'storage',
    label: 'Storage',
    desc: 'MinIO object storage + managed Postgres',
    icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
  },
  {
    id: 'inference',
    label: 'Inference',
    desc: 'Managed AI proxy: Anthropic, Sarvam, Gemini',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
  },
]

function ProgressDots({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-2 mb-10">
      {[1, 2, 3, 4].map((s) => (
        <div
          key={s}
          className={`rounded-full transition-all duration-300 ${
            s === step
              ? 'w-6 h-2.5 bg-emerald-500'
              : s < step
              ? 'w-2.5 h-2.5 bg-emerald-700'
              : 'w-2.5 h-2.5 bg-slate-700'
          }`}
        />
      ))}
    </div>
  )
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <div className="relative bg-slate-950 border border-slate-700 rounded-lg p-4 font-mono text-sm text-emerald-300 overflow-x-auto">
      <pre className="pr-16 whitespace-pre-wrap break-all">{code}</pre>
      <button
        onClick={copy}
        className="absolute top-3 right-3 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 border border-slate-700 rounded px-2 py-1 transition-colors"
      >
        {copied ? 'Copied!' : 'Copy'}
      </button>
    </div>
  )
}

// ---------- Steps ----------

function Step1({
  selected,
  onToggle,
  onContinue,
}: {
  selected: Set<Product>
  onToggle: (p: Product) => void
  onContinue: () => void
}) {
  return (
    <div className="space-y-8">
      <div className="text-center space-y-3">
        <h1 className="text-3xl font-bold text-slate-100 tracking-tight">Welcome to tinai.cloud</h1>
        <p className="text-slate-400 text-base max-w-lg mx-auto">
          India's sovereign cloud — compute, storage, and AI inference in one platform.
        </p>
      </div>

      <p className="text-sm text-slate-400 text-center">What would you like to use? Select all that apply.</p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {PRODUCTS.map((p) => {
          const active = selected.has(p.id)
          return (
            <button
              key={p.id}
              onClick={() => onToggle(p.id)}
              className={`group text-left rounded-xl border p-5 transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                active
                  ? 'border-emerald-500 bg-emerald-950/40 shadow-lg shadow-emerald-950/50'
                  : 'border-slate-700 bg-slate-900 hover:border-slate-600'
              }`}
            >
              <div
                className={`mb-3 w-8 h-8 flex items-center justify-center rounded-lg ${
                  active ? 'bg-emerald-600' : 'bg-slate-800 group-hover:bg-slate-700'
                }`}
              >
                <svg
                  className="w-4 h-4 text-white"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={1.75}
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d={p.icon} />
                </svg>
              </div>
              <div className={`font-semibold text-sm mb-1 ${active ? 'text-emerald-300' : 'text-slate-200'}`}>
                {p.label}
              </div>
              <div className="text-xs text-slate-500">{p.desc}</div>
              {active && (
                <div className="mt-3 flex items-center gap-1 text-xs text-emerald-400 font-medium">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414L8.414 15l-4.121-4.121a1 1 0 011.414-1.414L8.414 12.172l6.879-6.879a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  Selected
                </div>
              )}
            </button>
          )
        })}
      </div>

      <div className="flex justify-end">
        <button
          onClick={onContinue}
          disabled={selected.size === 0}
          className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

const SNIPPETS: Record<Product, string> = {
  instances: `tinai instance launch \\
  --image pytorch-v2.8 \\
  --type gpu-rtx4090-1x`,
  storage: `tinai storage bucket create my-bucket \\
  --region in`,
  inference: `curl https://api.tinai.cloud/v1/chat/completions \\
  -H "Authorization: Bearer $TINAI_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"claude-3-5-sonnet","messages":[{"role":"user","content":"Hello"}]}'`,
}

function Step2({ selected, onContinue }: { selected: Set<Product>; onContinue: () => void }) {
  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-slate-100">Quick start</h2>
        <p className="text-slate-400 text-sm">Install the CLI and run your first command.</p>
      </div>

      <div className="space-y-5">
        {PRODUCTS.filter((p) => selected.has(p.id)).map((p) => (
          <div key={p.id} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
              <svg
                className="w-4 h-4 text-emerald-500"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d={PRODUCTS.find((x) => x.id === p.id)!.icon} />
              </svg>
              {p.label}
            </div>
            <CodeBlock code={SNIPPETS[p.id]} />
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between">
        <a
          href="/docs/cli"
          className="text-sm text-emerald-400 hover:text-emerald-300 underline underline-offset-2 transition-colors"
        >
          Install CLI →
        </a>
        <button
          onClick={onContinue}
          className="px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors"
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function Step3({ onContinue }: { onContinue: () => void }) {
  const [keyName, setKeyName] = useState('default')
  const [loading, setLoading] = useState(false)
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function createKey() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/settings/api-keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tinai-CSRF': '1',
        },
        body: JSON.stringify({ name: keyName || 'default' }),
      })
      if (!res.ok) throw new Error(`Server returned ${res.status}`)
      const data = await res.json()
      setApiKey(data.key ?? data.api_key ?? data.token ?? JSON.stringify(data))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to create key')
    } finally {
      setLoading(false)
    }
  }

  function copyKey() {
    if (!apiKey) return
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-8">
      <div className="text-center space-y-2">
        <h2 className="text-2xl font-bold text-slate-100">Create your API key</h2>
        <p className="text-slate-400 text-sm">You'll use this to authenticate CLI and API calls.</p>
      </div>

      {!apiKey ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wider" htmlFor="key-name">
              Key name
            </label>
            <input
              id="key-name"
              type="text"
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="default"
              className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500 transition-colors"
            />
          </div>

          {error && (
            <p className="text-xs text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg px-3 py-2">{error}</p>
          )}

          <button
            onClick={createKey}
            disabled={loading}
            className="w-full py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors flex items-center justify-center gap-2"
          >
            {loading && (
              <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {loading ? 'Creating…' : 'Create API Key'}
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative bg-emerald-950/30 border border-emerald-700/60 rounded-xl p-4">
            <p className="font-mono text-sm text-emerald-300 break-all pr-16">{apiKey}</p>
            <button
              onClick={copyKey}
              className="absolute top-3 right-3 text-xs text-slate-400 hover:text-slate-200 bg-slate-800 border border-slate-700 rounded px-2 py-1 transition-colors"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div className="flex items-start gap-2 text-xs text-amber-400 bg-amber-950/20 border border-amber-800/40 rounded-lg px-3 py-2.5">
            <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path
                fillRule="evenodd"
                d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                clipRule="evenodd"
              />
            </svg>
            Save this — it won't be shown again.
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        {!apiKey && (
          <button onClick={onContinue} className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
            Skip for now
          </button>
        )}
        <button
          onClick={onContinue}
          disabled={!apiKey}
          className={`px-6 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors ${
            !apiKey ? '' : 'ml-auto'
          }`}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

const QUICK_LINKS = [
  { label: 'Launch Instance', href: '/instances/new', icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18' },
  { label: 'Create Bucket', href: '/storage/new', icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4' },
  { label: 'Create Endpoint', href: '/inference/new', icon: 'M13 10V3L4 14h7v7l9-11h-7z' },
  { label: 'View Docs', href: '/docs', icon: 'M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253' },
]

function Step4() {
  return (
    <div className="space-y-8 text-center">
      {/* Checkmark animation */}
      <div className="flex justify-center">
        <div className="relative w-20 h-20">
          <svg className="w-20 h-20" viewBox="0 0 80 80">
            <circle
              cx="40"
              cy="40"
              r="36"
              fill="none"
              stroke="#059669"
              strokeWidth="4"
              strokeDasharray="226"
              strokeDashoffset="0"
              style={{ animation: 'draw-circle 0.5s ease forwards' }}
            />
            <path
              d="M24 41 L35 52 L56 30"
              fill="none"
              stroke="#34d399"
              strokeWidth="4"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="50"
              strokeDashoffset="50"
              style={{ animation: 'draw-check 0.4s ease 0.4s forwards' }}
            />
          </svg>
        </div>
      </div>

      <style>{`
        @keyframes draw-circle {
          from { stroke-dashoffset: 226; }
          to { stroke-dashoffset: 0; }
        }
        @keyframes draw-check {
          from { stroke-dashoffset: 50; }
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      <div className="space-y-2">
        <h2 className="text-2xl font-bold text-slate-100">You're all set!</h2>
        <p className="text-slate-400 text-sm">Your tinai.cloud workspace is ready. Where do you want to go?</p>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {QUICK_LINKS.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="flex flex-col items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 hover:border-emerald-700/60 hover:bg-emerald-950/20 px-3 py-4 text-sm text-slate-300 hover:text-emerald-300 transition-all duration-200 group"
          >
            <div className="w-8 h-8 flex items-center justify-center rounded-lg bg-slate-800 group-hover:bg-emerald-900/50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d={link.icon} />
              </svg>
            </div>
            <span className="font-medium text-xs leading-tight text-center">{link.label}</span>
          </a>
        ))}
      </div>

      <a
        href="/"
        className="inline-flex items-center gap-2 px-8 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-sm transition-colors"
      >
        Go to Dashboard
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
        </svg>
      </a>
    </div>
  )
}

// ---------- Main ----------

export default function OnboardingPage() {
  const [step, setStep] = useState(1)
  const [selected, setSelected] = useState<Set<Product>>(new Set())

  function toggleProduct(p: Product) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  function advance() {
    setStep((s) => {
      const next = s + 1
      if (next === 4) {
        if (typeof window !== 'undefined') {
          localStorage.setItem('tinai_onboarding_done', '1')
        }
      }
      return next
    })
  }

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center px-4 py-12">
      {/* Subtle grid background */}
      <div
        className="fixed inset-0 pointer-events-none opacity-[0.03]"
        style={{
          backgroundImage:
            'linear-gradient(to right, #94a3b8 1px, transparent 1px), linear-gradient(to bottom, #94a3b8 1px, transparent 1px)',
          backgroundSize: '48px 48px',
        }}
      />

      <div className="relative w-full max-w-2xl">
        {/* Logo */}
        <div className="flex items-center justify-center gap-1.5 mb-8">
          <span className="text-emerald-400 font-bold text-xl tracking-tight">tinai</span>
          <span className="text-slate-600 text-sm">.cloud</span>
        </div>

        <ProgressDots step={step} />

        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl shadow-black/40">
          {step === 1 && <Step1 selected={selected} onToggle={toggleProduct} onContinue={advance} />}
          {step === 2 && (
            <Step2
              selected={selected.size > 0 ? selected : new Set<Product>(['instances'])}
              onContinue={advance}
            />
          )}
          {step === 3 && <Step3 onContinue={advance} />}
          {step === 4 && <Step4 />}
        </div>

        <p className="text-center text-xs text-slate-600 mt-6">
          Need help?{' '}
          <a href="/docs" className="text-slate-500 hover:text-slate-300 underline underline-offset-2 transition-colors">
            Read the docs
          </a>{' '}
          or{' '}
          <a
            href="mailto:support@tinai.cloud"
            className="text-slate-500 hover:text-slate-300 underline underline-offset-2 transition-colors"
          >
            contact support
          </a>
        </p>
      </div>
    </div>
  )
}
