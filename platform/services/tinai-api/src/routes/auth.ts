// TODO: Register in server.ts: app.register(authRoutes, { prefix: '/api/v1' })

// Requires no external deps — uses Node.js built-in crypto for JWT (HS256) and PBKDF2 password hashing.
// If you prefer bcrypt/jsonwebtoken add them: npm install jsonwebtoken bcryptjs @types/jsonwebtoken @types/bcryptjs
//
// Tables required (run 002_feature_tables.sql migration):
// CREATE TABLE IF NOT EXISTS users (
//   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   email         TEXT NOT NULL UNIQUE,
//   password_hash TEXT NOT NULL,
//   role          VARCHAR(20) NOT NULL DEFAULT 'tenant',
//   tenant_id     VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
//   region        VARCHAR(5) NOT NULL DEFAULT 'IN',
//   magic_token   TEXT,
//   magic_expires TIMESTAMPTZ,
//   last_login    TIMESTAMPTZ,
//   created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
// )
//
// Also requires 011_refresh_tokens.sql migration for refresh token support.

import { FastifyInstance } from 'fastify'
import { pbkdf2Sync, randomBytes, randomUUID, createHmac, timingSafeEqual, createHash } from 'crypto'
import https from 'https'

const JWT_SECRET: string = process.env.JWT_SECRET ?? ''
if (!JWT_SECRET) throw new Error('JWT_SECRET environment variable is required')
const JWT_EXPIRY_SECONDS      = 24 * 60 * 60      // 24 hours (access token)
const REFRESH_EXPIRY_DAYS     = 30                 // 30 days  (refresh token)
const MAGIC_LINK_EXPIRY_MINUTES = 15

// ---------------------------------------------------------------------------
// JWT helpers (HS256, no external deps)
// ---------------------------------------------------------------------------

function signJwt(payload: object, secret: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body   = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig    = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

async function verifyJwt(
  token: string,
  secret: string,
  pg?: FastifyInstance['pg'],
): Promise<Record<string, unknown>> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [header, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  if (sig !== expected) throw new Error('invalid signature')
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error('token expired')
  }
  // Denylist check: reject tokens that have been explicitly revoked (e.g. via logout).
  // Requires 009_revoked_tokens.sql migration to have been applied.
  if (pg) {
    const jti = payload.jti as string | undefined
    if (jti) {
      const { rows } = await pg.query(
        'SELECT 1 FROM revoked_tokens WHERE jti = $1 AND expires_at > NOW()',
        [jti],
      )
      if (rows.length) throw new Error('token revoked')
    }
  }
  return payload
}

function makeToken(user: { id: string; email: string; role: string; tenant_id: string }): string {
  return signJwt(
    {
      sub:       user.id,
      email:     user.email,
      role:      user.role,
      tenant_id: user.tenant_id,
      jti:       randomBytes(16).toString('hex'), // unique token ID for blocklist lookups
      iat:       Math.floor(Date.now() / 1000),
      exp:       Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS,
    },
    JWT_SECRET,
  )
}

// ---------------------------------------------------------------------------
// Postmark email delivery (B2)
// ---------------------------------------------------------------------------

/**
 * Send a magic-link / sign-in email via Postmark.
 * If POSTMARK_API_KEY is not set, logs a warning and skips gracefully.
 */
