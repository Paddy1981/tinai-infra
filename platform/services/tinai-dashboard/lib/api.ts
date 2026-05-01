import { cookies } from 'next/headers'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'

export async function authFetch(path: string): Promise<unknown> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) return null
  return res.json()
}

async function authHeaders(): Promise<HeadersInit> {
  const token = (await cookies()).get('tinai_token')?.value
  if (!token) console.error('[api] No tinai_token cookie found')
  else console.log('[api] Token found, length:', token.length)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export interface App {
  id: string
  name: string
  owner: string
  repo_full_name: string
  created_at: string
  deployment?: {
    status: string
    ready_replicas: number
    replicas: number
    image: string
  }
}

export interface Build {
  name: string
  start_time: string
  completion_time: string | null
  status: string
}

export interface AppDetail extends App {
  recent_builds: Build[]
}

export async function listApps(): Promise<App[]> {
  const hdrs = await authHeaders()
  console.log('[listApps] API_URL:', API_URL, 'hasAuth:', !!hdrs['Authorization' as keyof typeof hdrs])
  const res = await fetch(`${API_URL}/api/v1/apps`, { cache: 'no-store', headers: hdrs })
  console.log('[listApps] response:', res.status)
  if (!res.ok) throw new Error(`Failed to list apps: ${res.status}`)
  const data = await res.json()
  console.log('[listApps] apps count:', data.length)
  return data
}

export async function getApp(name: string): Promise<AppDetail> {
  const res = await fetch(`${API_URL}/api/v1/apps/${name}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get app: ${res.status}`)
  return res.json()
}

export interface CreateAppRequest {
  name: string
  repoFullName?: string
  createRepo?: boolean
  framework?: 'nextjs' | 'node' | 'static' | 'go'
}

export interface CreateAppResponse extends App {
  framework: string | null
  domain: string
  provisioning: {
    provisioned: string[]
    errors: string[]
  }
}

export async function createApp(body: CreateAppRequest): Promise<CreateAppResponse> {
  const res = await fetch(`${API_URL}/api/v1/apps`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error((err as any).error ?? `Failed to create app: ${res.status}`)
  }
  return res.json()
}

export interface UsageRow {
  app_name: string
  cpu_core_hours: number
  memory_gb_hours: number
  estimated_paise: number
  estimated_inr: string
}

export interface Invoice {
  id: string
  tenant: string
  month: string
  subtotal_paise: number
  gst_paise: number
  total_paise: number
  status: string
  razorpay_order_id: string | null
  razorpay_payment_id: string | null
  payment_status: 'pending' | 'captured' | 'failed' | null
  created_at: string
}

export interface RazorpayOrderResponse {
  order_id: string
  amount: number
  currency: string
  key_id: string
}

export interface InvoiceLineItem {
  id: string
  description: string
  quantity: number
  unit_price_paise: number
  amount_paise: number
}

export interface InvoiceDetail extends Invoice {
  line_items: InvoiceLineItem[]
}

export async function getCurrentUsage(): Promise<UsageRow[]> {
  const res = await fetch(`${API_URL}/api/v1/billing/usage/current`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get usage: ${res.status}`)
  return res.json()
}

export async function listInvoices(): Promise<Invoice[]> {
  const res = await fetch(`${API_URL}/api/v1/billing/invoices`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list invoices: ${res.status}`)
  return res.json()
}

export async function generateInvoice(): Promise<{ invoice_id: string }> {
  const res = await fetch(`${API_URL}/api/v1/billing/invoices/generate`, { method: 'POST', cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to generate invoice: ${res.status}`)
  return res.json()
}

export async function createPaymentOrder(invoiceId: string): Promise<RazorpayOrderResponse> {
  const res = await fetch(`${API_URL}/api/v1/billing/payment-orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify({ invoice_id: invoiceId }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Failed to create payment order: ${res.status}`)
  return res.json()
}

export async function getPaymentStatus(invoiceId: string): Promise<Invoice> {
  const res = await fetch(`${API_URL}/api/v1/billing/payment-status/${invoiceId}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get payment status: ${res.status}`)
  return res.json()
}

export interface ResidencyReportSummary {
  id: string
  tenant: string
  generated_at: string
  hash: string
}

export interface ResidencyReport {
  report_id: string
  tenant: string
  generated_at: string
  data_residency: string
  cluster_region: string
  apps: Array<{
    name: string
    namespace: string
    pods: Array<{ name: string; node: string; node_region: string; node_zone: string; phase: string }>
    pvc_count: number
  }>
  nodes: Array<{ name: string; region: string; zone: string }>
  build_registry: string
  assertion: string
  hash: string
}

export async function generateResidencyReport(): Promise<ResidencyReport> {
  const res = await fetch(`${API_URL}/api/v1/compliance/residency-report`, { method: 'POST', cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to generate residency report: ${res.status}`)
  return res.json()
}

export async function listResidencyReports(): Promise<ResidencyReportSummary[]> {
  const res = await fetch(`${API_URL}/api/v1/compliance/residency-reports`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list residency reports: ${res.status}`)
  return res.json()
}

// ── Environment-aware deployments ─────────────────────────────────────────────

export type EnvSlug = 'production' | 'staging' | 'development'

export interface EnvironmentDeployment {
  environment: EnvSlug
  status: string
  ready_replicas: number
  replicas: number
  image: string
  domain: string | null
  branch: string | null
  deployed_at: string | null
}

export interface AppEnvironments {
  app_name: string
  environments: EnvironmentDeployment[]
}

export async function getAppEnvironments(name: string): Promise<AppEnvironments> {
  const res = await fetch(`${API_URL}/api/v1/apps/${name}/environments`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get app environments: ${res.status}`)
  return res.json()
}

export interface AppEnvVars {
  environment: EnvSlug
  vars: Record<string, string>
  auto_injected: Record<string, string>
}

export interface ProjectSecret {
  key: string
  created_at: string
}

export interface ProjectApp {
  name: string
  repo_full_name: string
  environments: EnvironmentDeployment[]
}

export interface ProjectDetail {
  id: string
  name: string
  slug: string
  description?: string
  created_at: string
  apps: ProjectApp[]
  secrets: ProjectSecret[]
}

export async function getProjectDetail(id: string): Promise<ProjectDetail> {
  const res = await fetch(`${API_URL}/api/v1/projects/${id}/detail`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get project detail: ${res.status}`)
  return res.json()
}

// ── Space vertical ────────────────────────────────────────────────────────────

export interface Satellite {
  id: number
  norad_id: number
  name: string
  country: string
  category: string
  epoch: string | null
  updated_at: string
  tle_line1?: string
  tle_line2?: string
}

export interface SatellitesResponse {
  total: number
  satellites: Satellite[]
  error?: string
}

export async function listSatellites(): Promise<SatellitesResponse> {
  const res = await fetch(`${API_URL}/api/v1/space/satellites`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list satellites: ${res.status}`)
  return res.json()
}

export async function getStacCollections(): Promise<{ collections: any[] }> {
  const res = await fetch(`${API_URL}/api/v1/space/stac/collections`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get STAC collections: ${res.status}`)
  return res.json()
}

export interface CopilotResponse {
  response: string
  model: string
  active: boolean
}

export async function promoteApp(appName: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/apps/${encodeURIComponent(appName)}/promote`, {
    method: 'POST',
    headers: await authHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Promote failed: ${res.statusText}`)
}

export async function rollbackApp(appName: string, env: string = 'staging'): Promise<void> {
  const res = await fetch(`${API_URL}/api/v1/apps/${encodeURIComponent(appName)}/rollback?ns=${env}`, {
    method: 'POST',
    headers: await authHeaders(),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Rollback failed: ${res.statusText}`)
}

export async function askCopilot(message: string, app?: string): Promise<CopilotResponse> {
  const body: Record<string, string> = { message }
  if (app) body.app = app
  const res = await fetch(`${API_URL}/api/v1/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`Copilot error: ${res.status}`)
  return res.json()
}

// ── Compliance API ──────────────────────────────────────────────────────────

export interface ConsentRecord {
  id: string
  tenant_id: string
  purpose: string
  legal_basis: string
  granted: boolean
  notice_version: string
  region: string
  granted_at: string
  withdrawn_at: string | null
}

export interface ConsentStatus {
  purpose: string
  granted: boolean
  granted_at: string
  withdrawn_at: string | null
}

export interface ProcessingActivity {
  id: string
  tenant_id: string
  activity_name: string
  purpose: string
  legal_basis: string
  data_categories: string[]
  data_subjects: string[]
  retention_days: number
  processors: string[]
  transfer_regions: string[]
  is_marketing: boolean
  created_at: string
  updated_at: string
}

export interface BreachIncident {
  id: string
  tenant_id: string | null
  region: string
  detected_at: string
  description: string | null
  affected_categories: string[]
  affected_records: number
  status: string
  notification_draft: { subject: string; body: string; recommended_actions: string[] } | null
  regulator_notified_at: string | null
  principals_notified_at: string | null
  resolved_at: string | null
  hours_remaining: number
  deadline_passed: boolean
}

export interface ErasureRequest {
  id: string
  tenant_id: string
  requester_email: string
  data_categories: string[]
  full_erasure: boolean
  status: string
  requested_at: string
  completed_at: string | null
  sla_deadline: string
}

export interface DpaStatus {
  IN: { signed: boolean; signed_at: string | null; version: string | null }
  QA: { signed: boolean; signed_at: string | null; version: string | null }
  AE: { signed: boolean; signed_at: string | null; version: string | null }
}

export interface DpiaAssessment {
  id: string
  tenant_id: string
  region: string
  status: string
  risk_level: string | null
  created_at: string
  completed_at: string | null
}

export interface PrivacyNotice {
  version: string
  region: string
  law: string
  regulator: string
  dpo_email: string
  data_categories: string[]
  retention_summary: string
  ai_disclosure: string
  sub_processors: string[]
  generated_at: string
}

export async function getConsentStatus(tenantId = 'tinai-admin'): Promise<ConsentStatus[]> {
  const res = await fetch(`${API_URL}/api/v1/compliance/consent/status/${tenantId}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get consent status: ${res.status}`)
  return res.json()
}

export async function listProcessingActivities(tenantId = 'tinai-admin'): Promise<ProcessingActivity[]> {
  const res = await fetch(`${API_URL}/api/v1/compliance/ropa?tenant_id=${tenantId}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get RoPA: ${res.status}`)
  return res.json()
}

export async function listBreachIncidents(): Promise<BreachIncident[]> {
  const res = await fetch(`${API_URL}/api/v1/compliance/breach`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list incidents: ${res.status}`)
  return res.json()
}

export async function listErasureRequests(tenantId = 'tinai-admin'): Promise<ErasureRequest[]> {
  const res = await fetch(`${API_URL}/api/v1/compliance/erasure?tenant_id=${tenantId}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to list erasure requests: ${res.status}`)
  return res.json()
}

export async function getDpaStatus(tenantId = 'tinai-admin'): Promise<DpaStatus> {
  const res = await fetch(`${API_URL}/api/v1/compliance/dpa/status/${tenantId}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get DPA status: ${res.status}`)
  return res.json()
}

export async function getPrivacyNotice(region: string): Promise<PrivacyNotice> {
  const res = await fetch(`${API_URL}/api/v1/compliance/privacy-notice/${region}`, { cache: 'no-store', headers: await authHeaders() })
  if (!res.ok) throw new Error(`Failed to get privacy notice: ${res.status}`)
  return res.json()
}
