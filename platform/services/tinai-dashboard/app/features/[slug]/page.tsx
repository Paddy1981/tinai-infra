'use client'

import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'

const FEATURES = {
  'gpu-compute': {
    title: 'GPU Compute Platform',
    tagline: 'Plug-and-play GPU environments, not bare metal',
    hero: 'One-click Jupyter, VSCode, ComfyUI. Your workspace persists, your models stay put.',
    color: 'violet',
    icon: 'M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18',
    sections: [
      {
        title: 'Ready-to-Use Environments',
        items: [
          { name: 'Jupyter Lab', spec: 'Browser IDE', price: 'Pre-installed', use: 'Interactive notebooks, zero config' },
          { name: 'VSCode Server', spec: 'Full IDE', price: 'Pre-installed', use: 'Code, debug, Git — in browser' },
          { name: 'ComfyUI', spec: 'Visual workflow', price: 'Pre-installed', use: 'Drag-drop diffusion pipelines' },
          { name: 'SSH Access', spec: 'Direct terminal', price: 'Always on', use: 'Full control when you need it' },
        ],
      },
      {
        title: 'Platform Features',
        items: [
          { name: 'Persistent workspace', spec: '500 GB NVMe', use: 'Models, datasets, code stay put' },
          { name: 'One-click templates', spec: '14 pre-built images', use: 'PyTorch, vLLM, Stable Diffusion…' },
          { name: 'Auto-suspend', spec: 'After 10 min idle', use: 'Workspace persists, billing stops' },
          { name: 'Hot resume', spec: 'Back online in <60s', use: 'Pick up right where you left off' },
        ],
      },
      {
        title: 'GPU Hardware',
        items: [
          { name: 'RTX 4090', spec: '24 GB VRAM', price: '₹89/hour', use: 'Dev, inference, fine-tuning' },
          { name: 'A100 40GB', spec: '40 GB HBM2e', price: '₹280/hour', use: 'Multi-GPU training' },
          { name: 'H100 80GB', spec: '80 GB HBM3', price: '₹520/hour', use: 'Frontier models, 8× clusters' },
        ],
      },
    ],
  },
  'object-storage': {
    title: 'Object Storage',
    tagline: 'S3-compatible storage and managed databases',
    hero: 'MinIO object storage and PostgreSQL — provisioned instantly.',
    color: 'sky',
    icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4',
    sections: [
      {
        title: 'Object Storage (MinIO)',
        items: [
          { name: 'S3 API', spec: '100% compatible', price: '₹2/GB-month', use: 'Drop-in AWS S3 replacement' },
          { name: 'Versioning', spec: 'Built-in', use: 'Track object history' },
          { name: 'Lifecycle policies', spec: 'Auto-expire', use: 'Cost optimization' },
          { name: 'Geo-replication', spec: 'Cross-region', use: 'Disaster recovery' },
        ],
      },
      {
        title: 'Managed PostgreSQL',
        items: [
          { name: 'PostgreSQL 17', spec: 'Latest stable', price: '₹8/GB-month', use: 'Relational database' },
          { name: 'Auto backups', spec: 'Daily + PITR', use: 'Point-in-time recovery' },
          { name: 'Connection pooling', spec: 'PgBouncer', use: 'Handle 10K+ connections' },
          { name: 'Extensions', spec: 'PostGIS, pgvector', use: 'Spatial & vector data' },
        ],
      },
      {
        title: 'Features',
        items: [
          { name: 'In-region data', spec: 'India-only', use: 'Compliance' },
          { name: 'Encryption', spec: 'At-rest + in-transit', use: 'Security' },
          { name: 'Multi-tenancy', spec: 'Namespace isolation', use: 'Tenant separation' },
        ],
      },
    ],
  },
  'ai-inference': {
    title: 'AI Inference',
    tagline: 'Unified proxy for 10+ AI models',
    hero: 'One API for Claude, Gemini, Sarvam, Krutrim, and more.',
    color: 'orange',
    icon: 'M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z',
    sections: [
      {
        title: 'Supported Models',
        items: [
          { name: 'Claude Sonnet 4.5', spec: 'Anthropic', price: '₹2.40/1K tokens', use: 'Complex reasoning' },
          { name: 'Sarvam 2B', spec: 'Indian LLM', price: '₹0.01/1K tokens', use: 'Hindi + English' },
          { name: 'Gemini Pro', spec: 'Google', price: '₹0.50/1K tokens', use: 'Multimodal' },
          { name: 'Krutrim Pro', spec: 'Ola', price: '₹0.80/1K tokens', use: 'Indic languages' },
        ],
      },
      {
        title: 'Gateway Features',
        items: [
          { name: 'Semantic caching', spec: 'Redis-backed', use: '90% cost savings' },
          { name: 'Budget caps', spec: 'Per-tenant', use: 'Cost control' },
          { name: 'Rate limiting', spec: 'Token/min', use: 'Abuse prevention' },
          { name: 'Fallback routing', spec: 'Auto-retry', use: 'High availability' },
        ],
      },
      {
        title: 'Use Cases',
        items: [
          { name: 'Chatbots', spec: 'Multi-turn', use: 'Customer support' },
          { name: 'RAG pipelines', spec: 'Vector search', use: 'Document Q&A' },
          { name: 'Code generation', spec: 'IDE plugins', use: 'Dev tools' },
        ],
      },
    ],
  },
  'serverless-functions': {
    title: 'Serverless Functions',
    tagline: 'Deploy functions that scale from zero',
    hero: 'Powered by Knative. No servers, no idle costs.',
    color: 'amber',
    icon: 'M13 10V3L4 14h7v7l9-11h-7z',
    sections: [
      {
        title: 'Runtime Support',
        items: [
          { name: 'Python 3.12', spec: 'FastAPI included', use: 'Web APIs' },
          { name: 'Node.js 22', spec: 'Express + Hono', use: 'JavaScript functions' },
          { name: 'Go 1.23', spec: 'Native binaries', use: 'High performance' },
          { name: 'Custom images', spec: 'Dockerfile', use: 'Any runtime' },
        ],
      },
      {
        title: 'Features',
        items: [
          { name: 'Scale to zero', spec: 'Auto-suspend', price: 'No idle costs', use: 'Pay per invocation' },
          { name: 'Auto-scale', spec: '0 → 1000 pods', use: 'Handle traffic spikes' },
          { name: 'NATS events', spec: 'Pub/sub triggers', use: 'Event-driven' },
          { name: 'Cold start', spec: '<500ms', use: 'Fast startup' },
        ],
      },
      {
        title: 'Use Cases',
        items: [
          { name: 'API endpoints', spec: 'REST/GraphQL', use: 'Backend services' },
          { name: 'Webhooks', spec: 'GitHub/Slack', use: 'Integrations' },
          { name: 'Scheduled jobs', spec: 'Cron triggers', use: 'Batch processing' },
        ],
      },
    ],
  },
  'ai-gateway': {
    title: 'AI Gateway',
    tagline: 'Central control plane for all AI traffic',
    hero: 'Enforce policies, route by capability, audit every request.',
    color: 'rose',
    icon: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    sections: [
      {
        title: 'Routing Strategies',
        items: [
          { name: 'Capability-based', spec: 'Match by task', use: 'Auto-route to best model' },
          { name: 'Cost optimization', spec: 'Cheapest first', use: 'Minimize spend' },
          { name: 'Latency priority', spec: 'Fastest model', use: 'Real-time apps' },
          { name: 'Regional routing', spec: 'Geo-aware', use: 'Compliance' },
        ],
      },
      {
        title: 'Policy Enforcement',
        items: [
          { name: 'Budget caps', spec: 'Per-tenant/user', use: 'Cost control' },
          { name: 'Rate limits', spec: 'Requests/tokens', use: 'Fair usage' },
          { name: 'Content filters', spec: 'PII detection', use: 'Data security' },
          { name: 'Model access', spec: 'RBAC', use: 'Tenant isolation' },
        ],
      },
      {
        title: 'Observability',
        items: [
          { name: 'Audit logs', spec: 'Every request', use: 'Compliance' },
          { name: 'Cost tracking', spec: 'Per-tenant', use: 'Chargeback' },
          { name: 'Latency metrics', spec: 'P50/P99', use: 'Performance' },
          { name: 'Token usage', spec: 'Real-time', use: 'Budget alerts' },
        ],
      },
    ],
  },
  'multi-tenant-platform': {
    title: 'Multi-tenant Platform',
    tagline: 'Full tenant isolation with 4-tier quota enforcement',
    hero: 'Namespace-level policies, instant provisioning, zero cross-tenant leakage.',
    color: 'indigo',
    icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    sections: [
      {
        title: 'Isolation Layers',
        items: [
          { name: 'Namespace isolation', spec: 'Kubernetes NS', use: 'Resource separation' },
          { name: 'Network policies', spec: 'Kyverno', use: 'Zero cross-tenant traffic' },
          { name: 'RBAC', spec: 'Per-tenant', use: 'Access control' },
          { name: 'Storage isolation', spec: 'Dedicated PVCs', use: 'Data security' },
        ],
      },
      {
        title: 'Quota Tiers',
        items: [
          { name: 'Free', spec: '2 vCPU, 4 GB RAM', price: '₹0/month', use: 'Hobby projects' },
          { name: 'Starter', spec: '8 vCPU, 16 GB RAM', price: '₹2,000/month', use: 'Small teams' },
          { name: 'Pro', spec: '32 vCPU, 64 GB RAM', price: '₹8,000/month', use: 'Production workloads' },
          { name: 'Enterprise', spec: 'Custom quotas', price: 'Custom pricing', use: 'Large orgs' },
        ],
      },
      {
        title: 'Features',
        items: [
          { name: 'Instant provisioning', spec: '<10s', use: 'Fast onboarding' },
          { name: 'Tenant CLI', spec: 'kubectl plugin', use: 'Self-service' },
          { name: 'SSO integration', spec: 'OIDC', use: 'Enterprise auth' },
          { name: 'Chargeback', spec: 'Per-tenant costs', use: 'Cost allocation' },
        ],
      },
    ],
  },
  'tinai-mail': {
    title: 'Tinai Mail',
    tagline: 'Business email with your domain, zero vendor lock-in',
    hero: 'Sovereign mail server. Standard IMAP/SMTP. Works with any email client.',
    color: 'blue',
    icon: 'M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
    sections: [
      {
        title: 'Email Features',
        items: [
          { name: 'Custom domain', spec: 'mail@yourcompany.in', price: 'Included', use: 'Professional branding' },
          { name: 'Unlimited aliases', spec: 'sales@, support@', use: 'Team inboxes' },
          { name: 'Catch-all', spec: '*@domain.in', use: 'Never miss an email' },
          { name: 'Email forwarding', spec: 'Auto-forward rules', use: 'Route to external' },
        ],
      },
      {
        title: 'Security & Compliance',
        items: [
          { name: 'SPF/DKIM/DMARC', spec: 'Pre-configured', use: 'Email authentication' },
          { name: 'Anti-spam', spec: 'SpamAssassin + AI', use: '99.5% accuracy' },
          { name: 'TLS encryption', spec: 'In-transit + at-rest', use: 'End-to-end secure' },
          { name: 'Data residency', spec: 'India-only storage', use: 'Compliance ready' },
        ],
      },
      {
        title: 'Access & Clients',
        items: [
          { name: 'Webmail', spec: 'Modern UI', use: 'Browser access' },
          { name: 'IMAP/SMTP', spec: 'Standard protocols', use: 'Thunderbird, Outlook' },
          { name: 'Mobile sync', spec: 'iOS Mail, Gmail app', use: 'Native apps' },
          { name: 'API access', spec: 'REST + webhooks', use: 'Automation' },
        ],
      },
    ],
  },
  'coll': {
    title: 'COLL - Collaboration Platform',
    tagline: 'Open-source alternative to Slack, runs on your infrastructure',
    hero: 'Channels, DMs, file sharing, video calls. Your data, your control.',
    color: 'emerald',
    icon: 'M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z',
    sections: [
      {
        title: 'Communication',
        items: [
          { name: 'Channels', spec: 'Public + private', use: 'Team discussions' },
          { name: 'Direct messages', spec: '1-on-1 + group', use: 'Private chats' },
          { name: 'Threads', spec: 'Organized replies', use: 'Keep context' },
          { name: 'Reactions', spec: 'Emoji responses', use: 'Quick feedback' },
        ],
      },
      {
        title: 'Rich Content',
        items: [
          { name: 'File sharing', spec: 'Up to 100 MB', use: 'Share docs, images' },
          { name: 'Screen sharing', spec: 'Built-in', use: 'Collaborate visually' },
          { name: 'Video calls', spec: 'Up to 50 participants', use: 'Team meetings' },
          { name: 'Code snippets', spec: 'Syntax highlighting', use: 'Dev collaboration' },
        ],
      },
      {
        title: 'Platform Features',
        items: [
          { name: 'Integrations', spec: '100+ apps', use: 'GitHub, Jira, CI/CD' },
          { name: 'Webhooks', spec: 'Incoming/outgoing', use: 'Custom workflows' },
          { name: 'Search', spec: 'Full-text indexed', use: 'Find anything instantly' },
          { name: 'Mobile apps', spec: 'iOS + Android', use: 'Stay connected' },
        ],
      },
    ],
  },
  'edge-compute': {
    title: 'Edge Compute',
    tagline: 'Code that runs close to your users across 20+ Indian cities',
    hero: '<10ms latency nationwide. CDN + compute combined. Zero cold starts.',
    color: 'cyan',
    icon: 'M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    sections: [
      {
        title: 'Edge Locations (India)',
        items: [
          { name: 'Tier-1 cities', spec: '8 metros', use: 'Mumbai, Delhi, Bangalore, Chennai, Kolkata, Hyderabad, Pune, Ahmedabad' },
          { name: 'Tier-2 cities', spec: '12 cities', use: 'Jaipur, Lucknow, Kochi, Chandigarh, Bhopal, Indore...' },
          { name: 'Latency', spec: '<10ms', use: '95th percentile to end users' },
          { name: 'Network', spec: 'Multi-ISP peering', use: 'Jio, Airtel, BSNL, Vi optimized' },
        ],
      },
      {
        title: 'Compute Model',
        items: [
          { name: 'V8 Isolates', spec: 'JavaScript/WASM', price: '₹0.05/million requests', use: 'Ultra-fast, secure sandboxing' },
          { name: 'Zero cold start', spec: '<1ms spin-up', use: 'Always-hot execution' },
          { name: 'Global state', spec: 'KV + Durable Objects', use: 'Edge-native storage' },
          { name: 'Auto-scale', spec: '0 → 10K RPS instant', use: 'No capacity planning' },
        ],
      },
      {
        title: 'Use Cases',
        items: [
          { name: 'API routing', spec: 'Geo-aware', use: 'Route to nearest backend' },
          { name: 'Personalization', spec: 'A/B testing', use: 'User-specific content' },
          { name: 'Auth/WAF', spec: 'JWT validation', use: 'Security at the edge' },
          { name: 'SSR', spec: 'Edge rendering', use: 'Fast page loads' },
        ],
      },
    ],
  },
} as const

