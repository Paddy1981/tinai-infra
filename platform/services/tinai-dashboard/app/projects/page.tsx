'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Project {
  id: string
  name: string
  slug: string
  description?: string
  created_at: string
  environment_count?: number
}

const inputStyle = {
  backgroundColor: 'var(--t-surface-2)',
  borderColor: 'var(--t-border)',
  color: 'var(--t-text)',
}

export default function ProjectsPage() {
  const router = useRouter()
  const [projects, setProjects]   = useState<Project[]>([])
  const [loading, setLoading]     = useState(true)
  const [showNew, setShowNew]     = useState(false)
  const [name, setName]           = useState('')
  const [desc, setDesc]           = useState('')
  const [creating, setCreating]   = useState(false)
  const [error, setError]         = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/v1/projects')
      if (res.ok) setProjects(await res.json())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const create = async () => {
    if (!name.trim()) return
    setCreating(true)
    setError('')
    try {
      const res = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ name: name.trim(), description: desc.trim() || undefined }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create project')
      setShowNew(false)
      setName('')
      setDesc('')
      await load()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setCreating(false)
    }
  }

  const deleteProject = async (id: string, pname: string) => {
    if (!confirm(`Delete project "${pname}"? This will remove all its environments.`)) return
    await fetch(`/api/v1/projects/${id}`, { method: 'DELETE', headers: { 'x-tinai-csrf': '1' } })
    await load()
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>Projects</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
            Organise workloads by project and environment
          </p>
        </div>
        <button
          onClick={() => setShowNew(true)}
          className="flex items-center gap-2 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold hover:bg-[#EA6C0A] transition-colors"
        >
          <span className="material-symbols-outlined" style={{ fontSize: 16 }}>add</span>
          New Project
        </button>
      </div>

      {loading ? (
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading...</div>
      ) : projects.length === 0 ? (
        <div className="py-20 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>folder_open</span>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No projects yet</p>
          <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Create a project to organise your workloads</p>
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map(p => (
            <div
              key={p.id}
              onClick={() => router.push(`/projects/${p.id}`)}
              className="rounded-xl border p-5 transition-colors hover:border-[#F97316]/30 cursor-pointer"
              style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-7 h-7 rounded-lg bg-[#F97316]/15 flex items-center justify-center shrink-0">
                      <span className="text-[#F97316] text-xs font-bold uppercase">{p.name[0]}</span>
                    </div>
                    <h3 className="text-sm font-semibold" style={{ color: 'var(--t-text)' }}>{p.name}</h3>
                    <code className="text-xs px-1.5 py-0.5 rounded font-mono" style={{ backgroundColor: 'var(--t-surface-2)', color: 'var(--t-text-dim)' }}>
                      {p.slug}
                    </code>
                  </div>
                  {p.description && (
                    <p className="text-xs ml-9 mb-2" style={{ color: 'var(--t-text-muted)' }}>{p.description}</p>
                  )}
                  <div className="flex items-center gap-3 ml-9 mt-2">
                    <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--t-text-dim)' }}>
                      <span className="material-symbols-outlined" style={{ fontSize: 14 }}>layers</span>
                      {p.environment_count ?? 0} environment{(p.environment_count ?? 0) !== 1 ? 's' : ''}
                    </span>
                    <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
                      Created {new Date(p.created_at).toLocaleDateString('en-IN')}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--t-text-dim)' }}>chevron_right</span>
                  <button
                    onClick={(e) => { e.stopPropagation(); deleteProject(p.id, p.name) }}
                    className="p-1.5 rounded-lg transition-colors hover:text-red-400"
                    style={{ color: 'var(--t-text-dim)' }}
                    title="Delete project"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 16 }}>delete</span>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showNew && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-md mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h2 className="text-base font-bold mb-1" style={{ color: 'var(--t-text)' }}>New Project</h2>
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-muted)' }}>
              Creates production and staging environments automatically.
            </p>
            <div className="space-y-3">
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--t-text-muted)' }}>Project name</label>
                <input
                  autoFocus value={name} onChange={e => setName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') create() }}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#F97316]/50"
                  style={inputStyle} placeholder="my-project"
                />
              </div>
              <div>
                <label className="text-xs block mb-1" style={{ color: 'var(--t-text-muted)' }}>Description (optional)</label>
                <input
                  value={desc} onChange={e => setDesc(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm outline-none border focus:border-[#F97316]/50"
                  style={inputStyle} placeholder="What is this project for?"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
            </div>
            <div className="flex gap-3 mt-5">
              <button onClick={() => { setShowNew(false); setName(''); setDesc(''); setError('') }}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}>
                Cancel
              </button>
              <button onClick={create} disabled={creating || !name.trim()}
                className="flex-1 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A]">
                {creating ? 'Creating...' : 'Create Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