async function sendMagicLinkEmail(to: string, magicLinkUrl: string): Promise<void> {
  const apiKey = process.env.POSTMARK_API_KEY
  if (!apiKey) {
    console.warn('[auth] POSTMARK_API_KEY not set — skipping magic-link email delivery')
    return
  }

  // Lazy-require so the module is only loaded when the key is present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const postmark = require('postmark') as typeof import('postmark')
  const client = new postmark.ServerClient(apiKey)

  await client.sendEmail({
    From:     process.env.POSTMARK_FROM_EMAIL ?? 'noreply@tinai.cloud',
    To:       to,
    Subject:  'Your Tinai sign-in link',
    HtmlBody: `
<!DOCTYPE html>
<html>
<body style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="color:#1a1a2e">Sign in to Tinai</h2>
  <p>Click the button below to sign in. This link expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes.</p>
  <a href="${magicLinkUrl}"
     style="display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;
            text-decoration:none;border-radius:6px;font-weight:600">
    Sign in to Tinai
  </a>
  <p style="margin-top:24px;color:#666;font-size:13px">
    If you did not request this link, you can safely ignore this email.
  </p>
</body>
</html>`,
    TextBody: `Sign in to Tinai\n\nUse this link to sign in (expires in ${MAGIC_LINK_EXPIRY_MINUTES} minutes):\n${magicLinkUrl}\n\nIf you did not request this, ignore this email.`,
    MessageStream: 'outbound',
  })
}

// ---------------------------------------------------------------------------
// Refresh token helpers (B3)
// ---------------------------------------------------------------------------

const REFRESH_EXPIRY_SECONDS = REFRESH_EXPIRY_DAYS * 24 * 60 * 60

/**
 * Generate a cryptographically-random refresh token, store its SHA-256 hash
 * in the DB, and return the raw token (sent to the client once).
 */
async function createRefreshToken(
  pg: FastifyInstance['pg'],
  userId: string,
): Promise<string> {
  const raw  = randomBytes(32).toString('hex')
  const hash = createHash('sha256').update(raw).digest('hex')
  const expiresAt = new Date(Date.now() + REFRESH_EXPIRY_SECONDS * 1000)

  await pg.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hash, expiresAt.toISOString()],
  )

  return raw
}

/**
 * Rotate a refresh token: delete the old hash row, insert a new one.
 * Returns the new raw token, or null if the old token was not found / expired.
 */
async function rotateRefreshToken(
  pg: FastifyInstance['pg'],
  rawToken: string,
): Promise<{ newRawToken: string; userId: string } | null> {
  const hash = createHash('sha256').update(rawToken).digest('hex')

  // Delete the matching, unexpired row atomically and return the user_id.
  const { rows } = await pg.query(
    `DELETE FROM refresh_tokens
     WHERE token_hash = $1 AND expires_at > NOW()
     RETURNING user_id`,
    [hash],
  )

  if (!rows.length) return null

  const userId = rows[0].user_id as string
  const newRaw = await createRefreshToken(pg, userId)
  return { newRawToken: newRaw, userId }
}

// ---------------------------------------------------------------------------
// Password helpers (PBKDF2-SHA512, no external deps)
// ---------------------------------------------------------------------------

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const hash = pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
  return `pbkdf2:${salt}:${hash}`
}

function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  const [prefix, salt, hash] = parts.length === 3 ? parts : ['legacy', parts[0], parts[1]]
  if (prefix !== 'pbkdf2' && prefix !== 'legacy') return false
  if (!salt || !hash) return false
  const incoming = pbkdf2Sync(password, salt, 100_000, 64, 'sha512').toString('hex')
  return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(incoming, 'hex'))
}

// ---------------------------------------------------------------------------
// Route bodies
// ---------------------------------------------------------------------------

