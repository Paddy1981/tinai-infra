import ServiceCanvas from './ServiceCanvas'
import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

export interface CanvasApp {
  name: string
  status: 'running' | 'deploying' | 'failed' | 'unknown'
  cpu_percent?: number
  image?: string
}

export interface CanvasDatabase {
  app_name: string
  db_name: string
  host: string
  status: string
}

export interface CanvasVolume {
  volume_name: string
  mount_path: string
  size_gi: number
  status: string
}

async function authFetch(path: string) {
  const token = (await cookies()).get('tinai_token')?.value
  const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {}
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers })
  if (!res.ok) return null
  return res.json()
}

export default async function CanvasPage() {
  let apps: CanvasApp[] = []
  let databases: CanvasDatabase[] = []
  let volumes: CanvasVolume[] = []

  try {
    const rawApps = await authFetch('/api/v1/apps')
    if (rawApps) {
      apps = (rawApps as any[]).map(a => ({
        name: a.name,
        status: a.deployment?.status ?? 'unknown',
        cpu_percent: undefined,
        image: a.deployment?.image ?? undefined,
      }))

      // Fetch DB + volumes for each app in parallel (best-effort)
      await Promise.all(
        apps.map(async a => {
          const [db, vols] = await Promise.all([
            authFetch(`/api/v1/apps/${a.name}/database`).catch(() => null),
            authFetch(`/api/v1/apps/${a.name}/volumes`).catch(() => null),
          ])
          if (db) databases.push({ app_name: a.name, ...db })
          if (vols && Array.isArray(vols)) {
            vols.forEach((v: any) => volumes.push({ ...v }))
          }
        })
      )
    }
  } catch {
    /* render empty canvas on error */
  }

  return (
    <ServiceCanvas
      initialApps={apps}
      initialDatabases={databases}
      initialVolumes={volumes}
    />
  )
}
