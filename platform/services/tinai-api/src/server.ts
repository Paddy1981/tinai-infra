import Fastify from 'fastify'
import postgres from '@fastify/postgres'
import rateLimit from '@fastify/rate-limit'
import { createHmac, timingSafeEqual } from 'crypto'
import { loadConfig } from './config'
import { healthRoutes } from './routes/health'
import { appsRoutes } from './routes/apps'
import { billingRoutes } from './routes/billing'
import { complianceRoutes } from './routes/compliance'
import { spaceRoutes } from './routes/space'
import { aiRoutes } from './routes/ai'
import { consentRoutes } from './routes/consent'
import { ropaRoutes } from './routes/ropa'
import { breachRoutes } from './routes/breach'
import { erasureRoutes } from './routes/erasure'
import { dpaRoutes } from './routes/dpa'
import { privacyNoticeRoutes } from './routes/privacyNotice'
import { authRoutes } from './routes/auth'
import { metricsRoutes } from './routes/metrics'
import { customDomainsRoutes } from './routes/customDomains'
import { databasesRoutes } from './routes/databases'
import { volumesRoutes } from './routes/volumes'
import { templatesRoutes } from './routes/templates'
import { storageRoutes } from './routes/storage'
import { settingsRoutes } from './routes/settings'
import { codegenRoutes } from './routes/codegen'
import { instancesRoutes } from './routes/instances'
import { inferenceRoutes } from './routes/inference'
import { gatewayRoutes } from './routes/gateway'
import { workloadsRoutes } from './routes/workloads'
import { plansRoutes } from './routes/plans'
import { projectsRoutes } from './routes/projects'
import { adminRoutes } from './routes/admin'
import { envVarsRoutes } from './routes/envVars'
import { teamsRoutes } from './routes/teams'
import { auditLogRoutes } from './routes/auditLog'
import { webhooksRoutes } from './routes/webhooks'
import { usageAnalyticsRoutes } from './routes/usageAnalytics'
import { featureFlagsRoutes } from './routes/featureFlags'
import { firewallRoutes } from './routes/firewall'
import { cronJobsRoutes } from './routes/cronJobs'
import { observabilityRoutes } from './routes/observability'
import { gitRoutes } from './routes/git'
import { provisionerRoutes } from './routes/provisioner'
import { forgeRoutes } from './routes/forge'
import { mailRoutes } from './routes/mail'
import { registerUsageMeteringJob } from './jobs/usageMetering'

const cfg = loadConfig()

const app = Fastify({ logger: { level: 'info' } })

// ---------------------------------------------------------------------------
// CORS — allow dashboard and app origins to call this API
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://tinai.cloud',
  'https://app.tinai.cloud',
  'https://api.tinai.cloud',
  'http://localhost:3000',
  'http://localhost:3001',
])

app.addHook('onRequest', async (request, reply) => {
  const origin = request.headers.origin ?? ''
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : 'https://tinai.cloud'
  reply.header('Access-Control-Allow-Origin', allow)
  reply.header('Access-Control-Allow-Credentials', 'true')
  reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  reply.header('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  if (request.method === 'OPTIONS') {
    return reply.status(204).send()
  }
})

const PUBLIC_ROUTES = new Set([
  '/healthz',
  '/api/v1/auth/register',
  '/api/v1/auth/login',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/verify-magic-link',
  '/api/v1/auth/sms-otp',
  '/api/v1/auth/verify-sms',
  '/api/v1/auth/resend-sms',
  '/api/v1/billing/webhooks/razorpay',
  '/api/v1/compliance/privacy-notice',
  '/api/v1/templates',
  // Internal callbacks from tinai-forge — authenticated by X-Forge-API-Key, not JWT
  '/api/v1/forge/callbacks/build-complete',
  '/api/v1/forge/callbacks/rollout-complete',
])

// ---------------------------------------------------------------------------
// Redis-backed rate limiter for auth endpoints
// Uses ioredis when REDIS_URL is set (required for multi-replica correctness);
// falls back to in-memory store for local development.
// ---------------------------------------------------------------------------
const AUTH_RATE_LIMIT_MAX    = 5   // requests per window
const AUTH_RATE_LIMIT_WINDOW = 60  // seconds

const AUTH_RATE_LIMITED_ROUTES = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/register',
  '/api/v1/auth/magic-link',
  '/api/v1/auth/verify-magic-link',
  '/api/v1/auth/sms-otp',
  '/api/v1/auth/verify-sms',
  '/api/v1/auth/resend-sms',
])

