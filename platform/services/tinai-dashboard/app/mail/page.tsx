'use client'

import { useState } from 'react'

const TABS = ['Overview', 'API Keys', 'Domains', 'SMTP', 'SDK', 'Webhooks'] as const
type Tab = typeof TABS[number]

const inputStyle = {
  backgroundColor: 'var(--t-surface-2)',
  borderColor: 'var(--t-border)',
  color: 'var(--t-text)',
}

const CODE_SNIPPETS: Record<string, { label: string; lang: string; code: string }> = {
  node: {
    label: 'Node.js',
    lang: 'javascript',
    code: `import { TinaiMail } from '@tinai/mail'

const mail = new TinaiMail({ apiKey: 'tm_live_...' })

await mail.send({
  from: 'noreply@yourapp.com',
  to: 'user@example.com',
  subject: 'Welcome to our platform',
  html: '<h1>Welcome!</h1><p>Thanks for signing up.</p>',
})`,
  },
  python: {
    label: 'Python',
    lang: 'python',
    code: `from tinai_mail import TinaiMail

mail = TinaiMail(api_key="tm_live_...")

mail.send(
    from_addr="noreply@yourapp.com",
    to="user@example.com",
    subject="Welcome to our platform",
    html="<h1>Welcome!</h1><p>Thanks for signing up.</p>",
)`,
  },
  curl: {
    label: 'cURL',
    lang: 'bash',
    code: `curl -X POST https://api.tinai.cloud/v1/mail/send \\
  -H "Authorization: Bearer tm_live_..." \\
  -H "Content-Type: application/json" \\
  -d '{
    "from": "noreply@yourapp.com",
    "to": "user@example.com",
    "subject": "Welcome to our platform",
    "html": "<h1>Welcome!</h1>"
  }'`,
  },
  smtp: {
    label: 'SMTP',
    lang: 'text',
    code: `Host:     smtp.tinai.cloud
Port:     587 (STARTTLS) or 465 (SSL)
Username: your-tenant-id
Password: tm_live_...

# Works with any SMTP client:
# Nodemailer, PHPMailer, Django, Rails ActionMailer, etc.`,
  },
}

const WEBHOOK_EVENTS = [
  { event: 'mail.sent', desc: 'Email accepted for delivery' },
  { event: 'mail.delivered', desc: 'Email delivered to recipient MTA' },
  { event: 'mail.bounced', desc: 'Email bounced (hard or soft)' },
  { event: 'mail.opened', desc: 'Recipient opened the email' },
  { event: 'mail.clicked', desc: 'Recipient clicked a link' },
  { event: 'mail.complained', desc: 'Recipient marked as spam' },
]

