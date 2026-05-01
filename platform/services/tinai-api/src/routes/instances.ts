import { FastifyInstance } from 'fastify'

const FREE_TIER_MAX_RUNNING = 5

/** Format paise (integer) as a human-readable INR string, e.g. 18900 → "₹189/hr" */
function formatPaise(paise: number): string {
  const rupees = paise / 100
  return `₹${rupees % 1 === 0 ? rupees.toFixed(0) : rupees.toFixed(2)}/hr`
}

interface LaunchInstanceBody {
  name: string
  image_slug: string
  instance_type_slug: string
  volume_size_gb?: number
}

export async function instancesRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------------------
  // GET /instances/images — list all active images; optional ?category= filter
  // ---------------------------------------------------------------------------
  app.get<{ Querystring: { category?: string } }>('/instances/images', async (req, reply) => {
    const { category } = req.query

    const validCategories = ['pre-built', 'base-os', 'custom']
    if (category && !validCategories.includes(category)) {
      return reply.status(400).send({
        error: `invalid category; must be one of: ${validCategories.join(', ')}`,
      })
    }

    const { rows } = category
      ? await app.pg.query(
          `SELECT id, slug, name, version, category, framework, cuda_version, python_version,
                  os_version, description, docker_image, tags, is_active, created_at
           FROM instance_images
           WHERE is_active = true AND category = $1
           ORDER BY category, name`,
          [category],
        )
      : await app.pg.query(
          `SELECT id, slug, name, version, category, framework, cuda_version, python_version,
                  os_version, description, docker_image, tags, is_active, created_at
           FROM instance_images
           WHERE is_active = true
           ORDER BY category, name`,
        )

    return rows
  })

  // ---------------------------------------------------------------------------
  // GET /instances/types — list available instance type SKUs with formatted pricing
  // ---------------------------------------------------------------------------
  app.get('/instances/types', async (_req, _reply) => {
    const { rows } = await app.pg.query(
      `SELECT id, slug, name, category, gpu_model, gpu_count, vram_gb, vcpu, ram_gb,
              storage_gb, price_per_hour_paise, is_available, created_at
       FROM instance_types
       WHERE is_available = true
       ORDER BY category DESC, price_per_hour_paise ASC`,
    )

    return rows.map((row: any) => ({
      ...row,
      price_per_hour_inr: formatPaise(row.price_per_hour_paise),
    }))
  })

  // ---------------------------------------------------------------------------
  // GET /instances — list tenant's instances joined with image + type info
  // ---------------------------------------------------------------------------
  app.get('/instances', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    const { rows } = await app.pg.query(
      `SELECT
         i.id, i.name, i.status, i.pod_name, i.namespace,
         i.ssh_host, i.ssh_port, i.jupyter_url, i.volume_size_gb,
         i.started_at, i.stopped_at, i.created_at,
         img.slug  AS image_slug,  img.name  AS image_name,
         img.version AS image_version, img.framework, img.cuda_version,
         img.docker_image,
         it.slug   AS type_slug,   it.name   AS type_name,
         it.category AS type_category, it.gpu_model, it.gpu_count,
         it.vram_gb, it.vcpu, it.ram_gb,
         it.price_per_hour_paise
       FROM instances i
       JOIN instance_images img ON img.id = i.image_id
       JOIN instance_types  it  ON it.id  = i.instance_type_id
       WHERE i.tenant_id = $1
       ORDER BY i.created_at DESC`,
      [tenantId],
    )

    return rows.map((row: any) => ({
      ...row,
      price_per_hour_inr: formatPaise(row.price_per_hour_paise),
    }))
  })

  // ---------------------------------------------------------------------------
  // POST /instances — launch a new instance
  // ---------------------------------------------------------------------------
  app.post<{ Body: LaunchInstanceBody }>(
    '/instances',
    {
      schema: {
        body: {
          type: 'object',
          required: ['name', 'image_slug', 'instance_type_slug'],
          properties: {
            name:               { type: 'string', minLength: 1, maxLength: 63 },
            image_slug:         { type: 'string' },
            instance_type_slug: { type: 'string' },
            volume_size_gb:     { type: 'integer', minimum: 10, maximum: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, image_slug, instance_type_slug, volume_size_gb = 50 } = req.body

      // Resolve image
      const { rows: imageRows } = await app.pg.query(
        `SELECT id FROM instance_images WHERE slug = $1 AND is_active = true`,
        [image_slug],
      )
      if (!imageRows.length) {
        return reply.status(404).send({ error: `image '${image_slug}' not found or inactive` })
      }
      const imageId = imageRows[0].id

      // Resolve instance type
      const { rows: typeRows } = await app.pg.query(
        `SELECT id FROM instance_types WHERE slug = $1 AND is_available = true`,
        [instance_type_slug],
      )
      if (!typeRows.length) {
        return reply.status(404).send({ error: `instance type '${instance_type_slug}' not found or unavailable` })
      }
      const instanceTypeId = typeRows[0].id

      // Free tier guard: max 5 running instances per tenant
      const { rows: runningRows } = await app.pg.query(
        `SELECT COUNT(*)::int AS cnt
         FROM instances
         WHERE tenant_id = $1 AND status IN ('provisioning','running')`,
        [tenantId],
      )
      if (runningRows[0].cnt >= FREE_TIER_MAX_RUNNING) {
        return reply.status(429).send({
          error: `free tier limit reached: you may have at most ${FREE_TIER_MAX_RUNNING} running instances`,
        })
      }

      const { rows: [instance] } = await app.pg.query(
        `INSERT INTO instances
           (tenant_id, name, image_id, instance_type_id, volume_size_gb, status)
         VALUES ($1, $2, $3, $4, $5, 'provisioning')
         RETURNING id, tenant_id, name, status, volume_size_gb, created_at`,
        [tenantId, name, imageId, instanceTypeId, volume_size_gb],
      )

      // Notify provisioner service (best-effort; it also polls DB directly as fallback)
      const provisionerUrl = process.env.PROVISIONER_URL ?? 'http://tinai-instances.tinai-instances.svc.cluster.local'
      try {
        await fetch(`${provisionerUrl}/provision`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instance_id: instance.id }),
        })
      } catch (err) {
        // provisioner notified best-effort; it polls DB directly as fallback
        req.log.warn({ err, instance_id: instance.id }, 'provisioner notify failed — will self-heal via polling')
      }

      return reply.status(201).send(instance)
    },
  )

  // ---------------------------------------------------------------------------
  // GET /instances/:id — get single instance details
  // ---------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>('/instances/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT
         i.id, i.name, i.status, i.pod_name, i.namespace,
         i.ssh_host, i.ssh_port, i.jupyter_url, i.volume_size_gb,
         i.started_at, i.stopped_at, i.created_at,
         img.slug  AS image_slug,  img.name  AS image_name,
         img.version AS image_version, img.framework, img.cuda_version,
         img.docker_image,
         it.slug   AS type_slug,   it.name   AS type_name,
         it.category AS type_category, it.gpu_model, it.gpu_count,
         it.vram_gb, it.vcpu, it.ram_gb,
         it.price_per_hour_paise
       FROM instances i
       JOIN instance_images img ON img.id = i.image_id
       JOIN instance_types  it  ON it.id  = i.instance_type_id
       WHERE i.id = $1`,
      [id],
    )

    if (!rows.length) return reply.status(404).send({ error: 'instance not found' })

    const instance = rows[0]
    if (instance.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    return {
      ...instance,
      price_per_hour_inr: formatPaise(instance.price_per_hour_paise),
    }
  })

  // ---------------------------------------------------------------------------
  // DELETE /instances/:id — stop/delete instance (tenant must own it)
  // ---------------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>('/instances/:id', async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { id } = req.params

    const { rows } = await app.pg.query(
      `SELECT id, tenant_id, status FROM instances WHERE id = $1`,
      [id],
    )
    if (!rows.length) return reply.status(404).send({ error: 'instance not found' })

    const instance = rows[0]
    if (instance.tenant_id !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    if (instance.status === 'stopped') {
      return reply.status(409).send({ error: 'instance is already stopped' })
    }

    if (instance.status === 'stopping') {
      return reply.status(409).send({ error: 'instance is already stopping' })
    }

    // Transition: provisioning/running/error → stopping → stopped
    // The provisioner will pick up 'stopping' instances and terminate the K8s pod,
    // then update status to 'stopped' and set stopped_at.
    await app.pg.query(
      `UPDATE instances SET status = 'stopping' WHERE id = $1`,
      [id],
    )

    // For now, immediately mark as stopped (provisioner will handle this in next sprint).
    // TODO: Remove the immediate 'stopped' update once the provisioner is in place.
    await app.pg.query(
      `UPDATE instances SET status = 'stopped', stopped_at = NOW() WHERE id = $1`,
      [id],
    )

    return reply.status(200).send({ ok: true, id, status: 'stopped' })
  })
}
