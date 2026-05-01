'use client'

import { useEffect, useState, useCallback } from 'react'

interface NodeMetrics {
  instance: string
  cpu_percent: number
  memory_percent: number
  memory_total_gb: number
  memory_used_gb: number
  disk_percent: number
  disk_total_gb: number
  disk_used_gb: number
  uptime_hours: number
  load_1m: number
  load_5m: number
  load_15m: number
}

interface ContainerMetrics {
  pod: string
  namespace: string
  cpu_percent: number
  memory_mb: number
}

const PROM = '/api/v1/prometheus'

async function promQuery(query: string): Promise<{ metric: Record<string, string>; value: [number, string] }[]> {
  try {
    const res = await fetch(`${PROM}?query=${encodeURIComponent(query)}`)
    if (!res.ok) return []
    const data = await res.json()
    return data?.data?.result ?? []
  } catch {
    return []
  }
}

function Gauge({ label, value, max, unit, color }: { label: string; value: number; max: number; unit: string; color: string }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0
  const barColor = pct > 90 ? '#ef4444' : pct > 70 ? '#f59e0b' : color
  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
      <p className="text-xs mb-2" style={{ color: 'var(--t-text-dim)' }}>{label}</p>
      <div className="flex items-end gap-2 mb-2">
        <span className="text-2xl font-bold" style={{ color: 'var(--t-text)' }}>{value.toFixed(1)}</span>
        <span className="text-xs mb-1" style={{ color: 'var(--t-text-dim)' }}>/ {max.toFixed(1)} {unit}</span>
      </div>
      <div className="h-2 rounded-full" style={{ backgroundColor: 'var(--t-surface-2)' }}>
        <div className="h-2 rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: barColor }} />
      </div>
      <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>{pct.toFixed(0)}% used</p>
    </div>
  )
}

function Stat({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="rounded-lg border p-4" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
      <p className="text-xs mb-1" style={{ color: 'var(--t-text-dim)' }}>{label}</p>
      <div className="flex items-end gap-1">
        <span className="text-xl font-bold" style={{ color: 'var(--t-text)' }}>{value}</span>
        {suffix && <span className="text-xs mb-0.5" style={{ color: 'var(--t-text-dim)' }}>{suffix}</span>}
      </div>
    </div>
  )
}

