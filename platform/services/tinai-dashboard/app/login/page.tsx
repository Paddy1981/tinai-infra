'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'

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

function Countdown({ seconds, onZero }: { seconds: number; onZero: () => void }) {
  const [remaining, setRemaining] = useState(seconds)
  const cbRef = useRef(onZero)
  cbRef.current = onZero

  useEffect(() => {
    setRemaining(seconds)
    if (seconds <= 0) return
    const id = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) { clearInterval(id); cbRef.current(); return 0 }
        return prev - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [seconds])

  if (remaining <= 0) return null
  return <span className="text-xs text-[#4A4760]">Resend in {remaining}s</span>
}

function EmailPanel() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [magicSent, setMagicSent] = useState(false)

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail ?? data?.message ?? `Login failed: ${res.status}`)
      }
      const data = await res.json()
      const token: string = data.token ?? data.access_token ?? ''
      if (!token) throw new Error('No token returned from server')
      await saveSession(token)
      router.push('/apps')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Sign in failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleMagicLink() {
    if (!email) { setError('Enter your email address first'); return }
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.detail ?? data?.message ?? `Request failed: ${res.status}`)
      }
      setMagicSent(true)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Magic link request failed')
    } finally {
      setLoading(false)
    }
  }

  if (magicSent) {
    return (
      <div className="text-center py-4">
        <div className="w-10 h-10 rounded-full bg-[#F97316]/15 flex items-center justify-center mx-auto mb-3">
          <span className="text-[#F97316] text-lg">✓</span>
        </div>
        <p className="text-[#EDE9E1] font-medium mb-1">Check your email</p>
        <p className="text-sm text-[#8C89A4]">
          Magic link sent to <span className="text-[#EDE9E1]">{email}</span>
        </p>
        <button onClick={() => setMagicSent(false)} className="mt-4 text-xs text-[#4A4760] hover:text-[#8C89A4] underline">
          Back to sign in
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleSignIn} className="flex flex-col gap-4">
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
          id="password" type="password" autoComplete="current-password" required
          value={password} onChange={e => setPassword(e.target.value)}
          placeholder="••••••••"
          className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
        />
      </div>
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-400">{error}</div>
      )}
      <button type="submit" disabled={loading}
        className="w-full rounded-lg bg-[#F97316] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#EA6C0A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(249,115,22,0.25)]">
        {loading ? 'Signing in…' : 'Sign In'}
      </button>
      <button type="button" disabled={loading} onClick={handleMagicLink}
        className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-4 py-2.5 text-sm font-medium text-[#8C89A4] hover:border-[#F97316]/30 hover:text-[#EDE9E1] disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
        Send Magic Link
      </button>
    </form>
  )
}

type OTPStage = 'input' | 'verify'