interface RegisterBody  { email: string; password: string; tenant_id?: string }
interface LoginBody     { email: string; password: string }
interface MagicBody     { email: string }
interface VerifyBody    { email: string; token: string }
interface RefreshBody   { refresh_token: string }
interface SmsOtpBody    { mobile: string }
interface VerifySmsBody { mobile: string; otp: string }

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function authRoutes(app: FastifyInstance) {
  // POST /auth/register
  app.post<{ Body: RegisterBody }>('/auth/register', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:     { type: 'string', format: 'email' },
          password:  { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body
    const tenant_id = randomUUID()

    const { rows: existing } = await app.pg.query(
      'SELECT id FROM users WHERE email = $1', [email],
    )
    if (existing.length) return reply.status(409).send({ error: 'email already registered' })

    const passwordHash = hashPassword(password)

    const { rows: [user] } = await app.pg.query(
      `INSERT INTO users (email, password_hash, tenant_id)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, tenant_id, region, created_at`,
      [email, passwordHash, tenant_id],
    )

    // Auto-create default project + 3 environments for new tenant
    try {
      const { rows: [project] } = await app.pg.query(
        `INSERT INTO projects (tenant_id, name, slug, description)
         VALUES ($1, 'Default', 'default', 'Auto-created default project')
         ON CONFLICT (tenant_id, slug) DO NOTHING
         RETURNING id`,
        [user.tenant_id],
      )
      if (project?.id) {
        for (const env of ['production', 'staging', 'development']) {
          await app.pg.query(
            `INSERT INTO environments (project_id, tenant_id, name, slug)
             VALUES ($1, $2, $3, $4) ON CONFLICT (project_id, slug) DO NOTHING`,
            [project.id, user.tenant_id, env.charAt(0).toUpperCase() + env.slice(1), env],
          )
        }
      }
      // Assign free plan
      await app.pg.query(
        `INSERT INTO tenant_plans (tenant_id, plan_id) VALUES ($1, 'free')
         ON CONFLICT (tenant_id) DO NOTHING`,
        [user.tenant_id],
      )
    } catch { /* best-effort — tables may not be ready on first boot */ }

    const token = makeToken(user)
    return reply.status(201).send({ token, user })
  })

  // POST /auth/login
  app.post<{ Body: LoginBody }>('/auth/login', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'password'],
        properties: {
          email:    { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, password } = req.body

    const { rows } = await app.pg.query(
      'SELECT id, email, role, tenant_id, region, password_hash FROM users WHERE email = $1',
      [email],
    )
    if (!rows.length) return reply.status(401).send({ error: 'invalid credentials' })

    const user = rows[0]
    if (!verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: 'invalid credentials' })
    }

    await app.pg.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])

    const token         = makeToken(user)
    const refresh_token = await createRefreshToken(app.pg, user.id)

    return reply.send({
      access_token: token,
      token,          // backward-compat alias
      refresh_token,
      user: {
        id:        user.id,
        email:     user.email,
        role:      user.role,
        tenant_id: user.tenant_id,
      },
    })
  })

  // POST /auth/magic-link
  app.post<{ Body: MagicBody }>('/auth/magic-link', {
    schema: {
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email } = req.body

    const { rows } = await app.pg.query('SELECT id FROM users WHERE email = $1', [email])
    // Always return 200 to avoid email enumeration
    if (!rows.length) return reply.send({ message: 'If this email is registered, a magic link has been sent.' })

    // 6-digit numeric OTP (easier for users to type) with 16 bytes of entropy source
    const otpNum = (randomBytes(16).readUInt32BE(0) % 900000) + 100000
    const otp    = otpNum.toString()
    const expires = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)

    await app.pg.query(
      'UPDATE users SET magic_token = $1, magic_expires = $2 WHERE email = $3',
      [otp, expires.toISOString(), email],
    )

    // Build the magic-link URL and send via Postmark
    const appBaseUrl  = process.env.APP_BASE_URL ?? 'https://app.tinai.cloud'
    const magicLinkUrl = `${appBaseUrl}/auth/verify?email=${encodeURIComponent(email)}&token=${otp}`

    // Fire-and-forget — don't block the response or surface delivery errors to caller
    sendMagicLinkEmail(email, magicLinkUrl).catch((err) => {
      console.error('[auth] magic-link email delivery failed:', err)
    })

    const response: Record<string, unknown> = {
      message: 'If this email is registered, a magic link has been sent.',
    }
    if (process.env.NODE_ENV === 'development') {
      response.dev_token = otp
      response.dev_note  = 'dev_token is only returned in NODE_ENV=development — remove this in prod'
    }

    return reply.send(response)
  })

  // POST /auth/verify-magic-link
  app.post<{ Body: VerifyBody }>('/auth/verify-magic-link', {
    schema: {
      body: {
        type: 'object',
        required: ['email', 'token'],
        properties: {
          email: { type: 'string' },
          token: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { email, token } = req.body

    // Atomically consume the token: the UPDATE only succeeds if the email, token,
    // and expiry all match in a single statement, eliminating the TOCTOU race.
    const { rows } = await app.pg.query(
      `UPDATE users
       SET magic_token = NULL, magic_expires = NULL, last_login = NOW()
       WHERE email = $1
         AND magic_token = $2
         AND magic_expires > NOW()
       RETURNING id, email, role, tenant_id`,
      [email, token],
    )
    if (!rows.length) return reply.status(401).send({ error: 'invalid or expired token' })

    const user = rows[0]

    const jwtToken      = makeToken(user)
    const refresh_token = await createRefreshToken(app.pg, user.id)

    return reply.send({
      access_token: jwtToken,
      token: jwtToken,   // backward-compat alias
      refresh_token,
      user: {
        id:        user.id,
        email:     user.email,
        role:      user.role,
        tenant_id: user.tenant_id,
      },
    })
  })

  // GET /auth/me
  app.get('/auth/me', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'missing or malformed Authorization header' })
    }

    const token = authHeader.slice(7)
    let payload: Record<string, unknown>
    try {
      payload = await verifyJwt(token, JWT_SECRET, app.pg)
    } catch (err) {
      return reply.status(401).send({ error: (err as Error).message })
    }

    const { rows } = await app.pg.query(
      'SELECT id, email, role, tenant_id, region, last_login, created_at FROM users WHERE id = $1',
      [payload.sub],
    )
    if (!rows.length) return reply.status(401).send({ error: 'user not found' })

    return rows[0]
  })

  // ---------------------------------------------------------------------------
  // POST /auth/refresh — rotate refresh token, issue new access token (B3)
  // ---------------------------------------------------------------------------
  app.post<{ Body: RefreshBody }>('/auth/refresh', {
    schema: {
      body: {
        type: 'object',
        required: ['refresh_token'],
        properties: {
          refresh_token: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { refresh_token: rawToken } = req.body

    const result = await rotateRefreshToken(app.pg, rawToken)
    if (!result) {
      return reply.status(401).send({ error: 'invalid or expired refresh token' })
    }

    const { newRawToken, userId } = result

    // Load user to build JWT claims
    const { rows } = await app.pg.query(
      'SELECT id, email, role, tenant_id FROM users WHERE id = $1',
      [userId],
    )
    if (!rows.length) {
      return reply.status(401).send({ error: 'user not found' })
    }

    const user          = rows[0]
    const access_token  = makeToken(user)

    return reply.send({
      access_token,
      token: access_token,   // backward-compat alias
      refresh_token: newRawToken,
    })
  })

  // ---------------------------------------------------------------------------
  // SMS OTP helpers
  // ---------------------------------------------------------------------------

  /**
   * Send a 6-digit OTP to the given mobile number via MSG91 (if MSG91_AUTH_KEY is
   * set) or log it to the console for local development.
   * Returns the raw OTP so the route can include it in dev responses.
   */
  async function sendSmsOtp(mobile: string): Promise<string> {
    const otpNum = (randomBytes(16).readUInt32BE(0) % 900000) + 100000
    const otp = otpNum.toString()

    const authKey = process.env.MSG91_AUTH_KEY
    const templateId = process.env.MSG91_TEMPLATE_ID ?? ''
    const senderId = process.env.MSG91_SENDER_ID ?? 'TNAICL'

    if (authKey) {
      // MSG91 Send OTP v5 API
      const payload = JSON.stringify({
        template_id: templateId,
        mobile: `91${mobile}`,
        authkey: authKey,
        otp,
        sender: senderId,
      })
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'api.msg91.com',
            path: '/api/v5/otp',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
          },
          (res) => {
            res.resume()
            res.on('end', resolve)
          },
        )
        req.on('error', reject)
        req.write(payload)
        req.end()
      })
    } else {
      // Development: print to console
      console.log(`[SMS OTP] mobile=${mobile} otp=${otp}`)
    }

    return otp
  }

  function hashOtp(otp: string): string {
    return createHash('sha256').update(otp).digest('hex')
  }

  const SMS_OTP_EXPIRY_MINUTES = 10

  // ---------------------------------------------------------------------------
  // POST /auth/sms-otp — send OTP to mobile
  // ---------------------------------------------------------------------------
  app.post<{ Body: SmsOtpBody }>('/auth/sms-otp', {
    schema: {
      body: {
        type: 'object',
        required: ['mobile'],
        properties: {
          mobile: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { mobile } = req.body

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return reply.status(400).send({ error: 'mobile must be a 10-digit Indian number starting with 6–9' })
    }

    // Purge any existing OTPs for this mobile before inserting a fresh one
    await app.pg.query('DELETE FROM sms_otps WHERE mobile = $1', [mobile])

    const otp = await sendSmsOtp(mobile)
    const otpHash = hashOtp(otp)
    const expiresAt = new Date(Date.now() + SMS_OTP_EXPIRY_MINUTES * 60 * 1000)

    await app.pg.query(
      'INSERT INTO sms_otps (mobile, otp_hash, expires_at) VALUES ($1, $2, $3)',
      [mobile, otpHash, expiresAt.toISOString()],
    )

    const response: Record<string, unknown> = { ok: true }
    const isDevMode = !process.env.MSG91_AUTH_KEY && process.env.NODE_ENV !== 'production'
    if (isDevMode) {
      response.dev_otp = otp
      response.dev_note = 'dev_otp is only returned when MSG91_AUTH_KEY is not configured and NODE_ENV is not production'
    }
    return reply.send(response)
  })

  // ---------------------------------------------------------------------------
  // POST /auth/verify-sms — verify OTP, return JWT
  // ---------------------------------------------------------------------------
  app.post<{ Body: VerifySmsBody }>('/auth/verify-sms', {
    schema: {
      body: {
        type: 'object',
        required: ['mobile', 'otp'],
        properties: {
          mobile: { type: 'string' },
          otp:    { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { mobile, otp } = req.body

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return reply.status(400).send({ error: 'mobile must be a 10-digit Indian number starting with 6–9' })
    }

    // Fetch the most recent unexpired, unused OTP for this mobile
    const { rows } = await app.pg.query(
      `SELECT id, otp_hash FROM sms_otps
       WHERE mobile = $1
         AND used = false
         AND expires_at > NOW()
       ORDER BY created_at DESC
       LIMIT 1`,
      [mobile],
    )

    if (!rows.length) {
      return reply.status(401).send({ error: 'invalid or expired OTP' })
    }

    const record = rows[0]
    const incoming = hashOtp(otp)

    const recordBuf  = Buffer.from(record.otp_hash, 'hex')
    const incomingBuf = Buffer.from(incoming, 'hex')
    const hashMatch = recordBuf.length === incomingBuf.length && timingSafeEqual(recordBuf, incomingBuf)

    if (!hashMatch) {
      return reply.status(401).send({ error: 'invalid or expired OTP' })
    }

    // Mark as used
    await app.pg.query('UPDATE sms_otps SET used = true WHERE id = $1', [record.id])

    // Find or create a user keyed by mobile (stored as a synthetic email)
    const syntheticEmail = `${mobile}@sms.tinai.cloud`

    const { rows: existingUsers } = await app.pg.query(
      'SELECT id, email, role, tenant_id FROM users WHERE email = $1',
      [syntheticEmail],
    )

    let user: { id: string; email: string; role: string; tenant_id: string }

    if (existingUsers.length) {
      user = existingUsers[0]
      await app.pg.query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id])
    } else {
      // Create a new user — password_hash is a random sentinel (SMS users never use password auth)
      // tenant_id is derived from the mobile number so each SMS user gets their own tenant scope.
      const placeholderHash = `sms:${randomBytes(16).toString('hex')}`
      const smsTenantId = `tinai-sms-${mobile}`
      const { rows: [newUser] } = await app.pg.query(
        `INSERT INTO users (email, password_hash, role, tenant_id)
         VALUES ($1, $2, 'tenant', $3)
         RETURNING id, email, role, tenant_id`,
        [syntheticEmail, placeholderHash, smsTenantId],
      )
      user = newUser
    }

    const token = makeToken(user)
    return reply.send({
      token,
      user: {
        id:        user.id,
        email:     user.email,
        role:      user.role,
        tenant_id: user.tenant_id,
      },
    })
  })

  // ---------------------------------------------------------------------------
  // POST /auth/resend-sms — resend OTP (60-second cooldown)
  // ---------------------------------------------------------------------------
  app.post<{ Body: SmsOtpBody }>('/auth/resend-sms', {
    schema: {
      body: {
        type: 'object',
        required: ['mobile'],
        properties: {
          mobile: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { mobile } = req.body

    if (!/^[6-9]\d{9}$/.test(mobile)) {
      return reply.status(400).send({ error: 'mobile must be a 10-digit Indian number starting with 6–9' })
    }

    // Enforce 60-second cooldown: reject if a recent OTP was sent within the last minute
    const { rows: recent } = await app.pg.query(
      `SELECT id FROM sms_otps
       WHERE mobile = $1
         AND created_at > NOW() - INTERVAL '60 seconds'
       LIMIT 1`,
      [mobile],
    )

    if (recent.length) {
      return reply.status(429).send({ error: 'please wait 60 seconds before requesting another OTP' })
    }

    // Purge old OTPs and issue a fresh one
    await app.pg.query('DELETE FROM sms_otps WHERE mobile = $1', [mobile])

    const otp = await sendSmsOtp(mobile)
    const otpHash = hashOtp(otp)
    const expiresAt = new Date(Date.now() + SMS_OTP_EXPIRY_MINUTES * 60 * 1000)

    await app.pg.query(
      'INSERT INTO sms_otps (mobile, otp_hash, expires_at) VALUES ($1, $2, $3)',
      [mobile, otpHash, expiresAt.toISOString()],
    )

    return reply.send({ ok: true })
  })

  // POST /auth/logout
  //
  // Migration 003_revoked_tokens.sql — run once before enabling DB blocklist:
  // CREATE TABLE IF NOT EXISTS revoked_tokens (
  //   jti        TEXT PRIMARY KEY,
  //   user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  //   expires_at TIMESTAMPTZ NOT NULL,
  //   revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  // );
  // CREATE INDEX IF NOT EXISTS revoked_tokens_expires_at_idx ON revoked_tokens (expires_at);
  // -- Purge expired entries periodically:
  // -- DELETE FROM revoked_tokens WHERE expires_at < NOW();
  app.post<{ Body?: { refresh_token?: string } }>('/auth/logout', async (req, reply) => {
    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      try {
        // Pass pg so the denylist check also fires during logout (handles double-logout safely).
        const payload = await verifyJwt(token, JWT_SECRET, app.pg)
        const jti = payload.jti as string | undefined
        const exp = payload.exp as number | undefined
        if (jti && exp) {
          await app.pg.query(
            `INSERT INTO revoked_tokens (jti, user_id, expires_at)
             VALUES ($1, $2, to_timestamp($3))
             ON CONFLICT (jti) DO NOTHING`,
            [jti, payload.sub, exp],
          )
        }
        // Also delete all refresh tokens for this user so they cannot be rotated after logout.
        if (payload.sub) {
          await app.pg.query(
            'DELETE FROM refresh_tokens WHERE user_id = $1',
            [payload.sub],
          )
        }
      } catch {
        // Token already invalid or revoked — logout is still successful from the client's perspective
      }
    } else if (req.body?.refresh_token) {
      // Support token-less logout via refresh token (e.g. mobile apps that don't keep the access token).
      const hash = createHash('sha256').update(req.body.refresh_token).digest('hex')
      await app.pg.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [hash])
    }
    return { ok: true }
  })
}
