import { FastifyInstance } from 'fastify'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a human name into a URL-safe slug, e.g. "My Project!" → "my-project" */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ---------------------------------------------------------------------------
// Body shapes
// ---------------------------------------------------------------------------

interface CreateProjectBody {
  name: string
  description?: string
}

interface UpdateProjectBody {
  name?: string
  description?: string
}

interface CreateEnvironmentBody {
  name: 'production' | 'staging' | 'development' | 'preview'
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function projectsRoutes(app: FastifyInstance) {

  // -------------------------------------------------------------------------
  // POST /projects — create project + 3 default environments
  // -------------------------------------------------------------------------
  app.post<{ Body: CreateProjectBody }>(
    '/projects',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, description } = req.body
      const slug = slugify(name)

      // Check slug uniqueness for this tenant
      const { rows: existing } = await app.pg.query(
        `SELECT id FROM projects WHERE tenant_id = $1 AND slug = $2`,
        [tenantId, slug],
      )
      if (existing.length) {
        return reply.status(409).send({ error: `a project with slug "${slug}" already exists` })
      }

      const { rows: [project] } = await app.pg.query(
        `INSERT INTO projects (tenant_id, name, slug, description)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, name, slug, description ?? null],
      )

      // Create 3 default environments
      const defaultEnvs: Array<'production' | 'staging' | 'development'> = [
        'production',
        'staging',
        'development',
      ]

      const environments = []
      for (const envName of defaultEnvs) {
        const { rows: [env] } = await app.pg.query(
          `INSERT INTO environments (project_id, tenant_id, name, slug)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [project.id, tenantId, envName, envName],
        )
        environments.push(env)
      }

