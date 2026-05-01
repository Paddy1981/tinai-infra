import { listResidencyReports, ResidencyReportSummary } from '@/lib/api'
import GenerateReportButton from './GenerateReportButton'
import DownloadReportButton from './DownloadReportButton'

interface ModuleCard {
  icon: string
  name: string
  description: string
  href: string
  status: 'active' | 'setup' | 'planned'
}

const MODULES: ModuleCard[] = [
  {
    icon: '🛡',
    name: 'Data Residency Report',
    description: 'Verify all data and compute stays within Indian jurisdiction.',
    href: '/compliance/residency',
    status: 'active',
  },
  {
    icon: '📋',
    name: 'Consent Manager',
    description: 'Record and manage data subject consent per purpose and region.',
    href: '/compliance/consent',
    status: 'active',
  },
  {
    icon: '👤',
    name: 'Rights Requests',
    description: 'Handle erasure, access, and portability requests from data subjects.',
    href: '/compliance/rights',
    status: 'active',
  },
  {
    icon: '🚨',
    name: 'Breach Incidents',
    description: 'Track and manage data breach incidents within the 72-hour notification window.',
    href: '/compliance/breach',
    status: 'active',
  },
  {
    icon: '📄',
    name: 'Records of Processing (RoPA)',
    description: 'Maintain processing activity records under DPDP 2023, PDPPL 2016, PDPL 2021.',
    href: '/compliance/ropa',
    status: 'active',
  },
  {
    icon: '📊',
    name: 'DPIA',
    description: 'Data Protection Impact Assessments for high-risk processing activities.',
    href: '/compliance/dpia',
    status: 'planned',
  },
  {
    icon: '🤝',
    name: 'DPA Status',
    description: 'Data Processing Agreements signed with each jurisdiction.',
    href: '/compliance/dpa',
    status: 'active',
  },
  {
    icon: '👩‍💼',
    name: 'DPO Registry',
    description: 'Named Data Protection Officers for India, Qatar, and UAE.',
    href: '/compliance/dpo',
    status: 'setup',
  },
]

function statusBadge(status: ModuleCard['status']) {
  if (status === 'active') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs border bg-emerald-900/50 text-emerald-400 border-emerald-800">
        Active
      </span>
    )
  }
  if (status === 'setup') {
    return (
      <span className="inline-block rounded px-2 py-0.5 text-xs border bg-amber-900/50 text-amber-400 border-amber-800">
        Setup needed
      </span>
    )
  }
  return (
    <span className="inline-block rounded px-2 py-0.5 text-xs border bg-slate-800 text-slate-500 border-slate-700">
      Planned
    </span>
  )
}

function phaseBadge(phase: string) {
  const colours: Record<string, string> = {
    Running: 'bg-emerald-900/50 text-emerald-400 border border-emerald-800',
    Pending: 'bg-amber-900/50 text-amber-400 border border-amber-800',
    Failed: 'bg-red-900/50 text-red-400 border border-red-800',
    Succeeded: 'bg-slate-800 text-slate-400 border border-slate-700',
  }
  const cls = colours[phase] ?? 'bg-slate-800 text-slate-400 border border-slate-700'
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${cls}`}>
      {phase}
    </span>
  )
}

function ResidencySummary({ report }: { report: ResidencyReportSummary }) {
  const generatedAt = new Date(report.generated_at).toLocaleString('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  })

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-slate-400">Latest Residency Snapshot</h2>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">{generatedAt} IST</span>
          <a
            href="/compliance/residency"
            className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
          >
            Full report &rarr;
          </a>
        </div>
      </div>

      <div className="rounded-md border border-emerald-800 bg-emerald-950/40 px-3 py-2 flex items-start gap-2 mb-4">
        <span className="mt-0.5 text-emerald-400 text-sm leading-none">&#10003;</span>
        <p className="text-xs text-emerald-300 leading-relaxed">
          Residency report generated for tenant <span className="font-mono">{report.tenant}</span>.
          View the full report for jurisdiction assertions and node details.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
        <div>
          <span className="text-slate-500 uppercase tracking-wide text-[10px]">Report ID</span>
          <p className="text-slate-200 font-mono mt-1 truncate">{report.id}</p>
        </div>
        <div>
          <span className="text-slate-500 uppercase tracking-wide text-[10px]">Hash</span>
          <p className="text-slate-200 font-mono mt-1 truncate">{report.hash}</p>
        </div>
      </div>
    </div>
  )
}

export default async function CompliancePage() {
  let latestReport: ResidencyReportSummary | null = null
  let apiError = false

  try {
    const reports = await listResidencyReports()
    // Sort descending by generated_at and take the most recent
    if (reports.length > 0) {
      latestReport = reports.sort(
        (a, b) => new Date(b.generated_at).getTime() - new Date(a.generated_at).getTime()
      )[0]
    }
  } catch {
    // show hub without summary if API unavailable
    apiError = true
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Compliance</h1>
          <p className="text-sm text-slate-400 mt-1">
            Manage data privacy obligations across India (DPDP 2023), Qatar (PDPPL 2016), and UAE (PDPL 2021).
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 mt-1">
          <DownloadReportButton reportType="soc2" label="SOC 2 Report" />
          <DownloadReportButton reportType="dpdpa" label="DPDPA Report" />
        </div>
      </div>

      {/* Module grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {MODULES.map((m) => (
          <a
            key={m.href}
            href={m.href}
            className="rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-slate-700 transition-colors flex flex-col gap-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="text-lg leading-none">{m.icon}</span>
                <span className="text-sm font-medium text-slate-100">{m.name}</span>
              </div>
              {statusBadge(m.status)}
            </div>
            <p className="text-xs text-slate-400 leading-relaxed pl-7">{m.description}</p>
          </a>
        ))}
      </div>

      {/* Residency summary — show most recent report or prompt to generate one */}
      {latestReport && <ResidencySummary report={latestReport} />}

      {!latestReport && !apiError && <GenerateReportButton />}

      {!latestReport && apiError && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4">
          <p className="text-xs text-slate-500">
            Residency snapshot unavailable — ensure the control-plane API is reachable.
          </p>
        </div>
      )}
    </div>
  )
}
