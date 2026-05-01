const CSRF = { 'x-tinai-csrf': '1' }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InferenceModel {
  id: number
  provider: string
  model_id: string
  name: string
  context_window: number
  input_price_per_1m_paise: number
  output_price_per_1m_paise: number
}

export interface InferenceEndpoint {
  id: string
  tenant_id: string
  name: string
  provider: string
  model: string
  model_name?: string
  rpm_limit: number
  tpm_limit: number
  monthly_budget_paise: number
  status: string
  created_at: string
}

export interface InferenceUsageDay {
  day: string
  request_count: number
  input_tokens: number
  output_tokens: number
  cost_paise: number
}

// ── Model helpers ─────────────────────────────────────────────────────────────

export async function listModels(): Promise<InferenceModel[]> {
  const res = await fetch('/api/v1/inference/models')
  if (!res.ok) throw new Error(`Failed to list models: ${res.status}`)
  return res.json()
}

// ── Endpoint helpers ──────────────────────────────────────────────────────────

export async function listEndpoints(): Promise<InferenceEndpoint[]> {
  const res = await fetch('/api/v1/inference/endpoints')
  if (!res.ok) throw new Error(`Failed to list endpoints: ${res.status}`)
  return res.json()
}

export async function createEndpoint(body: {
  name: string
  provider: string
  model: string
  rpm_limit: number
  tpm_limit: number
  monthly_budget_paise: number
}): Promise<InferenceEndpoint> {
  const res = await fetch('/api/v1/inference/endpoints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.detail ?? `Server error: ${res.status}`)
  }
  return res.json()
}

export async function patchEndpoint(
  id: string,
  body: Partial<{ status: string; rpm_limit: number; tpm_limit: number; monthly_budget_paise: number }>
): Promise<InferenceEndpoint> {
  const res = await fetch(`/api/v1/inference/endpoints/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.detail ?? `Server error: ${res.status}`)
  }
  return res.json()
}

export async function deleteEndpoint(id: string): Promise<void> {
  const res = await fetch(`/api/v1/inference/endpoints/${id}`, {
    method: 'DELETE',
    headers: CSRF,
  })
  if (!res.ok) throw new Error(`Failed to delete endpoint: ${res.status}`)
}

export async function getEndpointUsage(id: string, days = 30): Promise<InferenceUsageDay[]> {
  const res = await fetch(`/api/v1/inference/endpoints/${id}/usage?days=${days}`)
  if (!res.ok) throw new Error(`Failed to fetch usage for endpoint ${id}: ${res.status}`)
  return res.json()
}
