import { listInstances, Instance } from '@/lib/instances-api'

function statusBadge(status: Instance['status']) {
  const map: Record<Instance['status'], { label: string; className: string }> = {
    provisioning: { label: 'Provisioning', className: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30' },
    running:      { label: 'Running',      className: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
    stopping:     { label: 'Stopping',     className: 'bg-orange-500/10 text-orange-400 border border-orange-500/30' },
    stopped:      { label: 'Stopped',      className: 'bg-slate-500/10 text-slate-400 border border-slate-500/30' },
    error:        { label: 'Error',        className: 'bg-red-500/10 text-red-400 border border-red-500/30' },
  }
  const { label, className } = map[status] ?? map.stopped
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}

export default async function InstancesPage() {
  let instances: Instance[] = []
  let error: string | null = null

  try {
    instances = await listInstances()
  } catch (e) {
    error = (e as Error).message
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">GPU Instances</h1>
          <p className="text-sm text-slate-500 mt-0.5">On-demand GPU compute for training and inference</p>
        </div>
        <a
          href="/instances/new"
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
          Launch Instance
        </a>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-4">
          {error}
        </div>
      )}

      {instances.length === 0 && !error && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/50 px-8 py-16 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800">
            <svg className="h-6 w-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-13.5 0V11.25m13.5 3V11.25m0 0a3 3 0 00-3-3h-7.5a3 3 0 00-3 3m13.5 0H3.75" />
            </svg>
          </div>
          <p className="text-slate-300 font-medium mb-1">No instances yet</p>
          <p className="text-slate-500 text-sm mb-4">Spin up a GPU instance in seconds</p>
          <a
            href="/instances/new"
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            Launch your first GPU instance →
          </a>
        </div>
      )}

      {instances.length > 0 && (
        <div className="rounded-lg border border-slate-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 bg-slate-900/60">
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Name</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Image</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Type</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">GPU</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Cost/hr</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">SSH</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {instances.map((inst) => (
                <tr key={inst.id} className="bg-slate-900 hover:bg-slate-800/60 transition-colors">
                  <td className="px-4 py-3">
                    <div>
                      <p className="font-medium text-slate-100">{inst.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{inst.id.slice(0, 8)}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div>
                      <p className="text-slate-200">{inst.image.name}</p>
                      <p className="text-xs text-slate-500 mt-0.5">{inst.image.version}</p>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{inst.instance_type.name}</td>
                  <td className="px-4 py-3">{statusBadge(inst.status)}</td>
                  <td className="px-4 py-3">
                    {inst.instance_type.gpu_model ? (
                      <div>
                        <p className="text-slate-200">{inst.instance_type.gpu_model}</p>
                        <p className="text-xs text-slate-500">{inst.instance_type.gpu_count}× · {inst.instance_type.vram_gb}GB VRAM</p>
                      </div>
                    ) : (
                      <span className="text-slate-500 text-xs">CPU only</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-slate-300 font-medium">{inst.instance_type.price_formatted}</td>
                  <td className="px-4 py-3">
                    {inst.ssh_host ? (
                      <code className="text-xs bg-slate-800 text-slate-300 px-2 py-0.5 rounded font-mono">
                        {inst.ssh_host}:{inst.ssh_port}
                      </code>
                    ) : (
                      <span className="text-slate-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {inst.jupyter_url && (
                        <a
                          href={inst.jupyter_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          Jupyter
                        </a>
                      )}
                      {inst.status === 'running' && (
                        <button className="text-xs text-red-400 hover:text-red-300 transition-colors border border-red-800 hover:border-red-700 rounded px-2 py-0.5">
                          Stop
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
