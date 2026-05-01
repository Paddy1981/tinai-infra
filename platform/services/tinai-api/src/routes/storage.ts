import { FastifyInstance } from 'fastify'

const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/
const DB_NAME_RE     = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

interface CreateBucketBody {
  name: string
  region?: string
  quota_gb?: number
}

interface CreateDatabaseBody {
  name: string
  pg_version?: string
  storage_gb?: number
}

/**
 * Ensure the storage tables exist with the correct schema.
 *
 * The legacy 002_feature_tables.sql migration created storage_buckets with
 * columns (app_name, bucket_name, public, size_limit_mb) which don't match
 * the tenant-based schema we need. If the old schema is detected we drop
 * and recreate the table so that routes don't 500 on missing columns.
 */
async function ensureStorageTables(app: FastifyInstance): Promise<void> {
  try {
    // --- storage_buckets ---------------------------------------------------
    // Check if the table exists and has the WRONG schema (legacy 002 migration)
    const { rows: bucketCols } = await app.pg.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'storage_buckets' AND table_schema = 'public'`,
    )
    const colNames = bucketCols.map((r: any) => r.column_name as string)

    if (colNames.length > 0 && !colNames.includes('tenant_id')) {
      // Legacy schema detected — drop and recreate
      app.log.info('storage: dropping legacy storage_buckets table (missing tenant_id)')
      await app.pg.query(`DROP TABLE IF EXISTS storage_buckets CASCADE`)
    }

    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS storage_buckets (
        id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    VARCHAR(63)  NOT NULL,
        name         VARCHAR(63)  NOT NULL,
        region       VARCHAR(10)  NOT NULL DEFAULT 'in',
        quota_gb     INTEGER      NOT NULL DEFAULT 10,
        used_bytes   BIGINT       NOT NULL DEFAULT 0,
        status       VARCHAR(20)  NOT NULL DEFAULT 'provisioning',
        access_key   TEXT,
        endpoint_url TEXT,
        created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_storage_buckets_tenant ON storage_buckets (tenant_id)`)

    // --- storage_databases -------------------------------------------------
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS storage_databases (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         VARCHAR(63)  NOT NULL,
        name              VARCHAR(63)  NOT NULL,
        pg_version        VARCHAR(5)   NOT NULL DEFAULT '16',
        storage_gb        INTEGER      NOT NULL DEFAULT 10,
        status            VARCHAR(20)  NOT NULL DEFAULT 'provisioning',
        connection_string TEXT,
        host              TEXT,
        port              INTEGER,
        db_user           TEXT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_storage_databases_tenant ON storage_databases (tenant_id)`)
  } catch (err: any) {
    app.log.warn({ msg: 'storage: ensureStorageTables DDL failed', err: err.message })
  }
}

export async function storageRoutes(app: FastifyInstance) {

  // Run table creation on plugin registration
  await ensureStorageTables(app)

  // ---------------------------------------------------------------------------
  // GET /storage/buckets — list tenant's buckets (exclude deleted)
  // ---------------------------------------------------------------------------
  app.get('/storage/buckets', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, name, region, quota_gb, used_bytes, status, access_key, endpoint_url, created_at
         FROM storage_buckets
         WHERE tenant_id = $1 AND status != 'deleted'
         ORDER BY created_at DESC`,
        [tenantId],
      )
      return rows
    } catch (err: any) {
      app.log.error({ msg: 'storage/buckets GET failed', err: err.message, tenantId })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /storage/buckets — create a new bucket
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateBucketBody }>(
    '/storage/buckets',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:     { type: 'string' },
            region:   { type: 'string', enum: ['in', 'qa', 'ae'] },
            quota_gb: { type: 'integer', minimum: 1, maximum: 10000 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })

      const { name, region = 'in', quota_gb = 10 } = req.body

      if (!BUCKET_NAME_RE.test(name)) {
        return reply.status(400).send({
          error: 'name must be 3–63 characters, lowercase alphanumeric and hyphens only, cannot start or end with a hyphen',
        })
      }

      try {
        // Check name uniqueness for this tenant
        const { rows: existing } = await app.pg.query(
          `SELECT id FROM storage_buckets WHERE tenant_id = $1 AND name = $2`,
          [tenantId, name],
        )
        if (existing.length) {
          return reply.status(409).send({ error: `bucket '${name}' already exists for this tenant` })
        }

        const { rows: [bucket] } = await app.pg.query(
          `INSERT INTO storage_buckets (tenant_id, name, region, quota_gb, status)
           VALUES ($1, $2, $3, $4, 'provisioning')
           RETURNING id, tenant_id, name, region, quota_gb, used_bytes, status, created_at`,
          [tenantId, name, region, quota_gb],
        )

        return reply.status(201).send(bucket)
      } catch (err: any) {
        app.log.error({ msg: 'storage/buckets POST failed', err: err.message, tenantId })
        return reply.status(500).send({ error: 'database error', detail: err.message })
      }
    },
  )

  // ---------------------------------------------------------------------------
  // GET /storage/buckets/:id — get single bucket (ownership check)
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/storage/buckets/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })
    const { id } = req.params

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, name, region, quota_gb, used_bytes, status, access_key, endpoint_url, created_at
         FROM storage_buckets
         WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'bucket not found' })

      const bucket = rows[0]
      if (bucket.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      return bucket
    } catch (err: any) {
      app.log.error({ msg: 'storage/buckets/:id GET failed', err: err.message })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /storage/buckets/:id — set status=deleting (ownership check)
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/storage/buckets/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })
    const { id } = req.params

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, status FROM storage_buckets WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'bucket not found' })

      const bucket = rows[0]
      if (bucket.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      if (bucket.status === 'deleting') {
        return reply.status(409).send({ error: 'bucket is already being deleted' })
      }
      if (bucket.status === 'deleted') {
        return reply.status(409).send({ error: 'bucket is already deleted' })
      }

      // Transition to deleting — provisioner will remove the MinIO bucket and set status=deleted
      await app.pg.query(
        `UPDATE storage_buckets SET status = 'deleting' WHERE id = $1`,
        [id],
      )

      return reply.status(200).send({ ok: true, id, status: 'deleting' })
    } catch (err: any) {
      app.log.error({ msg: 'storage/buckets/:id DELETE failed', err: err.message })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /storage/databases — list tenant's databases (exclude stopped/deleted)
  // ---------------------------------------------------------------------------
  app.get('/storage/databases', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, name, pg_version, storage_gb, status, connection_string, host, port, db_user, created_at
         FROM storage_databases
         WHERE tenant_id = $1 AND status NOT IN ('stopped', 'deleted')
         ORDER BY created_at DESC`,
        [tenantId],
      )
      return rows
    } catch (err: any) {
      app.log.error({ msg: 'storage/databases GET failed', err: err.message, tenantId })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  // POST /storage/databases — create a new managed Postgres database
  // ---------------------------------------------------------------------------
  app.post<{ Body: CreateDatabaseBody }>(
    '/storage/databases',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:       { type: 'string' },
            pg_version: { type: 'string', enum: ['14', '15', '16'] },
            storage_gb: { type: 'integer', minimum: 1, maximum: 10000 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })

      const { name, pg_version = '16', storage_gb = 10 } = req.body

      if (!DB_NAME_RE.test(name)) {
        return reply.status(400).send({
          error: 'name must be 3–63 characters, lowercase alphanumeric and hyphens only, cannot start or end with a hyphen',
        })
      }

      try {
        // Check name uniqueness for this tenant
        const { rows: existing } = await app.pg.query(
          `SELECT id FROM storage_databases WHERE tenant_id = $1 AND name = $2`,
          [tenantId, name],
        )
        if (existing.length) {
          return reply.status(409).send({ error: `database '${name}' already exists for this tenant` })
        }

        const { rows: [database] } = await app.pg.query(
          `INSERT INTO storage_databases (tenant_id, name, pg_version, storage_gb, status)
           VALUES ($1, $2, $3, $4, 'provisioning')
           RETURNING id, tenant_id, name, pg_version, storage_gb, status, created_at`,
          [tenantId, name, pg_version, storage_gb],
        )

        return reply.status(201).send(database)
      } catch (err: any) {
        app.log.error({ msg: 'storage/databases POST failed', err: err.message, tenantId })
        return reply.status(500).send({ error: 'database error', detail: err.message })
      }
    },
  )

  // ---------------------------------------------------------------------------
  // GET /storage/databases/:id — get single database (ownership check)
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/storage/databases/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })
    const { id } = req.params

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, name, pg_version, storage_gb, status, connection_string, host, port, db_user, created_at
         FROM storage_databases
         WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'database not found' })

      const database = rows[0]
      if (database.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      return database
    } catch (err: any) {
      app.log.error({ msg: 'storage/databases/:id GET failed', err: err.message })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /storage/databases/:id — set status=stopping (ownership check)
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/storage/databases/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    if (!tenantId) return reply.status(401).send({ error: 'missing tenant context' })
    const { id } = req.params

    try {
      const { rows } = await app.pg.query(
        `SELECT id, tenant_id, status FROM storage_databases WHERE id = $1`,
        [id],
      )

      if (!rows.length) return reply.status(404).send({ error: 'database not found' })

      const database = rows[0]
      if (database.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      if (database.status === 'stopping') {
        return reply.status(409).send({ error: 'database is already stopping' })
      }
      if (database.status === 'stopped') {
        return reply.status(409).send({ error: 'database is already stopped' })
      }

      // Transition to stopping — provisioner will shut down the CloudNativePG cluster and set status=stopped
      await app.pg.query(
        `UPDATE storage_databases SET status = 'stopping' WHERE id = $1`,
        [id],
      )

      return reply.status(200).send({ ok: true, id, status: 'stopping' })
    } catch (err: any) {
      app.log.error({ msg: 'storage/databases/:id DELETE failed', err: err.message })
      return reply.status(500).send({ error: 'database error', detail: err.message })
    }
  })
}
