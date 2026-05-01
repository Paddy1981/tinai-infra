import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const PROM_URL = process.env.PROMETHEUS_URL ?? 'http://prometheus.monitoring.svc.cluster.local:9090'

export async function GET(req: NextRequest) {
  // Verify auth
  const token = (await cookies()).get('tinai_token')?.value
  if (!token) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) return NextResponse.json({ error: 'server error' }, { status: 500 })

  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret))
    if (payload.role !== 'admin') return NextResponse.json({ error: 'admin only' }, { status: 403 })
  } catch {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 })
  }

  const query = req.nextUrl.searchParams.get('query')
  if (!query) return NextResponse.json({ error: 'query required' }, { status: 400 })

  const promRes = await fetch(`${PROM_URL}/api/v1/query?query=${encodeURIComponent(query)}`)
  const data = await promRes.json()

  return NextResponse.json(data, {
    headers: { 'cache-control': 'no-store' },
  })
}