// Register @fastify/rate-limit globally; routes that are NOT in AUTH_RATE_LIMITED_ROUTES
// opt out via { config: { rateLimit: false } } or we scope with keyGenerator.
// We register with a keyGenerator that only applies limits to auth routes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.register(rateLimit, {
  max: AUTH_RATE_LIMIT_MAX,
  timeWindow: AUTH_RATE_LIMIT_WINDOW * 1000,
  // allowList completely bypasses rate limiting (no counter increment) for non-auth routes
  allowList(request: any, key: string) {
    return key === '__no-limit__'
  },
  ...(process.env.REDIS_URL
    ? (() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Redis = require('ioredis')
        const redisClient = new Redis(process.env.REDIS_URL)
        redisClient.on('error', (err: Error) => app.log.error({ err }, 'rate-limit Redis error'))
        return { redis: redisClient }
      })()
    : {}),
  keyGenerator(request: any) {
    const routePath = request.url.split('?')[0]
    if (!AUTH_RATE_LIMITED_ROUTES.has(routePath)) {
      return '__no-limit__'
    }
    const ip = (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? request.socket.remoteAddress
      ?? 'unknown'
    return `auth-rl:${ip}:${routePath}`
  },
  errorResponseBuilder(_request: any, context: any) {
    return { error: `too many requests, please try again in ${Math.ceil(context.ttl / 1000)}s` }
  },
} as any)

app.addHook('preHandler', async (request, reply) => {
  // CSRF protection: require x-tinai-csrf header for mutating requests
  // This prevents CSRF from standard browsers as custom headers trigger preflight or cannot be sent via <form>.
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(request.method)) {
    // Only check if it's NOT a public route (auth endpoints might handle their own protection or be less sensitive to CSRF)
    if (!PUBLIC_ROUTES.has(request.routerPath ?? request.url.split('?')[0])) {
      if (request.headers['x-tinai-csrf'] !== '1') {
        return reply.status(403).send({ error: 'CSRF protection: missing or invalid x-tinai-csrf header' })
      }
    }
  }

  if (PUBLIC_ROUTES.has(request.routerPath ?? request.url.split('?')[0])) return
  // Deploy webhooks are authenticated by X-Tinai-Token, not JWT
  if (request.method === 'POST' && request.routerPath === '/api/v1/apps/:name/deploy') return
  const auth = request.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'missing or invalid authorization header' })
  }
  const token = auth.slice(7)
  try {
    const [headerB64, payloadB64, sigB64] = token.split('.')
    if (!headerB64 || !payloadB64 || !sigB64) throw new Error('malformed')
    const jwtSecret = cfg.jwtSecret ?? process.env.JWT_SECRET ?? ''
    if (!jwtSecret) throw new Error('JWT_SECRET not configured')
    const expectedSig = createHmac('sha256', jwtSecret)
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
    ;(request as any).userId = payload.sub
    // payload.tenant_id is the claim set by makeToken() in auth.ts
    ;(request as any).tenantId = payload.tenant_id ?? payload.tenant ?? payload.sub
    // payload.role is set by makeToken() — values: 'tenant' | 'admin'
    ;(request as any).role = payload.role ?? 'tenant'
  } catch (e: any) {
    return reply.status(401).send({ error: `unauthorized: ${e.message}` })
  }
})