      return reply.status(201).send({ ...project, environments })
    },
  )

  // -------------------------------------------------------------------------
  // GET /projects — list tenant's projects with environment count
  // -------------------------------------------------------------------------
  app.get('/projects', async (req) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      `SELECT p.*,
              COUNT(e.id)::int AS environment_count
       FROM projects p
       LEFT JOIN environments e ON e.project_id = p.id
       WHERE p.tenant_id = $1
       GROUP BY p.id
       ORDER BY p.created_at DESC`,
      [tenantId],
    )

    return rows
  })

  // -------------------------------------------------------------------------
  // GET /projects/:id — get project with its environments
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows: [project] } = await app.pg.query(
      `SELECT * FROM projects WHERE id = $1`,
      [id],
    )

    if (!project) return reply.status(404).send({ error: 'project not found' })
    if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows: environments } = await app.pg.query(
      `SELECT * FROM environments WHERE project_id = $1 ORDER BY created_at ASC`,
      [id],
    )

    return { ...project, environments }
  })

  // -------------------------------------------------------------------------
  // PUT /projects/:id — update name / description
  // -------------------------------------------------------------------------
  app.put<{ Params: { id: string }; Body: UpdateProjectBody }>(
    '/projects/:id',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            name:        { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string' },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params

      const { rows: [existing] } = await app.pg.query(
        `SELECT * FROM projects WHERE id = $1`,
        [id],
      )
      if (!existing) return reply.status(404).send({ error: 'project not found' })
      if (existing.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const newName        = req.body.name        ?? existing.name
      const newDescription = req.body.description !== undefined ? req.body.description : existing.description
      // Re-slug only when name changes
      const newSlug = req.body.name ? slugify(req.body.name) : existing.slug

      // Guard against slug collision on rename
      if (newSlug !== existing.slug) {
        const { rows: clash } = await app.pg.query(
          `SELECT id FROM projects WHERE tenant_id = $1 AND slug = $2 AND id <> $3`,
          [tenantId, newSlug, id],
        )
        if (clash.length) {
          return reply.status(409).send({ error: `a project with slug "${newSlug}" already exists` })
        }
      }

      const { rows: [updated] } = await app.pg.query(
        `UPDATE projects
         SET name = $1, slug = $2, description = $3, updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [newName, newSlug, newDescription, id],
      )

      return updated
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /projects/:id — delete project + cascade
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows: [project] } = await app.pg.query(
      `SELECT id, tenant_id FROM projects WHERE id = $1`,
      [id],
    )
    if (!project) return reply.status(404).send({ error: 'project not found' })
    if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    await app.pg.query(`DELETE FROM projects WHERE id = $1`, [id])

    return reply.status(204).send()
  })

  // -------------------------------------------------------------------------
  // GET /projects/:id/environments — list environments
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/projects/:id/environments', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows: [project] } = await app.pg.query(
      `SELECT id, tenant_id FROM projects WHERE id = $1`,
      [id],
    )
    if (!project) return reply.status(404).send({ error: 'project not found' })
    if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT * FROM environments WHERE project_id = $1 ORDER BY created_at ASC`,
      [id],
    )

    return rows
  })

  // -------------------------------------------------------------------------
  // GET /projects/:id/apps — list apps linked to this project
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/projects/:id/apps', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows: [project] } = await app.pg.query(
      `SELECT id, tenant_id FROM projects WHERE id = $1`,
      [id],
    )
    if (!project) return reply.status(404).send({ error: 'project not found' })
    if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT name, repo_full_name, environment, domain, framework, created_at
       FROM apps WHERE project_id = $1 ORDER BY name ASC`,
      [id],
    )

    // Enrich with K8s deployment status and real domains
    const k8s = require('@kubernetes/client-node')
    const kc = new k8s.KubeConfig()
    kc.loadFromDefault()
    const appsV1 = kc.makeApiClient(k8s.AppsV1Api)
    const NAMESPACE = process.env.STAGING_NAMESPACE || 'tinai-apps'

    const enriched = await Promise.all(rows.map(async (row: any) => {
      // Get real custom domain for production
      const { rows: domainRows } = await app.pg.query(
        `SELECT domain FROM custom_domains WHERE app_name = $1 AND verified = true ORDER BY created_at ASC LIMIT 1`,
        [row.name],
      )
      const prodDomain = domainRows[0]?.domain ?? `${row.name}.tinai.cloud`

      const environments = []
      for (const env of ['production', 'staging', 'development']) {
        const depName = env === 'production' ? row.name : `${row.name}-${env}`
        const domain = env === 'production' ? prodDomain : `${env}-${row.name}.tinai.cloud`
        try {
          const { body: dep } = await appsV1.readNamespacedDeployment(depName, NAMESPACE)
          environments.push({
            environment: env,
            status: (dep.status?.readyReplicas ?? 0) >= (dep.spec?.replicas ?? 1) ? 'running' : 'deploying',
            ready_replicas: dep.status?.readyReplicas ?? 0,
            replicas: dep.spec?.replicas ?? 1,
            image: dep.spec?.template?.spec?.containers?.[0]?.image ?? '',
            domain,
          })
        } catch {
          environments.push({
            environment: env,
            status: 'not_deployed',
            ready_replicas: 0,
            replicas: 0,
            image: '',
            domain,
          })
        }
      }
      return { ...row, environments }
    }))

    return enriched
  })

  // -------------------------------------------------------------------------
  // POST /projects/:id/environments — create custom environment
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string }; Body: CreateEnvironmentBody }>(
    '/projects/:id/environments',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', enum: ['production', 'staging', 'development', 'preview'] },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id } = req.params
      const { name } = req.body

      const { rows: [project] } = await app.pg.query(
        `SELECT id, tenant_id FROM projects WHERE id = $1`,
        [id],
      )
      if (!project) return reply.status(404).send({ error: 'project not found' })
      if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      // Check for duplicate (UNIQUE constraint on project_id + name)
      const { rows: existing } = await app.pg.query(
        `SELECT id FROM environments WHERE project_id = $1 AND name = $2`,
        [id, name],
      )
      if (existing.length) {
        return reply.status(409).send({ error: `environment "${name}" already exists in this project` })
      }

      const { rows: [env] } = await app.pg.query(
        `INSERT INTO environments (project_id, tenant_id, name, slug)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [id, tenantId, name, name],
      )

      return reply.status(201).send(env)
    },
  )

  // -------------------------------------------------------------------------
  // DELETE /projects/:id/environments/:envId — delete environment
  //   (blocked for 'production')
  // -------------------------------------------------------------------------
  app.delete<{ Params: { id: string; envId: string } }>(
    '/projects/:id/environments/:envId',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { id, envId } = req.params

      const { rows: [project] } = await app.pg.query(
        `SELECT id, tenant_id FROM projects WHERE id = $1`,
        [id],
      )
      if (!project) return reply.status(404).send({ error: 'project not found' })
      if (project.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rows: [env] } = await app.pg.query(
        `SELECT id, name FROM environments WHERE id = $1 AND project_id = $2`,
        [envId, id],
      )
      if (!env) return reply.status(404).send({ error: 'environment not found' })

      if (env.name === 'production') {
        return reply.status(400).send({ error: 'cannot delete the production environment' })
      }

      await app.pg.query(`DELETE FROM environments WHERE id = $1`, [envId])

      return reply.status(204).send()
    },
  )
}
