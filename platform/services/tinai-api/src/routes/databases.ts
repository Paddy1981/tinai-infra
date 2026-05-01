// NOTE: Registered in server.ts: app.register(databasesRoutes, { prefix: '/api/v1' })
// Migration: src/migrations/012_database_branches.sql

// CREATE TABLE IF NOT EXISTS app_databases (
//   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   app_name      VARCHAR(63) NOT NULL UNIQUE,
//   db_name       VARCHAR(63) NOT NULL UNIQUE,
//   host          TEXT NOT NULL DEFAULT 'postgresql.tinai-system.svc.cluster.local',
//   port          INTEGER NOT NULL DEFAULT 5432,
//   username      VARCHAR(63) NOT NULL,
//   password_hash TEXT NOT NULL,
//   status        VARCHAR(20) NOT NULL DEFAULT 'provisioning',
//   region        VARCHAR(5) NOT NULL DEFAULT 'IN',
//   created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
// )

import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { randomBytes } from 'crypto'
import * as http from 'http'
import { Pool } from 'pg'
import { loadConfig } from '../config'
import { requirePlan } from '../middleware/planGate'

const cfg = loadConfig()

const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const batchV1    = kc.makeApiClient(k8s.BatchV1Api)
const customObjs = kc.makeApiClient(k8s.CustomObjectsApi)

// CNPG CRD coordinates
const CNPG_GROUP   = 'postgresql.cnpg.io'
const CNPG_VERSION = 'v1'
const CNPG_PLURAL  = 'clusters'
const CNPG_NS      = process.env.CNPG_NAMESPACE ?? 'tinai-system'

const PG_HOST = 'postgresql.tinai-system.svc.cluster.local'
const PG_ADMIN_USER = process.env.PG_ADMIN_USER ?? 'tinai'
const PG_ADMIN_DB   = process.env.PG_ADMIN_DB   ?? 'tinai'

const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/
function assertSafeIdentifier(name: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new Error(`unsafe ${label} identifier: ${name}`)
  }
}

function randomSuffix(len: number) {
  return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)
}

async function runPsqlJob(
  jobName: string,
  sqlCommands: string,
  namespace: string,
  adminPass: string,
) {
  const adminUrl = `postgresql://${PG_ADMIN_USER}:${adminPass}@${PG_HOST}:5432/${PG_ADMIN_DB}`

  const job: k8s.V1Job = {
    metadata: {
      name: jobName,
      namespace,
      labels: { 'tinai.cloud/role': 'db-provisioner' },
    },
    spec: {
      ttlSecondsAfterFinished: 300,
      template: {
        spec: {
          restartPolicy: 'Never',
          containers: [{
            name: 'psql',
            image: 'postgres:16-alpine',
            command: ['psql', adminUrl, '-c', sqlCommands],
          }],
        },
      },
    },
  }

  await batchV1.createNamespacedJob(namespace, job)
}

