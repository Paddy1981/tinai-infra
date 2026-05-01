import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

async function authHeaders(): Promise<HeadersInit> {
  const token = (await cookies()).get('tinai_token')?.value
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface Project {
  id: string
  tenant_id: string
  name: string
  slug: string
  description: string | null
  created_at: string
  updated_at: string
  team_id: string | null
  environment_count: number
}

export async function listProjects(): Promise<Project[]> {
  const res = await fetch(`${API_URL}/api/v1/projects`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list projects: ${res.status}`)
  return res.json()
}

export async function getProject(id: string): Promise<Project> {
  const res = await fetch(`${API_URL}/api/v1/projects/${id}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get project: ${res.status}`)
  return res.json()
}
