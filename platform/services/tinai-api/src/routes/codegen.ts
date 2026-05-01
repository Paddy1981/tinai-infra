import Anthropic from '@anthropic-ai/sdk'
import { FastifyInstance } from 'fastify'
import { createGzip } from 'zlib'
import { promisify } from 'util'
import { writeAuditEvent } from '../utils/audit'
import { requireAdmin } from '../middleware/requireAdmin'

const gzip = promisify(createGzip)

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://minio.tinai-system.svc.cluster.local:9000'
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin'
const minioRootPassword = process.env.MINIO_ROOT_PASSWORD
if (!minioRootPassword) throw new Error('MINIO_ROOT_PASSWORD environment variable is required')
const MINIO_SECRET_KEY = minioRootPassword
const CODEGEN_BUCKET = 'codegen'

const FORGEJO_INTERNAL_URL = process.env.FORGEJO_INTERNAL_URL ?? 'http://forgejo.tinai-system.svc.cluster.local:3000'
const FORGEJO_ADMIN_TOKEN = process.env.FORGEJO_ADMIN_TOKEN ?? ''
const BUILD_API_URL = process.env.BUILD_API_URL ?? 'http://build-api.tinai-system.svc.cluster.local:4000'

const CODEGEN_SYSTEM_PROMPT = `You are a code generator for the Tinai Cloud platform.
Generate a complete, deployable application given a description.
Output ONLY valid JSON in this exact format:
{
  "files": [
    {"path": "package.json", "content": "..."},
    {"path": "app/page.tsx", "content": "..."},
    {"path": "Dockerfile", "content": "..."}
  ],
  "env_vars": {"DATABASE_URL": "will be injected", "NEXT_PUBLIC_API_URL": ""},
  "description": "Brief description of what was generated",
  "requires_database": true
}

Rules:
- Always include a Dockerfile
- For Next.js: use App Router, Tailwind CSS, TypeScript
- For databases: use environment variable DATABASE_URL (Tinai will inject it)
- Keep code minimal but functional
- For auth: use Tinai's auth service (TINAI_AUTH_URL env var)`

const STARTER_TEMPLATES = [
  { id: 'saas-starter', name: 'SaaS Starter', description: 'Next.js + Auth + Postgres + Stripe', stack: 'nextjs', tags: ['saas', 'auth', 'payments'] },
  { id: 'api-service', name: 'REST API', description: 'Node.js + Express + Postgres + Swagger', stack: 'node', tags: ['api', 'backend'] },
  { id: 'ml-app', name: 'ML Model Server', description: 'Python + FastAPI + ML inference endpoint', stack: 'python', tags: ['ml', 'ai'] },
  { id: 'realtime-app', name: 'Real-time App', description: 'Next.js + WebSockets + Tinai Realtime', stack: 'nextjs', tags: ['realtime'] },
  { id: 'blog', name: 'Blog/CMS', description: 'Next.js + Markdown + MDX + SEO optimised', stack: 'nextjs', tags: ['content'] },
  { id: 'ecommerce', name: 'E-commerce', description: 'Next.js + Cart + Razorpay + Inventory DB', stack: 'nextjs', tags: ['ecommerce', 'payments'] },
  { id: 'dashboard-starter', name: 'Data Dashboard', description: 'Next.js + Charts + Postgres + CSV upload', stack: 'nextjs', tags: ['data'] },
  { id: 'space-app', name: 'Space Data App', description: 'Next.js + Tinai Space API + Satellite tracker', stack: 'nextjs', tags: ['space'] },
]

interface GeneratedFile {
  path: string
  content: string
}

interface CodegenResult {
  files: GeneratedFile[]
  env_vars: Record<string, string>
  description: string
  requires_database: boolean
}

// ─── MinIO helpers (raw S3-compatible HTTP, no SDK needed) ───────────────────

