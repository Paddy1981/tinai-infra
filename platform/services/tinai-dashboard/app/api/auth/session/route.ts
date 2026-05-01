import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

// ---------------------------------------------------------------------------
// In-memory rate limiter: max 10 POST attempts per IP per 60s window
// ---------------------------------------------------------------------------
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

// Prune expired entries every 60s to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) {
      rateLimitMap.delete(key)
    }
  }
}, 60_000)

function checkRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(ip)
  if (!entry || now > entry.resetAt) {
    // Cap map size to prevent memory exhaustion from distributed attacks
    if (rateLimitMap.size >= 10_000) {
      const oldest = rateLimitMap.keys().next().value
      if (oldest !== undefined) rateLimitMap.delete(oldest)
    }
    rateLimitMap.set(ip, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 10) return false
  entry.count++
  return true
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for') ?? 'unknown'
  if (!checkRateLimit(ip)) {
    return NextResponse.json({ error: 'too many requests' }, { status: 429 })
  }

  const { token } = await req.json()
  if (!token || typeof token !== 'string') {
    return NextResponse.json({ error: 'missing token' }, { status: 400 })
  }

  // Validate JWT signature before trusting the token — prevents an attacker
  // from injecting an arbitrary string into the httpOnly cookie.
  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    return NextResponse.json({ error: 'server misconfiguration' }, { status: 500 })
  }
  try {
    await jwtVerify(token, new TextEncoder().encode(jwtSecret))
  } catch {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set('tinai_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: 60 * 60 * 24 * 7, // 7 days
    path: '/',
  })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete('tinai_token')
  return response
}