app.register(postgres, { connectionString: cfg.databaseUrl })
app.register(healthRoutes)
app.register(appsRoutes, { prefix: '/api/v1' })
app.register(billingRoutes, { prefix: '/api/v1' })
app.register(complianceRoutes, { prefix: '/api/v1' })
// Space vertical — connects to PostGIS at SPACE_DATABASE_URL (separate from main DB)
app.register(spaceRoutes, { prefix: '/api/v1' })
app.register(aiRoutes, { prefix: '/api/v1' })
app.register(consentRoutes, { prefix: '/api/v1' })
app.register(ropaRoutes, { prefix: '/api/v1' })
app.register(breachRoutes, { prefix: '/api/v1' })
app.register(erasureRoutes, { prefix: '/api/v1' })
app.register(dpaRoutes, { prefix: '/api/v1' })
app.register(privacyNoticeRoutes, { prefix: '/api/v1' })
app.register(authRoutes, { prefix: '/api/v1' })
app.register(metricsRoutes, { prefix: '/api/v1' })
app.register(customDomainsRoutes, { prefix: '/api/v1' })
app.register(databasesRoutes, { prefix: '/api/v1' })
app.register(volumesRoutes, { prefix: '/api/v1' })
app.register(templatesRoutes, { prefix: '/api/v1' })
app.register(storageRoutes, { prefix: '/api/v1' })
app.register(gitRoutes, { prefix: '/api/v1' })
app.register(settingsRoutes, { prefix: '/api/v1' })
app.register(codegenRoutes, { prefix: '/api/v1' })
app.register(instancesRoutes, { prefix: '/api/v1' })
app.register(inferenceRoutes, { prefix: '/api/v1' })
app.register(gatewayRoutes, { prefix: '/api/v1' })
app.register(workloadsRoutes, { prefix: '/api/v1' })
app.register(plansRoutes, { prefix: '/api/v1' })
app.register(projectsRoutes, { prefix: '/api/v1' })
app.register(adminRoutes, { prefix: '/api/v1' })
app.register(envVarsRoutes, { prefix: '/api/v1' })
app.register(teamsRoutes, { prefix: '/api/v1' })
app.register(auditLogRoutes, { prefix: '/api/v1' })
app.register(webhooksRoutes, { prefix: '/api/v1' })
app.register(usageAnalyticsRoutes, { prefix: '/api/v1' })
app.register(featureFlagsRoutes, { prefix: '/api/v1' })
app.register(firewallRoutes, { prefix: '/api/v1' })
app.register(cronJobsRoutes, { prefix: '/api/v1' })
app.register(observabilityRoutes, { prefix: '/api/v1' })
app.register(provisionerRoutes, { prefix: '/api/v1' })
// Forge white-label pipeline proxy + callback endpoints
app.register(forgeRoutes, { prefix: '/api/v1' })
// Mail management — Stalwart integration
app.register(mailRoutes, { prefix: '/api/v1' })

/** Wait for PostgreSQL to accept connections before proceeding.
 *  Retries with exponential backoff (1s, 2s, 4s … max 30s) for up to 5 minutes.
 *  This prevents crash-loops when the api pod starts before postgres is ready
 *  (common on k3d/local restarts and during cluster cold-starts). */
async function waitForPostgres(url: string, log: typeof app.log): Promise<void> {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: url, max: 1 })
  const MAX_WAIT_MS = 5 * 60 * 1000
  const start = Date.now()
  let delay = 1000

  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const client = await pool.connect()
      await client.query('SELECT 1')
      client.release()
      await pool.end()
      log.info('postgres ready')
      return
    } catch (err: any) {
      log.warn({ err: err.message, delay_ms: delay }, 'postgres not ready — retrying')
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }

  await pool.end()
  throw new Error(`postgres did not become ready within 5 minutes`)
}

