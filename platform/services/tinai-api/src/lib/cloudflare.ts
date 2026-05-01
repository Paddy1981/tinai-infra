// Cloudflare Tunnel API integration for automatic domain routing
// When a tenant adds a custom domain, this module:
// 1. Adds a public hostname route to the tunnel
// 2. Creates a CNAME DNS record in the zone (if domain is on Cloudflare)
// 3. For non-Cloudflare domains, returns CNAME instructions

const CF_API = 'https://api.cloudflare.com/client/v4'
const CF_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? ''
const CF_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID ?? '8b8da24cf0dc815a113249b114e14cfc'
const CF_TUNNEL_ID = process.env.CLOUDFLARE_TUNNEL_ID ?? '995c1ef1-04a4-48ce-816d-a8552fa42fcb'

function cfHeaders() {
  return {
    Authorization: `Bearer ${CF_API_TOKEN}`,
    'Content-Type': 'application/json',
  }
}

export function isConfigured(): boolean {
  return !!CF_API_TOKEN
}

// Get current tunnel configuration (all ingress rules)
export async function getTunnelConfig(): Promise<{ ingress: Array<{ hostname?: string; service: string; originRequest?: Record<string, unknown> }> } | null> {
  if (!CF_API_TOKEN) return null
  const res = await fetch(
    `${CF_API}/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`,
    { headers: cfHeaders() },
  )
  if (!res.ok) {
    console.error(`[cloudflare] getTunnelConfig failed: ${res.status}`)
    return null
  }
  const data = await res.json() as any
  return data.result?.config ?? null
}

// Add a domain route to the tunnel
export async function addTunnelRoute(hostname: string, localPort: number): Promise<{ success: boolean; error?: string }> {
  if (!CF_API_TOKEN) {
    return { success: false, error: 'Cloudflare API token not configured' }
  }

  // Get current config
  const config = await getTunnelConfig()
  if (!config) {
    return { success: false, error: 'Failed to fetch tunnel configuration' }
  }

  // Check if route already exists
  const existing = config.ingress.find(r => r.hostname === hostname)
  if (existing) {
    return { success: true } // Already configured
  }

  // Add new route before the catch-all (last entry)
  const newIngress = [
    ...config.ingress.filter(r => r.hostname), // All named routes
    { hostname, service: `http://localhost:${localPort}`, originRequest: {} },
    ...config.ingress.filter(r => !r.hostname), // Catch-all (404)
  ]

  const res = await fetch(
    `${CF_API}/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`,
    {
      method: 'PUT',
      headers: cfHeaders(),
      body: JSON.stringify({
        config: { ingress: newIngress },
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    return { success: false, error: err.errors?.[0]?.message ?? `HTTP ${res.status}` }
  }

  return { success: true }
}

// Remove a domain route from the tunnel
export async function removeTunnelRoute(hostname: string): Promise<{ success: boolean; error?: string }> {
  if (!CF_API_TOKEN) {
    return { success: false, error: 'Cloudflare API token not configured' }
  }

  const config = await getTunnelConfig()
  if (!config) {
    return { success: false, error: 'Failed to fetch tunnel configuration' }
  }

  const newIngress = config.ingress.filter(r => r.hostname !== hostname)

  // Ensure catch-all still exists
  if (!newIngress.some(r => !r.hostname)) {
    newIngress.push({ service: 'http_status:404' })
  }

  const res = await fetch(
    `${CF_API}/accounts/${CF_ACCOUNT_ID}/cfd_tunnel/${CF_TUNNEL_ID}/configurations`,
    {
      method: 'PUT',
      headers: cfHeaders(),
      body: JSON.stringify({
        config: { ingress: newIngress },
      }),
    },
  )

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any
    return { success: false, error: err.errors?.[0]?.message ?? `HTTP ${res.status}` }
  }

  return { success: true }
}

// Get the CNAME target for the tunnel
export function tunnelCnameTarget(): string {
  return `${CF_TUNNEL_ID}.cfargotunnel.com`
}

// Check if a domain resolves to the tunnel
export async function verifyDomainDns(hostname: string): Promise<{ verified: boolean; cname?: string }> {
  try {
    const res = await fetch(`https://dns.google/resolve?name=${hostname}&type=CNAME`)
    const data = await res.json() as any
    const answers = data.Answer ?? []
    for (const a of answers) {
      if (a.type === 5 && a.data?.includes('cfargotunnel.com')) {
        return { verified: true, cname: a.data }
      }
    }
    // Also check if it resolves to Cloudflare IPs (proxied)
    const aRes = await fetch(`https://dns.google/resolve?name=${hostname}&type=A`)
    const aData = await aRes.json() as any
    const aAnswers = aData.Answer ?? []
    for (const a of aAnswers) {
      if (a.type === 1) {
        // Cloudflare IP ranges: 104.16-31.x.x, 172.64-71.x.x
        const ip = a.data
        if (ip.startsWith('104.') || ip.startsWith('172.6') || ip.startsWith('172.7')) {
          return { verified: true, cname: `cloudflare-proxied (${ip})` }
        }
      }
    }
    return { verified: false }
  } catch {
    return { verified: false }
  }
}

// Map app name + port for tunnel routing
export function appHostPort(appName: string, environment: string = 'production'): number {
  // Known port mappings from K3s hostPorts
  const PORTS: Record<string, number> = {
    'tinai-dashboard': 3000,
    'tinai-api': 3001,
    'tinai-auth': 3002,
    'tinai-functions': 3004,
    'tinai-gateway': 3005,
    'tinai-realtime': 3006,
    'forgejo': 3010,
    'laruneng-com': 3030,
    'safety-forge': 3040,
    'sattrack': 3050,
    'astro-data': 3060,
    'coll': 3070,
    'larun-se': 3080,
    'larun-space': 3090,
    'hello-tinai': 3110,
    'tinai-forge': 8090,
  }
  return PORTS[appName] ?? 3000
}