export default function HardwarePage() {
  const [nodes, setNodes] = useState<NodeMetrics[]>([])
  const [containers, setContainers] = useState<ContainerMetrics[]>([])
  const [loading, setLoading] = useState(true)
  const [lastUpdate, setLastUpdate] = useState('')

  const load = useCallback(async () => {
    const [memTotal, memAvail, cpuIdle, diskSize, diskAvail, load1, load5, load15, uptime] = await Promise.all([
      promQuery('node_memory_MemTotal_bytes'),
      promQuery('node_memory_MemAvailable_bytes'),
      promQuery('avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) by (instance)'),
      promQuery('node_filesystem_size_bytes{mountpoint="/"}'),
      promQuery('node_filesystem_avail_bytes{mountpoint="/"}'),
      promQuery('node_load1'),
      promQuery('node_load5'),
      promQuery('node_load15'),
      promQuery('node_time_seconds - node_boot_time_seconds'),
    ])

    const instances = new Set<string>()
    memTotal.forEach(r => instances.add(r.metric.instance))

    const nodeList: NodeMetrics[] = []
    for (const inst of instances) {
      const mt = memTotal.find(r => r.metric.instance === inst)
      const ma = memAvail.find(r => r.metric.instance === inst)
      const ci = cpuIdle.find(r => r.metric.instance === inst)
      const ds = diskSize.find(r => r.metric.instance === inst)
      const da = diskAvail.find(r => r.metric.instance === inst)
      const l1 = load1.find(r => r.metric.instance === inst)
      const l5 = load5.find(r => r.metric.instance === inst)
      const l15 = load15.find(r => r.metric.instance === inst)
      const ut = uptime.find(r => r.metric.instance === inst)

      const memTotalGb = mt ? parseFloat(mt.value[1]) / 1024 ** 3 : 0
      const memAvailGb = ma ? parseFloat(ma.value[1]) / 1024 ** 3 : 0
      const diskTotalGb = ds ? parseFloat(ds.value[1]) / 1024 ** 3 : 0
      const diskAvailGb = da ? parseFloat(da.value[1]) / 1024 ** 3 : 0

      nodeList.push({
        instance: inst.replace(':9100', ''),
        cpu_percent: ci ? (1 - parseFloat(ci.value[1])) * 100 : 0,
        memory_percent: memTotalGb > 0 ? ((memTotalGb - memAvailGb) / memTotalGb) * 100 : 0,
        memory_total_gb: memTotalGb,
        memory_used_gb: memTotalGb - memAvailGb,
        disk_percent: diskTotalGb > 0 ? ((diskTotalGb - diskAvailGb) / diskTotalGb) * 100 : 0,
        disk_total_gb: diskTotalGb,
        disk_used_gb: diskTotalGb - diskAvailGb,
        uptime_hours: ut ? parseFloat(ut.value[1]) / 3600 : 0,
        load_1m: l1 ? parseFloat(l1.value[1]) : 0,
        load_5m: l5 ? parseFloat(l5.value[1]) : 0,
        load_15m: l15 ? parseFloat(l15.value[1]) : 0,
      })
    }

    // Container metrics
    const [containerMem, containerCpu] = await Promise.all([
      promQuery('container_memory_usage_bytes{namespace=~"tinai-apps|tinai-system",container!="",container!="POD"}'),
      promQuery('rate(container_cpu_usage_seconds_total{namespace=~"tinai-apps|tinai-system",container!="",container!="POD"}[5m])'),
    ])

    const containerMap = new Map<string, ContainerMetrics>()
    containerMem.forEach(r => {
      const key = `${r.metric.namespace}/${r.metric.pod}`
      containerMap.set(key, {
        pod: r.metric.pod ?? '',
        namespace: r.metric.namespace ?? '',
        cpu_percent: 0,
        memory_mb: parseFloat(r.value[1]) / 1024 ** 2,
      })
    })
    containerCpu.forEach(r => {
      const key = `${r.metric.namespace}/${r.metric.pod}`
      const existing = containerMap.get(key)
      if (existing) existing.cpu_percent = parseFloat(r.value[1]) * 100
    })

    setNodes(nodeList)
    setContainers(Array.from(containerMap.values()).sort((a, b) => b.memory_mb - a.memory_mb))
    setLastUpdate(new Date().toLocaleTimeString())
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30000)
    return () => clearInterval(id)
  }, [load])

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>Hardware Monitor</h1>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>Real-time infrastructure metrics from Prometheus</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>Updated: {lastUpdate}</span>
          <button onClick={load} className="px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors hover:border-[#F97316]/30"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading metrics...</div>
      ) : (
        <>
          {nodes.map(node => (
            <div key={node.instance} className="mb-8">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <h2 className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>{node.instance}</h2>
                <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
                  Up {Math.floor(node.uptime_hours / 24)}d {Math.floor(node.uptime_hours % 24)}h
                </span>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
                <Gauge label="CPU" value={node.cpu_percent} max={100} unit="%" color="#F97316" />
                <Gauge label="Memory" value={node.memory_used_gb} max={node.memory_total_gb} unit="GB" color="#3b82f6" />
                <Gauge label="Disk" value={node.disk_used_gb} max={node.disk_total_gb} unit="GB" color="#8b5cf6" />
                <Stat label="Load Average" value={`${node.load_1m.toFixed(2)}`} suffix={`${node.load_5m.toFixed(2)} / ${node.load_15m.toFixed(2)}`} />
              </div>
            </div>
          ))}

          {containers.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--t-text)' }}>
                Container Resources ({containers.length} containers)
              </h2>
              <div className="rounded-lg border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
                <table className="w-full text-xs">
                  <thead>
                    <tr style={{ backgroundColor: 'var(--t-surface-2)' }}>
                      <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--t-text-dim)' }}>Pod</th>
                      <th className="text-left px-3 py-2 font-medium" style={{ color: 'var(--t-text-dim)' }}>Namespace</th>
                      <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--t-text-dim)' }}>CPU %</th>
                      <th className="text-right px-3 py-2 font-medium" style={{ color: 'var(--t-text-dim)' }}>Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {containers.slice(0, 25).map(c => (
                      <tr key={`${c.namespace}/${c.pod}`} className="border-t" style={{ borderColor: 'var(--t-border)' }}>
                        <td className="px-3 py-2 font-mono" style={{ color: 'var(--t-text)' }}>{c.pod}</td>
                        <td className="px-3 py-2" style={{ color: 'var(--t-text-muted)' }}>{c.namespace}</td>
                        <td className="px-3 py-2 text-right" style={{ color: c.cpu_percent > 50 ? '#f59e0b' : 'var(--t-text-muted)' }}>
                          {c.cpu_percent.toFixed(1)}%
                        </td>
                        <td className="px-3 py-2 text-right" style={{ color: c.memory_mb > 200 ? '#f59e0b' : 'var(--t-text-muted)' }}>
                          {c.memory_mb.toFixed(0)} MB
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