function hmacSha256(key: Buffer | string, data: string): Buffer {
  const { createHmac } = require('crypto')
  return createHmac('sha256', key).update(data).digest()
}

function sha256Hex(data: string | Buffer): string {
  const { createHash } = require('crypto')
  return createHash('sha256').update(data).digest('hex')
}

/** Build a minimal presigned-style PUT to MinIO using AWS Sig V4 */
async function minioUpload(objectKey: string, body: Buffer, contentType = 'application/zip'): Promise<void> {
  const url = new URL(`/${CODEGEN_BUCKET}/${objectKey}`, MINIO_ENDPOINT)
  const now = new Date()
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const amzdate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z'
  const region = 'us-east-1' // MinIO default
  const service = 's3'
  const bodyHash = sha256Hex(body)

  const headers: Record<string, string> = {
    'host': url.host,
    'x-amz-date': amzdate,
    'x-amz-content-sha256': bodyHash,
    'content-type': contentType,
    'content-length': String(body.length),
  }

  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n'
  const canonicalRequest = [
    'PUT',
    url.pathname,
    '',
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n')

  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzdate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n')

  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(
        hmacSha256(`AWS4${MINIO_SECRET_KEY}`, datestamp),
        region,
      ),
      service,
    ),
    'aws4_request',
  )

  const { createHmac } = require('crypto')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${MINIO_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: { ...headers, Authorization: authorization },
    body,
  })

  if (!res.ok && res.status !== 409) {
    // Try to create bucket first if it doesn't exist (404 on bucket)
    if (res.status === 404 || res.status === 403) {
      // Best-effort bucket creation — swallow errors
      try {
        const bucketUrl = new URL(`/${CODEGEN_BUCKET}`, MINIO_ENDPOINT)
        await fetch(bucketUrl.toString(), {
          method: 'PUT',
          headers: {
            'host': url.host,
            'x-amz-date': amzdate,
            'x-amz-content-sha256': sha256Hex(''),
            'content-length': '0',
            Authorization: authorization,
          },
        })
        // Retry the upload
        const retry = await fetch(url.toString(), {
          method: 'PUT',
          headers: { ...headers, Authorization: authorization },
          body,
        })
        if (!retry.ok) throw new Error(`MinIO upload failed after bucket creation: ${retry.status}`)
        return
      } catch {
        // MinIO not available — continue; the download_url will still be returned
        return
      }
    }
    throw new Error(`MinIO upload failed: ${res.status} ${await res.text()}`)
  }
}

