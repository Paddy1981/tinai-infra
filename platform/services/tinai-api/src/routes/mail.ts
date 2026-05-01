import { FastifyInstance } from 'fastify'
import * as http from 'http'
import * as crypto from 'crypto'
import * as dns from 'dns'

const STALWART_URL = process.env.STALWART_ADMIN_URL || 'http://stalwart.core.svc.cluster.local:8080'
const STALWART_PASSWORD = process.env.STALWART_ADMIN_PASSWORD || 'TwTtawGS7KWZwdfFdn6gbA=='
const STALWART_AUTH = 'Basic ' + Buffer.from(`admin:${STALWART_PASSWORD}`).toString('base64')

// ---------------------------------------------------------------------------
// Stalwart Admin API helper
// ---------------------------------------------------------------------------
async function stalwartRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: any }> {
  const url = new URL(path, STALWART_URL)
  const payload = body ? JSON.stringify(body) : undefined

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': STALWART_AUTH,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {}
            resolve({ status: res.statusCode ?? 500, data: parsed })
          } catch {
            resolve({ status: res.statusCode ?? 500, data: { raw: data } })
          }
        })
      },
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Mail routes plugin
// ---------------------------------------------------------------------------
export async function mailRoutes(app: FastifyInstance) {

  // ── Consumer (Tier 1): Provision @tinai.cloud mail account ──────────────
  app.post('/mail/provision', async (req, reply) => {
    const userId = (req as any).userId as string
    const tenantId = (req as any).tenantId as string

    // Look up user email from the users table
    const { rows } = await app.pg.query(
      'SELECT email, display_name FROM users WHERE id = $1',
      [userId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'user not found' })

    const userEmail = rows[0].email as string
    const displayName = (rows[0].display_name as string) || userEmail.split('@')[0]

    // Derive the tinai.cloud mailbox name from the user's primary email
    const localPart = userEmail.split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase()
    const mailAddress = `${localPart}@tinai.cloud`

    // Generate a random initial password
    const tempPassword = crypto.randomBytes(16).toString('base64url')

    const { status, data } = await stalwartRequest('POST', '/api/principal', {
      type: 'individual',
      name: localPart,
      description: displayName,
      secrets: [tempPassword],
      emails: [mailAddress],
      quota: 1_073_741_824, // 1 GB default
      roles: ['user'],
      memberOf: [],
    })

    if (status >= 400 && status !== 409) {
      app.log.error({ status, data }, 'stalwart provision failed')
      return reply.status(502).send({ error: 'mail provisioning failed', detail: data })
    }

    return {
      email: mailAddress,
      imap: 'mail.tinai.cloud',
      smtp: 'mail.tinai.cloud',
      password: tempPassword,
      note: 'Save this password — it cannot be retrieved later. Change it via webmail.',
    }
  })

  // ── Consumer (Tier 1): Get current user's mail account ──────────────────
  app.get('/mail/account', async (req, reply) => {
    const userId = (req as any).userId as string

    const { rows } = await app.pg.query(
      'SELECT email FROM users WHERE id = $1',
      [userId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'user not found' })

    const localPart = (rows[0].email as string).split('@')[0].replace(/[^a-z0-9._-]/gi, '').toLowerCase()

    const { status, data } = await stalwartRequest('GET', `/api/principal/${encodeURIComponent(localPart)}`)

    if (status === 404) {
      return { provisioned: false, email: null }
    }
    if (status >= 400) {
      app.log.error({ status, data }, 'stalwart account lookup failed')
      return reply.status(502).send({ error: 'mail service unavailable' })
    }

    return {
      provisioned: true,
      email: data.emails?.[0] ?? `${localPart}@tinai.cloud`,
      quota: data.quota ?? null,
      imap: 'mail.tinai.cloud',
      smtp: 'mail.tinai.cloud',
    }
  })

  // ── Consumer (Tier 1): Signatures CRUD ──────────────────────────────────
  app.get('/mail/signatures', async (req, reply) => {
    const userId = (req as any).userId as string
    const { rows } = await app.pg.query(
      'SELECT id, name, html, is_default, created_at FROM mail_signatures WHERE user_id = $1 ORDER BY created_at',
      [userId],
    )
    return rows
  })

  app.post('/mail/signatures', async (req, reply) => {
    const userId = (req as any).userId as string
    const { name, html, is_default } = req.body as { name: string; html: string; is_default?: boolean }

    if (!name || !html) return reply.status(400).send({ error: 'name and html are required' })

    // If setting as default, unset existing defaults first
    if (is_default) {
      await app.pg.query('UPDATE mail_signatures SET is_default = false WHERE user_id = $1', [userId])
    }

    const { rows } = await app.pg.query(
      `INSERT INTO mail_signatures (user_id, name, html, is_default)
       VALUES ($1, $2, $3, $4) RETURNING id, name, html, is_default, created_at`,
      [userId, name, html, is_default ?? false],
    )
    return reply.status(201).send(rows[0])
  })

  app.put<{ Params: { id: string } }>('/mail/signatures/:id', async (req, reply) => {
    const userId = (req as any).userId as string
    const { name, html, is_default } = req.body as { name?: string; html?: string; is_default?: boolean }

    // Verify ownership
    const { rows: existing } = await app.pg.query(
      'SELECT id FROM mail_signatures WHERE id = $1 AND user_id = $2',
      [req.params.id, userId],
    )
    if (!existing.length) return reply.status(404).send({ error: 'signature not found' })

    if (is_default) {
      await app.pg.query('UPDATE mail_signatures SET is_default = false WHERE user_id = $1', [userId])
    }

    const { rows } = await app.pg.query(
      `UPDATE mail_signatures
       SET name = COALESCE($1, name),
           html = COALESCE($2, html),
           is_default = COALESCE($3, is_default),
           updated_at = NOW()
       WHERE id = $4 AND user_id = $5
       RETURNING id, name, html, is_default, created_at, updated_at`,
      [name ?? null, html ?? null, is_default ?? null, req.params.id, userId],
    )
    return rows[0]
  })

  app.delete<{ Params: { id: string } }>('/mail/signatures/:id', async (req, reply) => {
    const userId = (req as any).userId as string

    const { rowCount } = await app.pg.query(
      'DELETE FROM mail_signatures WHERE id = $1 AND user_id = $2',
      [req.params.id, userId],
    )
    if (!rowCount) return reply.status(404).send({ error: 'signature not found' })
    return { ok: true }
  })

  // ── Business (Tier 2): Custom domain management ────────────────────────

  // Add custom mail domain
  app.post('/mail/domains', {
    preHandler: (await import('../middleware/planGate')).requirePlan('custom_domains'),
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { domain } = req.body as { domain: string }

    if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) {
      return reply.status(400).send({ error: 'invalid domain name' })
    }

    const domainLower = domain.toLowerCase()

    // Generate verification token
    const verifyToken = crypto.randomBytes(20).toString('hex')

    // Register domain in Stalwart
    const { status, data } = await stalwartRequest('POST', '/api/principal', {
      type: 'domain',
      name: domainLower,
    })

    if (status >= 400 && status !== 409) {
      app.log.error({ status, data }, 'stalwart domain creation failed')
      return reply.status(502).send({ error: 'failed to register domain with mail server' })
    }

    // Store domain record with verification token
    try {
      const { rows } = await app.pg.query(
        `INSERT INTO mail_domains (tenant_id, domain, verify_token)
         VALUES ($1, $2, $3)
         RETURNING id, domain, verified, verify_token, created_at`,
        [tenantId, domainLower, verifyToken],
      )

      return reply.status(201).send({
        ...rows[0],
        dns_instructions: {
          type: 'TXT',
          name: `_tinai-verify.${domainLower}`,
          value: verifyToken,
          note: 'Add this TXT record to your DNS, then call the verify endpoint.',
        },
      })
    } catch (e: any) {
      if (e.code === '23505') {
        return reply.status(409).send({ error: 'domain already registered' })
      }
      throw e
    }
  })

  // List tenant's custom mail domains
  app.get('/mail/domains', {
    preHandler: (await import('../middleware/planGate')).requirePlan('custom_domains'),
  }, async (req) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      `SELECT id, domain, verified, created_at
       FROM mail_domains
       WHERE tenant_id = $1
       ORDER BY created_at`,
      [tenantId],
    )
    return rows
  })

  // Verify DNS for custom domain
  app.get<{ Params: { id: string } }>('/mail/domains/:id/verify', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      'SELECT id, domain, verify_token, verified FROM mail_domains WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'domain not found' })

    const domainRecord = rows[0]

    if (domainRecord.verified) {
      return { verified: true, domain: domainRecord.domain }
    }

    // DNS lookup for verification TXT record
    const hostname = `_tinai-verify.${domainRecord.domain}`
    let verified = false

    try {
      const records = await dns.promises.resolveTxt(hostname)
      // records is an array of arrays of strings
      const flatRecords = records.map((r: string[]) => r.join(''))
      verified = flatRecords.includes(domainRecord.verify_token)
    } catch (e: any) {
      // ENOTFOUND / ENODATA means the record doesn't exist yet
      if (e.code !== 'ENOTFOUND' && e.code !== 'ENODATA') {
        app.log.warn({ err: e.message, hostname }, 'DNS lookup error')
      }
    }

    if (verified) {
      await app.pg.query(
        'UPDATE mail_domains SET verified = true WHERE id = $1',
        [domainRecord.id],
      )

      // Set up DKIM signing for this domain
      const dkimSelector = 'tinai'
      try {
        await stalwartRequest('POST', '/api/settings', {
          [`signature.${domainRecord.domain}`]: {
            selector: dkimSelector,
            domain: domainRecord.domain,
            algorithm: 'ed25519-sha256',
            canonicalization: 'relaxed/relaxed',
          },
        })
      } catch (e: any) {
        app.log.warn({ err: e.message }, 'DKIM setup failed — can be configured later')
      }
    }

    return {
      verified,
      domain: domainRecord.domain,
      expected_record: {
        type: 'TXT',
        name: hostname,
        value: domainRecord.verify_token,
      },
    }
  })

  // Remove custom domain
  app.delete<{ Params: { id: string } }>('/mail/domains/:id', {
    preHandler: (await import('../middleware/planGate')).requirePlan('custom_domains'),
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      'SELECT domain FROM mail_domains WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    )
    if (!rows.length) return reply.status(404).send({ error: 'domain not found' })

    const domainName = rows[0].domain

    // Remove from Stalwart
    try {
      await stalwartRequest('DELETE', `/api/principal/${encodeURIComponent(domainName)}`)
    } catch (e: any) {
      app.log.warn({ err: e.message }, 'stalwart domain removal failed — continuing')
    }

    await app.pg.query('DELETE FROM mail_domains WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId])

    return { ok: true }
  })

  // Provision user on custom domain
  app.post<{ Params: { id: string } }>('/mail/domains/:id/users', {
    preHandler: (await import('../middleware/planGate')).requirePlan('custom_domains'),
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { username, password, display_name } = req.body as {
      username: string
      password: string
      display_name?: string
    }

    if (!username || !password) {
      return reply.status(400).send({ error: 'username and password are required' })
    }

    // Verify domain ownership
    const { rows: domainRows } = await app.pg.query(
      'SELECT domain, verified FROM mail_domains WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    )
    if (!domainRows.length) return reply.status(404).send({ error: 'domain not found' })
    if (!domainRows[0].verified) return reply.status(400).send({ error: 'domain not verified — complete DNS verification first' })

    const domainName = domainRows[0].domain
    const cleanUsername = username.replace(/[^a-z0-9._-]/gi, '').toLowerCase()
    const mailAddress = `${cleanUsername}@${domainName}`

    const { status, data } = await stalwartRequest('POST', '/api/principal', {
      type: 'individual',
      name: cleanUsername,
      description: display_name ?? cleanUsername,
      secrets: [password],
      emails: [mailAddress],
      quota: 5_368_709_120, // 5 GB
      roles: ['user'],
      memberOf: [],
    })

    if (status >= 400 && status !== 409) {
      app.log.error({ status, data }, 'stalwart user creation on custom domain failed')
      return reply.status(502).send({ error: 'mail user provisioning failed', detail: data })
    }

    if (status === 409) {
      return reply.status(409).send({ error: 'user already exists' })
    }

    return reply.status(201).send({
      email: mailAddress,
      username: cleanUsername,
      domain: domainName,
      imap: `mail.${domainName}`,
      smtp: `mail.${domainName}`,
    })
  })

  // List users on custom domain
  app.get<{ Params: { id: string } }>('/mail/domains/:id/users', {
    preHandler: (await import('../middleware/planGate')).requirePlan('custom_domains'),
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    // Verify domain ownership
    const { rows: domainRows } = await app.pg.query(
      'SELECT domain FROM mail_domains WHERE id = $1 AND tenant_id = $2',
      [req.params.id, tenantId],
    )
    if (!domainRows.length) return reply.status(404).send({ error: 'domain not found' })

    const domainName = domainRows[0].domain

    // Fetch all individual principals from Stalwart and filter by domain
    const { status, data } = await stalwartRequest('GET', '/api/principal?type=individual')

    if (status >= 400) {
      app.log.error({ status, data }, 'stalwart list users failed')
      return reply.status(502).send({ error: 'mail service unavailable' })
    }

    // data may be an array of principal names or objects depending on Stalwart version
    const principals: string[] = Array.isArray(data) ? data : (data.items ?? [])

    // Fetch each principal's details and filter by domain email
    const domainUsers: Array<{ name: string; email: string; description?: string }> = []

    for (const principalName of principals) {
      const { status: s, data: principal } = await stalwartRequest(
        'GET',
        `/api/principal/${encodeURIComponent(principalName)}`,
      )
      if (s !== 200) continue

      const emails: string[] = principal.emails ?? []
      const matchesOurDomain = emails.some((e: string) => e.endsWith(`@${domainName}`))
      if (matchesOurDomain) {
        domainUsers.push({
          name: principal.name,
          email: emails.find((e: string) => e.endsWith(`@${domainName}`)) ?? emails[0],
          description: principal.description,
        })
      }
    }

    return domainUsers
  })
}
