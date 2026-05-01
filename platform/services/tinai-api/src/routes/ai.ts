import Anthropic from '@anthropic-ai/sdk'
import { FastifyInstance } from 'fastify'
import * as https from 'https'
import * as http from 'http'
import { writeAuditEvent } from '../utils/audit'
import { requireAdmin } from '../middleware/requireAdmin'

const SYSTEM_PROMPT = `You are Tinai Copilot, the AI assistant for Tinai Cloud — India's sovereign PaaS for the space economy.
You help platform operators and developers understand their deployments, diagnose build failures, interpret usage metrics, and navigate the platform.
Be concise and technical. Use Kubernetes/DevOps terminology. Focus on actionable answers.
Platform: Kubernetes (k3s) on India infrastructure | Stack: Forgejo, Kaniko, Fastify, Next.js 15`

// ---------------------------------------------------------------------------
// Loki helpers
// ---------------------------------------------------------------------------
const LOKI_URL = process.env.LOKI_URL ?? 'http://loki.tinai-system.svc.cluster.local:3100'
const LOKI_QUERY_RANGE_PATH = '/loki/api/v1/query_range'

interface LokiStream {
  stream: Record<string, string>
  values: [string, string][] // [nanosecond-unix-timestamp, log-line]
}

interface LokiQueryResult {
  streams: LokiStream[]
}

function lokiGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const transport = parsed.protocol === 'https:' ? https : http
    const req = transport.get(url, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', reject)
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error('Loki request timed out')) })
  })
}

async function queryLoki(logql: string, startMs: number, endMs: number, limit = 500): Promise<LokiQueryResult> {
  const params = new URLSearchParams({
    query: logql,
    start: String(startMs * 1_000_000),  // nanoseconds
    end:   String(endMs   * 1_000_000),
    limit: String(limit),
    direction: 'backward',
  })
  const url = `${LOKI_URL}${LOKI_QUERY_RANGE_PATH}?${params.toString()}`
  const raw = await lokiGet(url)
  const parsed = JSON.parse(raw)
  return { streams: parsed?.data?.result ?? [] }
}

interface ChatBody {
  message: string
  app?: string
}

