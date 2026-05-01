// TODO: Register in server.ts: app.register(customDomainsRoutes, { prefix: '/api/v1' })

// Run migration: CREATE TABLE IF NOT EXISTS custom_domains (
//   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   app_name VARCHAR(63) NOT NULL,
//   domain TEXT NOT NULL UNIQUE,
//   verified BOOLEAN NOT NULL DEFAULT false,
//   cert_status VARCHAR(20) NOT NULL DEFAULT 'pending',
//   verify_token TEXT,
//   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
// )

import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { randomBytes } from 'crypto'
import { promises as dns } from 'dns'
import { loadConfig } from '../config'

const cfg = loadConfig()

const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const networkingV1 = kc.makeApiClient(k8s.NetworkingV1Api)

async function getIngress(appName: string) {
  try {
    const { body } = await networkingV1.readNamespacedIngress(appName, cfg.stagingNamespace)
    return body
  } catch {
    return null
  }
}

async function upsertIngressRule(appName: string, domain: string) {
  const ingress = await getIngress(appName)
  const newRule: k8s.V1IngressRule = {
    host: domain,
    http: {
      paths: [{
        path: '/',
        pathType: 'Prefix',
        backend: {
          service: {
            name: appName,
            port: { number: 80 },
          },
        },
      }],
    },
  }

  if (ingress) {
    if (!ingress.spec) ingress.spec = {}
    if (!ingress.spec.rules) ingress.spec.rules = []
    // Avoid duplicate
    ingress.spec.rules = ingress.spec.rules.filter(r => r.host !== domain)
    ingress.spec.rules.push(newRule)
    await networkingV1.replaceNamespacedIngress(appName, cfg.stagingNamespace, ingress)
  } else {
    const newIngress: k8s.V1Ingress = {
      metadata: {
        name: appName,
        namespace: cfg.stagingNamespace,
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        },
      },
      spec: {
        rules: [newRule],
        tls: [{ hosts: [domain], secretName: `${appName}-tls` }],
      },
    }
    await networkingV1.createNamespacedIngress(cfg.stagingNamespace, newIngress)
  }
}

async function removeIngressRule(appName: string, domain: string) {
  const ingress = await getIngress(appName)
  if (!ingress || !ingress.spec?.rules) return
  ingress.spec.rules = ingress.spec.rules.filter(r => r.host !== domain)
  await networkingV1.replaceNamespacedIngress(appName, cfg.stagingNamespace, ingress)
}

interface AddDomainBody {
  domain: string
}

export async function customDomainsRoutes(app: FastifyInstance) {
  // GET /apps/:name/domains
  app.get<{ Params: { name: string } }>('/apps/:name/domains', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { rows: appRows } = await app.pg.query('SELECT id, owner FROM apps WHERE name = $1', [req.params.name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id, domain, verified, cert_status, created_at
       FROM custom_domains WHERE app_name = $1 ORDER BY created_at ASC`,
      [req.params.name],
    )
    return rows
  })

  // POST /apps/:name/domains
  app.post<{ Params: { name: string }; Body: AddDomainBody }>('/apps/:name/domains', {
    schema: {
      body: {
        type: 'object',
        required: ['domain'],
        properties: {
          domain: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params
    const { domain } = req.body

    const { rows: appRows } = await app.pg.query('SELECT id, owner FROM apps WHERE name = $1', [name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const verifyToken = `tinai-${name}-${randomBytes(4).toString('hex')}`

    const { rows: existing } = await app.pg.query(
      'SELECT id FROM custom_domains WHERE domain = $1', [domain],
    )
    if (existing.length) return reply.status(409).send({ error: 'domain already registered' })

    const { rows: [record] } = await app.pg.query(
      `INSERT INTO custom_domains (app_name, domain, verify_token)
       VALUES ($1, $2, $3) RETURNING id, domain, verified, cert_status, created_at`,
      [name, domain, verifyToken],
    )

    // Wire K8s Ingress (best-effort; don't fail the request if K8s is unavailable)
    try {
      await upsertIngressRule(name, domain)
    } catch (err) {
      app.log.warn({ err }, 'failed to update ingress for custom domain')
    }

    return reply.status(201).send({
      ...record,
      verify_txt_name:  `_tinai-verify.${domain}`,
      verify_txt_value: verifyToken,
    })
  })

  // DELETE /apps/:name/domains/:domain
  app.delete<{ Params: { name: string; domain: string } }>(
    '/apps/:name/domains/:domain',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, domain } = req.params

      const { rows: appRows } = await app.pg.query('SELECT id, owner FROM apps WHERE name = $1', [name])
      if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
      if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const result = await app.pg.query(
        'DELETE FROM custom_domains WHERE app_name = $1 AND domain = $2',
        [name, domain],
      )
      if (!result.rowCount) return reply.status(404).send({ error: 'domain not found' })

      try {
        await removeIngressRule(name, domain)
      } catch (err) {
        app.log.warn({ err }, 'failed to remove ingress rule for deleted domain')
      }

      return reply.status(204).send()
    },
  )

  // POST /apps/:name/domains/:domain/verify
  app.post<{ Params: { name: string; domain: string } }>(
    '/apps/:name/domains/:domain/verify',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, domain } = req.params

      const { rows: appRows } = await app.pg.query('SELECT id, owner FROM apps WHERE name = $1', [name])
      if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
      if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      // Fetch the stored verification token before updating.
      const { rows: tokenRows } = await app.pg.query(
        'SELECT verify_token FROM custom_domains WHERE app_name = $1 AND domain = $2',
        [name, domain],
      )
      if (!tokenRows.length) return reply.status(404).send({ error: 'domain not found' })

      const verificationToken: string = tokenRows[0].verify_token
      const expectedToken = `tinai-verify=${verificationToken}`

      // Perform real DNS TXT lookup on the verification subdomain.
      const records = await dns.resolveTxt(`_tinai-verify.${domain}`).catch(() => [] as string[][])
      const flat = records.flat()
      if (!flat.some(r => r === expectedToken)) {
        return reply.status(400).send({
          error: 'DNS TXT record not found',
          expected: expectedToken,
          hint: `Add a TXT record: _tinai-verify.${domain} → ${expectedToken}`,
        })
      }

      const { rows } = await app.pg.query(
        `UPDATE custom_domains SET verified = true, cert_status = 'issuing'
         WHERE app_name = $1 AND domain = $2
         RETURNING id, domain, verified, cert_status`,
        [name, domain],
      )

      return rows[0]
    },
  )
}
