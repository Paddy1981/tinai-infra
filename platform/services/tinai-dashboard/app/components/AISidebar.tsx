'use client'

import { useState, useRef, useEffect } from 'react'

const API_URL = ''

// Page-specific quick prompts — mirrors sattrack-web's PAGE_CONTEXTS pattern
const PAGE_CONTEXTS: Record<string, { name: string; prompts: string[] }> = {
  '/apps': {
    name: 'Apps',
    prompts: ['Why did my last build fail?', 'List apps with issues', 'How do I redeploy?'],
  },
  '/billing': {
    name: 'Billing',
    prompts: ['How can I reduce compute costs?', 'Explain my usage this month', 'What is included in GST?'],
  },
  '/compliance': {
    name: 'Compliance',
    prompts: ['DPDP compliance status?', 'Data residency summary', 'MeitY requirements'],
  },
  '/space': {
    name: 'Space',
    prompts: ['Which ISRO satellites are tracked?', 'India satellite coverage', 'CARTOSAT-3 status'],
  },
  '/copilot': {
    name: 'Copilot',
    prompts: ['Platform health summary', 'Top cost optimization tips', 'Build & deploy quick guide'],
  },
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function AISidebar() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pathname, setPathname] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setPathname(window.location.pathname)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  const ctx =
    Object.entries(PAGE_CONTEXTS).find(([k]) => pathname.startsWith(k))?.[1] ??
    { name: 'Tinai', prompts: ['Platform status overview', 'Build & deploy help', 'Cost optimisation tips'] }

  async function send(text: string) {
    const t = text.trim()
    if (!t || loading) return
    setMessages(p => [...p, { role: 'user', content: t }])
    setInput('')
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: t }),
      })
      const data = await res.json()
      setMessages(p => [...p, { role: 'assistant', content: data.response }])
    } catch {
      setMessages(p => [...p, { role: 'assistant', content: 'Connection error — please try again.' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) }
  }

  return (
    <>
      {/* Floating trigger button — fixed bottom-right, inspired by sattrack-web */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Open AI Copilot"
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-semibold text-white shadow-lg transition-transform hover:-translate-y-0.5"
        style={{ background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)', boxShadow: '0 4px 18px rgba(79,70,229,0.45)' }}
      >
        <span style={{ fontSize: 16 }}>✦</span>
        <span>Ask AI</span>
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Slide-out panel — same layout as sattrack-web #ais-panel */}
      <div
        className={`fixed top-0 right-0 bottom-0 z-50 flex flex-col border-l border-slate-800 bg-slate-950 shadow-2xl transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}
        style={{ width: 380 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <div>
            <div className="text-sm font-bold text-slate-100">Tinai Copilot</div>
            <div
              className="mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold uppercase tracking-wide"
              style={{ color: '#a0a8f8', background: 'rgba(79,70,229,0.12)', borderColor: 'rgba(79,70,229,0.3)' }}
            >
              <span style={{ fontSize: 8 }}>✦</span>
              {ctx.name}
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-1.5 py-0.5 text-xl text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-100"
          >
            ×
          </button>
        </div>

        {/* Quick prompt chips */}
        <div className="flex flex-wrap gap-1.5 border-b border-slate-800/50 px-3 py-2">
          {ctx.prompts.map(p => (
            <button
              key={p}
              onClick={() => send(p)}
              className="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
              style={{ color: '#a0a8f8', background: 'rgba(79,70,229,0.08)', borderColor: 'rgba(79,70,229,0.25)' }}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Messages */}
        <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          {messages.length === 0 && !loading && (
            <p className="mt-8 text-center text-xs italic text-slate-600">
              Ask anything about your platform
            </p>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                  m.role === 'user'
                    ? 'border border-indigo-800 bg-indigo-900/30 text-indigo-100'
                    : 'border border-slate-700 bg-slate-800 text-slate-200 whitespace-pre-wrap'
                }`}
              >
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-amber-400">
                Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-slate-800 p-3">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask anything…"
              disabled={loading}
              className="flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 placeholder-slate-600 focus:border-indigo-700 focus:outline-none disabled:opacity-50"
            />
            <button
              onClick={() => send(input)}
              disabled={loading || !input.trim()}
              className="rounded-lg bg-indigo-700 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
