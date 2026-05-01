'use client'

import { useState } from 'react'

const TABS = ['Overview', 'API Keys', 'Channels', 'SDK', 'Webhooks'] as const
type Tab = typeof TABS[number]

const CODE_SNIPPETS: Record<string, { label: string; code: string }> = {
  node: {
    label: 'Node.js',
    code: `import { TinaiColl } from '@tinai/coll'

const coll = new TinaiColl({ apiKey: 'tc_live_...' })

// Create a channel
const channel = await coll.channels.create({
  name: 'project-updates',
  type: 'group',  // 'group' | 'direct' | 'broadcast'
})

// Send a message
await channel.send({
  text: 'Deployment v2.1 is live!',
  metadata: { type: 'deploy', version: '2.1' },
})

// Listen for real-time messages
channel.on('message', (msg) => {
  console.log(\`[\${msg.sender}]: \${msg.text}\`)
})`,
  },
  python: {
    label: 'Python',
    code: `from tinai_coll import TinaiColl

coll = TinaiColl(api_key="tc_live_...")

# Create a channel
channel = coll.channels.create(
    name="project-updates",
    channel_type="group",
)

# Send a message
channel.send(
    text="Deployment v2.1 is live!",
    metadata={"type": "deploy", "version": "2.1"},
)

# Async listener for real-time
async for msg in channel.listen():
    print(f"[{msg.sender}]: {msg.text}")`,
  },
  curl: {
    label: 'REST API',
    code: `# Create channel
curl -X POST https://api.tinai.cloud/v1/coll/channels \\
  -H "Authorization: Bearer tc_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"name": "project-updates", "type": "group"}'

# Send message
curl -X POST https://api.tinai.cloud/v1/coll/channels/{id}/messages \\
  -H "Authorization: Bearer tc_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{"text": "Deployment v2.1 is live!"}'

# WebSocket connection for real-time
wscat -c "wss://ws.tinai.cloud/v1/coll?token=tc_live_..."`,
  },
  react: {
    label: 'React',
    code: `import { CollProvider, useChannel, useMessages } from '@tinai/coll-react'

function App() {
  return (
    <CollProvider apiKey="tc_live_...">
      <Chat channelId="project-updates" />
    </CollProvider>
  )
}

function Chat({ channelId }: { channelId: string }) {
  const channel = useChannel(channelId)
  const { messages, send } = useMessages(channelId)

  return (
    <div>
      {messages.map(m => (
        <div key={m.id}>{m.sender}: {m.text}</div>
      ))}
      <input onKeyDown={e => {
        if (e.key === 'Enter') send({ text: e.currentTarget.value })
      }} />
    </div>
  )
}`,
  },
}

const WEBHOOK_EVENTS = [
  { event: 'message.created', desc: 'New message in a channel' },
  { event: 'message.updated', desc: 'Message was edited' },
  { event: 'message.deleted', desc: 'Message was deleted' },
  { event: 'channel.created', desc: 'New channel created' },
  { event: 'member.joined', desc: 'User joined a channel' },
  { event: 'member.left', desc: 'User left a channel' },
  { event: 'presence.online', desc: 'User came online' },
  { event: 'typing.start', desc: 'User started typing' },
]

