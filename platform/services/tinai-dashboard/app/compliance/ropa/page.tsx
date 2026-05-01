import { listProcessingActivities, ProcessingActivity } from '@/lib/api'
import DownloadReportButton from '../DownloadReportButton'

const API_URL = process.env.API_URL ?? 'http://tinai-api.tinai-system.svc.cluster.local:3000'
const EXPORT_URL = `${process.env.NEXT_PUBLIC_API_URL ?? 'https://api.tinai.cloud'}/api/v1/compliance/ropa/export?tenant_id=tinai-admin`

function Chip({ label }: { label: string }) {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] border bg-slate-800 text-slate-400 border-slate-700 mr-1 mb-1">
      {label}
    </span>
  )
}

function MarketingTag() {
  return (
    <span className="inline-block rounded px-1.5 py-0.5 text-[10px] border bg-amber-900/50 text-amber-400 border-amber-800">
      Marketing
    </span>
  )
}

export default async function RopaPage() {
  let activities: ProcessingActivity[] = []
  let error: string | null = null

  try {
    activities = await listProcessingActivities()
  } catch (err) {
    error = err instanceof Error ? err.message : 'Failed to load RoPA'
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div>
          <a
            href="/compliance"
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            &larr; Compliance
          </a>
          <h1 className="text-xl font-semibold mt-2">Records of Processing Activities (RoPA)</h1>
        </div>
        <div className="flex items-center gap-2 mt-7">
          <a
            href={EXPORT_URL}
            className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-600 hover:text-slate-100 transition-colors"
          >
            Export CSV
          </a>
          <DownloadReportButton reportType="dpdpa" label="Download DPDPA Report" />
        </div>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-800/50 px-4 py-3 text-xs text-slate-400 leading-relaxed">
        Maintained under DPDP 2023 (India), PDPPL 2016 (Qatar), and PDPL 2021 (UAE). All processing activities must be documented here.
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
        <h2 className="text-sm font-medium text-slate-400 mb-3">
          Processing Activities
          <span className="ml-2 text-xs font-normal text-slate-600">({activities.length})</span>
        </h2>

        {activities.length === 0 && !error && (
          <p className="text-sm text-slate-500">No processing activities recorded yet.</p>
        )}

        {activities.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
                  <th className="pb-2 font-medium pr-3">Activity Name</th>
                  <th className="pb-2 font-medium pr-3">Purpose</th>
                  <th className="pb-2 font-medium pr-3">Legal Basis</th>
                  <th className="pb-2 font-medium pr-3">Data Categories</th>
                  <th className="pb-2 font-medium pr-3">Data Subjects</th>
                  <th className="pb-2 font-medium pr-3">Retention (days)</th>
                  <th className="pb-2 font-medium pr-3">Processors</th>
                  <th className="pb-2 font-medium">Marketing?</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {activities.map(a => (
                  <tr key={a.id} className="text-slate-300 align-top">
                    <td className="py-2.5 pr-3 text-xs font-medium font-mono whitespace-nowrap">{a.activity_name}</td>
                    <td className="py-2.5 pr-3 text-xs text-slate-400">{a.purpose}</td>
                    <td className="py-2.5 pr-3 text-xs text-slate-400 whitespace-nowrap">{a.legal_basis}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap">
                        {a.data_categories.map(c => <Chip key={c} label={c} />)}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap">
                        {a.data_subjects.map(s => <Chip key={s} label={s} />)}
                      </div>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-400 text-center">{a.retention_days}</td>
                    <td className="py-2.5 pr-3">
                      <div className="flex flex-wrap">
                        {a.processors.length > 0
                          ? a.processors.map(p => <Chip key={p} label={p} />)
                          : <span className="text-slate-600 text-xs">—</span>
                        }
                      </div>
                    </td>
                    <td className="py-2.5">
                      {a.is_marketing ? <MarketingTag /> : <span className="text-slate-600 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
