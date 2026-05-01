// NOTE: `jose` is required for JWT verification — run `npm install jose` if not already installed.
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { jwtVerify } from 'jose' // edge-compatible

// Public paths: accessible without auth
const PUBLIC_PATHS = ['/', '/login', '/signup', '/pricing', '/features', '/_next', '/favicon', '/api/auth', '/api/v1/auth']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isPublic = PUBLIC_PATHS.some(p => pathname === p || (p !== '/' && pathname.startsWith(p)))

  const token = request.cookies.get('tinai_token')?.value

  // Authenticated user visiting a public page → send to app
  if (isPublic && token) {
    try {
      const jwtSecret = process.env.JWT_SECRET
      if (!jwtSecret) throw new Error('JWT_SECRET missing')
      await jwtVerify(token, new TextEncoder().encode(jwtSecret))
      if (pathname === '/' || pathname === '/login' || pathname === '/signup') {
        return NextResponse.redirect(new URL('/instances', request.url))
      }
    } catch {
      // invalid token — let them through to the public page
    }
  }

  if (isPublic) return NextResponse.next()

  // Protected route — require valid token
  if (!token) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  try {
    const jwtSecret = process.env.JWT_SECRET
    if (!jwtSecret) throw new Error('JWT_SECRET environment variable is required')
    const { payload } = await jwtVerify(token, new TextEncoder().encode(jwtSecret))

    // Gate admin routes: only users with role 'admin' may access /admin/*
    if (pathname.startsWith('/admin') && payload.role !== 'admin') {
      return NextResponse.redirect(new URL('/', request.url))
    }

    return NextResponse.next()
  } catch {
    const response = NextResponse.redirect(new URL('/login', request.url))
    response.cookies.delete('tinai_token')
    return response
  }
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }
