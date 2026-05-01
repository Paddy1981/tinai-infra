import { FastifyInstance } from 'fastify'
import { Pool } from 'pg'

const spaceDatabaseUrl = process.env.SPACE_DATABASE_URL
const spacePool = spaceDatabaseUrl ? new Pool({ connectionString: spaceDatabaseUrl }) : null

interface Satellite {
  id: number
  norad_id: number
  name: string
  country: string
  category: string
  epoch: string | null
  updated_at: string
  tle_line1: string
  tle_line2: string
}

const STAC_ROOT = {
  type: 'Catalog',
  id: 'tinai-space-catalog',
  title: 'Tinai Space Data Catalog',
  description: 'STAC-compatible catalog for Indian space economy data',
  stac_version: '1.0.0',
  links: [
    { rel: 'self', href: '/api/v1/space/stac', type: 'application/json' },
    { rel: 'collections', href: '/api/v1/space/stac/collections', type: 'application/json' },
  ],
  conformsTo: [
    'https://api.stacspec.org/v1.0.0/core',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
  ],
}

const STAC_COLLECTIONS = {
  collections: [
    {
      id: 'isro-eo',
      title: 'ISRO Earth Observation Archive',
      description: 'Satellite imagery from CARTOSAT, RESOURCESAT, RISAT missions',
      stac_version: '1.0.0',
      extent: {
        spatial: { bbox: [[68.0, 6.0, 97.0, 37.0]] },
        temporal: { interval: [['2000-01-01T00:00:00Z', null]] },
      },
      links: [],
    },
    {
      id: 'inspace-startups',
      title: 'IN-SPACe Startup Datasets',
      description: 'Curated datasets from IN-SPACe registered space technology startups',
      stac_version: '1.0.0',
      extent: {
        spatial: { bbox: [[68.0, 6.0, 97.0, 37.0]] },
        temporal: { interval: [['2020-01-01T00:00:00Z', null]] },
      },
      links: [],
    },
  ],
  links: [{ rel: 'self', href: '/api/v1/space/stac/collections' }],
}

export async function spaceRoutes(app: FastifyInstance) {
  // GET /space/satellites
  app.get('/space/satellites', async (_req, reply) => {
    if (!spacePool) return reply.send({ total: 0, satellites: [], error: 'space database not configured' })
    try {
      const { rows } = await spacePool.query<Satellite>(
        `SELECT id, norad_id, name, country, category, epoch, updated_at, tle_line1, tle_line2
         FROM satellites
         ORDER BY country, name
         LIMIT 200`,
      )
      return reply.send({ total: rows.length, satellites: rows })
    } catch {
      return reply.send({ total: 0, satellites: [], error: 'space database unavailable' })
    }
  })

  // GET /space/satellites/:noradId
  app.get<{ Params: { noradId: string } }>('/space/satellites/:noradId', async (req, reply) => {
    const noradId = parseInt(req.params.noradId, 10)
    if (isNaN(noradId)) {
      return reply.status(400).send({ error: 'invalid norad_id' })
    }
    if (!spacePool) return reply.status(503).send({ error: 'space database not configured' })
    try {
      const { rows } = await spacePool.query<Satellite>(
        `SELECT id, norad_id, name, country, category, epoch, updated_at
         FROM satellites
         WHERE norad_id = $1`,
        [noradId],
      )
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'satellite not found' })
      }
      return reply.send(rows[0])
    } catch {
      return reply.status(503).send({ error: 'space database unavailable' })
    }
  })

  // GET /space/stac
  app.get('/space/stac', async (_req, reply) => {
    return reply.send(STAC_ROOT)
  })

  // GET /space/stac/collections
  app.get('/space/stac/collections', async (_req, reply) => {
    return reply.send(STAC_COLLECTIONS)
  })
}
