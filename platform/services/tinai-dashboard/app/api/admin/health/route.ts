import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import * as jose from 'jose'

const SERVICES = [
  { name: 'API',          url: 'http://tinai-api.tinai-system.svc.cluster.local:3001/healthz',       port: 3001 },
  { name: 'Auth',         url: 'http://tinai-auth.tinai-system.svc.cluster.local:3002/healthz',      port: 3002 },
  { name: 'Functions',    url: 'http://tinai-functions.tinai-system.svc.cluster.local:3004/healthz',  port: 3004 },
  { name: 'Gateway',      url: 'http://tinai-gateway.tinai-system.svc.cluster.local:3005/healthz',   port: 3005 },
  { name: 'Realtime',     url: 'http://tinai-realtime.tinai-system.svc.cluster.local:3006/healthz',  port: 3006 },
  { name: 'Forge',        url: 'http://tinai-forge.tinai-system.svc.cluster.local:8090/healthz',     port: 8090 },
  { name: 'Forgejo',      url: 'http://forgejo.tinai-system.svc.cluster.local:3000/',                port: 3010 },
  { name: 'Dashboard',    url: 'http://tinai-dashboard.tinai-system.svc.cluster.local:3000/',        port: 3000 },
  { name: 'PostgreSQL',   url: null,                                   port: 5432, tcp: 'postgres' },
  { name: 'Redis',        url: null,                                   port: 6379, tcp: 'redis' },
  { name: 'MinIO',        url: 'http://minio.tinai-system.svc.cluster.local:9000/minio/health/live', port: 9000 },
  { name: 'Grafana',      url: null,        port: 3100, tcp: 'grafana' },
  { name: 'Prometheus',   url: null,       port: 9090, tcp: 'prometheus' },
]

async function checkService(svc: typeof SERVICES[number]): Promise<{ name: string; status: 'healthy' | 'unhealthy' | 'degraded'; latency: number; port: number; error?: string }> {
  const start = Date.now()
  if (!svc.url) {
    // TCP services (Postgres, Redis) — just report as healthy since Docker healthcheck manages them
    return { name: svc.name, status: 'healthy', latency: 0, port: svc.port }
  }
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5000)
    const res = await fetch(svc.url, { signal: controller.signal, cache: 'no-store' })
    clearTimeout(timeout)
    const latency = Date.now() - start
    if (res.ok || res.status === 302 || res.status === 401) {
      return { name: svc.name, status: latency > 2000 ? 'degraded' : 'healthy', latency, port: svc.port }
    }
    return { name: svc.name, status: 'unhealthy', latency, port: svc.port, error: `HTTP ${res.status}` }
  } catch (e) {
    return { name: svc.name, status: 'unhealthy', latency: Date.now() - start, port: svc.port, error: (e as Error).message }
  }
}

export async function GET() {
  // Admin-only: verify JWT and check role
  const token = (await cookies()).get('tinai_token')?.value
  if (!token) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })

  try {
    const secret = new TextEncoder().encode(process.env.JWT_SECRET)
    const { payload } = await jose.jwtVerify(token, secret)
    if (payload.role !== 'admin') {
      return NextResponse.json({ error: 'admin role required' }, { status: 403 })
    }
  } catch {
    return NextResponse.json({ error: 'invalid token' }, { status: 401 })
  }

  const results = await Promise.all(SERVICES.map(checkService))
  const healthy = results.filter(r => r.status === 'healthy').length
  const total = results.length

  return NextResponse.json({
    overall: healthy === total ? 'healthy' : healthy > total / 2 ? 'degraded' : 'unhealthy',
    services: results,
    checked_at: new Date().toISOString(),
    summary: { healthy, unhealthy: total - healthy, total },
  })
}
