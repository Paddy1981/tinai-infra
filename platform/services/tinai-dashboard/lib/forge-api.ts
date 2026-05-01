// Typed API client for Forge backend endpoints
// All forge API calls proxy through next.config.ts rewrites: /api/forge/* → tinai-api /api/v1/forge/*

export interface ForgeProduct {
  id: string
  name: string
  repo: string
  current_version: string
  latest_version: string
  status: 'up_to_date' | 'update_available' | 'building' | 'rolling_out' | 'failed'
  last_checked_at: string
}

export interface ForgeSummary {
  total_products: number
  up_to_date: number
  updates_available: number
  builds_in_progress: number
  rollouts_in_progress: number
  last_check: string
  forge_status?: 'not_deployed'
}

export interface ForgeBuild {
  id: string
  product_id: string
  version: string
  status: 'queued' | 'building' | 'success' | 'failed'
  image: string
  started_at: string
  finished_at?: string
  duration_seconds?: number
  cts_passed?: boolean
  error_message?: string
}

export interface ForgeRollout {
  id: string
  product_id: string
  from_version: string
  to_version: string
  strategy: 'bigbang' | 'rolling' | 'canary'
  status: 'in_progress' | 'completed' | 'paused' | 'rolled_back' | 'failed' | 'partially_completed'
  total_tenants: number
  completed_tenants: number
  failed_tenants: number
  started_at: string
  completed_at?: string
}

const BASE = '/api/forge'

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

export const forgeApi = {
  getSummary: () => apiFetch<ForgeSummary>('/summary'),

  getProducts: () => apiFetch<ForgeProduct[]>('/products'),

  checkProduct: (id: string) =>
    apiFetch<{ update_available: boolean; latest_version: string }>(`/products/${id}/check`, {
      method: 'POST',
    }),

  buildProduct: (id: string) =>
    apiFetch<{ build_id: string; status: string }>(`/products/${id}/build`, {
      method: 'POST',
      body: '{}',
    }),

  getBuilds: (params?: { product?: string; status?: string; limit?: number }) => {
    const qs = new URLSearchParams()
    if (params?.product) qs.set('product', params.product)
    if (params?.status) qs.set('status', params.status)
    if (params?.limit) qs.set('limit', String(params.limit))
    return apiFetch<ForgeBuild[]>(`/builds${qs.toString() ? '?' + qs : ''}`)
  },

  getRollouts: (params?: { active?: boolean; product?: string }) => {
    const qs = new URLSearchParams()
    if (params?.active) qs.set('active', 'true')
    if (params?.product) qs.set('product', params.product)
    return apiFetch<ForgeRollout[]>(`/rollouts${qs.toString() ? '?' + qs : ''}`)
  },

  getRollout: (id: string) =>
    apiFetch<
      ForgeRollout & {
        tenant_statuses?: Array<{ tenant_id: string; status: string; updated_at?: string }>
      }
    >(`/rollouts/${id}`),

  startRollout: (productId: string, strategy = 'auto') =>
    apiFetch<{ rollout_id: string }>('/rollouts', {
      method: 'POST',
      body: JSON.stringify({ product_id: productId, strategy }),
    }),

  pauseRollout: (id: string) =>
    apiFetch<void>(`/rollouts/${id}/pause`, { method: 'POST' }),
  resumeRollout: (id: string) =>
    apiFetch<void>(`/rollouts/${id}/resume`, { method: 'POST' }),
  rollbackRollout: (id: string) =>
    apiFetch<void>(`/rollouts/${id}/rollback`, { method: 'POST' }),
}
