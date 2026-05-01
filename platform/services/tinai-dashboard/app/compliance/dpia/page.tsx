export default function DpiaPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <a
          href="/compliance"
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          &larr; Compliance
        </a>
        <h1 className="text-xl font-semibold mt-2">Data Protection Impact Assessments (DPIA)</h1>
      </div>

      <div className="rounded-md border border-slate-700 bg-slate-800/50 px-4 py-3 text-xs text-slate-400 leading-relaxed">
        DPIAs are required for processing activities that are likely to result in a high risk to individuals. Required under DPDP 2023 for Significant Data Fiduciaries and recommended under PDPPL 2016 and PDPL 2021.
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-12 flex flex-col items-center gap-3 text-center">
        <span className="text-4xl">📊</span>
        <p className="text-slate-300 text-sm font-medium">DPIA Module — Coming Soon</p>
        <p className="text-slate-500 text-xs max-w-sm leading-relaxed">
          The DPIA module will provide guided risk assessments, automated scoring, and regulator-ready reports. Available in the next release.
        </p>
      </div>
    </div>
  )
}
