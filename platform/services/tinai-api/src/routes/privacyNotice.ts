import { FastifyInstance } from 'fastify'

type Region = 'IN' | 'QA' | 'AE'

interface SubProcessor {
  name: string
  purpose: string
  location: string
  regions_active: Region[]
}

interface PrivacyNotice {
  version: string
  region: Region
  law: string
  regulator: string
  dpo_email: string
  data_categories: string[]
  retention_summary: Record<string, string>
  ai_disclosure: string
  sub_processors: SubProcessor[]
  generated_at: string
}

const AI_DISCLOSURE =
  'Tinai Copilot uses Claude claude-sonnet-4-6 by Anthropic. Context shared: app names and usage metrics only. ' +
  'No source code or user data is sent to AI systems.'

const SUB_PROCESSORS: SubProcessor[] = [
  {
    name: 'Forgejo',
    purpose: 'Self-hosted Git hosting for source code and CI/CD pipeline management',
    location: 'India (in-cluster)',
    regions_active: ['IN', 'QA', 'AE'],
  },
  {
    name: 'Kaniko',
    purpose: 'In-cluster container image building — no data leaves the cluster during builds',
    location: 'India (in-cluster)',
    regions_active: ['IN', 'QA', 'AE'],
  },
  {
    name: 'E2E Networks',
    purpose: 'Cloud infrastructure provider — compute, storage and networking for the IN region',
    location: 'India',
    regions_active: ['IN'],
  },
  {
    name: 'Razorpay',
    purpose: 'Payment gateway for invoice collection and GST-compliant billing',
    location: 'India',
    regions_active: ['IN'],
  },
  {
    name: 'Anthropic',
    purpose: 'AI model API provider (Claude claude-sonnet-4-6) for the Tinai Copilot feature',
    location: 'United States',
    regions_active: ['IN', 'QA', 'AE'],
  },
  {
    name: 'SendGrid',
    purpose: 'Transactional email delivery for notifications, invoices and platform alerts',
    location: 'United States',
    regions_active: ['IN', 'QA', 'AE'],
  },
]

const NOTICES: Record<Region, Omit<PrivacyNotice, 'generated_at'>> = {
  IN: {
    version: '1.1',
    region: 'IN',
    law: 'Digital Personal Data Protection Act, 2023 (DPDP Act)',
    regulator: 'Data Protection Board of India',
    dpo_email: 'dpo-in@tinai.cloud',
    data_categories: [
      'Account identifiers (name, email, company name)',
      'Authentication credentials (hashed passwords, API keys)',
      'Usage metrics (CPU and memory consumption per application)',
      'Billing data (invoice amounts, payment status)',
      'Application metadata (app names, repository references)',
      'Access logs and IP addresses',
      'Support and communication records',
    ],
    retention_summary: {
      account_data: '730 days after account closure',
      usage_metrics: 'Rolling 12-month window; billing-relevant data retained for 7 years',
      audit_logs: '365 days',
      ai_context: '90 days',
      invoices: '7 years (legal obligation under GST rules)',
    },
    ai_disclosure: AI_DISCLOSURE,
    sub_processors: SUB_PROCESSORS.filter(sp => sp.regions_active.includes('IN')),
  },

  QA: {
    version: '1.1',
    region: 'QA',
    law: 'Personal Data Privacy Protection Law No. 13 of 2016 (PDPPL)',
    regulator: 'Ministry of Transport and Communications — National Cyber Security Agency',
    dpo_email: 'dpo-qa@tinai.cloud',
    data_categories: [
      'Account identifiers (name, email, organisation name)',
      'Authentication credentials (hashed passwords, API tokens)',
      'Platform usage metrics (resource consumption statistics)',
      'Billing information (invoice records, payment confirmations)',
      'Application metadata (deployment names, source repository references)',
      'System access logs and originating IP addresses',
    ],
    retention_summary: {
      account_data: '730 days after account termination',
      usage_metrics: '12 months rolling',
      audit_logs: '365 days',
      ai_context: '90 days',
      invoices: '5 years',
    },
    ai_disclosure: AI_DISCLOSURE,
    sub_processors: SUB_PROCESSORS.filter(sp => sp.regions_active.includes('QA')),
  },

  AE: {
    version: '1.1',
    region: 'AE',
    law: 'Federal Decree-Law No. 45 of 2021 on Personal Data Protection (UAE PDPL)',
    regulator: 'UAE Data Office',
    dpo_email: 'dpo-ae@tinai.cloud',
    data_categories: [
      'Identity data (full name, email address, employer details)',
      'Credential data (hashed authentication material, session tokens)',
      'Technical usage data (compute and memory metrics per workload)',
      'Financial data (invoice history, billing correspondence)',
      'Platform configuration data (application names, environment metadata)',
      'Security logs (access events, IP addresses, timestamps)',
    ],
    retention_summary: {
      account_data: '730 days from last active use or account termination',
      usage_metrics: '12 months rolling',
      audit_logs: '365 days',
      ai_context: '90 days',
      invoices: '5 years (UAE Commercial Transactions Law)',
    },
    ai_disclosure: AI_DISCLOSURE,
    sub_processors: SUB_PROCESSORS.filter(sp => sp.regions_active.includes('AE')),
  },
}

export async function privacyNoticeRoutes(app: FastifyInstance) {
  // GET /privacy-notice/:region — return the privacy notice for a region
  app.get<{ Params: { region: string } }>('/compliance/privacy-notice/:region', async (req, reply) => {
    const region = req.params.region.toUpperCase() as Region

    if (!['IN', 'QA', 'AE'].includes(region)) {
      return reply.status(400).send({ error: 'unsupported region — valid values: IN, QA, AE' })
    }

    const notice: PrivacyNotice = {
      ...NOTICES[region],
      generated_at: new Date().toISOString(),
    }

    return reply.send(notice)
  })
}
