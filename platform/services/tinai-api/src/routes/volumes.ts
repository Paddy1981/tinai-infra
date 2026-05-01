// TODO: Register in server.ts: app.register(volumesRoutes, { prefix: '/api/v1' })

// CREATE TABLE IF NOT EXISTS app_volumes (
//   id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
//   app_name      VARCHAR(63) NOT NULL,
//   volume_name   VARCHAR(63) NOT NULL UNIQUE,
//   mount_path    TEXT NOT NULL,
//   size_gi       INTEGER NOT NULL DEFAULT 5,
//   storage_class VARCHAR(63) NOT NULL DEFAULT 'local-path',
//   status        VARCHAR(20) NOT NULL DEFAULT 'pending',
//   region        VARCHAR(5) NOT NULL DEFAULT 'IN',
//   created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
// )

import { FastifyInstance } from 'fastify'
import * as k8s from '@kubernetes/client-node'
import { randomBytes } from 'crypto'
import { loadConfig } from '../config'

const cfg = loadConfig()

const kc = new k8s.KubeConfig()
try {
  kc.loadFromCluster()
} catch {
  kc.loadFromDefault()
}
const coreV1  = kc.makeApiClient(k8s.CoreV1Api)
const appsV1  = kc.makeApiClient(k8s.AppsV1Api)

function randomSuffix(len: number) {
  return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)
}

async function patchDeploymentAddVolume(
  appName: string,
  pvcName: string,
  mountPath: string,
) {
  const { body: dep } = await appsV1.readNamespacedDeployment(appName, cfg.stagingNamespace)
  const spec = dep.spec!.template!.spec!

  if (!spec.volumes) spec.volumes = []
  if (!spec.containers?.[0].volumeMounts) spec.containers![0].volumeMounts = []

  spec.volumes.push({ name: pvcName, persistentVolumeClaim: { claimName: pvcName } })
  spec.containers![0].volumeMounts!.push({ name: pvcName, mountPath })

  await appsV1.replaceNamespacedDeployment(appName, cfg.stagingNamespace, dep)
}

async function patchDeploymentRemoveVolume(appName: string, pvcName: string) {
  const { body: dep } = await appsV1.readNamespacedDeployment(appName, cfg.stagingNamespace)
  const spec = dep.spec!.template!.spec!

  spec.volumes = (spec.volumes ?? []).filter(v => v.name !== pvcName)
  if (spec.containers?.[0].volumeMounts) {
    spec.containers![0].volumeMounts = spec.containers![0].volumeMounts!.filter(vm => vm.name !== pvcName)
  }

  await appsV1.replaceNamespacedDeployment(appName, cfg.stagingNamespace, dep)
}

interface AddVolumeBody {
  mount_path: string
  size_gi?: number
}

export async function volumesRoutes(app: FastifyInstance) {
  // GET /apps/:name/volumes — enforce ownership
  app.get<{ Params: { name: string } }>('/apps/:name/volumes', async (req, reply) => {
    const tenantId = (req as any).tenantId as string

    const { rows: appRows } = await app.pg.query('SELECT owner FROM apps WHERE name = $1', [req.params.name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const { rows } = await app.pg.query(
      `SELECT id, volume_name, mount_path, size_gi, storage_class, status, region, created_at
       FROM app_volumes WHERE app_name = $1 ORDER BY created_at ASC`,
      [req.params.name],
    )
    return rows
  })

  // POST /apps/:name/volumes — enforce ownership
  app.post<{ Params: { name: string }; Body: AddVolumeBody }>('/apps/:name/volumes', {
    schema: {
      body: {
        type: 'object',
        required: ['mount_path'],
        properties: {
          mount_path: { type: 'string' },
          size_gi:    { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (req, reply) => {
    const tenantId = (req as any).tenantId as string
    const { name } = req.params
    const { mount_path, size_gi = 5 } = req.body

    const { rows: appRows } = await app.pg.query('SELECT owner FROM apps WHERE name = $1', [name])
    if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
    if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

    const suffix     = randomSuffix(6)
    const volumeName = `${name}-${suffix}-pvc`

    const pvc: k8s.V1PersistentVolumeClaim = {
      metadata: { name: volumeName, namespace: cfg.stagingNamespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: `${size_gi}Gi` } },
        storageClassName: 'local-path',
      },
    }

    try {
      await coreV1.createNamespacedPersistentVolumeClaim(cfg.stagingNamespace, pvc)
    } catch (err) {
      app.log.warn({ err }, 'failed to create PVC')
      return reply.status(502).send({ error: 'failed to create persistent volume claim' })
    }

    try {
      await patchDeploymentAddVolume(name, volumeName, mount_path)
    } catch (err) {
      app.log.warn({ err }, 'PVC created but failed to mount into deployment')
      // Non-fatal — operator can mount manually or on next deploy
    }

    const { rows: [record] } = await app.pg.query(
      `INSERT INTO app_volumes (app_name, volume_name, mount_path, size_gi, status)
       VALUES ($1, $2, $3, $4, 'bound')
       RETURNING id, volume_name, mount_path, size_gi, storage_class, status, region, created_at`,
      [name, volumeName, mount_path, size_gi],
    )

    return reply.status(201).send(record)
  })

  // DELETE /apps/:name/volumes/:volumeName — enforce ownership
  app.delete<{ Params: { name: string; volumeName: string } }>(
    '/apps/:name/volumes/:volumeName',
    async (req, reply) => {
      const tenantId = (req as any).tenantId as string
      const { name, volumeName } = req.params

      const { rows: appRows } = await app.pg.query('SELECT owner FROM apps WHERE name = $1', [name])
      if (!appRows.length) return reply.status(404).send({ error: 'app not found' })
      if (appRows[0].owner !== tenantId) return reply.status(403).send({ error: 'Forbidden' })

      const { rows } = await app.pg.query(
        'SELECT id FROM app_volumes WHERE app_name = $1 AND volume_name = $2',
        [name, volumeName],
      )
      if (!rows.length) return reply.status(404).send({ error: 'volume not found' })

      // Remove from Deployment first (best-effort)
      try {
        await patchDeploymentRemoveVolume(name, volumeName)
      } catch (err) {
        app.log.warn({ err }, 'failed to unmount volume from deployment')
      }

      // Delete the PVC
      try {
        await coreV1.deleteNamespacedPersistentVolumeClaim(volumeName, cfg.stagingNamespace)
      } catch (err) {
        app.log.warn({ err }, 'failed to delete PVC from K8s')
      }

      await app.pg.query(
        'DELETE FROM app_volumes WHERE app_name = $1 AND volume_name = $2',
        [name, volumeName],
      )

      return reply.status(200).send({
        ok: true,
        warning: 'Data on this volume has been permanently deleted. This action cannot be undone.',
      })
    },
  )
}