function MobileOTPPanel() {
  const router = useRouter()
  const [stage, setStage] = useState<OTPStage>('input')
  const [mobile, setMobile] = useState('')
  const [otp, setOtp] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendCountdown, setResendCountdown] = useState(0)

  async function handleSendOTP(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (!/^[6-9]\d{9}$/.test(mobile)) { setError('Enter a valid 10-digit Indian mobile number'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/sms-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? `Request failed: ${res.status}`)
      setStage('verify')
      setResendCountdown(60)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Failed to send OTP')
    } finally {
      setLoading(false)
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    if (otp.length !== 6) { setError('Enter the 6-digit OTP'); return }
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/verify-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile, otp }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? `Verification failed: ${res.status}`)
      const token: string = data.token ?? ''
      if (!token) throw new Error('No token returned from server')
      await saveSession(token)
      router.push('/apps')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Verification failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleResend() {
    setError(null)
    setLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/v1/auth/resend-sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mobile }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? data?.message ?? `Resend failed: ${res.status}`)
      setResendCountdown(60)
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Resend failed')
    } finally {
      setLoading(false)
    }
  }

  if (stage === 'input') {
    return (
      <form onSubmit={handleSendOTP} className="flex flex-col gap-4">
        <div>
          <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="mobile">Mobile Number</label>
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg border border-r-0 border-[#2A2844] bg-[#1C1C38] px-3 text-sm text-[#4A4760] select-none">+91</span>
            <input
              id="mobile" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={10} required
              value={mobile} onChange={e => setMobile(e.target.value.replace(/\D/g, '').slice(0, 10))}
              placeholder="9876543210"
              className="w-full rounded-r-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none"
            />
          </div>
        </div>
        {error && <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-400">{error}</div>}
        <button type="submit" disabled={loading}
          className="w-full rounded-lg bg-[#F97316] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#EA6C0A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(249,115,22,0.25)]">
          {loading ? 'Sending OTP…' : 'Send OTP'}
        </button>
      </form>
    )
  }

  return (
    <form onSubmit={handleVerify} className="flex flex-col gap-4">
      <p className="text-sm text-[#8C89A4] text-center">OTP sent to <span className="text-[#EDE9E1]">+91 {mobile}</span></p>
      <div>
        <label className="block text-xs text-[#8C89A4] mb-1.5" htmlFor="otp">6-Digit OTP</label>
        <input
          id="otp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required
          value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="123456"
          className="w-full rounded-lg border border-[#2A2844] bg-[#14142A] px-3 py-2 text-sm text-[#EDE9E1] placeholder-[#4A4760] focus:border-[#F97316]/50 focus:outline-none tracking-widest text-center"
        />
      </div>
      {error && <div className="rounded-lg border border-red-800 bg-red-950/30 px-3 py-2 text-sm text-red-400">{error}</div>}
      <button type="submit" disabled={loading}
        className="w-full rounded-lg bg-[#F97316] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#EA6C0A] disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-[0_0_20px_rgba(249,115,22,0.25)]">
        {loading ? 'Verifying…' : 'Verify OTP'}
      </button>
      <div className="flex items-center justify-between">
        <button type="button" onClick={() => { setStage('input'); setOtp(''); setError(null) }}
          className="text-xs text-[#4A4760] hover:text-[#8C89A4] underline">
          Change number
        </button>
        {resendCountdown > 0 ? (
          <Countdown seconds={resendCountdown} onZero={() => setResendCountdown(0)} />
        ) : (
          <button type="button" disabled={loading} onClick={handleResend}
            className="text-xs text-[#F97316] hover:text-[#FDBA74] disabled:opacity-40 disabled:cursor-not-allowed">
            Resend OTP
          </button>
        )}
      </div>
    </form>
  )
}

type Tab = 'email' | 'mobile'

export default function LoginPage() {
  const [activeTab, setActiveTab] = useState<Tab>('email')

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#07070F] px-4"
      style={{
        backgroundImage: 'radial-gradient(ellipse 80% 50% at 50% -20%, rgba(249,115,22,0.08), transparent)',
      }}
    >
      <div className="w-full max-w-sm">
        {/* Horizontal lockup */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#F97316] flex items-center justify-center shadow-[0_0_32px_rgba(249,115,22,0.4)]">
            <span className="text-white"><TmarkLogo size={22} /></span>
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-headline leading-none">
              <span className="font-bold text-[#EDE9E1]">tinai</span>
              <span className="font-light text-[#8C89A4]">.cloud</span>
            </h1>
            <p className="text-xs uppercase tracking-widest text-[#4A4760] mt-1 font-medium">Sovereign Cloud Platform</p>
          </div>
        </div>

        <div className="rounded-xl border border-[#2A2844] bg-[#0E0E1C] overflow-hidden">
          {/* Tab bar */}
          <div className="flex border-b border-[#2A2844]">
            {(['email', 'mobile'] as const).map(tab => (
              <button key={tab} type="button" onClick={() => setActiveTab(tab)}
                className={`flex-1 py-2.5 text-xs font-medium transition-colors ${
                  activeTab === tab
                    ? 'bg-[#0E0E1C] text-[#F97316] border-b-2 border-[#F97316]'
                    : 'bg-[#14142A]/60 text-[#4A4760] hover:text-[#8C89A4]'
                }`}>
                {tab === 'email' ? 'Email' : 'Mobile OTP'}
              </button>
            ))}
          </div>
          <div className="p-6">
            {activeTab === 'email' ? <EmailPanel /> : <MobileOTPPanel />}
          </div>
        </div>

        <p className="text-center text-sm text-[#8C89A4] mt-6">
          Don&apos;t have an account?{' '}
          <a href="/signup" className="text-[#F97316] hover:text-[#FDBA74] font-medium">
            Sign up
          </a>
        </p>

        <p className="text-center text-xs text-[#4A4760] mt-3">
          Your data stays in India. Always.
        </p>
      </div>
    </div>
  )
}