export default function CollPage() {
  const [activeTab, setActiveTab] = useState<Tab>('Overview')
  const [activeSnippet, setActiveSnippet] = useState('node')

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center">
            <span className="material-symbols-outlined text-emerald-400" style={{ fontSize: 22 }}>forum</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>COLL</h1>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Real-time messaging and collaboration API</p>
          </div>
        </div>
        <a
          href="https://docs.tinai.cloud/coll"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:border-emerald-500/30"
          style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
          Docs
        </a>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mt-6 mb-6 border-b" style={{ borderColor: 'var(--t-border)' }}>
        {TABS.map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-colors relative ${
              activeTab === tab ? 'text-[#F97316]' : ''
            }`}
            style={activeTab !== tab ? { color: 'var(--t-text-muted)' } : {}}
          >
            {tab}
            {activeTab === tab && (
              <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#F97316] rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === 'Overview' && (
        <div className="space-y-6">
          {/* Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Messages', value: '0', sub: 'This month', icon: 'chat', color: 'text-emerald-400' },
              { label: 'Channels', value: '0', sub: 'Active', icon: 'tag', color: 'text-blue-400' },
              { label: 'Connections', value: '0', sub: 'Peak concurrent', icon: 'cable', color: 'text-violet-400' },
              { label: 'API Keys', value: '0', sub: 'Active', icon: 'key', color: 'text-amber-400' },
            ].map(s => (
              <div key={s.label} className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs" style={{ color: 'var(--t-text-muted)' }}>{s.label}</span>
                  <span className={`material-symbols-outlined ${s.color}`} style={{ fontSize: 16 }}>{s.icon}</span>
                </div>
                <p className="text-xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>{s.value}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--t-text-dim)' }}>{s.sub}</p>
              </div>
            ))}
          </div>

          {/* Quick start */}
          <div className="rounded-xl border p-6" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--t-text)' }}>Quick Start</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-muted)' }}>Add real-time messaging to your app</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { step: '1', title: 'Create API Key', desc: 'Generate a COLL API key', tab: 'API Keys' as Tab, icon: 'key' },
                { step: '2', title: 'Create Channel', desc: 'Set up your first messaging channel', tab: 'Channels' as Tab, icon: 'tag' },
                { step: '3', title: 'Integrate SDK', desc: 'Add real-time messaging with 5 lines', tab: 'SDK' as Tab, icon: 'code' },
              ].map(s => (
                <button
                  key={s.step}
                  onClick={() => setActiveTab(s.tab)}
                  className="text-left p-4 rounded-lg border transition-colors hover:border-emerald-500/30"
                  style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-5 h-5 rounded-full bg-emerald-500/15 text-emerald-400 text-xs font-bold flex items-center justify-center">{s.step}</span>
                    <span className="text-sm font-medium" style={{ color: 'var(--t-text)' }}>{s.title}</span>
                  </div>
                  <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{s.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Features */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { icon: 'bolt', title: 'Real-time', desc: 'WebSocket-based sub-50ms delivery' },
              { icon: 'group', title: 'Channels', desc: 'Group, direct, and broadcast channels' },
              { icon: 'history', title: 'Message History', desc: 'Persistent storage with search' },
              { icon: 'attach_file', title: 'File Sharing', desc: 'Upload files and media to channels' },
              { icon: 'notifications', title: 'Push Notifications', desc: 'FCM/APNs for mobile apps' },
              { icon: 'lock', title: 'Sovereign', desc: 'All data stays in Indian infra' },
              { icon: 'person', title: 'Presence', desc: 'Online/offline/typing indicators' },
              { icon: 'thread_unread', title: 'Threads', desc: 'Threaded replies and reactions' },
              { icon: 'widgets', title: 'React Components', desc: 'Drop-in UI kit for React apps' },
            ].map(f => (
              <div key={f.icon} className="rounded-lg border p-3" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
                <span className="material-symbols-outlined text-emerald-400 mb-2 block" style={{ fontSize: 18 }}>{f.icon}</span>
                <p className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>{f.title}</p>
                <p className="text-[11px] mt-0.5" style={{ color: 'var(--t-text-dim)' }}>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* API Keys */}
      {activeTab === 'API Keys' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Manage API keys for the COLL API</p>
            <button className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Create Key
            </button>
          </div>
          <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <p className="text-xs mb-2" style={{ color: 'var(--t-text-muted)' }}>Key types:</p>
            <div className="space-y-2">
              {[
                { type: 'Server', prefix: 'tc_server_', desc: 'Full access — use in your backend only. Never expose to client.' },
                { type: 'Client', prefix: 'tc_client_', desc: 'Limited access — safe for browser/mobile SDKs. Read + send only.' },
              ].map(k => (
                <div key={k.type} className="flex items-start gap-3 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--t-surface-2)' }}>
                  <code className="text-xs font-mono text-emerald-400 w-24 shrink-0 mt-0.5">{k.prefix}</code>
                  <div>
                    <p className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>{k.type} Key</p>
                    <p className="text-[11px]" style={{ color: 'var(--t-text-dim)' }}>{k.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
            <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>key</span>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No API keys yet</p>
          </div>
        </div>
      )}

      {/* Channels */}
      {activeTab === 'Channels' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Manage messaging channels</p>
            <button className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Create Channel
            </button>
          </div>
          <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <p className="text-xs mb-2" style={{ color: 'var(--t-text-muted)' }}>Channel types:</p>
            <div className="grid grid-cols-3 gap-2">
              {[
                { type: 'Group', icon: 'group', desc: 'Multi-user chat with history' },
                { type: 'Direct', icon: 'person', desc: '1:1 private messaging' },
                { type: 'Broadcast', icon: 'campaign', desc: 'One-to-many notifications' },
              ].map(c => (
                <div key={c.type} className="text-center p-3 rounded-lg" style={{ backgroundColor: 'var(--t-surface-2)' }}>
                  <span className="material-symbols-outlined text-emerald-400 block mb-1" style={{ fontSize: 20 }}>{c.icon}</span>
                  <p className="text-xs font-semibold" style={{ color: 'var(--t-text)' }}>{c.type}</p>
                  <p className="text-[10px] mt-0.5" style={{ color: 'var(--t-text-dim)' }}>{c.desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
            <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>forum</span>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No channels yet</p>
            <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Create channels via the API or dashboard</p>
          </div>
        </div>
      )}

      {/* SDK */}
      {activeTab === 'SDK' && (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            Integrate real-time messaging using our SDK or REST API.
          </p>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
            <div className="flex border-b" style={{ borderColor: 'var(--t-border)', backgroundColor: 'var(--t-surface-2)' }}>
              {Object.entries(CODE_SNIPPETS).map(([key, { label }]) => (
                <button
                  key={key}
                  onClick={() => setActiveSnippet(key)}
                  className={`px-4 py-2 text-xs font-medium transition-colors ${activeSnippet === key ? 'text-[#F97316] bg-[#F97316]/5' : ''}`}
                  style={activeSnippet !== key ? { color: 'var(--t-text-muted)' } : {}}
                >
                  {label}
                </button>
              ))}
            </div>
            <pre className="p-4 text-xs font-mono overflow-x-auto" style={{ backgroundColor: 'var(--t-surface)', color: 'var(--t-text)' }}>
              {CODE_SNIPPETS[activeSnippet].code}
            </pre>
          </div>
          <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-sm font-semibold mb-2" style={{ color: 'var(--t-text)' }}>Install SDK</h3>
            <div className="space-y-2">
              {[
                { pkg: 'npm install @tinai/coll', label: 'Node.js' },
                { pkg: 'npm install @tinai/coll-react', label: 'React' },
                { pkg: 'pip install tinai-coll', label: 'Python' },
                { pkg: 'go get github.com/tinai-cloud/coll-go', label: 'Go' },
              ].map(p => (
                <div key={p.label} className="flex items-center gap-3">
                  <span className="text-xs w-14 shrink-0" style={{ color: 'var(--t-text-dim)' }}>{p.label}</span>
                  <code className="text-xs font-mono px-3 py-1.5 rounded-lg flex-1" style={{ backgroundColor: 'var(--t-surface-2)', color: 'var(--t-text)' }}>{p.pkg}</code>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Webhooks */}
      {activeTab === 'Webhooks' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
              Get server-side notifications for messaging events.
            </p>
            <button className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Add Endpoint
            </button>
          </div>
          <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--t-text)' }}>Available Events</h3>
            <div className="space-y-1.5">
              {WEBHOOK_EVENTS.map(e => (
                <div key={e.event} className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ backgroundColor: 'var(--t-surface-2)' }}>
                  <code className="text-xs font-mono text-emerald-400 w-36 shrink-0">{e.event}</code>
                  <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{e.desc}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
            <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>webhook</span>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No webhook endpoints configured</p>
          </div>
        </div>
      )}
    </div>
  )
}
