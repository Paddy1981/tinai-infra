// Thin reverse proxy — reads httpOnly cookie, forwards to the internal API.
// All settings/profile/API-key routes in the dashboard call /api/v1/... through
// this proxy so the auth token never needs to live in localStorage.
import { cookies } from 'next/headers'
import { NextRequest, NextResponse } from 'next/server'

const UPSTREAM = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3001'
const AUTH_UPSTREAM = process.env.AUTH_URL ?? 'http://tinai-auth.tinai-system.svc.cluster.local:3002'
const BUILD_UPSTREAM = process.env.BUILD_API_URL ?? 'http://build-api.tinai-system.svc.cluster.local:8080'
const BUILD_API_TOKEN = process.env.BUILD_API_TOKEN ?? ''

/** Routes that should be proxied to the build-api instead of the main API */
function isBuildRoute(pathSegments: string[]): boolean {
  // Match apps/*/promote and apps/*/rollback
  if (pathSegments.length >= 3 && pathSegments[0] === 'apps') {
    const action = pathSegments[2]
    if (action === 'promote' || action === 'rollback') return true
  }
  return false
}

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }): Promise<NextResponse> {
  const { path } = await params
  const isAuthRoute = path[0] === 'auth'

  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isAuthRoute) {
    if (req.headers.get('x-tinai-csrf') !== '1') {
      return NextResponse.json({ error: 'csrf check failed' }, { status: 403 })
    }
  }

  const token = (await cookies()).get('tinai_token')?.value
  if (!token && !isAuthRoute) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // [...path] already strips the /api/v1 prefix, so just rejoin the segments.
  const upstreamPath = '/api/v1/' + path.join('/')

  const useBuildApi = isBuildRoute(path)
  const upstreamBase = isAuthRoute ? AUTH_UPSTREAM : useBuildApi ? BUILD_UPSTREAM : UPSTREAM
  const upstreamURL = upstreamBase + upstreamPath + (req.nextUrl.search ?? '')

  const headers = new Headers(req.headers)
  if (isAuthRoute) {
    // Auth routes may not have a token yet (e.g. login, register)
    if (token) headers.set('Authorization', `Bearer ${token}`)
  } else if (useBuildApi) {
    headers.set('Authorization', `Bearer ${BUILD_API_TOKEN}`)
  } else {
    headers.set('Authorization', `Bearer ${token}`)
  }
  // Do not forward host header to avoid SNI confusion.
  headers.delete('host')

  const upstreamRes = await fetch(upstreamURL, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
    // @ts-expect-error Node.js fetch supports duplex
    duplex: 'half',
  })

  const body = await upstreamRes.arrayBuffer()
  const resHeaders = new Headers()
  upstreamRes.headers.forEach((v, k) => {
    // Strip hop-by-hop headers
    if (!['transfer-encoding', 'connection', 'keep-alive'].includes(k.toLowerCase())) {
      resHeaders.set(k, v)
    }
  })
  resHeaders.set('cache-control', 'no-store, no-cache, must-revalidate')

  return new NextResponse(body, {
    status: upstreamRes.status,
    headers: resHeaders,
  })
}

export const GET    = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx)
export const POST   = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx)
export const PUT    = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx)
export const PATCH  = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx)
export const DELETE = (req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) => proxy(req, ctx)
