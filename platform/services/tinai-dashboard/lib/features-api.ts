import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

async function authHeaders(): Promise<HeadersInit> {
  const token = (await cookies()).get('tinai_token')?.value
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface MetricPoint {
  timestamp: string
  cpu_cores: number
  memory_bytes: number
  memory_mb: number
}

export interface AppMetrics {
  app_name: string
  period: string
  points: MetricPoint[]
}

export async function getAppMetrics(name: string, period = '24h'): Promise<AppMetrics> {
  const res = await fetch(`${API_URL}/api/v1/metrics/${name}?period=${period}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get metrics: ${res.status}`)
  return res.json()
}

// ── Metrics Summary ───────────────────────────────────────────────────────────

export interface MetricsSummary {
  app_name: string
  avg_cpu: number
  max_cpu: number
  avg_memory_mb: number
  max_memory_mb: number
  total_cost_paise: number
}

export async function getMetricsSummary(): Promise<MetricsSummary[]> {
  const res = await fetch(`${API_URL}/api/v1/metrics/summary`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get metrics summary: ${res.status}`)
  return res.json()
}

// ── Custom Domains ────────────────────────────────────────────────────────────

export interface CustomDomain {
  id: string
  app_name: string
  domain: string
  verified: boolean
  cert_status: string
  created_at: string
}

export async function listDomains(appName: string): Promise<CustomDomain[]> {
  const res = await fetch(`${API_URL}/api/v1/apps/${appName}/domains`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list domains: ${res.status}`)
  return res.json()
}

// ── Volumes ───────────────────────────────────────────────────────────────────

export interface AppVolume {
  id: string
  app_name: string
  volume_name: string
  mount_path: string
  size_gi: number
  status: string
  created_at: string
}

export async function listVolumes(appName: string): Promise<AppVolume[]> {
  const res = await fetch(`${API_URL}/api/v1/apps/${appName}/volumes`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list volumes: ${res.status}`)
  return res.json()
}

// ── Templates ─────────────────────────────────────────────────────────────────

export interface ServiceTemplate {
  id: string
  name: string
  category: string
  description: string
  icon: string
  image: string
  port: number
  env: Record<string, string>
  requires_volume: boolean
}

export async function listTemplates(): Promise<ServiceTemplate[]> {
  const res = await fetch(`${API_URL}/api/v1/templates`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list templates: ${res.status}`)
  return res.json()
}

export async function getTemplate(id: string): Promise<ServiceTemplate> {
  const res = await fetch(`${API_URL}/api/v1/templates/${id}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get template: ${res.status}`)
  return res.json()
}

// ── Databases ─────────────────────────────────────────────────────────────────

export interface AppDatabase {
  id: string
  app_name: string
  db_name: string
  host: string
  port: number
  username: string
  status: string
  region: string
  created_at: string
  pgvector_enabled?: boolean
}

export async function getAppDatabase(appName: string): Promise<AppDatabase | null> {
  const res = await fetch(`${API_URL}/api/v1/apps/${appName}/database`, { cache: 'no-store', headers: await authHeaders() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Failed to get database: ${res.status}`)
  return res.json()
}

// ── Storage Buckets ───────────────────────────────────────────────────────────

export interface StorageBucket {
  id: string
  app_name: string
  bucket_name: string
  public: boolean
  size_limit_mb: number
  created_at: string
}

export async function listStorageBuckets(appName: string): Promise<StorageBucket[]> {
  const res = await fetch(`${API_URL}/api/v1/apps/${appName}/storage`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list storage buckets: ${res.status}`)
  return res.json()
}
