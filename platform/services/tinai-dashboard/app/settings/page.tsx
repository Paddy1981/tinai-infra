'use client'

import { useEffect, useState } from 'react'
import { useTheme } from '../context/ThemeContext'

const API_URL = ''

interface ApiKey {
  id: string
  name: string
  key_prefix: string
  last_used: string | null
  created_at: string
}

interface Profile {
  display_name: string
  email: string
  mobile: string
}

interface NotificationPrefs {
  deploy_success: boolean
  deploy_failure: boolean
  billing_threshold: '' | '500' | '1000' | '5000'
  compliance_deadline: boolean
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-[#2A2844] bg-[#0E0E1C] p-6 flex flex-col gap-5">
      <h2 className="text-xs font-semibold text-[#8C89A4] uppercase tracking-widest">{title}</h2>
      {children}
    </section>
  )
}

function Field({
  label, value, onChange, type = 'text', readOnly = false, placeholder,
}: {
  label: string; value: string; onChange?: (v: string) => void
  type?: string; readOnly?: boolean; placeholder?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs text-[#8C89A4] font-medium">{label}</label>
      <input
        type={type} value={value} readOnly={readOnly} placeholder={placeholder}
        onChange={e => onChange?.(e.target.value)}
        className={`rounded-lg border px-3 py-2 text-sm outline-none transition-colors
          ${readOnly
            ? 'border-[#2A2844] bg-[#07070F] text-[#4A4760] cursor-default'
            : 'border-[#2A2844] bg-[#14142A] text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50'
          }`}
      />
    </div>
  )
}

function SaveBtn({ onClick, loading }: { onClick: () => void; loading?: boolean }) {
  return (
    <button onClick={onClick} disabled={loading}
      className="self-start px-4 py-2 rounded-lg bg-[#F97316] hover:bg-[#EA6C0A] disabled:opacity-50 text-sm font-semibold text-white transition-colors">
      {loading ? 'Saving…' : 'Save changes'}
    </button>
  )
}

function StatusMsg({ msg, error }: { msg: string; error?: boolean }) {
  if (!msg) return null
  return (
    <p className={`text-xs ${error ? 'text-red-400' : 'text-[#8C89A4]'}`}>{msg}</p>
  )
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
function ProfileSection() {
  const [profile, setProfile] = useState<Profile>({ display_name: '', email: '', mobile: '' })
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [pwSaving, setPwSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [pwMsg, setPwMsg] = useState('')
  const [pwError, setPwError] = useState(false)

  // Load profile on mount
  useEffect(() => {
    fetch(`${API_URL}/api/v1/settings/profile`, {})
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setProfile(data) })
      .catch(() => {})
  }, [])

  const saveProfile = async () => {
    setSaving(true); setMsg('')
    try {
      const res = await fetch(`${API_URL}/api/v1/settings/profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ display_name: profile.display_name, mobile: profile.mobile }),
      })
      setMsg(res.ok ? 'Profile saved.' : 'Failed to save profile.')
    } finally { setSaving(false) }
  }

  const changePassword = async () => {
    setPwError(false)
    if (pw.next !== pw.confirm) { setPwMsg('Passwords do not match.'); setPwError(true); return }
    if (pw.next.length < 8) { setPwMsg('New password must be at least 8 characters.'); setPwError(true); return }
    setPwSaving(true); setPwMsg('')
    try {
      const res = await fetch(`${API_URL}/api/v1/settings/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ current_password: pw.current, new_password: pw.next }),
      })
      if (res.ok) { setPwMsg('Password changed.'); setPw({ current: '', next: '', confirm: '' }) }
      else { const d = await res.json(); setPwMsg(d.error ?? 'Failed.'); setPwError(true) }
    } finally { setPwSaving(false) }
  }

  return (
    <Section title="Profile">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Display name" value={profile.display_name}
          onChange={v => setProfile(p => ({ ...p, display_name: v }))} placeholder="Your name" />
        <Field label="Email" value={profile.email} readOnly />
        <Field label="Mobile" value={profile.mobile}
          onChange={v => setProfile(p => ({ ...p, mobile: v }))} placeholder="+91 98765 43210" />
      </div>
      <SaveBtn onClick={saveProfile} loading={saving} />
      <StatusMsg msg={msg} />

      <div className="border-t border-[#2A2844]" />

      <p className="text-xs font-semibold text-[#8C89A4] uppercase tracking-widest">Change password</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Current password" type="password" value={pw.current}
          onChange={v => setPw(p => ({ ...p, current: v }))} />
        <Field label="New password" type="password" value={pw.next}
          onChange={v => setPw(p => ({ ...p, next: v }))} />
        <Field label="Confirm new password" type="password" value={pw.confirm}
          onChange={v => setPw(p => ({ ...p, confirm: v }))} />
      </div>
      <SaveBtn onClick={changePassword} loading={pwSaving} />
      <StatusMsg msg={pwMsg} error={pwError} />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// API Keys
// ---------------------------------------------------------------------------
function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)
  const [msg, setMsg] = useState('')

  const load = async () => {
    const res = await fetch(`${API_URL}/api/v1/settings/api-keys`, {})
    if (res.ok) setKeys(await res.json())
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    if (!newName.trim()) return
    setCreating(true); setMsg('')
    try {
      const res = await fetch(`${API_URL}/api/v1/settings/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      if (res.ok) {
        const data = await res.json()
        setRevealed(data.key)
        setNewName('')
        await load()
      } else {
        const d = await res.json(); setMsg(d.error ?? 'Failed to create key.')
      }
    } finally { setCreating(false) }
  }

  const revoke = async (id: string) => {
    if (!confirm('Revoke this key? This cannot be undone.')) return
    const res = await fetch(`${API_URL}/api/v1/settings/api-keys/${id}`, {
      method: 'DELETE',
    })
    if (res.ok) setKeys(k => k.filter(x => x.id !== id))
  }

  return (
    <Section title="API Keys">
      {revealed && (
        <div className="rounded-lg border border-[#F97316]/40 bg-[#F97316]/8 p-3 text-xs font-mono text-[#FDBA74] break-all">
          <strong className="block mb-1 font-sans text-[#F97316] not-italic">
            Copy this key — it will not be shown again.
          </strong>
          {revealed}
          <button onClick={() => setRevealed(null)} className="mt-2 text-[#4A4760] hover:text-[#8C89A4] font-sans not-italic">
            Dismiss
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[#4A4760] border-b border-[#2A2844]">
              <th className="pb-2 font-medium">Name</th>
              <th className="pb-2 font-medium">Key prefix</th>
              <th className="pb-2 font-medium">Created</th>
              <th className="pb-2 font-medium">Last used</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#2A2844]/50">
            {keys.length === 0 && (
              <tr><td colSpan={5} className="py-3 text-sm text-[#4A4760]">No API keys yet.</td></tr>
            )}
            {keys.map(k => (
              <tr key={k.id} className="text-[#8C89A4]">
                <td className="py-2 text-[#EDE9E1]">{k.name}</td>
                <td className="py-2 font-mono text-xs">{k.key_prefix}…</td>
                <td className="py-2 text-xs">{new Date(k.created_at).toLocaleDateString('en-IN')}</td>
                <td className="py-2 text-xs">{k.last_used ? new Date(k.last_used).toLocaleDateString('en-IN') : '—'}</td>
                <td className="py-2 text-right">
                  <button onClick={() => revoke(k.id)} className="text-xs text-red-400 hover:text-red-300">Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-3 items-end">
        <Field label="Key name" value={newName} onChange={setNewName} placeholder="my-ci-key" />
        <button onClick={create} disabled={creating || !newName.trim()}
          className="shrink-0 px-4 py-2 rounded-lg bg-[#F97316] hover:bg-[#EA6C0A] disabled:opacity-50 text-sm font-semibold text-white transition-colors mb-0.5">
          {creating ? 'Creating…' : 'Create key'}
        </button>
      </div>
      {msg && <p className="text-xs text-red-400">{msg}</p>}
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
function NotificationsSection() {
  const [prefs, setPrefs] = useState<NotificationPrefs>({
    deploy_success: true,
    deploy_failure: true,
    billing_threshold: '1000',
    compliance_deadline: true,
  })
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetch(`${API_URL}/api/v1/settings/notifications`, {})
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setPrefs(data) })
      .catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true); setMsg('')
    try {
      const res = await fetch(`${API_URL}/api/v1/settings/notifications`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify(prefs),
      })
      setMsg(res.ok ? 'Preferences saved.' : 'Failed to save.')
    } finally { setSaving(false) }
  }

  function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
    return (
      <label className="flex items-center gap-3 cursor-pointer select-none">
        <button type="button" onClick={() => onChange(!checked)}
          className={`relative w-10 h-5 rounded-full transition-colors ${checked ? 'bg-[#F97316]' : 'bg-[#2A2844]'}`}>
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
        </button>
        <span className="text-sm text-[#EDE9E1]">{label}</span>
      </label>
    )
  }

  return (
    <Section title="Notifications">
      <Toggle label="Deploy success" checked={prefs.deploy_success}
        onChange={v => setPrefs(p => ({ ...p, deploy_success: v }))} />
      <Toggle label="Deploy failure" checked={prefs.deploy_failure}
        onChange={v => setPrefs(p => ({ ...p, deploy_failure: v }))} />
      <Toggle label="Compliance deadline reminder" checked={prefs.compliance_deadline}
        onChange={v => setPrefs(p => ({ ...p, compliance_deadline: v }))} />

      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-[#8C89A4] font-medium">Billing threshold alert</label>
        <select value={prefs.billing_threshold}
          onChange={e => setPrefs(p => ({ ...p, billing_threshold: e.target.value as NotificationPrefs['billing_threshold'] }))}
          className="rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] focus:border-[#F97316]/50 outline-none w-48">
          <option value="">Disabled</option>
          <option value="500">₹500</option>
          <option value="1000">₹1,000</option>
          <option value="5000">₹5,000</option>
        </select>
      </div>

      <SaveBtn onClick={save} loading={saving} />
      <StatusMsg msg={msg} />
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Appearance (light / dark theme)
// ---------------------------------------------------------------------------
function AppearanceSection() {
  const { theme, setTheme: apply } = useTheme()

  return (
    <Section title="Appearance">
      <p className="text-sm text-[#8C89A4]">Choose your preferred color theme.</p>
      <div className="flex gap-3">
        {(['dark', 'light'] as const).map(t => (
          <button key={t} onClick={() => apply(t)}
            className={`flex flex-col items-center gap-2 px-5 py-4 rounded-xl border-2 transition-all ${
              theme === t
                ? 'border-[#F97316] bg-[#F97316]/8'
                : 'border-[#2A2844] hover:border-[#F97316]/30'
            }`}>
            {/* Mini preview */}
            <div className={`w-16 h-10 rounded-lg border overflow-hidden ${t === 'dark' ? 'bg-[#07070F] border-[#2A2844]' : 'bg-[#F9F7F4] border-[#E4E0D8]'}`}>
              <div className={`h-2.5 w-full ${t === 'dark' ? 'bg-[#0E0E1C]' : 'bg-white'} border-b ${t === 'dark' ? 'border-[#2A2844]' : 'border-[#E4E0D8]'}`} />
              <div className="p-1.5 flex flex-col gap-1">
                <div className={`h-1 w-10 rounded-full ${t === 'dark' ? 'bg-[#2A2844]' : 'bg-[#E4E0D8]'}`} />
                <div className={`h-1 w-7 rounded-full ${t === 'dark' ? 'bg-[#2A2844]' : 'bg-[#E4E0D8]'}`} />
              </div>
            </div>
            <span className={`text-xs font-semibold capitalize ${theme === t ? 'text-[#F97316]' : 'text-[#8C89A4]'}`}>
              {t}
            </span>
          </button>
        ))}
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Danger Zone
// ---------------------------------------------------------------------------
function DangerZone() {
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)

  const deleteAccount = async () => {
    if (confirmText !== 'delete my account') return
    setDeleting(true)
    try {
      await fetch(`${API_URL}/api/v1/settings/account`, {
        method: 'DELETE',
      })
      window.location.href = '/login'
    } finally { setDeleting(false) }
  }

  return (
    <Section title="Danger Zone">
      <p className="text-sm text-[#8C89A4]">
        Deleting your account is permanent and cannot be undone. All apps, data, and billing records will be removed.
      </p>
      <div className="flex flex-col gap-2 max-w-sm">
        <Field
          label='Type "delete my account" to confirm'
          value={confirmText}
          onChange={setConfirmText}
          placeholder="delete my account"
        />
        <button onClick={deleteAccount} disabled={confirmText !== 'delete my account' || deleting}
          className="px-4 py-2 rounded-lg bg-red-700 hover:bg-red-600 disabled:opacity-40 text-sm font-semibold text-white transition-colors">
          {deleting ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </Section>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
export default function SettingsPage() {
  return (
    <div className="p-8 max-w-3xl mx-auto flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold text-[#EDE9E1] font-headline">Settings</h1>
        <p className="text-sm text-[#8C89A4] mt-1">Manage your profile, security, and preferences</p>
      </div>
      <ProfileSection />
      <AppearanceSection />
      <ApiKeysSection />
      <NotificationsSection />
      <DangerZone />
    </div>
  )
}