export default function FeaturePage() {
  const params = useParams()
  const router = useRouter()
  const slug = params.slug as string
  const feature = FEATURES[slug as keyof typeof FEATURES]

  if (!feature) {
    return (
      <div className="min-h-screen bg-[#07070F] text-[#EDE9E1] flex items-center justify-center">
        <div className="text-center space-y-4">
          <h1 className="text-4xl font-bold">Feature not found</h1>
          <button
            onClick={() => router.push('/')}
            className="px-6 py-3 bg-[#F97316] hover:bg-[#EA6C0A] rounded-lg text-white font-semibold transition-colors"
          >
            Back to Home
          </button>
        </div>
      </div>
    )
  }

  const colorClasses = {
    violet: 'from-violet-950/40 text-violet-400 border-violet-800/50',
    sky: 'from-sky-950/40 text-sky-400 border-sky-800/50',
    orange: 'from-orange-950/40 text-orange-400 border-orange-800/50',
    amber: 'from-amber-950/40 text-amber-400 border-amber-800/50',
    rose: 'from-rose-950/40 text-rose-400 border-rose-800/50',
    indigo: 'from-indigo-950/40 text-indigo-400 border-indigo-800/50',
  }

  const { text: textColor, from: gradientColor, border: borderColor } = {
    text: `text-${feature.color}-400`,
    from: `from-${feature.color}-950/40`,
    border: `border-${feature.color}-800/50`,
  }

  return (
    <div className="min-h-screen bg-[#07070F] text-[#EDE9E1]">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 bg-[#07070F]/95 backdrop-blur-xl border-b border-[#2A2844] py-3">
        <div className="max-w-7xl mx-auto px-6 flex items-center justify-between">
          <button
            onClick={() => router.push('/')}
            className="flex items-center gap-2 text-[#8C89A4] hover:text-[#EDE9E1] transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            <span className="font-medium">Back to Platform</span>
          </button>

          <a
            href="/login"
            className="px-5 py-2 rounded-lg bg-[#F97316] hover:bg-[#EA6C0A] text-white text-sm font-semibold transition-colors"
          >
            Get Started
          </a>
        </div>
      </header>

      {/* Hero */}
      <section className="pt-32 pb-16 px-6">
        <div className="max-w-5xl mx-auto text-center space-y-6">
          <div className={`inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-[#14142A] border ${borderColor}`}>
            <svg className={`w-10 h-10 ${textColor}`} fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d={feature.icon} />
            </svg>
          </div>

          <h1 className="text-6xl font-bold tracking-tight">{feature.title}</h1>
          <p className="text-2xl text-[#8C89A4]">{feature.tagline}</p>
          <p className="text-xl text-[#F97316] font-semibold max-w-3xl mx-auto">{feature.hero}</p>

          <div className="flex gap-4 justify-center pt-4">
            <a
              href="/login?register=true"
              className="px-8 py-4 rounded-xl bg-[#F97316] hover:bg-[#EA6C0A] text-white font-bold transition-all duration-200 shadow-[0_0_30px_rgba(249,115,22,0.4)] hover:shadow-[0_0_40px_rgba(249,115,22,0.6)] hover:-translate-y-1"
            >
              Start Building
            </a>
            <a
              href="https://docs.tinai.cloud"
              className="px-8 py-4 rounded-xl border border-[#2A2844] hover:border-[#F97316]/50 text-[#EDE9E1] font-semibold transition-colors"
            >
              View Docs
            </a>
          </div>
        </div>
      </section>

      {/* Content Sections */}
      <section className="py-16 px-6">
        <div className="max-w-7xl mx-auto space-y-16">
          {feature.sections.map((section, idx) => (
            <div key={idx}>
              <h2 className="text-3xl font-bold mb-8 text-center">{section.title}</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {section.items.map((item, itemIdx) => (
                  <div
                    key={itemIdx}
                    className="rounded-xl border border-[#2A2844] bg-[#0E0E1C] p-6 hover:border-[#F97316]/40 hover:shadow-[0_0_20px_rgba(249,115,22,0.1)] transition-all duration-300"
                  >
                    <h3 className="text-lg font-bold text-[#EDE9E1] mb-2">{item.name}</h3>
                    <p className="text-sm text-[#8C89A4] mb-1">{item.spec}</p>
                    {'price' in item && item.price && <p className="text-base font-semibold text-[#F97316] mb-2">{item.price}</p>}
                    <p className="text-xs text-[#4A4760]">{item.use}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6 border-t border-[#2A2844]">
        <div className="max-w-3xl mx-auto text-center space-y-6">
          <h2 className="text-4xl font-bold">Ready to get started?</h2>
          <p className="text-lg text-[#8C89A4]">Launch your first {feature.title.toLowerCase()} instance in under 60 seconds.</p>
          <a
            href="/login?register=true"
            className="inline-block px-8 py-4 rounded-xl bg-[#F97316] hover:bg-[#EA6C0A] text-white font-bold transition-all duration-200 shadow-[0_0_30px_rgba(249,115,22,0.4)] hover:shadow-[0_0_40px_rgba(249,115,22,0.6)] hover:-translate-y-1"
          >
            Get Started Free
          </a>
        </div>
      </section>
    </div>
  )
}