async function minioDownload(objectKey: string): Promise<Buffer> {
  const url = new URL(`/${CODEGEN_BUCKET}/${objectKey}`, MINIO_ENDPOINT)
  const now = new Date()
  const datestamp = now.toISOString().slice(0, 10).replace(/-/g, '')
  const amzdate = now.toISOString().replace(/[:-]/g, '').slice(0, 15) + 'Z'
  const region = 'us-east-1'
  const service = 's3'
  const bodyHash = sha256Hex('')

  const headers: Record<string, string> = {
    'host': url.host,
    'x-amz-date': amzdate,
    'x-amz-content-sha256': bodyHash,
  }

  const signedHeaders = Object.keys(headers).sort().join(';')
  const canonicalHeaders = Object.keys(headers).sort().map(k => `${k}:${headers[k]}`).join('\n') + '\n'
  const canonicalRequest = ['GET', url.pathname, '', canonicalHeaders, signedHeaders, bodyHash].join('\n')
  const credentialScope = `${datestamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const signingKey = hmacSha256(
    hmacSha256(
      hmacSha256(
        hmacSha256(`AWS4${MINIO_SECRET_KEY}`, datestamp),
        region,
      ),
      service,
    ),
    'aws4_request',
  )

  const { createHmac } = require('crypto')
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  const authorization = `AWS4-HMAC-SHA256 Credential=${MINIO_ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: { ...headers, Authorization: authorization },
  })
  if (!res.ok) throw new Error(`MinIO download failed: ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

// ─── Minimal in-memory ZIP builder (no external deps) ────────────────────────

function buildZip(files: GeneratedFile[]): Buffer {
  // RFC 1952 / PKZIP — local file headers + central directory + end-of-central-directory
  const { createHash } = require('crypto')
  const localEntries: Buffer[] = []
  const centralEntries: Buffer[] = []
  let offset = 0

  for (const f of files) {
    const fileData = Buffer.from(f.content, 'utf8')
    const fileName = Buffer.from(f.path, 'utf8')
    const crc32 = crc32Compute(fileData)
    const modTime = 0x0000
    const modDate = 0x0000

    // Local file header (signature 0x04034b50)
    const localHeader = Buffer.alloc(30 + fileName.length)
    localHeader.writeUInt32LE(0x04034b50, 0)  // signature
    localHeader.writeUInt16LE(20, 4)            // version needed
    localHeader.writeUInt16LE(0, 6)             // flags
    localHeader.writeUInt16LE(0, 8)             // compression (stored)
    localHeader.writeUInt16LE(modTime, 10)
    localHeader.writeUInt16LE(modDate, 12)
    localHeader.writeUInt32LE(crc32, 14)
    localHeader.writeUInt32LE(fileData.length, 18)  // compressed size
    localHeader.writeUInt32LE(fileData.length, 22)  // uncompressed size
    localHeader.writeUInt16LE(fileName.length, 26)
    localHeader.writeUInt16LE(0, 28)            // extra field length
    fileName.copy(localHeader, 30)

    const localEntry = Buffer.concat([localHeader, fileData])
    localEntries.push(localEntry)

    // Central directory header (signature 0x02014b50)
    const centralHeader = Buffer.alloc(46 + fileName.length)
    centralHeader.writeUInt32LE(0x02014b50, 0) // signature
    centralHeader.writeUInt16LE(20, 4)           // version made by
    centralHeader.writeUInt16LE(20, 6)           // version needed
    centralHeader.writeUInt16LE(0, 8)            // flags
    centralHeader.writeUInt16LE(0, 10)           // compression
    centralHeader.writeUInt16LE(modTime, 12)
    centralHeader.writeUInt16LE(modDate, 14)
    centralHeader.writeUInt32LE(crc32, 16)
    centralHeader.writeUInt32LE(fileData.length, 20)
    centralHeader.writeUInt32LE(fileData.length, 24)
    centralHeader.writeUInt16LE(fileName.length, 28)
    centralHeader.writeUInt16LE(0, 30)           // extra length
    centralHeader.writeUInt16LE(0, 32)           // comment length
    centralHeader.writeUInt16LE(0, 34)           // disk start
    centralHeader.writeUInt16LE(0, 36)           // int attr
    centralHeader.writeUInt32LE(0, 38)           // ext attr
    centralHeader.writeUInt32LE(offset, 42)      // local header offset
    fileName.copy(centralHeader, 46)

    centralEntries.push(centralHeader)
    offset += localEntry.length
  }

  const centralDir = Buffer.concat(centralEntries)
  const centralDirSize = centralDir.length

  // End of central directory record (signature 0x06054b50)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)                      // disk number
  eocd.writeUInt16LE(0, 6)                      // start disk
  eocd.writeUInt16LE(files.length, 8)           // entries on disk
  eocd.writeUInt16LE(files.length, 10)          // total entries
  eocd.writeUInt32LE(centralDirSize, 12)
  eocd.writeUInt32LE(offset, 16)               // central dir offset
  eocd.writeUInt16LE(0, 20)                    // comment length

  return Buffer.concat([...localEntries, centralDir, eocd])
}

/** CRC-32 table-driven implementation (IEEE 802.3) */
function crc32Compute(buf: Buffer): number {
  const table = buildCrc32Table()
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}

let _crc32Table: Uint32Array | null = null
function buildCrc32Table(): Uint32Array {
  if (_crc32Table) return _crc32Table
  _crc32Table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    _crc32Table[i] = c
  }
  return _crc32Table
}

// ─── Job ID store (in-memory — good enough for single-pod; use Redis for HA) ─

const jobStore = new Map<string, { objectKey: string; result: CodegenResult }>()

// ─── Route handlers ───────────────────────────────────────────────────────────

interface GenerateBody {
  description: string
  stack: 'nextjs' | 'node' | 'python-flask'
  appName: string
}

interface DeployBody {
  jobId: string
  appName: string
}

export async function codegenRoutes(app: FastifyInstance) {

  // GET /codegen/templates
  app.get('/codegen/templates', async (_req, reply) => {
    return reply.send(STARTER_TEMPLATES)
  })

  // POST /codegen/generate — admin only (runs as tinai-admin, deploys to platform)
  app.post<{ Body: GenerateBody }>('/codegen/generate', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['description', 'stack', 'appName'],
        properties: {
          description: { type: 'string', minLength: 10 },
          stack: { type: 'string', enum: ['nextjs', 'node', 'python-flask'] },
          appName: { type: 'string', minLength: 2, maxLength: 63 },
        },
      },
    },
  }, async (req, reply) => {
    const { description, stack, appName } = req.body

    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.status(503).send({
        error: 'Code generation is not activated. Add ANTHROPIC_API_KEY to the tinai-api deployment.',
      })
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    let parsed: CodegenResult
    try {
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 8192,
        system: CODEGEN_SYSTEM_PROMPT,
        messages: [{
          role: 'user',
          content: `Generate a ${stack} application: ${description}\n\nApp name: ${appName}`,
        }],
      })

      const raw = msg.content[0].type === 'text' ? msg.content[0].text : ''

      // Strip markdown code fences if Claude wraps the JSON
      const jsonText = raw.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()

      parsed = JSON.parse(jsonText) as CodegenResult
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(502).send({ error: `Code generation failed: ${msg}` })
    }

    // Build zip in memory
    const zipBuffer = buildZip(parsed.files)
    const timestamp = Date.now()
    const objectKey = `${appName}/${timestamp}.zip`

    // Store to MinIO (best-effort — don't fail the request if MinIO is unavailable)
    try {
      await minioUpload(objectKey, zipBuffer)
    } catch (err: unknown) {
      app.log.warn({ err }, 'MinIO upload failed — job will still be returned but deploy may fail')
    }

    const jobId = `cg-${timestamp}-${Math.random().toString(36).slice(2, 8)}`
    jobStore.set(jobId, { objectKey, result: parsed })

    await writeAuditEvent(app, {
      tenant_id: 'tinai-admin',
      action: 'codegen_generate',
      resource: 'codegen',
      resource_id: jobId,
      metadata: {
        appName,
        stack,
        file_count: parsed.files.length,
        requires_database: parsed.requires_database,
      },
    })

    const filesWithSizes = parsed.files.map(f => ({
      path: f.path,
      size: Buffer.byteLength(f.content, 'utf8'),
    }))

    const downloadUrl = `${MINIO_ENDPOINT}/${CODEGEN_BUCKET}/${objectKey}`

    return reply.status(201).send({
      jobId,
      files: filesWithSizes,
      env_vars: parsed.env_vars,
      description: parsed.description,
      requires_database: parsed.requires_database,
      download_url: downloadUrl,
    })
  })

  // POST /codegen/deploy — admin only (pushes to Forgejo, triggers build pipeline)
  app.post<{ Body: DeployBody }>('/codegen/deploy', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['jobId', 'appName'],
        properties: {
          jobId: { type: 'string' },
          appName: { type: 'string', minLength: 2, maxLength: 63 },
        },
      },
    },
  }, async (req, reply) => {
    const { jobId, appName } = req.body

    const job = jobStore.get(jobId)
    if (!job) {
      return reply.status(404).send({ error: 'Job not found. Jobs expire when the API restarts.' })
    }

    // 1. Download zip from MinIO
    let zipBuffer: Buffer
    try {
      zipBuffer = await minioDownload(job.objectKey)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(502).send({ error: `Failed to retrieve generated code from storage: ${msg}` })
    }

    // 2. Create Forgejo repository
    const repoName = appName.toLowerCase().replace(/[^a-z0-9-]/g, '-')
    let repoFullName: string
    try {
      const createRes = await fetch(`${FORGEJO_INTERNAL_URL}/api/v1/user/repos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${FORGEJO_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          name: repoName,
          description: job.result.description,
          private: true,
          auto_init: false,
        }),
      })

      if (!createRes.ok) {
        const errBody = await createRes.text()
        throw new Error(`Forgejo repo creation failed (${createRes.status}): ${errBody}`)
      }

      const repoData = await createRes.json() as { full_name: string }
      repoFullName = repoData.full_name
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      return reply.status(502).send({ error: `Repository creation failed: ${msg}` })
    }

    // 3. Push each file to Forgejo
    const pushErrors: string[] = []
    for (const f of job.result.files) {
      try {
        const contentBase64 = Buffer.from(f.content, 'utf8').toString('base64')
        const pushRes = await fetch(
          `${FORGEJO_INTERNAL_URL}/api/v1/repos/${repoFullName}/contents/${encodeURIComponent(f.path)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `token ${FORGEJO_ADMIN_TOKEN}`,
            },
            body: JSON.stringify({
              message: `feat: initial commit — generated by Tinai codegen (job ${jobId})`,
              content: contentBase64,
            }),
          },
        )
        if (!pushRes.ok) {
          const errText = await pushRes.text()
          pushErrors.push(`${f.path}: ${pushRes.status} ${errText}`)
        }
      } catch (err: unknown) {
        pushErrors.push(`${f.path}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (pushErrors.length > 0) {
      app.log.warn({ pushErrors }, 'Some files failed to push to Forgejo')
    }

    // 4. Trigger build via build-api
    let buildId: string
    try {
      const buildRes = await fetch(`${BUILD_API_URL}/api/v1/builds`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `token ${FORGEJO_ADMIN_TOKEN}`,
        },
        body: JSON.stringify({
          repo: repoFullName,
          app_name: appName,
          source: 'codegen',
          job_id: jobId,
        }),
      })

      if (!buildRes.ok) {
        const errText = await buildRes.text()
        throw new Error(`Build trigger failed (${buildRes.status}): ${errText}`)
      }

      const buildData = await buildRes.json() as { id?: string; build_id?: string }
      buildId = (buildData.id ?? buildData.build_id ?? `build-${Date.now()}`).toString()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // Non-fatal — return partial success so caller knows the repo was created
      app.log.warn({ err }, 'Build trigger failed')
      buildId = `pending-${Date.now()}`
    }

    // Register app in platform DB
    try {
      await app.pg.query(
        `INSERT INTO apps (name, repo_full_name)
         VALUES ($1, $2)
         ON CONFLICT (name) DO UPDATE SET repo_full_name = EXCLUDED.repo_full_name`,
        [appName, repoFullName],
      )
    } catch {
      // App may already exist — non-fatal
    }

    await writeAuditEvent(app, {
      tenant_id: 'tinai-admin',
      action: 'codegen_deploy',
      resource: 'codegen',
      resource_id: jobId,
      metadata: { appName, repoFullName, buildId, push_errors: pushErrors.length },
    })

    const repoUrl = `${FORGEJO_INTERNAL_URL.replace('http://', 'https://').replace('.svc.cluster.local:3000', '')}/${repoFullName}`

    return reply.status(201).send({
      repoUrl,
      buildId,
      appUrl: `https://${appName}.apps.tinai.cloud`,
      push_warnings: pushErrors.length > 0 ? pushErrors : undefined,
    })
  })
}
