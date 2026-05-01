'use client'

import { useState, useRef, useEffect } from 'react'
import { useProject } from '../context/ProjectContext'

const ENV_LABELS: Record<string, string> = {
  production:  'prod',
  staging:     'staging',
  development: 'dev',
}

export default function ProjectSwitcher() {
  const { projects, activeProject, activeEnv, setActiveProject, setActiveEnv, loading } = useProject()

  const [open, setOpen]               = useState(false)
  const [showNew, setShowNew]         = useState(false)
  const [newName, setNewName]         = useState('')
  const [creating, setCreating]       = useState(false)
  const [createError, setCreateError] = useState('')

  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const createProject = async () => {
    if (!newName.trim()) return
    setCreating(true)
    setCreateError('')
    try {
      const res = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ name: newName.trim() }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create project')
      const created = await res.json()
      setShowNew(false)
      setNewName('')
      window.location.reload()
      setActiveProject(created)
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  const envs = activeProject?.environments ?? []

  return (
    <>
      <div className="px-4 pb-3 shrink-0">
        {/* Project dropdown trigger */}
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setOpen(o => !o)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-[#14142A] border border-[#2A2844] hover:border-[#F97316]/30 transition-colors group"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-5 h-5 rounded bg-[#F97316]/15 flex items-center justify-center shrink-0">
                <span className="text-[#F97316] text-[9px] font-bold font-headline uppercase">
                  {loading ? '…' : (activeProject?.name?.[0] ?? 'P')}
                </span>
              </div>
              <span className="text-xs font-semibold text-[#EDE9E1] truncate">
                {loading ? 'Loading…' : (activeProject?.name ?? 'Select project')}
              </span>
            </div>
            <span
              className={`material-symbols-outlined text-[#4A4760] group-hover:text-[#F97316] transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
              style={{ fontSize: 16 }}
            >
              expand_more
            </span>
          </button>

          {/* Dropdown */}
          {open && (
            <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[#0E0E1C] border border-[#2A2844] rounded-lg shadow-xl overflow-hidden">
              <div className="py-1 max-h-56 overflow-y-auto">
                {projects.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { setActiveProject(p); setOpen(false) }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-[#14142A] transition-colors ${
                      p.id === activeProject?.id ? 'text-[#F97316]' : 'text-[#8C89A4]'
                    }`}
                  >
                    <div className="w-4 h-4 rounded bg-[#F97316]/10 flex items-center justify-center shrink-0">
                      <span className="text-[#F97316] text-[8px] font-bold uppercase">{p.name[0]}</span>
                    </div>
                    <span className="truncate flex-1 text-left font-medium">{p.name}</span>
                    {p.id === activeProject?.id && (
                      <span className="material-symbols-outlined text-[#F97316]" style={{ fontSize: 14 }}>check</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="border-t border-[#2A2844] py-1">
                <button
                  onClick={() => { setOpen(false); setShowNew(true) }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-[#8C89A4] hover:bg-[#14142A] hover:text-[#F97316] transition-colors"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
                  New project
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Environment pill tabs */}
        {envs.length > 0 && (
          <div className="flex items-center gap-1 mt-2">
            {envs.map(env => {
              const isActive = activeEnv === env.slug
              return (
                <button
                  key={env.id}
                  onClick={() => setActiveEnv(env.slug)}
                  className={`flex-1 text-center px-1.5 py-1 rounded text-[10px] font-semibold transition-colors ${
                    isActive
                      ? 'bg-[#F97316]/12 text-[#F97316] border border-[#F97316]/30'
                      : 'text-[#4A4760] hover:bg-[#14142A] hover:text-[#EDE9E1] border border-transparent'
                  }`}
                >
                  {ENV_LABELS[env.slug] ?? env.name}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* "New project" modal */}
      {showNew && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="bg-[#0E0E1C] border border-[#2A2844] rounded-xl p-6 w-full max-w-sm mx-4">
            <h2 className="text-base font-bold text-[#EDE9E1] mb-4">New Project</h2>
            <label className="text-xs text-[#8C89A4] block mb-1">Project name</label>
            <input
              autoFocus
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createProject() }}
              className="w-full bg-[#14142A] border border-[#2A2844] rounded-lg px-3 py-2 text-sm text-[#EDE9E1] outline-none focus:border-[#F97316]/50 mb-2"
              placeholder="my-new-project"
            />
            {createError && <p className="text-xs text-red-400 mb-2">{createError}</p>}
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => { setShowNew(false); setNewName(''); setCreateError('') }}
                className="flex-1 px-4 py-2 border border-[#2A2844] rounded-lg text-sm text-[#8C89A4] hover:bg-[#14142A]"
              >
                Cancel
              </button>
              <button
                onClick={createProject}
                disabled={creating || !newName.trim()}
                className="flex-1 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A]"
              >
                {creating ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