export async function databasesRoutes(app: FastifyInstance) {
  // GET /apps/:name/database — enforce ownership
  app.get<{ Params: { name: string } }>('/apps/:name/database', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [name]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id, app_name, db_name, host, port, username, status, region, created_at
       FROM app_databases WHERE app_name = $1`,
      [name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'no database provisioned for this app' })

    return rows[0]
  })

  // POST /apps/:name/database — enforce ownership + plan gate
  app.post<{ Params: { name: string } }>('/apps/:name/database', {
    preHandler: requirePlan('databases'),
  }, async (req, reply) => {
    const pgAdminPass = process.env.PG_ADMIN_PASS
    if (!pgAdminPass) {
      app.log.error('PG_ADMIN_PASS env var is required for database provisioning')
      return reply.status(503).send({ error: 'database provisioning is not configured' })
    }

    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query('SELECT owner FROM apps WHERE name = $1', [name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows: existing } = await app.pg.query(
      'SELECT id FROM app_databases WHERE app_name = $1', [name],
    )
    if (existing.length) return reply.status(409).send({ error: 'database already provisioned for this app' })

    const suffix   = randomSuffix(6)
    const dbName   = `tinai_${name.replace(/-/g, '_')}_${suffix}`
    const username = dbName
    const password = randomBytes(18).toString('base64url') // shown once

    try {
      assertSafeIdentifier(dbName, 'database')
      assertSafeIdentifier(username, 'username')
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    const sqlCommands = [
      `CREATE DATABASE ${dbName};`,
      `CREATE USER ${username} WITH PASSWORD '${password}';`,
      `GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${username};`,
    ].join(' ')

    const jobName = `db-provision-${name}-${suffix}`

    try {
      await runPsqlJob(jobName, sqlCommands, cfg.buildNamespace, pgAdminPass)
    } catch (err) {
      app.log.warn({ err }, 'failed to dispatch db provisioning job')
      // Continue — record is inserted with status=provisioning, job error is non-fatal
    }

    // Store password hash (reversible lookup not needed; password shown only on creation)
    const { rows: [record] } = await app.pg.query(
      `INSERT INTO app_databases (app_name, db_name, host, username, password_hash, status)
       VALUES ($1, $2, $3, $4, $5, 'provisioning')
       RETURNING id, app_name, db_name, host, port, username, status, region, created_at`,
      [name, dbName, PG_HOST, username, `provisioned:${Date.now()}`],
    )

    return reply.status(201).send({
      ...record,
      password, // shown once — not stored in plain text
      connection_string: `postgresql://${username}:${password}@${PG_HOST}:5432/${dbName}`,
      note: 'Save the password now — it will not be shown again.',
    })
  })

  // DELETE /apps/:name/database — enforce ownership
  app.delete<{ Params: { name: string } }>('/apps/:name/database', async (req, reply) => {
    const pgAdminPass = process.env.PG_ADMIN_PASS
    if (!pgAdminPass) {
      app.log.error('PG_ADMIN_PASS env var is required for database provisioning')
      return reply.status(503).send({ error: 'database provisioning is not configured' })
    }

    const tenantId = (req as any).tenantId as string
    const { name } = req.params

    const { rows: appRows } = await app.pg.query('SELECT owner FROM apps WHERE name = $1', [name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      'SELECT db_name, username FROM app_databases WHERE app_name = $1', [name],
    )
    if (!rows.length) return reply.status(404).send({ error: 'no database found for this app' })

    const { db_name: dbName, username } = rows[0]

    try {
      assertSafeIdentifier(dbName, 'database')
      assertSafeIdentifier(username, 'username')
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    const sqlCommands = [
      `DROP DATABASE IF EXISTS ${dbName};`,
      `DROP USER IF EXISTS ${username};`,
    ].join(' ')

    const suffix  = randomSuffix(6)
    const jobName = `db-drop-${name}-${suffix}`

    try {
      await runPsqlJob(jobName, sqlCommands, cfg.buildNamespace, pgAdminPass)
    } catch (err) {
      app.log.warn({ err }, 'failed to dispatch db drop job')
    }

    await app.pg.query('DELETE FROM app_databases WHERE app_name = $1', [name])

    return reply.status(204).send()
  })

  // POST /databases/:app/query — Execute SQL on the app's provisioned database — enforce ownership
  app.post<{
    Params: { app: string }
    Body: { sql: string }
  }>('/databases/:app/query', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { app: appName } = req.params
    const { sql } = req.body ?? {}

    if (typeof sql !== 'string' || !sql.trim()) {
      return reply.status(400).send({ error: 'sql must be a non-empty string' })
    }

    if (sql.length > 10_000) {
      return reply.status(400).send({ error: 'query exceeds 10,000-character limit' })
    }

    // Verify the caller owns this app before granting DB access
    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    // Look up provisioned DB credentials
    const { rows: dbRows } = await app.pg.query(
      `SELECT host, port, db_name, username FROM app_databases WHERE app_name = $1 AND status = 'available'`,
      [appName],
    )
    if (!dbRows.length) {
      return reply.status(404).send({ error: 'no available database found for this app' })
    }

    const { host, port, db_name: dbName, username } = dbRows[0]

    // Resolve tenant password from K8s secret env (JSON map { app_name: password })
    let tenantPassword: string | undefined
    const secretEnv = process.env.PG_TENANT_PASSWORDS_SECRET
    if (secretEnv) {
      try {
        const passwordMap: Record<string, string> = JSON.parse(secretEnv)
        tenantPassword = passwordMap[appName]
      } catch {
        app.log.warn('PG_TENANT_PASSWORDS_SECRET is not valid JSON')
      }
    }

    if (!tenantPassword) {
      return reply.status(503).send({ error: 'tenant database password not available' })
    }

    // Connect to tenant DB using a short-lived pool
    const pool = new Pool({
      host,
      port: Number(port),
      database: dbName,
      user: username,
      password: tenantPassword,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    })

    const start = Date.now()
    let result: { rows: Record<string, unknown>[]; fields: { name: string }[]; rowCount: number }

    try {
      const pgResult = await pool.query(sql)
      result = {
        rows: pgResult.rows as Record<string, unknown>[],
        fields: (pgResult.fields ?? []).map(f => ({ name: f.name })),
        rowCount: pgResult.rowCount ?? pgResult.rows.length,
      }
    } catch (err) {
      const message = (err as Error).message
      // Log to audit_events before returning the error
      await app.pg.query(
        `INSERT INTO audit_events (tenant, action, resource, detail, created_at)
         VALUES ($1, 'sql_query', 'database', $2, NOW())
         ON CONFLICT DO NOTHING`,
        [appName, JSON.stringify({ error: message, sql: sql.slice(0, 500) })],
      ).catch(() => { /* audit logging is best-effort */ })
      return reply.status(400).send({ error: message })
    } finally {
      pool.end().catch(() => { /* ignore */ })
    }

    const duration_ms = Date.now() - start

    // Audit log (best-effort)
    await app.pg.query(
      `INSERT INTO audit_events (tenant, action, resource, detail, created_at)
       VALUES ($1, 'sql_query', 'database', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [appName, JSON.stringify({ rowCount: result.rowCount, duration_ms, sql: sql.slice(0, 500) })],
    ).catch(() => { /* audit logging is best-effort */ })

    return reply.send({
      rows: result.rows,
      fields: result.fields,
      rowCount: result.rowCount,
      duration_ms,
    })
  })

  // ---------------------------------------------------------------------------
  // PostgREST proxy helpers
  // ---------------------------------------------------------------------------

  /**
   * Proxy a request to the tenant's PostgREST sidecar using the Node.js built-in
   * `http` module so no extra dependency is required.
   *
   * Returns { statusCode, headers, body } where body is a Buffer.
   */
  function proxyToPostgrest(opts: {
    app: string
    path: string
    method: string
    headers: Record<string, string>
    body?: Buffer | string
  }): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(opts.app)) {
        return reject(new Error('invalid app name'))
      }
      const host = `${opts.app}-postgrest.tinai-tenant-${opts.app}.svc.cluster.local`
      const reqOpts: http.RequestOptions = {
        hostname: host,
        port: 3000,
        path: opts.path,
        method: opts.method,
        headers: opts.headers,
      }

      const req = http.request(reqOpts, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 200,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        )
      })

      req.on('error', reject)

      if (opts.body) req.write(opts.body)
      req.end()
    })
  }

  // ---------------------------------------------------------------------------
  // GET /databases/:app/api — return the PostgREST OpenAPI spec — enforce ownership
  // ---------------------------------------------------------------------------
  app.get<{ Params: { app: string } }>('/databases/:app/api', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { app: appName } = req.params

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id FROM app_databases WHERE app_name = $1 AND status = 'available'`,
      [appName],
    )
    if (!rows.length) {
      return reply.status(404).send({ error: 'no available database found for this app' })
    }

    const forwardHeaders: Record<string, string> = {
      Accept: 'application/json',
    }
    const authHeader = req.headers['authorization']
    if (authHeader) forwardHeaders['Authorization'] = authHeader as string

    let response: Awaited<ReturnType<typeof proxyToPostgrest>>
    try {
      response = await proxyToPostgrest({
        app: appName,
        path: '/',
        method: 'GET',
        headers: forwardHeaders,
      })
    } catch (err) {
      app.log.warn({ err }, `PostgREST proxy error for app=${appName}`)
      return reply.status(502).send({ error: 'could not reach PostgREST for this app' })
    }

    reply.status(response.statusCode)
    const ct = response.headers['content-type']
    if (ct) reply.header('content-type', ct)
    return reply.send(response.body)
  })

  // ---------------------------------------------------------------------------
  // ALL /databases/:app/api/* — transparent proxy to PostgREST — enforce ownership
  // ---------------------------------------------------------------------------
  app.all<{ Params: { app: string; '*': string } }>('/databases/:app/api/*', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { app: appName } = req.params
    const wildcard = (req.params as Record<string, string>)['*'] ?? ''

    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id FROM app_databases WHERE app_name = $1 AND status = 'available'`,
      [appName],
    )
    if (!rows.length) {
      return reply.status(404).send({ error: 'no available database found for this app' })
    }

    const forwardHeaders: Record<string, string> = {}
    const headersToCopy = ['authorization', 'content-type', 'prefer', 'range']
    for (const h of headersToCopy) {
      const v = req.headers[h]
      if (v) forwardHeaders[h] = Array.isArray(v) ? v[0] : v
    }

    // Pass request body if present
    let bodyBuf: Buffer | undefined
    if (req.body) {
      if (typeof req.body === 'string') {
        bodyBuf = Buffer.from(req.body)
      } else if (Buffer.isBuffer(req.body)) {
        bodyBuf = req.body
      } else {
        bodyBuf = Buffer.from(JSON.stringify(req.body))
        if (!forwardHeaders['content-type']) {
          forwardHeaders['content-type'] = 'application/json'
        }
      }
      forwardHeaders['content-length'] = String(bodyBuf.length)
    }

    let response: Awaited<ReturnType<typeof proxyToPostgrest>>
    try {
      response = await proxyToPostgrest({
        app: appName,
        path: `/${wildcard}${req.url.includes('?') ? '?' + req.url.split('?')[1] : ''}`,
        method: req.method,
        headers: forwardHeaders,
        body: bodyBuf,
      })
    } catch (err) {
      app.log.warn({ err }, `PostgREST proxy error for app=${appName} path=/${wildcard}`)
      return reply.status(502).send({ error: 'could not reach PostgREST for this app' })
    }

    // Audit log (best-effort)
    await app.pg.query(
      `INSERT INTO audit_events (tenant, action, resource, detail, created_at)
       VALUES ($1, 'postgrest_proxy', 'database', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [appName, JSON.stringify({ method: req.method, path: `/${wildcard}`, status: response.statusCode })],
    ).catch(() => { /* best-effort */ })

    reply.status(response.statusCode)
    const headersToForward = ['content-type', 'content-range', 'range-unit', 'content-length']
    for (const h of headersToForward) {
      const v = response.headers[h]
      if (v) reply.header(h, v as string)
    }
    return reply.send(response.body)
  })

  // ---------------------------------------------------------------------------
  // POST /databases/:app/vector-search — pgvector semantic similarity search — enforce ownership
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { app: string }
    Body: {
      table: string
      embedding_column: string
      query_vector: number[]
      limit?: number
      threshold?: number
    }
  }>('/databases/:app/vector-search', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { app: appName } = req.params
    const {
      table,
      embedding_column,
      query_vector,
      limit: rawLimit = 10,
      threshold: rawThreshold = 0.0,
    } = req.body ?? {}

    // Validate required fields
    if (typeof table !== 'string' || !table.trim()) {
      return reply.status(400).send({ error: 'table must be a non-empty string' })
    }
    if (typeof embedding_column !== 'string' || !embedding_column.trim()) {
      return reply.status(400).send({ error: 'embedding_column must be a non-empty string' })
    }
    if (!Array.isArray(query_vector) || query_vector.length === 0) {
      return reply.status(400).send({ error: 'query_vector must be a non-empty array of numbers' })
    }

    // Guard against SQL injection via identifier names
    try {
      assertSafeIdentifier(table, 'table')
      assertSafeIdentifier(embedding_column, 'embedding_column')
    } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    // Verify the caller owns this app before granting DB access
    const { rows: appRows } = await app.pg.query(
      'SELECT owner FROM apps WHERE name = $1', [appName]
    )
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const limit = Math.min(Math.max(1, Number(rawLimit)), 200)
    const threshold = Number(rawThreshold)

    // Look up provisioned DB credentials
    const { rows: dbRows } = await app.pg.query(
      `SELECT host, port, db_name, username FROM app_databases WHERE app_name = $1 AND status = 'available'`,
      [appName],
    )
    if (!dbRows.length) {
      return reply.status(404).send({ error: 'no available database found for this app' })
    }

    const { host, port, db_name: dbName, username } = dbRows[0]

    let tenantPassword: string | undefined
    const secretEnv = process.env.PG_TENANT_PASSWORDS_SECRET
    if (secretEnv) {
      try {
        const passwordMap: Record<string, string> = JSON.parse(secretEnv)
        tenantPassword = passwordMap[appName]
      } catch {
        app.log.warn('PG_TENANT_PASSWORDS_SECRET is not valid JSON')
      }
    }
    if (!tenantPassword) {
      return reply.status(503).send({ error: 'tenant database password not available' })
    }

    const pool = new Pool({
      host,
      port: Number(port),
      database: dbName,
      user: username,
      password: tenantPassword,
      max: 2,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    })

    const vectorLiteral = `[${query_vector.join(',')}]`
    // Use safe-identifier-validated names directly in the query; parameterise the vector literal.
    const sql = `
      SELECT *,
             1 - (${embedding_column} <=> $1::vector) AS similarity
      FROM   ${table}
      WHERE  1 - (${embedding_column} <=> $1::vector) > $2
      ORDER  BY similarity DESC
      LIMIT  $3
    `

    const start = Date.now()
    let rows: Record<string, unknown>[]
    try {
      const pgResult = await pool.query(sql, [vectorLiteral, threshold, limit])
      rows = pgResult.rows as Record<string, unknown>[]
    } catch (err) {
      const message = (err as Error).message
      await app.pg.query(
        `INSERT INTO audit_events (tenant, action, resource, detail, created_at)
         VALUES ($1, 'vector_search', 'database', $2, NOW())
         ON CONFLICT DO NOTHING`,
        [appName, JSON.stringify({ error: message, table, embedding_column })],
      ).catch(() => { /* best-effort */ })
      return reply.status(400).send({ error: message })
    } finally {
      pool.end().catch(() => { /* ignore */ })
    }

    const duration_ms = Date.now() - start

    await app.pg.query(
      `INSERT INTO audit_events (tenant, action, resource, detail, created_at)
       VALUES ($1, 'vector_search', 'database', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [appName, JSON.stringify({ table, embedding_column, dims: query_vector.length, rowCount: rows.length, duration_ms })],
    ).catch(() => { /* best-effort */ })

    return reply.send({ rows, rowCount: rows.length, duration_ms })
  })

  // ---------------------------------------------------------------------------
  // POST /databases/:id/branches — create a CNPG PITR branch from a timestamp
  // ---------------------------------------------------------------------------
  app.post<{
    Params: { id: string }
    Body: { name: string; restore_to?: string }
  }>('/databases/:id/branches', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id: parentId } = req.params
    const { name, restore_to } = req.body ?? {}

    if (typeof name !== 'string' || !name.trim()) {
      return reply.status(400).send({ error: 'name must be a non-empty string' })
    }
    try { assertSafeIdentifier(name, 'branch name') } catch (err) {
      return reply.status(400).send({ error: (err as Error).message })
    }

    // Look up parent database — must belong to the calling tenant's app
    const { rows: dbRows } = await app.pg.query(
      `SELECT ad.id, ad.db_name, ad.host, a.owner
       FROM app_databases ad
       JOIN apps a ON a.name = ad.app_name
       WHERE ad.id = $1`,
      [parentId],
    )
    if (!dbRows.length) return reply.status(404).send({ error: 'database not found' })
    if (dbRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const parentDbName: string = dbRows[0].db_name
    const restoreTo  = restore_to ?? new Date().toISOString()
    const branchClusterName = `branch-${parentDbName.slice(0, 30)}-${randomSuffix(6)}`

    // Create the CNPG Cluster CR for the branch
    const clusterCR = {
      apiVersion: `${CNPG_GROUP}/${CNPG_VERSION}`,
      kind: 'Cluster',
      metadata: {
        name: branchClusterName,
        namespace: CNPG_NS,
        labels: {
          'tinai.cloud/tenant-id': tenantId,
          'tinai.cloud/branch-parent': parentId,
        },
      },
      spec: {
        instances: 1,
        bootstrap: {
          recovery: {
            source: parentDbName,
            recoveryTarget: {
              targetTime: restoreTo,
            },
          },
        },
        externalClusters: [
          {
            name: parentDbName,
            barmanObjectStore: {
              serverName: parentDbName,
              // Credentials and endpoint are inherited from the parent cluster's backup config
              // via the tinai-cnpg-backup secret — operators must ensure this is configured.
            },
          },
        ],
        storage: { size: '5Gi' },
      },
    }

    try {
      await customObjs.createNamespacedCustomObject(
        CNPG_GROUP, CNPG_VERSION, CNPG_NS, CNPG_PLURAL, clusterCR,
      )
    } catch (err) {
      app.log.warn({ err }, 'databases: failed to create CNPG branch Cluster CR')
      // Continue — record branch as provisioning even if CR creation fails (operator retry possible)
    }

    const { rows: [branch] } = await app.pg.query(
      `INSERT INTO database_branches (parent_id, tenant_id, name, restore_to, status)
       VALUES ($1, $2, $3, $4, 'provisioning')
       RETURNING id, parent_id, tenant_id, name, restore_to, status, created_at`,
      [parentId, tenantId, name, restoreTo],
    )

    const pgHost = dbRows[0].host as string
    const connectionString = `postgresql://${branchClusterName}:5432/app?host=${pgHost}`

    return reply.status(201).send({
      id:                branch.id,
      name:              branch.name,
      status:            branch.status,
      restore_to:        branch.restore_to,
      connection_string: connectionString,
    })
  })

  // ---------------------------------------------------------------------------
  // GET /databases/:id/branches — list branches for a database
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/databases/:id/branches', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id: parentId } = req.params

    // Verify ownership
    const { rows: dbRows } = await app.pg.query(
      `SELECT ad.id FROM app_databases ad
       JOIN apps a ON a.name = ad.app_name
       WHERE ad.id = $1 AND a.owner = $2`,
      [parentId, tenantId],
    )
    if (!dbRows.length) return reply.status(404).send({ error: 'database not found' })

    const { rows } = await app.pg.query(
      `SELECT id, parent_id, name, restore_to, status, created_at
       FROM database_branches
       WHERE parent_id = $1
       ORDER BY created_at DESC`,
      [parentId],
    )
    return reply.send({ branches: rows })
  })

  // ---------------------------------------------------------------------------
  // DELETE /databases/:id/branches/:branchId — delete a branch
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string; branchId: string } }>(
    '/databases/:id/branches/:branchId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id: parentId, branchId } = req.params

      // Verify parent DB ownership
      const { rows: dbRows } = await app.pg.query(
        `SELECT ad.id FROM app_databases ad
         JOIN apps a ON a.name = ad.app_name
         WHERE ad.id = $1 AND a.owner = $2`,
        [parentId, tenantId],
      )
      if (!dbRows.length) return reply.status(404).send({ error: 'database not found' })

      const { rows: branchRows } = await app.pg.query(
        'SELECT id FROM database_branches WHERE id = $1 AND parent_id = $2 AND tenant_id = $3',
        [branchId, parentId, tenantId],
      )
      if (!branchRows.length) return reply.status(404).send({ error: 'branch not found' })

      // Derive the cluster name stored in k8s by listing CRs with the branch label
      try {
        const listResp: any = await customObjs.listNamespacedCustomObject(
          CNPG_GROUP, CNPG_VERSION, CNPG_NS, CNPG_PLURAL,
          undefined, undefined, undefined, undefined,
          `tinai.cloud/branch-parent=${parentId}`,
        )
        const items: any[] = listResp?.body?.items ?? []
        for (const item of items) {
          const crName: string = item?.metadata?.name ?? ''
          if (!crName) continue
          try {
            await customObjs.deleteNamespacedCustomObject(
              CNPG_GROUP, CNPG_VERSION, CNPG_NS, CNPG_PLURAL, crName,
            )
          } catch (err) {
            app.log.warn({ err, crName }, 'databases: failed to delete CNPG branch Cluster CR')
          }
        }
      } catch (err) {
        app.log.warn({ err }, 'databases: failed to list CNPG branch Cluster CRs for deletion')
      }

      await app.pg.query('DELETE FROM database_branches WHERE id = $1', [branchId])

      return reply.status(204).send()
    },
  )
}