export default function MailPage() {
  const [activeTab, setActiveTab] = useState<Tab>('Overview')
  const [activeSnippet, setActiveSnippet] = useState('node')

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-blue-500/15 flex items-center justify-center">
            <span className="material-symbols-outlined text-blue-400" style={{ fontSize: 22 }}>mail</span>
          </div>
          <div>
            <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>Tinai Mail</h1>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Transactional email API for your applications</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="https://coll.tinai.cloud/mail"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>inbox</span>
            Open Inbox
          </a>
          <a
            href="https://mail.tinai.cloud"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:border-blue-500/30"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>mail</span>
            Webmail
          </a>
          <a
            href="https://docs.tinai.cloud/mail"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm transition-colors hover:border-blue-500/30"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>open_in_new</span>
            Docs
          </a>
        </div>
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
              { label: 'Emails Sent', value: '0', sub: 'This month', icon: 'send', color: 'text-blue-400' },
              { label: 'Delivery Rate', value: '—', sub: 'No data yet', icon: 'check_circle', color: 'text-emerald-400' },
              { label: 'Domains', value: '0', sub: 'Verified', icon: 'domain', color: 'text-violet-400' },
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
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-muted)' }}>Send your first email in 3 steps</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { step: '1', title: 'Create API Key', desc: 'Generate a key in the API Keys tab', tab: 'API Keys' as Tab, icon: 'key' },
                { step: '2', title: 'Verify Domain', desc: 'Add DNS records for your sending domain', tab: 'Domains' as Tab, icon: 'domain' },
                { step: '3', title: 'Send Email', desc: 'Use the SDK or REST API to send', tab: 'SDK' as Tab, icon: 'code' },
              ].map(s => (
                <button
                  key={s.step}
                  onClick={() => setActiveTab(s.tab)}
                  className="text-left p-4 rounded-lg border transition-colors hover:border-blue-500/30"
                  style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="w-5 h-5 rounded-full bg-blue-500/15 text-blue-400 text-xs font-bold flex items-center justify-center">{s.step}</span>
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
              { icon: 'speed', title: 'High Deliverability', desc: 'SPF, DKIM, DMARC auto-configured' },
              { icon: 'lock', title: 'Data Sovereignty', desc: 'Emails routed through Indian infra' },
              { icon: 'webhook', title: 'Webhooks', desc: 'Real-time delivery events' },
              { icon: 'html', title: 'Templates', desc: 'Reusable HTML email templates' },
              { icon: 'analytics', title: 'Analytics', desc: 'Opens, clicks, bounce tracking' },
              { icon: 'schedule', title: 'Scheduled Send', desc: 'Queue emails for later delivery' },
            ].map(f => (
              <div key={f.icon} className="rounded-lg border p-3" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
                <span className="material-symbols-outlined text-blue-400 mb-2 block" style={{ fontSize: 18 }}>{f.icon}</span>
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
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Manage API keys for the Mail API</p>
            <button className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Create Key
            </button>
          </div>
          <div className="py-16 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
            <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>key</span>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No API keys yet</p>
            <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Create a key to start sending emails via the API</p>
          </div>
        </div>
      )}

      {/* Domains */}
      {activeTab === 'Domains' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Verify domains for sending email</p>
            <button className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors">
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
              Add Domain
            </button>
          </div>
          <div className="rounded-xl border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <p className="text-xs mb-3" style={{ color: 'var(--t-text-muted)' }}>
              To send email from your domain, add these DNS records:
            </p>
            <div className="space-y-2">
              {[
                { type: 'TXT', name: '_tinai', value: 'tinai-verify=...', purpose: 'Domain verification' },
                { type: 'TXT', name: '@', value: 'v=spf1 include:spf.tinai.cloud ~all', purpose: 'SPF' },
                { type: 'CNAME', name: 'tm._domainkey', value: 'dkim.tinai.cloud', purpose: 'DKIM' },
                { type: 'TXT', name: '_dmarc', value: 'v=DMARC1; p=quarantine; rua=mailto:dmarc@tinai.cloud', purpose: 'DMARC' },
              ].map(r => (
                <div key={r.name} className="flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-mono" style={{ backgroundColor: 'var(--t-surface-2)' }}>
                  <span className="text-blue-400 font-semibold w-12 shrink-0">{r.type}</span>
                  <span style={{ color: 'var(--t-text)' }} className="w-28 shrink-0">{r.name}</span>
                  <span style={{ color: 'var(--t-text-dim)' }} className="flex-1 truncate">{r.value}</span>
                  <span className="text-[10px] shrink-0" style={{ color: 'var(--t-text-dim)' }}>{r.purpose}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
            <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>domain</span>
            <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No verified domains</p>
          </div>
        </div>
      )}

      {/* SMTP */}
      {activeTab === 'SMTP' && (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            Use standard SMTP to send email from any application or framework.
          </p>
          <div className="rounded-xl border p-5" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-sm font-semibold mb-3" style={{ color: 'var(--t-text)' }}>SMTP Credentials</h3>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'Host', value: 'smtp.tinai.cloud' },
                { label: 'Port (TLS)', value: '587' },
                { label: 'Port (SSL)', value: '465' },
                { label: 'Username', value: 'Your tenant ID' },
                { label: 'Password', value: 'Your API key (tm_live_...)' },
                { label: 'Auth', value: 'PLAIN or LOGIN' },
              ].map(c => (
                <div key={c.label}>
                  <label className="text-xs block mb-1" style={{ color: 'var(--t-text-dim)' }}>{c.label}</label>
                  <div className="px-3 py-2 rounded-lg text-sm font-mono" style={{ backgroundColor: 'var(--t-surface-2)', color: 'var(--t-text)' }}>
                    {c.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SDK */}
      {activeTab === 'SDK' && (
        <div className="space-y-4">
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            Integrate Tinai Mail using our SDK or REST API.
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
                { pkg: 'npm install @tinai/mail', label: 'Node.js' },
                { pkg: 'pip install tinai-mail', label: 'Python' },
                { pkg: 'go get github.com/tinai-cloud/mail-go', label: 'Go' },
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
              Get notified of email delivery events in real-time.
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
                  <code className="text-xs font-mono text-blue-400 w-36 shrink-0">{e.event}</code>
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
