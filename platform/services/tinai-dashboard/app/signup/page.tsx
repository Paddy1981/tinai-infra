'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

const API_URL = ''

function saveSession(token: string): Promise<Response> {
  return fetch('/api/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
}

function TmarkLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M 8,4 H 24 Q 29,4 29,9 V 14 H 20 V 28 Q 20,32 16,32 Q 12,32 12,28 V 14 H 3 V 9 Q 3,4 8,4 Z"
        fill="currentColor"
      />
    </svg>
  )
}

export default function SignupPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function deriveTenantId(company: string, emailAddr: string): string {
    if (company.trim()) {
      return company
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 63)
    }
    // Fall back to email domain
    const domain = emailAddr.split('@')[1] ?? 'default'
    return domain
      .replace(/[^a-z0-9.]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63)
  }

  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    setLoading(true)
    try {
      const tenantId = deriveTenantId(companyName, email)

      const res = await fetch(`${API_URL}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          tenant_id: tenantId,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error ?? data?.message ?? `Registration failed: ${res.status}`)
      }

      const data = await res.json()
      const token: string = data.token ?? data.access_token ?? ''
      if (!token) throw new Error('No token returned from server')

      await saveSession(token)
      router.push('/apps')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Sign up failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#07070F] px-4"
      style={{
        backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(249,115,22,0.08), transparent)',
      }}
    >
      <div className="w-full max-w-sm">
        {/* Branding */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#F97316] flex items-center justify-center shadow-[0_0_32px_rgba(249,115,22,0.4)]">
            <span className="text-white"><TmarkLogo size={22} /></span>
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-headline leading-none">
              <span className="font-bold text-[#EDE9E1]">tinai</span>
              <span className="font-light text-[#8C89A4]">.cloud</span>
            </h1>
            <p className="text-xs uppercase tracking-widest text-[#4A4760] mt-1 font-medium">Create your account</p>
          </div>
        </div>

        <div className="rounded-xl border border-[#2A2844] bg-[#0E0E1C] overflow-hidden">
          <div className="p-6">
            <form onSubmit={handleSignUp} className="flex flex-col gap-4">
              <div>
                <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="email">Email</label>
                <input
                  id="email" type="email" autoComplete="email" required
                  value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="password">Password</label>
                <input
                  id="password" type="password" autoComplete="new-password" required minLength={8}
                  value={password} onChange={e => setPassword(e.target.value)}
                  placeholder="Min. 8 characters"
                  className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="confirm-password">Confirm Password</label>
                <input
                  id="confirm-password" type="password" autoComplete="new-password" required minLength={8}
                  value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="company">
                  Company / Tenant Name <span className="text-[#4A4760]">(optional)</span>
                </label>
                <input
                  id="company" type="text" autoComplete="organization"
                  value={companyName} onChange={e => setCompanyName(e.target.value)}
                  placeholder="Acme Inc."
                  className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
                />
              </div>
              {error && (
                <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-400">{error}</div>
              )}
              <button type="submit" disabled={loading}
                className="w-full rounded-lg bg-[#F97316] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#EA6C0A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(249,115,22,0.25)]">
                {loading ? 'Creating account...' : 'Create Account'}
              </button>
            </form>
          </div>
        </div>

        <p className="text-center text-sm text-[#8C89A4] mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-[#F97316] hover:text-[#FDBA74] font-medium">
            Sign in
          </Link>
        </p>

        <p className="text-center text-xs text-[#4A4760] mt-3">
          Your data stays in India. Always.
        </p>
      </div>
    </div>
  )
}
