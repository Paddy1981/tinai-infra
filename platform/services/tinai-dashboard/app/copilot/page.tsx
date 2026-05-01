'use client'

import { useState, useRef, useEffect } from 'react'

type Incident = { pod: string; service: string; count: number; sample: string; last_seen: string }

function IncidentsFeed() {
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [loading, setLoading] = useState(true)
  const [explaining, setExplaining] = useState<string | null>(null)
  const [explanations, setExplanations] = useState<Record<string, { explanation: string; suggested_fix: string }>>({})

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/copilot/incidents')
      if (res.ok) setIncidents(await res.json())
    } finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  const explain = async (inc: Incident) => {
    if (explanations[inc.pod]) return
    setExplaining(inc.pod)
    try {
      const res = await fetch('/api/v1/copilot/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ log_snippet: inc.sample }),
      })
      if (res.ok) { const data = await res.json(); setExplanations(e => ({ ...e, [inc.pod]: data })) }
    } finally { setExplaining(null) }
  }

  if (loading) return <div className="text-center text-slate-500 py-20">Querying Loki…</div>
  if (incidents.length === 0) return (
    <div className="text-center py-20">
      <span className="material-symbols-outlined text-emerald-500 block mb-2" style={{ fontSize: 36 }}>check_circle</span>
      <p className="text-slate-400 text-sm">No errors in the last 30 minutes</p>
    </div>
  )

  return (
    <div className="space-y-2 overflow-y-auto flex-1">
      <div className="flex justify-end mb-2">
        <button onClick={load} className="text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1">
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span> Refresh
        </button>
      </div>
      {incidents.map(inc => (
        <div key={inc.pod} className="rounded-lg border border-slate-700 bg-slate-900 overflow-hidden">
          <div className="flex items-center gap-3 p-3">
            <span className="material-symbols-outlined text-red-400 shrink-0" style={{ fontSize: 18 }}>error</span>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="text-sm font-medium text-slate-200">{inc.service || inc.pod}</span>
                <span className="text-xs px-1.5 py-0.5 bg-red-400/10 text-red-400 rounded">{inc.count}×</span>
              </div>
              <p className="text-xs text-slate-500 font-mono truncate">{inc.sample}</p>
            </div>
            <button onClick={() => explain(inc)} disabled={explaining === inc.pod}
              className="shrink-0 text-xs px-2 py-1 bg-emerald-900/30 text-emerald-400 border border-emerald-800 rounded hover:bg-emerald-900/50 disabled:opacity-50">
              {explaining === inc.pod ? '…' : 'Explain'}
            </button>
          </div>
          {explanations[inc.pod] && (
            <div className="border-t border-slate-700 p-3 bg-slate-800/50 grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-semibold text-emerald-400 mb-1">What happened</p>
                <p className="text-xs text-slate-300 leading-relaxed">{explanations[inc.pod].explanation}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-emerald-400 mb-1">Suggested fix</p>
                <p className="text-xs text-slate-300 font-mono leading-relaxed whitespace-pre-wrap">{explanations[inc.pod].suggested_fix}</p>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const STARTERS = [
  'Why did my last build fail?',
  'Show me the current deployment status',
  'How can I reduce my compute costs?',
  'What ISRO satellites are currently tracked?',
]

function CopilotChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState<boolean | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function sendMessage(text: string) {
    const trimmed = text.trim()
    if (!trimmed || loading) return

    const userMsg: Message = { role: 'user', content: trimmed }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      const res = await fetch('/api/v1/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ message: trimmed }),
      })
      if (!res.ok) throw new Error(`Copilot error: ${res.status}`)
      const data = await res.json()
      setActive(data.active)
      setMessages(prev => [...prev, { role: 'assistant', content: data.response }])
    } catch (err: any) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${err.message ?? 'Failed to reach copilot'}` },
      ])
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    sendMessage(input)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Stub mode banner */}
      {active === false && (
        <div className="mb-3 rounded-md border border-amber-700 bg-amber-900/20 px-4 py-2 text-sm text-amber-400">
          Copilot in stub mode — add ANTHROPIC_API_KEY to activate
        </div>
      )}

      {/* Chat area */}
      <div className="flex-1 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900 p-4 min-h-0">
        {messages.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center h-full gap-6 py-8">
            <p className="text-slate-500 text-sm">Ask anything about your platform</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-lg">
              {STARTERS.map(q => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  className="text-left rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 hover:border-emerald-700 hover:bg-slate-700 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={
                    msg.role === 'user'
                      ? 'max-w-[75%] rounded-lg border border-emerald-800 bg-emerald-900/30 px-4 py-2 text-sm text-slate-100'
                      : 'max-w-[80%] rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-slate-200 whitespace-pre-wrap'
                  }
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm text-amber-400">
                  Thinking...
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}
      </div>

      {/* Input area */}
      <form onSubmit={handleSubmit} className="mt-3 flex gap-2 items-end">
        <textarea
          rows={2}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask about builds, deployments, costs, satellites…"
          disabled={loading}
          className="flex-1 resize-none rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:border-emerald-700 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Ask
        </button>
      </form>
    </div>
  )
}

export default function CopilotPage() {
  const [tab, setTab] = useState<'chat' | 'incidents'>('chat')
  return (
    <div className="flex flex-col h-[calc(100vh-120px)]">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Copilot</h1>
          <p className="text-sm text-slate-400 mt-1">AI-powered platform assistant</p>
        </div>
        <div className="flex gap-1 bg-slate-800 rounded-lg p-1">
          {(['chat', 'incidents'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${tab === t ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
              {t === 'chat' ? 'Chat' : 'Incidents'}
            </button>
          ))}
        </div>
      </div>
      {tab === 'chat' ? <CopilotChat /> : <IncidentsFeed />}
    </div>
  )
}