async function start() {
  await waitForPostgres(cfg.databaseUrl, app.log)
  await app.ready()

  // Full compliance schema is in src/migrations/001_compliance_tables.sql
  // Feature tables (custom_domains, app_databases, app_volumes, storage_buckets, users) are in
  // src/migrations/002_feature_tables.sql — run both before first deploy.

  // Best-effort inline migrations — tables may already exist or app user may lack DDL privileges.
  // Run src/migrations/*.sql as superuser for a clean first-deploy.
  const ddl: string[] = [
    `CREATE TABLE IF NOT EXISTS apps (
      id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
      name           VARCHAR(63)  UNIQUE NOT NULL,
      owner          VARCHAR(63)  NOT NULL DEFAULT 'tinai-admin',
      repo_full_name VARCHAR(255) UNIQUE NOT NULL,
      created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS usage_snapshots (
      id           UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      app_name     VARCHAR(63)   NOT NULL,
      namespace    VARCHAR(63)   NOT NULL,
      cpu_cores    NUMERIC(10,6) NOT NULL DEFAULT 0,
      memory_bytes BIGINT        NOT NULL DEFAULT 0,
      snapshot_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_usage_snapshots_app_time ON usage_snapshots (app_name, snapshot_at)`,
    `CREATE TABLE IF NOT EXISTS residency_reports (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant       VARCHAR(63) NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      report       JSONB       NOT NULL,
      hash         TEXT        NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS invoices (
      id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant         VARCHAR(63) NOT NULL DEFAULT 'tinai-admin',
      month          DATE        NOT NULL,
      subtotal_paise BIGINT      NOT NULL DEFAULT 0,
      gst_paise      BIGINT      NOT NULL DEFAULT 0,
      total_paise    BIGINT      NOT NULL DEFAULT 0,
      status         VARCHAR(20) NOT NULL DEFAULT 'draft',
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant, month)
    )`,
    `CREATE TABLE IF NOT EXISTS invoice_line_items (
      id               UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
      invoice_id       UUID          NOT NULL REFERENCES invoices(id),
      description      TEXT          NOT NULL,
      quantity         NUMERIC(12,4) NOT NULL,
      unit_price_paise BIGINT        NOT NULL,
      amount_paise     BIGINT        NOT NULL
    )`,
  ]
  for (const stmt of ddl) {
    try { await app.pg.query(stmt) }
    catch (e: any) { app.log.warn({ msg: 'inline DDL skipped', err: e.message }) }
  }
  // 016 — user profile columns (best-effort: may fail if app user lacks ALTER privilege)
  try {
    await app.pg.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name VARCHAR(120)`)
    await app.pg.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile VARCHAR(20)`)
    await app.pg.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{
          "deploy_success": true,
          "deploy_failure": true,
          "billing_threshold": "1000",
          "compliance_deadline": true
        }'::jsonb
    `)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped 016 migration (run as superuser manually)', err: e.message })
  }

  // cpu_seconds_log (004_active_billing) — needed for /billing/overview
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS cpu_seconds_log (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        app_name         VARCHAR(63) NOT NULL,
        namespace        VARCHAR(63) NOT NULL,
        cpu_seconds      NUMERIC(12,6) NOT NULL DEFAULT 0,
        memory_byte_secs BIGINT NOT NULL DEFAULT 0,
        window_start     TIMESTAMPTZ NOT NULL,
        window_end       TIMESTAMPTZ NOT NULL
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_cpu_seconds_app_time ON cpu_seconds_log (app_name, window_start)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped cpu_seconds_log DDL', err: e.message })
  }

  // api_keys table (005_settings)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id     UUID        NOT NULL,
        name        VARCHAR(63) NOT NULL,
        key_hash    TEXT        NOT NULL UNIQUE,
        key_prefix  VARCHAR(8)  NOT NULL,
        last_used   TIMESTAMPTZ,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys (user_id)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped api_keys DDL (run migration manually)', err: e.message })
  }

  // webhook_secret column on apps (added in this release)
  try {
    await app.pg.query(`ALTER TABLE apps ADD COLUMN IF NOT EXISTS webhook_secret TEXT`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped webhook_secret migration', err: e.message })
  }

  // storage_buckets + storage_databases (002_feature_tables / storage vertical)
  try {
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
  } catch (e: any) {
    app.log.warn({ msg: 'skipped storage DDL', err: e.message })
  }

  // app_volumes (volumes vertical)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS app_volumes (
        id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        app_name      VARCHAR(63) NOT NULL,
        volume_name   VARCHAR(63) NOT NULL UNIQUE,
        mount_path    TEXT        NOT NULL,
        size_gi       INTEGER     NOT NULL DEFAULT 5,
        storage_class VARCHAR(63) NOT NULL DEFAULT 'local-path',
        status        VARCHAR(20) NOT NULL DEFAULT 'pending',
        region        VARCHAR(5)  NOT NULL DEFAULT 'IN',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_app_volumes_app ON app_volumes (app_name)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped app_volumes DDL', err: e.message })
  }

  // custom_domains (customDomains vertical)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS custom_domains (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        app_name    VARCHAR(63) NOT NULL,
        domain      TEXT        NOT NULL UNIQUE,
        verified    BOOLEAN     NOT NULL DEFAULT false,
        cert_status VARCHAR(20) NOT NULL DEFAULT 'pending',
        verify_token TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_custom_domains_app ON custom_domains (app_name)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped custom_domains DDL', err: e.message })
  }

  // projects + environments
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id   VARCHAR(63) NOT NULL,
        name        VARCHAR(63) NOT NULL,
        slug        VARCHAR(63) NOT NULL,
        description TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, slug)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects (tenant_id)`)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS environments (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tenant_id  VARCHAR(63) NOT NULL,
        name       VARCHAR(63) NOT NULL,
        slug       VARCHAR(63) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (project_id, slug)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_environments_project ON environments (project_id)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped projects/environments DDL', err: e.message })
  }

  // plans + tenant_plans (plan gating)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS plans (
        id         TEXT        PRIMARY KEY,
        name       VARCHAR(63) NOT NULL,
        price_inr  INTEGER     NOT NULL DEFAULT 0,
        limits     JSONB       NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS tenant_plans (
        tenant_id       VARCHAR(63) PRIMARY KEY,
        plan_id         TEXT        NOT NULL REFERENCES plans(id),
        override_limits JSONB,
        started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at      TIMESTAMPTZ
      )
    `)
    // Seed plans (idempotent)
    await app.pg.query(`
      INSERT INTO plans (id, name, price_inr, limits) VALUES
        ('free',       'Free',       0,    '{"max_workloads":3,"max_databases":1,"max_functions":5,"storage_gb":1,"api_calls_month":10000}'::jsonb),
        ('starter',    'Starter',    499,  '{"max_workloads":10,"max_databases":3,"max_functions":20,"storage_gb":10,"api_calls_month":100000}'::jsonb),
        ('pro',        'Pro',        1999, '{"max_workloads":50,"max_databases":10,"max_functions":100,"storage_gb":100,"api_calls_month":1000000}'::jsonb),
        ('enterprise', 'Enterprise', 0,    '{"max_workloads":-1,"max_databases":-1,"max_functions":-1,"storage_gb":-1,"api_calls_month":-1}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped plans DDL', err: e.message })
  }

  // workloads (workloads vertical — replaces/extends apps for Workloads page)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS workloads (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      VARCHAR(63) NOT NULL,
        name           VARCHAR(63) NOT NULL,
        type           VARCHAR(20) NOT NULL DEFAULT 'service',
        status         VARCHAR(20) NOT NULL DEFAULT 'pending',
        source_git_url TEXT,
        source_ref     VARCHAR(63) NOT NULL DEFAULT 'main',
        image          TEXT,
        port           INTEGER,
        env            JSONB       NOT NULL DEFAULT '{}'::jsonb,
        replicas       INTEGER     NOT NULL DEFAULT 1,
        memory_limit   VARCHAR(20) NOT NULL DEFAULT '512Mi',
        cpu_limit      VARCHAR(20) NOT NULL DEFAULT '500m',
        domain         TEXT,
        project_id     UUID        REFERENCES projects(id) ON DELETE SET NULL,
        environment    VARCHAR(63) NOT NULL DEFAULT 'production',
        last_deployed_at TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (tenant_id, name)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_workloads_tenant ON workloads (tenant_id)`)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_workloads_project ON workloads (project_id)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped workloads DDL', err: e.message })
  }

  // instance_images, instance_types, user_instances (Instances vertical)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS instance_images (
        id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        slug           VARCHAR(63) NOT NULL UNIQUE,
        name           VARCHAR(63) NOT NULL,
        version        VARCHAR(20),
        category       VARCHAR(20) NOT NULL DEFAULT 'pre-built',
        framework      VARCHAR(63),
        cuda_version   VARCHAR(20),
        python_version VARCHAR(20),
        os_version     VARCHAR(63),
        description    TEXT,
        docker_image   TEXT        NOT NULL,
        tags           TEXT[]      NOT NULL DEFAULT '{}',
        is_active      BOOLEAN     NOT NULL DEFAULT true,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS instance_types (
        id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        slug                 VARCHAR(63) NOT NULL UNIQUE,
        name                 VARCHAR(63) NOT NULL,
        category             VARCHAR(20) NOT NULL DEFAULT 'gpu',
        gpu_model            VARCHAR(63),
        gpu_count            INTEGER     NOT NULL DEFAULT 1,
        vram_gb              INTEGER,
        vcpu                 INTEGER     NOT NULL DEFAULT 4,
        ram_gb               INTEGER     NOT NULL DEFAULT 16,
        storage_gb           INTEGER     NOT NULL DEFAULT 100,
        price_per_hour_paise INTEGER     NOT NULL DEFAULT 0,
        is_available         BOOLEAN     NOT NULL DEFAULT true,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS user_instances (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    VARCHAR(63) NOT NULL,
        name         VARCHAR(63) NOT NULL,
        image_id     UUID        REFERENCES instance_images(id),
        type_id      UUID        REFERENCES instance_types(id),
        status       VARCHAR(20) NOT NULL DEFAULT 'pending',
        pod_name     TEXT,
        namespace    VARCHAR(63),
        ssh_host     TEXT,
        ssh_port     INTEGER,
        ssh_public_key TEXT,
        jupyter_url  TEXT,
        jupyter_token TEXT,
        volume_size_gb INTEGER   NOT NULL DEFAULT 50,
        started_at   TIMESTAMPTZ,
        stopped_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_user_instances_tenant ON user_instances (tenant_id)`)
    // Seed a starter GPU instance type
    await app.pg.query(`
      INSERT INTO instance_types (slug, name, category, gpu_model, gpu_count, vram_gb, vcpu, ram_gb, storage_gb, price_per_hour_paise)
      VALUES
        ('a100-40gb', 'NVIDIA A100 40GB', 'gpu', 'A100 40GB', 1, 40, 12, 80, 500, 8500),
        ('a100-80gb', 'NVIDIA A100 80GB', 'gpu', 'A100 80GB', 1, 80, 16, 160, 500, 16000),
        ('t4-16gb',   'NVIDIA T4 16GB',   'gpu', 'T4 16GB',   1, 16, 4,  32,  200, 2500),
        ('cpu-8c32g', 'CPU 8c/32GB',       'cpu', NULL,        0, NULL,8,  32,  200, 800)
      ON CONFLICT (slug) DO NOTHING
    `)
    await app.pg.query(`
      INSERT INTO instance_images (slug, name, version, category, framework, cuda_version, python_version, docker_image, description)
      VALUES
        ('pytorch-2-cuda12', 'PyTorch 2.0', '2.0', 'pre-built', 'PyTorch', '12.1', '3.11', 'pytorch/pytorch:2.0.1-cuda11.7-cudnn8-runtime', 'PyTorch 2.0 with CUDA 12'),
        ('tensorflow-2-gpu',  'TensorFlow 2.13', '2.13', 'pre-built', 'TensorFlow', '11.8', '3.10', 'tensorflow/tensorflow:2.13.0-gpu', 'TensorFlow with GPU support'),
        ('jupyter-lab',       'JupyterLab',  '4.0',  'pre-built', NULL, NULL, '3.11', 'jupyter/datascience-notebook:latest', 'Full data-science JupyterLab'),
        ('ubuntu-22-base',    'Ubuntu 22.04','22.04','base-os',   NULL, NULL, NULL,   'ubuntu:22.04', 'Plain Ubuntu 22.04 LTS')
      ON CONFLICT (slug) DO NOTHING
    `)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped instances DDL', err: e.message })
  }

  // workload_env_vars + project_secrets (017_env_vars_secrets)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS workload_env_vars (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        workload_id UUID         NOT NULL REFERENCES workloads(id) ON DELETE CASCADE,
        tenant_id   VARCHAR(63)  NOT NULL,
        key         VARCHAR(255) NOT NULL,
        value       TEXT         NOT NULL,
        is_secret   BOOLEAN      NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (workload_id, key)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_wenv_workload ON workload_env_vars (workload_id)`)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS project_secrets (
        id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id  UUID         NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        tenant_id   VARCHAR(63)  NOT NULL,
        key         VARCHAR(255) NOT NULL,
        value       TEXT         NOT NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (project_id, key)
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_psecret_project ON project_secrets (project_id)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped env_vars/secrets DDL', err: e.message })
  }

  // mail_signatures + mail_domains (mail vertical)
  try {
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS mail_signatures (
        id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id    UUID        NOT NULL,
        name       VARCHAR(120) NOT NULL,
        html       TEXT        NOT NULL,
        is_default BOOLEAN     NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_mail_signatures_user ON mail_signatures (user_id)`)
    await app.pg.query(`
      CREATE TABLE IF NOT EXISTS mail_domains (
        id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id    VARCHAR(63) NOT NULL,
        domain       TEXT        NOT NULL UNIQUE,
        verified     BOOLEAN     NOT NULL DEFAULT false,
        verify_token TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await app.pg.query(`CREATE INDEX IF NOT EXISTS idx_mail_domains_tenant ON mail_domains (tenant_id)`)
  } catch (e: any) {
    app.log.warn({ msg: 'skipped mail DDL', err: e.message })
  }

  app.log.info('database ready')

  // Start usage metering cron — polls k8s pods every 60 s
  registerUsageMeteringJob(app)

  await app.listen({ port: cfg.port, host: '0.0.0.0' })
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})

// Graceful shutdown on SIGTERM/SIGINT
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    app.log.info(`received ${sig} — shutting down`)
    app.close().then(() => {
      process.exit(0)
    })
  })
}
