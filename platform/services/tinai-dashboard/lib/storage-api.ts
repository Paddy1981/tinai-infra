const CSRF = { 'x-tinai-csrf': '1' }

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StorageBucket {
  id: string
  tenant_id: string
  name: string
  region: string
  quota_gb: number
  used_bytes: number
  status: string
  access_key: string | null
  endpoint_url: string | null
  created_at: string
}

export interface StorageDatabase {
  id: string
  tenant_id: string
  name: string
  pg_version: string
  storage_gb: number
  status: string
  connection_string: string | null
  host: string | null
  port: number | null
  db_user: string | null
  created_at: string
}

// ── Bucket helpers ────────────────────────────────────────────────────────────

export async function listBuckets(): Promise<StorageBucket[]> {
  const res = await fetch('/api/v1/storage/buckets')
  if (!res.ok) throw new Error(`Failed to list buckets: ${res.status}`)
  return res.json()
}

export async function createBucket(body: {
  name: string
  region: string
  quota_gb: number
}): Promise<StorageBucket> {
  const res = await fetch('/api/v1/storage/buckets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error ?? err?.detail ?? `Server error: ${res.status}`)
  }
  return res.json()
}

export async function deleteBucket(id: string): Promise<void> {
  const res = await fetch(`/api/v1/storage/buckets/${id}`, {
    method: 'DELETE',
    headers: CSRF,
  })
  if (!res.ok) throw new Error(`Failed to delete bucket: ${res.status}`)
}

// ── Database helpers ──────────────────────────────────────────────────────────

export async function listDatabases(): Promise<StorageDatabase[]> {
  const res = await fetch('/api/v1/storage/databases')
  if (!res.ok) throw new Error(`Failed to list databases: ${res.status}`)
  return res.json()
}

export async function createDatabase(body: {
  name: string
  pg_version: string
  storage_gb: number
}): Promise<StorageDatabase> {
  const res = await fetch('/api/v1/storage/databases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...CSRF },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err?.error ?? err?.detail ?? `Server error: ${res.status}`)
  }
  return res.json()
}

export async function deleteDatabase(id: string): Promise<void> {
  const res = await fetch(`/api/v1/storage/databases/${id}`, {
    method: 'DELETE',
    headers: CSRF,
  })
  if (!res.ok) throw new Error(`Failed to delete database: ${res.status}`)
}
