'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import type { CanvasApp, CanvasDatabase, CanvasVolume } from './page'

// ── Constants ────────────────────────────────────────────────────────────────

const NODE_W = 140
const NODE_H = 64
const COL_GAP = 200
const ROW_GAP = 100
const CANVAS_PAD = 60

type NodeKind = 'app' | 'database' | 'redis' | 'volume' | 'function'

interface Node {
  id: string
  kind: NodeKind
  label: string
  sublabel: string
  statusBadge?: string
  statusColor?: string
  meta?: string
  appRef?: string      // for db/volume — which app it belongs to
}

interface Edge {
  from: string
  to: string
  style: 'solid' | 'dashed'
  color: string
}

interface Pos { x: number; y: number }

// ── Colour palette ───────────────────────────────────────────────────────────

const KIND_COLORS: Record<NodeKind, { border: string; bg: string; dot: string }> = {
  app:      { border: '#3b82f6', bg: '#1e3a5f', dot: '#60a5fa' },
  database: { border: '#22c55e', bg: '#14352a', dot: '#4ade80' },
  redis:    { border: '#ef4444', bg: '#3b1212', dot: '#f87171' },
  volume:   { border: '#eab308', bg: '#352d0a', dot: '#fde047' },
  function: { border: '#a855f7', bg: '#2e1652', dot: '#c084fc' },
}

const STATUS_COLORS: Record<string, string> = {
  running:     '#4ade80',
  deploying:   '#facc15',
  failed:      '#f87171',
  unknown:     '#94a3b8',
  available:   '#4ade80',
  provisioning:'#facc15',
  bound:       '#4ade80',
}

// ── Build graph from props ───────────────────────────────────────────────────

function buildGraph(
  apps: CanvasApp[],
  databases: CanvasDatabase[],
  volumes: CanvasVolume[],
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []

  for (const a of apps) {
    nodes.push({
      id:          `app:${a.name}`,
      kind:        'app',
      label:       a.name,
      sublabel:    a.image?.split('/').pop()?.split(':')[0] ?? 'container',
      statusBadge: a.status,
      statusColor: STATUS_COLORS[a.status] ?? STATUS_COLORS.unknown,
      appRef:      a.name,
    })
  }

  for (const db of databases) {
    const nodeId = `db:${db.app_name}`
    nodes.push({
      id:          nodeId,
      kind:        'database',
      label:       db.db_name,
      sublabel:    'Postgres 16 + pgvector',
      statusBadge: db.status,
      statusColor: STATUS_COLORS[db.status] ?? STATUS_COLORS.unknown,
      appRef:      db.app_name,
    })
    edges.push({
      from:  `app:${db.app_name}`,
      to:    nodeId,
      style: 'solid',
      color: '#3b82f6',
    })
  }

  for (const vol of volumes) {
    // volumes may belong to multiple apps; use volume_name as key
    const nodeId = `vol:${vol.volume_name}`
    if (!nodes.find(n => n.id === nodeId)) {
      nodes.push({
        id:          nodeId,
        kind:        'volume',
        label:       vol.volume_name,
        sublabel:    `${vol.size_gi}Gi · ${vol.mount_path}`,
        statusBadge: vol.status,
        statusColor: STATUS_COLORS[vol.status] ?? STATUS_COLORS.unknown,
      })
    }
  }

  return { nodes, edges }
}

// ── Auto-layout: columns by kind ─────────────────────────────────────────────

function autoLayout(nodes: Node[]): Record<string, Pos> {
  const cols: NodeKind[] = ['function', 'app', 'database', 'volume', 'redis']
  const byKind: Partial<Record<NodeKind, Node[]>> = {}
  for (const n of nodes) {
    if (!byKind[n.kind]) byKind[n.kind] = []
    byKind[n.kind]!.push(n)
  }

  const positions: Record<string, Pos> = {}
  let colIdx = 0

  for (const kind of cols) {
    const kindNodes = byKind[kind] ?? []
    if (kindNodes.length === 0) continue
    kindNodes.forEach((n, row) => {
      positions[n.id] = {
        x: CANVAS_PAD + colIdx * (NODE_W + COL_GAP),
        y: CANVAS_PAD + row * (NODE_H + ROW_GAP),
      }
    })
    colIdx++
  }

  return positions
}

// ── SVG bezier path ───────────────────────────────────────────────────────────

function bezierPath(from: Pos, to: Pos): string {
  const fx = from.x + NODE_W
  const fy = from.y + NODE_H / 2
  const tx = to.x
  const ty = to.y + NODE_H / 2
  const cx = (fx + tx) / 2
  return `M ${fx} ${fy} C ${cx} ${fy}, ${cx} ${ty}, ${tx} ${ty}`
}

// ── Export canvas as PNG ──────────────────────────────────────────────────────

