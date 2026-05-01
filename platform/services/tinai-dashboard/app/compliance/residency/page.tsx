import { generateResidencyReport, ResidencyReport } from '@/lib/api'

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

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
      <span className="text-sm text-slate-200 font-mono break-all">{value}</span>
    </div>
  )
}

function ReportView({ report }: { report: ResidencyReport }) {
  const generatedAt = new Date(report.generated_at).toLocaleString('en-IN', {
    dateStyle: 'long',
    timeStyle: 'medium',
    timeZone: 'Asia/Kolkata',
  })
  const hashShort = report.hash.slice(0, 16)

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 mb-1">
          <a
            href="/compliance"
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            &larr; Compliance
          </a>
        </div>
        <h1 className="text-xl font-semibold">Data Residency Report</h1>
        <div className="flex flex-wrap gap-3 text-xs text-slate-500">
          <span>Generated: {generatedAt} IST</span>
          <span className="text-slate-700">|</span>
          <span className="font-mono">
            SHA-256: <span className="text-slate-400">{hashShort}&hellip;</span>
          </span>
          {report.tenant && (
            <>
              <span className="text-slate-700">|</span>
              <span>Tenant: <span className="text-slate-400">{report.tenant}</span></span>
            </>
          )}
        </div>
      </div>

      {/* Assertion banner */}
      <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 px-4 py-3 flex items-start gap-3">
        <span className="mt-0.5 text-emerald-400 text-base leading-none">&#10003;</span>
        <p className="text-sm text-emerald-300 leading-relaxed">{report.assertion}</p>
      </div>

      {/* Infrastructure stats */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-4">Infrastructure</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <StatItem label="Data Residency" value={report.data_residency} />
          <StatItem label="Cluster Region" value={report.cluster_region} />
          <StatItem label="Build Registry" value={report.build_registry} />
        </div>
      </div>

      {/* Apps */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">
          Apps
          <span className="ml-2 text-xs font-normal text-slate-600">({report.apps.length})</span>
        </h2>
        {report.apps.length === 0 ? (
          <p className="text-sm text-slate-500">No apps deployed.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">App</th>
                <th className="pb-2 font-medium">Namespace</th>
                <th className="pb-2 font-medium">Pods</th>
                <th className="pb-2 font-medium">Nodes</th>
                <th className="pb-2 font-medium">PVCs</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {report.apps.map(app => {
                const uniqueNodes = [...new Set(app.pods.map(p => p.node))].join(', ')
                const podsByPhase: Record<string, number> = {}
                for (const pod of app.pods) {
                  podsByPhase[pod.phase] = (podsByPhase[pod.phase] ?? 0) + 1
                }
                return (
                  <tr key={`${app.namespace}/${app.name}`} className="text-slate-300">
                    <td className="py-2.5 font-mono text-xs font-medium">{app.name}</td>
                    <td className="py-2.5 text-xs text-slate-400">{app.namespace}</td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {Object.entries(podsByPhase).map(([phase, count]) => (
                          <span key={phase} className="flex items-center gap-1">
                            {phaseBadge(phase)}
                            {count > 1 && (
                              <span className="text-xs text-slate-500">&times;{count}</span>
                            )}
                          </span>
                        ))}
                        {app.pods.length === 0 && (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </div>
                    </td>
                    <td className="py-2.5 text-xs text-slate-400 font-mono">
                      {uniqueNodes || <span className="text-slate-600">—</span>}
                    </td>
                    <td className="py-2.5 text-xs text-slate-400">{app.pvc_count}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Nodes */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">
          Nodes
          <span className="ml-2 text-xs font-normal text-slate-600">({report.nodes.length})</span>
        </h2>
        {report.nodes.length === 0 ? (
          <p className="text-sm text-slate-500">No nodes reported.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                <th className="pb-2 font-medium">Name</th>
                <th className="pb-2 font-medium">Region</th>
                <th className="pb-2 font-medium">Zone</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {report.nodes.map(node => (
                <tr key={node.name} className="text-slate-300">
                  <td className="py-2.5 font-mono text-xs font-medium">{node.name}</td>
                  <td className="py-2.5 text-xs text-slate-400">{node.region || <span className="text-slate-600">—</span>}</td>
                  <td className="py-2.5 text-xs text-slate-400">{node.zone || <span className="text-slate-600">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Report Integrity */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-medium text-slate-400">Report Integrity</h2>
          <span className="text-xs text-slate-600">SHA-256 of report payload</span>
        </div>
        <pre className="rounded bg-slate-950 border border-slate-800 px-4 py-3 text-xs font-mono text-emerald-400 break-all whitespace-pre-wrap">
          {report.hash}
        </pre>
      </div>
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <a
          href="/compliance"
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          &larr; Compliance
        </a>
      </div>
      <h1 className="text-xl font-semibold">Data Residency Report</h1>
      <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-4 flex items-start gap-3">
        <span className="mt-0.5 text-red-400 text-base leading-none">&#9888;</span>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-red-300">Unable to generate report</p>
          <p className="text-xs text-red-400/80">{message}</p>
          <p className="text-xs text-slate-500 mt-1">
            Ensure the control-plane API is reachable and the compliance endpoint is deployed.
          </p>
        </div>
      </div>
    </div>
  )
}

export default async function ResidencyPage() {
  let report: ResidencyReport | null = null
  let error: string | null = null

  try {
    report = await generateResidencyReport()
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error'
  }

  if (error || !report) {
    return <ErrorCard message={error ?? 'No report returned'} />
  }

  return <ReportView report={report} />
}
