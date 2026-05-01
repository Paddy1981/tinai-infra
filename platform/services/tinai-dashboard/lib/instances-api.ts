import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

async function authHeaders(): Promise<HeadersInit> {
  const token = (await cookies()).get('tinai_token')?.value
  return token ? { Authorization: `Bearer ${token}` } : {}
}

// Types matching the instances API
export interface InstanceImage {
  id: number
  slug: string
  name: string
  version: string
  category: 'pre-built' | 'base-os' | 'custom'
  framework: string | null
  cuda_version: string | null
  python_version: string | null
  os_version: string
  description: string
  docker_image: string
  tags: string[]
}

export interface InstanceType {
  id: number
  slug: string
  name: string
  category: 'gpu' | 'cpu'
  gpu_model: string | null
  gpu_count: number
  vram_gb: number | null
  vcpu: number
  ram_gb: number
  storage_gb: number
  price_per_hour_paise: number
  price_formatted: string  // "₹189/hr"
  is_available: boolean
}

export interface Instance {
  id: string
  name: string
  status: 'provisioning' | 'running' | 'stopping' | 'stopped' | 'error'
  image: InstanceImage
  instance_type: InstanceType
  ssh_host: string | null
  ssh_port: number | null
  jupyter_url: string | null
  volume_size_gb: number
  started_at: string | null
  created_at: string
}

export async function listInstanceImages(category?: string): Promise<InstanceImage[]> {
  const url = category
    ? `${API_URL}/api/v1/instances/images?category=${encodeURIComponent(category)}`
    : `${API_URL}/api/v1/instances/images`
  const res = await fetch(url, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list instance images: ${res.status}`)
  return res.json()
}

export async function listInstanceTypes(): Promise<InstanceType[]> {
  const res = await fetch(`${API_URL}/api/v1/instances/types`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list instance types: ${res.status}`)
  return res.json()
}

export async function listInstances(): Promise<Instance[]> {
  const res = await fetch(`${API_URL}/api/v1/instances`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list instances: ${res.status}`)
  return res.json()
}
