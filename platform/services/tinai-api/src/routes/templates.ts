// TODO: Register in server.ts: app.register(templatesRoutes, { prefix: '/api/v1' })

import { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { requireAdmin } from '../middleware/requireAdmin'

function generatePassword(length = 24): string {
  return randomBytes(length).toString('base64url').slice(0, length)
}

interface Template {
  id: string
  name: string
  category: string
  description: string
  icon: string
  image: string
  port: number
  env: Record<string, string>
  requires_volume: boolean
  volume_mount?: string
}

const TEMPLATES: Template[] = [
  {
    id: 'postgres', name: 'PostgreSQL', category: 'Database',
    description: 'Managed PostgreSQL 16', icon: '🐘',
    image: 'postgres:16-alpine', port: 5432,
    env: { POSTGRES_DB: 'app', POSTGRES_USER: 'app', POSTGRES_PASSWORD: generatePassword() },
    requires_volume: true, volume_mount: '/var/lib/postgresql/data',
  },
  {
    id: 'redis', name: 'Redis', category: 'Cache',
    description: 'Redis 7 in-memory cache', icon: '🔴',
    image: 'redis:7-alpine', port: 6379,
    env: {}, requires_volume: false,
  },
  {
    id: 'mysql', name: 'MySQL', category: 'Database',
    description: 'MySQL 8.0', icon: '🐬',
    image: 'mysql:8.0', port: 3306,
    env: { MYSQL_ROOT_PASSWORD: generatePassword(), MYSQL_DATABASE: 'app' },
    requires_volume: true, volume_mount: '/var/lib/mysql',
  },
  {
    id: 'nginx', name: 'NGINX', category: 'Starter',
    description: 'NGINX reverse proxy / static server', icon: '🌐',
    image: 'nginx:alpine', port: 80,
    env: {}, requires_volume: false,
  },
  {
    id: 'minio', name: 'MinIO', category: 'Storage',
    description: 'S3-compatible object storage', icon: '📦',
    image: 'minio/minio:latest', port: 9000,
    env: { MINIO_ROOT_USER: 'admin', MINIO_ROOT_PASSWORD: generatePassword() },
    requires_volume: true, volume_mount: '/data',
  },
  {
    id: 'mongodb', name: 'MongoDB', category: 'Database',
    description: 'MongoDB 7', icon: '🍃',
    image: 'mongo:7', port: 27017,
    env: { MONGO_INITDB_ROOT_USERNAME: 'admin', MONGO_INITDB_ROOT_PASSWORD: generatePassword() },
    requires_volume: true, volume_mount: '/data/db',
  },
  {
    id: 'rabbitmq', name: 'RabbitMQ', category: 'Messaging',
    description: 'RabbitMQ message broker', icon: '🐰',
    image: 'rabbitmq:3-management-alpine', port: 5672,
    env: { RABBITMQ_DEFAULT_USER: 'admin', RABBITMQ_DEFAULT_PASS: generatePassword() },
    requires_volume: false,
  },
  {
    id: 'node-hello', name: 'Node.js Hello', category: 'Starter',
    description: 'Node.js 20 hello world', icon: '💚',
    image: 'node:20-alpine', port: 3000,
    env: {}, requires_volume: false,
  },
  {
    id: 'go-hello', name: 'Go Hello', category: 'Starter',
    description: 'Go 1.21 hello world', icon: '🐹',
    image: 'golang:1.21-alpine', port: 8080,
    env: {}, requires_volume: false,
  },
  {
    id: 'python-flask', name: 'Python Flask', category: 'Starter',
    description: 'Python 3.12 + Flask', icon: '🐍',
    image: 'python:3.12-slim', port: 5000,
    env: {}, requires_volume: false,
  },
  {
    id: 'tinai-mail-server', name: 'Tinai Mail Server', category: 'Email',
    description: 'Enterprise mail server powered by Stalwart. Pre-configured with IMAP, SMTP, JMAP, CalDAV, CardDAV, spam filtering (Spamhaus, Barracuda), DKIM signing, SPF/DMARC enforcement, and Tinai security hardening. Includes webmail UI.',
    icon: '📧',
    image: 'stalwartlabs/stalwart:latest', port: 8080,
    env: {
      STALWART_ADMIN_USER: 'admin',
      STALWART_ADMIN_PASSWORD: generatePassword(),
      TINAI_MAIL_DOMAIN: 'your-domain.com',
      TINAI_MAIL_TIER: 'business',
      TINAI_SMTP_RELAY: 'smtp.tinai.cloud',
      TINAI_DKIM_AUTO: 'true',
      TINAI_SPAM_FILTER: 'aggressive',
      TINAI_RATE_LIMIT: '1000/day',
    },
    requires_volume: true, volume_mount: '/opt/stalwart',
  },
  {
    id: 'tinai-webmail', name: 'Tinai Webmail', category: 'Email',
    description: 'Modern webmail UI for Tinai Mail Server. Features: compose, search, attachments, signatures, HTML sanitization, themes. Pair with Tinai Mail Server for a complete stack.',
    icon: '💌',
    image: 'tinai/mail-ui:v4', port: 3000,
    env: {
      JMAP_URL: 'http://tinai-mail-server:8080',
      STALWART_PASSWORD: '',
      JWT_SECRET: generatePassword(32),
      TINAI_AUTH_URL: 'http://tinai-auth.tinai-system.svc.cluster.local:3002',
    },
    requires_volume: false,
  },
]

const TEMPLATE_MAP = new Map<string, Template>(TEMPLATES.map(t => [t.id, t]))

interface FromTemplateBody {
  template_id: string
  app_name: string
  env_overrides?: Record<string, string>
}

export async function templatesRoutes(app: FastifyInstance) {
  // GET /templates
  app.get('/templates', async () => {
    return TEMPLATES
  })

  // GET /templates/:id
  app.get<{ Params: { id: string } }>('/templates/:id', async (req, reply) => {
    const tpl = TEMPLATE_MAP.get(req.params.id)
    if (!tpl) return reply.status(404).send({ error: 'template not found' })
    return tpl
  })

  // POST /apps/from-template — admin only (registers app under tinai-admin owner)
  app.post<{ Body: FromTemplateBody }>('/apps/from-template', {
    preHandler: requireAdmin,
    schema: {
      body: {
        type: 'object',
        required: ['template_id', 'app_name'],
        properties: {
          template_id:   { type: 'string' },
          app_name:      { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$' },
          env_overrides: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
    },
  }, async (req, reply) => {
    const { template_id, app_name, env_overrides = {} } = req.body

    const tpl = TEMPLATE_MAP.get(template_id)
    if (!tpl) return reply.status(404).send({ error: `template '${template_id}' not found` })

    // Register the app (same logic as POST /apps)
    const repoFullName = `templates/${template_id}/${app_name}`
    const { rows: existing } = await app.pg.query(
      'SELECT id FROM apps WHERE name = $1', [app_name],
    )
    if (existing.length) {
      return reply.status(409).send({ error: `app '${app_name}' already exists` })
    }

    const { rows: [createdApp] } = await app.pg.query(
      `INSERT INTO apps (name, owner, repo_full_name) VALUES ($1, 'tinai-admin', $2) RETURNING *`,
      [app_name, repoFullName],
    )

    // Merge template env with overrides
    const finalEnv: Record<string, string> = { ...tpl.env, ...env_overrides }

    const nextSteps: string[] = [
      `App '${app_name}' registered from template '${tpl.name}'.`,
      `Image: ${tpl.image} — port: ${tpl.port}`,
      `Set env vars via POST /api/v1/apps/${app_name}/env`,
      `Trigger a deploy via the build pipeline or POST /api/v1/apps/${app_name}/deploy`,
    ]

    if (tpl.requires_volume) {
      nextSteps.push(
        `This template requires a persistent volume at '${tpl.volume_mount}'. ` +
        `Create one via POST /api/v1/apps/${app_name}/volumes with { "mount_path": "${tpl.volume_mount}" }`,
      )
    }

    if (Object.keys(finalEnv).length > 0) {
      nextSteps.push(
        `Default env vars: ${Object.keys(finalEnv).join(', ')} — override sensitive values (passwords) before deploying.`,
      )
    }

    return reply.status(201).send({
      app: createdApp,
      template: tpl,
      effective_env: finalEnv,
      next_steps: nextSteps,
    })
  })
}
