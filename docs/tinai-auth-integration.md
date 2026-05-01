# Tinai Auth Integration Guide

Complete reference for integrating authentication into applications built on the Tinai Cloud Platform.

Covers the **tinai-auth** Go microservice, the **tinai-api** Fastify auth routes, and the **@tinai/client** TypeScript SDK.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Auth API Endpoints](#auth-api-endpoints)
3. [JWT Token Format and Verification](#jwt-token-format-and-verification)
4. [Refresh Tokens](#refresh-tokens)
5. [SMS OTP Authentication](#sms-otp-authentication)
6. [SSO / OIDC Authentication](#sso--oidc-authentication)
7. [WebAuthn / Passkeys](#webauthn--passkeys)
8. [Using @tinai/client in a Next.js App](#using-tinaiclient-in-a-nextjs-app)
9. [Using @tinai/client in a Node.js/Express App](#using-tinaiclient-in-a-nodejsexpress-app)
10. [Migration Guide: Replacing @supabase/supabase-js](#migration-guide-replacing-supabasesupabase-js)
11. [Environment Variables](#environment-variables)
12. [Rate Limiting](#rate-limiting)
13. [Database Schema](#database-schema)

---

## Architecture Overview

Tinai auth is served by two services that share the same JWT secret and database:

| Service | Language | Default Port | Base URL |
|---|---|---|---|
| **tinai-auth** | Go | 3002 | `https://auth.tinai.cloud` |
| **tinai-api** | TypeScript (Fastify) | 3001 | `https://api.tinai.cloud` |

Both services issue and verify HS256 JWTs signed with the same `JWT_SECRET`. The `tinai-api` service additionally supports refresh tokens and token revocation (blocklist). The `tinai-auth` Go service provides SSO (OIDC), SMS OTP via Msg91, and WebAuthn/passkey flows.

The **@tinai/client** SDK (`npm install @tinai/client`) is the recommended client library. It talks to the API over HTTP for auth and WebSocket for realtime subscriptions.

Authentication methods supported:

- Email + password
- Magic link / email OTP
- SMS OTP (Indian mobile numbers via Msg91)
- SSO / OIDC (Azure AD, Google Workspace, Okta)
- WebAuthn / passkeys (FIDO2)

---

## Auth API Endpoints

All endpoints are prefixed with `/api/v1` on tinai-api, or `/api/v1` on tinai-auth.

### POST /api/v1/auth/register

Create a new user account and receive a JWT.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepass123",
  "tenant_id": "my-org",
  "region": "IN"
}
```

- `email` (required) - must be unique
- `password` (required) - minimum 8 characters
- `tenant_id` (optional) - defaults to `"tinai-admin"`
- `region` (optional) - defaults to `"IN"`

**Response (201):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "tenant",
    "tenant_id": "my-org",
    "region": "IN",
    "created_at": "2026-04-03T10:00:00Z"
  }
}
```

**Errors:**
- `400` - Missing email/password or password < 8 chars
- `409` - Email already registered

---

### POST /api/v1/auth/login

Authenticate with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "securepass123"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "a1b2c3d4e5f6...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "email": "user@example.com",
    "role": "tenant",
    "tenant_id": "my-org"
  }
}
```

Notes:
- `access_token` and `token` are identical (backward compatibility alias).
- `refresh_token` is returned only by tinai-api (not tinai-auth).
- tinai-auth returns `expires_in` (seconds) instead of `refresh_token`.

**Errors:**
- `400` - Missing fields
- `401` - Invalid credentials

---

### POST /api/v1/auth/magic-link

Request a magic link / OTP email. Always returns 200 to prevent email enumeration.

**Request:**
```json
{
  "email": "user@example.com"
}
```

**Response (200):**
```json
{
  "message": "If this email is registered, a magic link has been sent."
}
```

In development mode (`NODE_ENV=development`), the response includes:
```json
{
  "message": "...",
  "dev_token": "123456",
  "dev_note": "Remove dev_token in production"
}
```

The magic link/OTP expires after **15 minutes**.

---

### POST /api/v1/auth/verify-magic-link

Verify a magic link OTP and receive a JWT.

**Request:**
```json
{
  "email": "user@example.com",
  "token": "123456"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "a1b2c3d4e5f6...",
  "user": {
    "id": "...",
    "email": "user@example.com",
    "role": "tenant",
    "tenant_id": "my-org"
  }
}
```

The token is consumed atomically -- it cannot be replayed.

**Errors:**
- `400` - Missing email or token
- `401` - Invalid or expired token

---

### POST /api/v1/auth/refresh

Rotate a refresh token and receive a new access token + refresh token pair.

**Request:**
```json
{
  "refresh_token": "a1b2c3d4e5f6..."
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIs...",
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "refresh_token": "new-refresh-token..."
}
```

Notes:
- Refresh tokens are single-use. The old token is deleted and a new one created.
- Refresh tokens expire after **30 days**.
- Only available on tinai-api (not tinai-auth).

**Errors:**
- `401` - Invalid or expired refresh token

---

### GET /api/v1/auth/me

Return the authenticated user's profile. Requires a valid Bearer token.

**Headers:**
```
Authorization: Bearer <jwt>
```

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "role": "tenant",
  "tenant_id": "my-org",
  "region": "IN",
  "last_login": "2026-04-03T10:00:00Z",
  "created_at": "2026-01-01T00:00:00Z"
}
```

**Errors:**
- `401` - Missing/invalid/expired token

---

### POST /api/v1/auth/logout

Revoke the current access token and all refresh tokens for the user.

**Headers:**
```
Authorization: Bearer <jwt>
```

Alternatively, logout by refresh token (for mobile apps):
```json
{
  "refresh_token": "a1b2c3d4e5f6..."
}
```

**Response (200):**
```json
{ "ok": true }
```

On tinai-api, the JWT `jti` claim is added to the `revoked_tokens` table, and all refresh tokens for the user are deleted. Subsequent API calls with the revoked JWT will fail with `401`.

On tinai-auth, logout is a no-op (stateless JWT); the client discards the token.

---

## JWT Token Format and Verification

### Token Structure

Tinai uses **HS256** (HMAC-SHA256) JWTs. No external JWT library is required -- both services implement signing and verification using stdlib crypto.

**Header:**
```json
{
  "alg": "HS256",
  "typ": "JWT"
}
```

**Payload (claims):**
```json
{
  "sub": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "role": "tenant",
  "tenant_id": "my-org",
  "jti": "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
  "iat": 1743667200,
  "exp": 1743753600
}
```

| Claim | Type | Description |
|---|---|---|
| `sub` | string (UUID) | User ID |
| `email` | string | User email (omitted for mobile-only users) |
| `mobile` | string | Mobile number with country code (only for SMS OTP sessions) |
| `role` | string | `"tenant"` or `"admin"` |
| `tenant_id` | string | Tenant/org identifier for multi-tenancy |
| `jti` | string | Unique token ID (tinai-api only; used for revocation) |
| `iat` | number | Issued-at Unix timestamp (seconds) |
| `exp` | number | Expiration Unix timestamp (seconds) |

### Token Lifetimes

| Token Type | Lifetime | Service |
|---|---|---|
| Access token (tinai-api) | 24 hours | tinai-api |
| Access token (tinai-auth) | 7 days | tinai-auth |
| Refresh token | 30 days | tinai-api only |
| Magic link OTP | 15 minutes | Both |
| SMS OTP | 10 minutes | Both |

### Verifying Tokens in Your Own Backend

To verify a Tinai JWT in your own service, use the same `JWT_SECRET` and HS256:

**Node.js (no dependencies):**
```typescript
import { createHmac, timingSafeEqual } from 'crypto'

function verifyTinaiJwt(token: string, secret: string): Record<string, unknown> {
  const [headerB64, payloadB64, sigB64] = token.split('.')
  if (!headerB64 || !payloadB64 || !sigB64) throw new Error('malformed token')

  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')

  const sigBuf = Buffer.from(sigB64, 'base64url')
  const expBuf = Buffer.from(expectedSig, 'base64url')

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new Error('invalid signature')
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired')
  }

  return payload
}
```

**Go:**
```go
import "tinai.cloud/auth/internal/auth"

claims, err := auth.Verify(tokenString, os.Getenv("JWT_SECRET"))
if err != nil {
    // handle invalid/expired token
}
fmt.Println(claims.Sub, claims.Email, claims.Role, claims.TenantID)
```

### Password Hashing

Passwords are hashed with **PBKDF2-SHA512** (100,000 iterations, 64-byte key, 16-byte random salt). The stored format is:

```
pbkdf2:<saltHex>:<hashHex>
```

---

## Refresh Tokens

Refresh tokens are available on **tinai-api** only. They enable long-lived sessions without keeping long-lived JWTs.

### Flow

1. **Login** (`POST /api/v1/auth/login`) returns `access_token` + `refresh_token`.
2. Use `access_token` as `Bearer` token for all API calls.
3. When the access token expires (24h), call `POST /api/v1/auth/refresh` with the `refresh_token`.
4. The server atomically deletes the old refresh token and issues a new pair.
5. On **logout**, all refresh tokens for the user are deleted.

### Storage

- Refresh tokens are stored as SHA-256 hashes in the `refresh_tokens` table.
- The raw token is sent to the client once and never stored server-side.
- Expired tokens should be periodically purged: `DELETE FROM refresh_tokens WHERE expires_at < NOW()`

---

## SMS OTP Authentication

SMS OTP is supported for Indian mobile numbers (10 digits, starting with 6-9). OTPs are delivered via **Msg91**.

### Flow

1. `POST /api/v1/auth/sms-otp` with `{ "mobile": "9876543210" }`
2. User receives a 6-digit OTP via SMS (10-minute expiry).
3. `POST /api/v1/auth/verify-sms` with `{ "mobile": "9876543210", "otp": "123456" }`
4. If the user does not exist, an account is auto-created.
5. A JWT is returned.

### Resend

`POST /api/v1/auth/resend-sms` with `{ "mobile": "9876543210" }`. Enforces a 60-second cooldown between sends. On tinai-auth, resend triggers a voice-call fallback.

### Requirements

Set `MSG91_AUTH_KEY` and `MSG91_TEMPLATE_ID` environment variables. Without these, the OTP endpoint returns `501 Not Implemented` (tinai-auth) or logs the OTP to console (tinai-api in dev mode).

---

## SSO / OIDC Authentication

Supported providers: **Azure AD**, **Google Workspace**, **Okta**. Configured via environment variables; unconfigured providers are silently skipped.

### Flow

1. Redirect user to `GET /api/v1/auth/sso/{provider}` (e.g., `/api/v1/auth/sso/google`).
2. The server sets a CSRF `oidc_state` cookie and redirects to the provider's authorization endpoint.
3. After the user consents, the provider redirects to `GET /api/v1/auth/sso/{provider}/callback`.
4. The server validates the CSRF state, exchanges the authorization code for tokens, fetches userinfo, upserts the user in Postgres, and issues a Tinai JWT.

### Response (callback)

```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "...",
    "email": "user@corp.com",
    "role": "tenant",
    "tenant_id": "tinai-admin",
    "provider": "google"
  },
  "expires_in": 604800
}
```

SSO users are auto-provisioned with an empty `password_hash` (they never authenticate via password).

---

## WebAuthn / Passkeys

Four endpoints on tinai-auth for FIDO2 passkey registration and authentication.

### Registration (existing user adds a passkey)

1. `POST /api/v1/auth/passkey/register/begin` with `{ "email": "user@example.com" }` -- returns `PublicKeyCredentialCreationOptions`.
2. Pass the options to `navigator.credentials.create()` in the browser.
3. `POST /api/v1/auth/passkey/register/finish` with the browser's response -- stores the credential and returns a JWT.

### Authentication (login with passkey)

1. `POST /api/v1/auth/passkey/login/begin` with `{ "email": "user@example.com" }` (or `{}` for discoverable credentials) -- returns `PublicKeyCredentialRequestOptions`.
2. Pass the options to `navigator.credentials.get()` in the browser.
3. `POST /api/v1/auth/passkey/login/finish` with the browser's response -- returns a JWT.

Session state is stored in Postgres (`webauthn_sessions` table, 5-minute expiry) to keep the service stateless across replicas.

---

## Using @tinai/client in a Next.js App

### Installation

```bash
npm install @tinai/client
```

(No need for `ws` in browser environments.)

### Create a shared client instance

```typescript
// lib/tinai.ts
import { createClient } from '@tinai/client'

export const tinai = createClient(
  process.env.NEXT_PUBLIC_TINAI_API_URL!,
  {
    realtimeUrl: process.env.NEXT_PUBLIC_TINAI_REALTIME_URL,
  }
)
```

### Sign in (client component)

```tsx
'use client'

import { useState } from 'react'
import { tinai } from '@/lib/tinai'

export function LoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { session, error } = await tinai.auth.signIn({ email, password })
    if (error) {
      setError(error.message)
    } else {
      // session.token is the JWT; session.tenant_id is populated
      // Session is auto-persisted in localStorage
      window.location.href = '/dashboard'
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" />
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" placeholder="Password" />
      {error && <p style={{ color: 'red' }}>{error}</p>}
      <button type="submit">Sign In</button>
    </form>
  )
}
```

### Magic link flow

```tsx
// Step 1: Request the magic link
const { error } = await tinai.auth.signInWithOtp({ email: 'user@example.com' })

// Step 2: Verify the OTP (from email link or manual entry)
const { session, error } = await tinai.auth.verifyOtp({
  email: 'user@example.com',
  token: '123456',
})
```

### Listen for auth state changes

```tsx
'use client'

import { useEffect } from 'react'
import { tinai } from '@/lib/tinai'

export function AuthListener({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const { unsubscribe } = tinai.auth.onAuthStateChange(({ event, session }) => {
      if (event === 'SIGNED_IN') {
        console.log('User signed in:', session?.email)
      }
      if (event === 'SIGNED_OUT') {
        window.location.href = '/login'
      }
    })
    return unsubscribe
  }, [])

  return <>{children}</>
}
```

### Protect pages (middleware.ts)

Since sessions are stored in `localStorage` (browser-only), server-side protection requires passing the JWT as a cookie or checking it client-side:

```tsx
// A simple client-side auth guard
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { tinai } from '@/lib/tinai'

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter()

  useEffect(() => {
    const session = tinai.auth.getSession()
    if (!session) {
      router.replace('/login')
    }
  }, [router])

  return <>{children}</>
}
```

### Realtime subscriptions

```tsx
'use client'

import { useEffect } from 'react'
import { tinai } from '@/lib/tinai'

export function OrderFeed() {
  useEffect(() => {
    const sub = tinai.db
      .from('orders')
      .on('INSERT', (payload) => {
        console.log('New order:', payload.record)
      })
      .on('UPDATE', (payload) => {
        console.log('Updated:', payload.record)
      })
      .subscribe()

    return () => sub.unsubscribe()
  }, [])

  return <div>Listening for order changes...</div>
}
```

---

## Using @tinai/client in a Node.js/Express App

### Installation

```bash
npm install @tinai/client ws
```

The `ws` package is required in Node.js for WebSocket support (it is an optional peer dependency).

### Server-side client setup

```typescript
// lib/tinai.ts
import { createClient } from '@tinai/client'

export const tinai = createClient(process.env.TINAI_API_URL!, {
  realtimeUrl: process.env.TINAI_REALTIME_URL,
})
```

Note: In Node.js there is no `localStorage`, so sessions are stored in memory only. You must manage token persistence yourself (e.g., store in a database or session store).

### Express auth middleware

```typescript
import { createHmac, timingSafeEqual } from 'crypto'
import { Request, Response, NextFunction } from 'express'

const JWT_SECRET = process.env.JWT_SECRET!

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'missing authorization header' })
  }

  const token = auth.slice(7)
  const [headerB64, payloadB64, sigB64] = token.split('.')
  if (!headerB64 || !payloadB64 || !sigB64) {
    return res.status(401).json({ error: 'malformed token' })
  }

  const expectedSig = createHmac('sha256', JWT_SECRET)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url')

  const sigBuf = Buffer.from(sigB64, 'base64url')
  const expBuf = Buffer.from(expectedSig, 'base64url')

  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return res.status(401).json({ error: 'invalid token' })
  }

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString())
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return res.status(401).json({ error: 'token expired' })
  }

  // Attach user info to the request
  ;(req as any).userId = payload.sub
  ;(req as any).tenantId = payload.tenant_id
  ;(req as any).role = payload.role
  next()
}
```

### Using the middleware

```typescript
import express from 'express'
import { requireAuth } from './middleware/auth'

const app = express()

// Public routes
app.post('/api/login', async (req, res) => {
  const { session, error } = await tinai.auth.signIn(req.body)
  if (error) return res.status(401).json({ error: error.message })
  res.json({ token: session.token, tenant_id: session.tenant_id })
})

// Protected routes
app.get('/api/profile', requireAuth, (req, res) => {
  res.json({
    userId: (req as any).userId,
    tenantId: (req as any).tenantId,
    role: (req as any).role,
  })
})

app.listen(3000)
```

### Realtime in Node.js

```typescript
import { createClient } from '@tinai/client'

const tinai = createClient('https://api.tinai.cloud', {
  realtimeUrl: 'wss://realtime.tinai.cloud',
  token: 'your-jwt-token',
})

const sub = tinai.db
  .from('events')
  .on('*', (payload) => {
    console.log(`${payload.event} on ${payload.table}:`, payload.record)
  })
  .subscribe()

// Channel-level pub/sub
const channelSub = tinai.channel('tenant:acme:logs')
  .on('broadcast', (payload) => console.log('log:', payload))
  .subscribe()
```

---

## Migration Guide: Replacing @supabase/supabase-js

### Package swap

```diff
- npm install @supabase/supabase-js
+ npm install @tinai/client
```

### Client initialization

```diff
- import { createClient } from '@supabase/supabase-js'
- const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
+ import { createClient } from '@tinai/client'
+ const tinai = createClient(TINAI_API_URL, {
+   realtimeUrl: TINAI_REALTIME_URL,
+ })
```

Key difference: Tinai does not use an "anon key" / public API key. Authentication is handled via email+password login or other auth flows. There is no anonymous access mode.

### Auth operations

```diff
  // Sign in
- const { data, error } = await supabase.auth.signInWithPassword({
-   email: 'user@example.com',
-   password: 'secret',
- })
+ const { session, error } = await tinai.auth.signIn({
+   email: 'user@example.com',
+   password: 'secret',
+ })

  // Get session
- const { data: { session } } = await supabase.auth.getSession()
+ const session = tinai.auth.getSession()

  // Auth state listener
- const { data: { subscription } } = supabase.auth.onAuthStateChange(
-   (event, session) => { ... }
- )
- subscription.unsubscribe()
+ const { unsubscribe } = tinai.auth.onAuthStateChange(
+   ({ event, session }) => { ... }
+ )
+ unsubscribe()

  // Sign out
- await supabase.auth.signOut()
+ tinai.auth.signOut()

  // Magic link
- await supabase.auth.signInWithOtp({ email: 'user@example.com' })
+ await tinai.auth.signInWithOtp({ email: 'user@example.com' })

  // Verify OTP
- await supabase.auth.verifyOtp({ email, token, type: 'email' })
+ await tinai.auth.verifyOtp({ email, token })
```

### Return type differences

| Supabase | Tinai |
|---|---|
| `{ data: { session }, error }` | `{ session, error }` |
| `session.access_token` | `session.token` |
| `session.user.id` | Access via JWT `sub` claim |
| `session.user.app_metadata.tenant` | `session.tenant_id` |

### Realtime subscriptions

```diff
  // Table-level
- const channel = supabase
-   .channel('orders-changes')
-   .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' },
-     (payload) => console.log(payload))
-   .subscribe()
+ const sub = tinai.db
+   .from('orders')
+   .on('INSERT', (payload) => console.log(payload))
+   .subscribe()

  // Unsubscribe
- supabase.removeChannel(channel)
+ sub.unsubscribe()

  // Channel-level broadcast
- const channel = supabase.channel('room-1')
-   .on('broadcast', { event: 'message' },
-     (payload) => console.log(payload))
-   .subscribe()
+ const sub = tinai.channel('room-1')
+   .on('broadcast', (payload) => console.log(payload))
+   .subscribe()
```

### What is NOT supported (yet)

- **Supabase Database queries** (`supabase.from('table').select()`) - Tinai does not provide a PostgREST-like query builder. Use direct SQL via your own database connection.
- **Supabase Storage** (`supabase.storage.from('bucket')`) - Use the Tinai storage API endpoints directly.
- **Supabase Edge Functions** - Use Tinai workloads.
- **Row Level Security (RLS)** - Enforce authorization in your application layer using the `tenant_id` and `role` claims from the JWT.

---

## Environment Variables

### Required (both services)

| Variable | Description | Example |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string | `postgres://user:pass@host:5432/tinai` |
| `JWT_SECRET` | Shared secret for HS256 JWT signing | A random 32+ byte string |

### tinai-auth specific

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3002` | HTTP listen port |
| `ALLOWED_ORIGINS` | `https://dashboard.tinai.cloud` | Comma-separated CORS origins |
| `APP_NAME` | `Tinai Cloud` | Display name in emails |
| `NODE_ENV` | `production` | Set to `development` for dev mode (exposes OTP in responses) |

### tinai-api specific

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | HTTP listen port |
| `APP_BASE_URL` | `https://app.tinai.cloud` | Base URL for magic-link emails |
| `POSTMARK_API_KEY` | (none) | Postmark API key for sending magic-link emails |
| `POSTMARK_FROM_EMAIL` | `noreply@tinai.cloud` | Sender address for magic-link emails |
| `REDIS_URL` | (none) | Redis for distributed rate limiting (falls back to in-memory) |

### SMS OTP (Msg91)

| Variable | Default | Description |
|---|---|---|
| `MSG91_AUTH_KEY` | (none) | Msg91 auth key -- required to enable SMS |
| `MSG91_TEMPLATE_ID` | (none) | OTP template ID registered in Msg91 |
| `MSG91_SENDER_ID` | `TINAI` | 6-char sender header |

### SSO / OIDC (tinai-auth)

For each provider (`AZURE`, `GOOGLE`, `OKTA`):

| Variable | Description |
|---|---|
| `OIDC_{PROVIDER}_CLIENT_ID` | OAuth client ID |
| `OIDC_{PROVIDER}_CLIENT_SECRET` | OAuth client secret |
| `OIDC_{PROVIDER}_ISSUER` | OIDC issuer URL |
| `OIDC_{PROVIDER}_REDIRECT_URL` | Callback URL (e.g., `https://auth.tinai.cloud/api/v1/auth/sso/google/callback`) |

Typical issuer values:
- Azure AD: `https://login.microsoftonline.com/{tenant-id}/v2.0`
- Google: `https://accounts.google.com`
- Okta: `https://{domain}.okta.com`

### WebAuthn / Passkeys (tinai-auth)

| Variable | Default | Description |
|---|---|---|
| `WEBAUTHN_RPID` | `tinai.cloud` | Relying Party ID (your domain) |
| `WEBAUTHN_ORIGINS` | `https://app.tinai.cloud,https://tinai.cloud` | Comma-separated allowed origins |

### @tinai/client (frontend)

| Variable | Description |
|---|---|
| `NEXT_PUBLIC_TINAI_API_URL` | e.g., `https://api.tinai.cloud` |
| `NEXT_PUBLIC_TINAI_REALTIME_URL` | e.g., `wss://realtime.tinai.cloud` |

---

## Rate Limiting

### tinai-auth (Go)

Two tiers of in-memory token-bucket rate limiting:

| Tier | Routes | Rate | Burst |
|---|---|---|---|
| Auth-sensitive | `/login`, `/register`, `/magic-link`, `/sms-otp`, `/verify-sms`, `/sso/*`, `/passkey/*` | 5 req/min | 5 |
| Global | All other routes | 60 req/min | 60 |

Keyed by client IP. Returns `429 Too Many Requests` with a `Retry-After` header.

### tinai-api (Fastify)

Redis-backed (via `@fastify/rate-limit`) when `REDIS_URL` is set, otherwise in-memory:

| Routes | Limit |
|---|---|
| All auth routes (`/login`, `/register`, `/magic-link`, etc.) | 5 req/60s per IP |
| All other routes | No limit |

---

## Database Schema

### users (core table)

```sql
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'tenant',
  tenant_id     VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
  region        VARCHAR(5) NOT NULL DEFAULT 'IN',
  magic_token   TEXT,
  magic_expires TIMESTAMPTZ,
  mobile        VARCHAR(15) UNIQUE,
  mobile_verified BOOLEAN NOT NULL DEFAULT false,
  display_name  VARCHAR(120),
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### refresh_tokens (tinai-api)

```sql
CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### revoked_tokens (tinai-api)

```sql
CREATE TABLE revoked_tokens (
  jti        TEXT PRIMARY KEY,
  user_id    UUID NOT NULL,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
```

### sms_otp_requests (tinai-auth)

```sql
CREATE TABLE sms_otp_requests (
  mobile        VARCHAR(15) PRIMARY KEY,
  sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0
);
```

### webauthn_credentials (tinai-auth)

```sql
CREATE TABLE webauthn_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     VARCHAR(63) NOT NULL,
  credential_id BYTEA NOT NULL UNIQUE,
  public_key    BYTEA NOT NULL,
  sign_count    BIGINT NOT NULL DEFAULT 0,
  aaguid        UUID,
  display_name  TEXT NOT NULL DEFAULT 'My Passkey',
  transports    TEXT[] DEFAULT '{}',
  backed_up     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ
);
```

### webauthn_sessions (tinai-auth)

```sql
CREATE TABLE webauthn_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    VARCHAR(63),
  challenge    TEXT NOT NULL UNIQUE,
  session_data JSONB NOT NULL,
  flow         VARCHAR(20) NOT NULL DEFAULT 'registration',
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '5 minutes'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```