export async function aiRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // POST /ai/chat — authenticated user chat with context scoping
  // ---------------------------------------------------------------------------
  app.post<{ Body: ChatBody }>('/ai/chat', {
    schema: {
      body: {
        type: 'object',
        required: ['message'],
        properties: {
          message: { type: 'string' },
          app: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { message, app: appName } = req.body

    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.send({
        response: 'Platform Copilot is not yet activated. Add ANTHROPIC_API_KEY to the tinai-api deployment to enable AI assistance.',
        model: 'stub',
        active: false,
      })
    }

    try {
      const contextParts: string[] = []

      // 1. Apps list — scoped to authenticated tenant
      try {
        const { rows: appRows } = await app.pg.query(
          'SELECT name, repo_full_name, created_at FROM apps WHERE owner = $1 ORDER BY created_at DESC',
          [tenantId],
        )
        if (appRows.length > 0) {
          const appList = appRows.map((r: { name: string; repo_full_name: string; created_at: string }) =>
            `- ${r.name} (repo: ${r.repo_full_name}, created: ${r.created_at})`,
          ).join('\n')
          contextParts.push(`Your registered apps:\n${appList}`)
        } else {
          contextParts.push('Registered apps: none')
        }
      } catch {
        contextParts.push('Registered apps: unavailable')
      }

      // 2. Usage summary (last 1 hour) — scoped to authenticated tenant
      try {
        const { rows: usageRows } = await app.pg.query(
          `SELECT u.app_name,
                  ROUND(SUM(u.cpu_cores*5.0/60),3) AS cpu_hrs,
                  ROUND(SUM(u.memory_bytes/1073741824.0*5.0/60),3) AS mem_hrs
           FROM usage_snapshots u
           JOIN apps a ON a.name = u.app_name
           WHERE a.owner = $1 AND u.snapshot_at > NOW()-INTERVAL '1 hour'
           GROUP BY u.app_name`,
          [tenantId],
        )
        if (usageRows.length > 0) {
          const usageList = usageRows.map((r: { app_name: string; cpu_hrs: string; mem_hrs: string }) =>
            `- ${r.app_name}: CPU ${r.cpu_hrs} core-hrs, Memory ${r.mem_hrs} GiB-hrs`,
          ).join('\n')
          contextParts.push(`Your usage (last 1h):\n${usageList}`)
        } else {
          contextParts.push('Usage (last 1h): no data')
        }
      } catch {
        contextParts.push('Usage (last 1h): unavailable')
      }

      // 3. App-specific context if requested — verify ownership
      if (appName) {
        try {
          const { rows: specificRows } = await app.pg.query(
            'SELECT name, repo_full_name FROM apps WHERE name=$1 AND owner=$2',
            [appName, tenantId],
          )
          if (specificRows.length > 0) {
            const r = specificRows[0] as { name: string; repo_full_name: string }
            contextParts.push(`Focused app — ${r.name}: repo ${r.repo_full_name}`)
          } else {
            contextParts.push(`Focused app "${appName}": not found or access denied`)
          }
        } catch {
          contextParts.push(`Focused app "${appName}": lookup unavailable`)
        }
      }

      const context = contextParts.join('\n\n')

      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await client.messages.create({
        model: 'claude-3-5-sonnet-20240620',
        max_tokens: 1024,
        system: SYSTEM_PROMPT + '\n\nUser Context:\n' + context,
        messages: [{ role: 'user', content: message }],
      })

      const responseText = msg.content[0].type === 'text' ? msg.content[0].text : ''

      const CONSEQUENTIAL_KEYWORDS = ['deploy', 'delete', 'scale', 'restart', 'rollback']
      const lowerResponse = responseText.toLowerCase()
      const requires_review = CONSEQUENTIAL_KEYWORDS.some(kw => lowerResponse.includes(kw))

      await writeAuditEvent(app, {
        tenant_id: tenantId,
        action: 'ai_chat',
        resource: 'copilot',
        resource_id: null,
        metadata: {
          model: 'claude-3-5-sonnet-20240620',
          active: true,
          message_length: message.length,
          has_app_context: !!appName,
          requires_review,
        },
      })

      return reply.send({
        response: responseText,
        model: 'claude-3-5-sonnet-20240620',
        active: true,
        requires_review,
      })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.send({
        response: 'AI service error: ' + message,
        model: 'error',
        active: false,
      })
    }
  })

  // ---------------------------------------------------------------------------
  // GET /copilot/incidents — query Loki for recent errors and summarise them
  // Restricted to admins.
  // ---------------------------------------------------------------------------
  app.get('/copilot/incidents', { preHandler: requireAdmin }, async (req, reply) => {
    const endMs   = Date.now()
    const startMs = endMs - 30 * 60 * 1000  // last 30 minutes

    const logql = `{namespace="tinai-system"} |= "error" | json`

    let streams: LokiStream[] = []
    try {
      const result = await queryLoki(logql, startMs, endMs, 500)
      streams = result.streams
    } catch (err) {
      app.log.warn({ err }, 'copilot/incidents: Loki query failed')
      return reply.status(502).send({ error: 'failed to query Loki' })
    }

    const podMap = new Map<string, { service: string; lines: string[] }>()

    for (const stream of streams) {
      const pod     = stream.stream.pod ?? stream.stream.pod_name ?? stream.stream.container ?? 'unknown'
      const service = stream.stream.app ?? stream.stream.container ?? pod

      if (!podMap.has(pod)) podMap.set(pod, { service, lines: [] })
      const entry = podMap.get(pod)!

      for (const [, line] of stream.values) {
        entry.lines.push(line)
      }
    }

    const incidents = Array.from(podMap.entries())
      .map(([pod, { service, lines }]) => ({
        pod,
        service,
        count: lines.length,
        sample: lines[0] ?? '',
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)

    return reply.send({
      queried_from: new Date(startMs).toISOString(),
      queried_to:   new Date(endMs).toISOString(),
      total_streams: streams.length,
      incidents,
    })
  })

  // ---------------------------------------------------------------------------
  // POST /copilot/explain — explain a log snippet
  // ---------------------------------------------------------------------------
  app.post<{ Body: { log_snippet: string } }>('/copilot/explain', {
    schema: {
      body: {
        type: 'object',
        required: ['log_snippet'],
        properties: {
          log_snippet: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { log_snippet } = req.body
    if (!log_snippet.trim()) return reply.status(400).send({ error: 'log_snippet required' })
    if (!process.env.ANTHROPIC_API_KEY) return reply.status(503).send({ error: 'AI service not configured' })

    const prompt = `Explain this log snippet from a production cloud app and suggest a fix:\n\n${log_snippet.slice(0, 4000)}`

    try {
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
      const msg = await client.messages.create({
        model: 'claude-3-5-sonnet-20240620',
        max_tokens: 512,
        messages: [{ role: 'user', content: prompt }],
      })

      const text = msg.content[0].type === 'text' ? msg.content[0].text : ''
      return reply.send({ response: text })
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return reply.status(500).send({ error: 'AI service error: ' + message })
    }
  })
}