function exportPNG(svgEl: SVGSVGElement) {
  const box  = svgEl.getBoundingClientRect()
  const data = new XMLSerializer().serializeToString(svgEl)
  const blob = new Blob([data], { type: 'image/svg+xml;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const img  = new Image()
  img.onload = () => {
    const cvs = document.createElement('canvas')
    cvs.width  = box.width  * 2
    cvs.height = box.height * 2
    const ctx = cvs.getContext('2d')!
    ctx.scale(2, 2)
    ctx.fillStyle = '#020617' // slate-950
    ctx.fillRect(0, 0, box.width, box.height)
    ctx.drawImage(img, 0, 0)
    URL.revokeObjectURL(url)
    const link  = document.createElement('a')
    link.href   = cvs.toDataURL('image/png')
    link.download = 'service-canvas.png'
    link.click()
  }
  img.src = url
}

// ── Quick-info panel ──────────────────────────────────────────────────────────

function InfoPanel({ node, onClose }: { node: Node; onClose: () => void }) {
  const c = KIND_COLORS[node.kind]
  return (
    <div className="absolute right-0 top-0 w-64 bg-slate-900 border rounded-lg p-4 shadow-xl z-10"
         style={{ borderColor: c.border }}>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs uppercase tracking-wide font-medium" style={{ color: c.dot }}>
          {node.kind}
        </span>
        <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-lg leading-none">×</button>
      </div>
      <div className="font-mono text-sm text-slate-100 mb-1 break-all">{node.label}</div>
      <div className="text-xs text-slate-400 mb-3">{node.sublabel}</div>
      {node.statusBadge && (
        <div className="flex items-center gap-2 mb-3">
          <span className="w-2 h-2 rounded-full inline-block" style={{ background: node.statusColor }} />
          <span className="text-xs text-slate-300">{node.statusBadge}</span>
        </div>
      )}
      {node.kind === 'app' && (
        <a
          href={`/apps/${node.label}`}
          className="block text-center text-xs rounded border border-slate-700 py-1.5 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
        >
          Open app detail →
        </a>
      )}
      {node.kind === 'database' && node.appRef && (
        <a
          href={`/apps/${node.appRef}/database`}
          className="block text-center text-xs rounded border border-slate-700 py-1.5 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
        >
          Open database →
        </a>
      )}
      {node.kind === 'volume' && node.appRef && (
        <a
          href={`/apps/${node.appRef}/volumes`}
          className="block text-center text-xs rounded border border-slate-700 py-1.5 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
        >
          Open volumes →
        </a>
      )}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────

interface Props {
  initialApps:      CanvasApp[]
  initialDatabases: CanvasDatabase[]
  initialVolumes:   CanvasVolume[]
}

const STORAGE_KEY = 'tinai_canvas_positions'

export default function ServiceCanvas({ initialApps, initialDatabases, initialVolumes }: Props) {
  const { nodes, edges } = buildGraph(initialApps, initialDatabases, initialVolumes)

  // Load saved positions from localStorage (or auto-layout)
  const [positions, setPositions] = useState<Record<string, Pos>>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem(STORAGE_KEY)
        if (saved) return JSON.parse(saved)
      } catch { /* ignore */ }
    }
    return autoLayout(nodes)
  })

  // Persist positions on change
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(positions)) } catch { /* ignore */ }
  }, [positions])

  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [dragging, setDragging] = useState<{ id: string; ox: number; oy: number } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Compute canvas dimensions
  const maxX = Math.max(...Object.values(positions).map(p => p.x), 0) + NODE_W + CANVAS_PAD
  const maxY = Math.max(...Object.values(positions).map(p => p.y), 0) + NODE_H + CANVAS_PAD

  // ── Drag handlers ──────────────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    const pos = positions[id] ?? { x: 0, y: 0 }
    setDragging({ id, ox: e.clientX - pos.x, oy: e.clientY - pos.y })
    setSelectedNode(nodes.find(n => n.id === id) ?? null)
  }, [positions, nodes])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging) return
    setPositions(prev => ({
      ...prev,
      [dragging.id]: {
        x: Math.max(0, e.clientX - dragging.ox),
        y: Math.max(0, e.clientY - dragging.oy),
      },
    }))
  }, [dragging])

  const onMouseUp = useCallback(() => setDragging(null), [])

  const handleAutoLayout = () => {
    const newPos = autoLayout(nodes)
    setPositions(newPos)
  }

  const handleFitToScreen = () => {
    if (!svgRef.current) return
    svgRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const handleExport = () => {
    if (svgRef.current) exportPNG(svgRef.current)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Service Canvas</h1>
          <p className="text-sm text-slate-400 mt-1">
            Visual map of all apps, databases, and volumes — drag to reposition
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleAutoLayout}
            className="text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Auto-layout
          </button>
          <button
            onClick={handleFitToScreen}
            className="text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Fit to screen
          </button>
          <button
            onClick={handleExport}
            className="text-xs px-3 py-1.5 rounded border border-slate-700 hover:border-slate-500 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Export PNG
          </button>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-slate-500">
        {(Object.entries(KIND_COLORS) as [NodeKind, typeof KIND_COLORS[NodeKind]][]).map(([kind, c]) => (
          <span key={kind} className="flex items-center gap-1.5">
            <span className="w-3 h-3 rounded border" style={{ borderColor: c.border, background: c.bg }} />
            {kind.charAt(0).toUpperCase() + kind.slice(1)}
          </span>
        ))}
        <span className="ml-4 flex items-center gap-1.5">
          <svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="#3b82f6" strokeWidth="1.5"/></svg>
          active connection
        </span>
        <span className="flex items-center gap-1.5">
          <svg width="24" height="8"><line x1="0" y1="4" x2="24" y2="4" stroke="#94a3b8" strokeWidth="1.5" strokeDasharray="4 3"/></svg>
          co-located
        </span>
      </div>

      {nodes.length === 0 ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-8 text-center">
          <p className="text-slate-400 text-sm mb-2">No services found.</p>
          <a href="/apps" className="text-xs text-blue-400 hover:text-blue-300">
            Deploy your first app →
          </a>
        </div>
      ) : (
        <div className="relative rounded-lg border border-slate-800 overflow-hidden bg-slate-950">
          {/* Info panel overlay */}
          {selectedNode && (
            <InfoPanel
              node={selectedNode}
              onClose={() => setSelectedNode(null)}
            />
          )}

          {/* SVG canvas */}
          <svg
            ref={svgRef}
            width={maxX}
            height={maxY}
            className="block cursor-default select-none"
            style={{ minHeight: 400 }}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            {/* Dot grid background */}
            <defs>
              <pattern id="grid" x="0" y="0" width="24" height="24" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="0.8" fill="#1e293b" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />

            {/* Dashed co-location lines for nodes sharing the same appRef */}
            {nodes
              .filter(n => n.kind !== 'app' && n.appRef)
              .map(n => {
                const appId = `app:${n.appRef}`
                const from  = positions[appId]
                const to    = positions[n.id]
                if (!from || !to) return null
                // Only draw dashed if there's no solid edge already
                const hasSolid = edges.some(e => e.from === appId && e.to === n.id)
                if (hasSolid) return null
                return (
                  <path
                    key={`colocate:${n.id}`}
                    d={bezierPath(from, to)}
                    fill="none"
                    stroke="#475569"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                    opacity={0.6}
                  />
                )
              })}

            {/* Solid connection edges */}
            {edges.map(e => {
              const from = positions[e.from]
              const to   = positions[e.to]
              if (!from || !to) return null
              return (
                <path
                  key={`edge:${e.from}-${e.to}`}
                  d={bezierPath(from, to)}
                  fill="none"
                  stroke={e.color}
                  strokeWidth={1.8}
                  strokeDasharray={e.style === 'dashed' ? '6 4' : undefined}
                  opacity={0.8}
                />
              )
            })}

            {/* Nodes */}
            {nodes.map(n => {
              const pos = positions[n.id] ?? { x: 0, y: 0 }
              const c   = KIND_COLORS[n.kind]
              const isSelected = selectedNode?.id === n.id
              return (
                <g
                  key={n.id}
                  transform={`translate(${pos.x},${pos.y})`}
                  style={{ cursor: 'grab' }}
                  onMouseDown={e => onMouseDown(e, n.id)}
                  onClick={() => setSelectedNode(n)}
                >
                  {/* Node card */}
                  <rect
                    width={NODE_W}
                    height={NODE_H}
                    rx={6}
                    ry={6}
                    fill={c.bg}
                    stroke={isSelected ? '#f8fafc' : c.border}
                    strokeWidth={isSelected ? 2 : 1.5}
                    opacity={0.95}
                  />

                  {/* Status indicator dot */}
                  {n.statusColor && (
                    <circle
                      cx={NODE_W - 10}
                      cy={10}
                      r={4}
                      fill={n.statusColor}
                    />
                  )}

                  {/* Kind dot */}
                  <circle cx={14} cy={NODE_H / 2} r={5} fill={c.dot} opacity={0.9} />

                  {/* Labels */}
                  <text
                    x={26}
                    y={NODE_H / 2 - 6}
                    fontSize={10}
                    fontFamily="ui-monospace, monospace"
                    fill="#f1f5f9"
                    dominantBaseline="middle"
                  >
                    {n.label.length > 14 ? n.label.slice(0, 13) + '…' : n.label}
                  </text>
                  <text
                    x={26}
                    y={NODE_H / 2 + 9}
                    fontSize={9}
                    fontFamily="ui-sans-serif, sans-serif"
                    fill="#64748b"
                    dominantBaseline="middle"
                  >
                    {n.sublabel.length > 16 ? n.sublabel.slice(0, 15) + '…' : n.sublabel}
                  </text>
                </g>
              )
            })}
          </svg>
        </div>
      )}

      {/* Add service prompt */}
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>{nodes.length} service{nodes.length !== 1 ? 's' : ''} on canvas</span>
        <a href="/templates" className="text-slate-500 hover:text-slate-300 transition-colors">
          + Add service from template →
        </a>
      </div>
    </div>
  )
}
