'use client'
import { createContext, useContext, useState, useEffect, ReactNode } from 'react'

export type Environment = { id: string; name: string; slug: string }
export type Project = { id: string; name: string; slug: string; environments: Environment[] }

type ProjectContextType = {
  projects: Project[]
  activeProject: Project | null
  activeEnv: string
  setActiveProject: (p: Project) => void
  setActiveEnv: (e: string) => void
  loading: boolean
}

const DEFAULT_ENVS: Environment[] = [
  { id: 'production',  name: 'Production',  slug: 'production'  },
  { id: 'staging',     name: 'Staging',     slug: 'staging'     },
  { id: 'development', name: 'Development', slug: 'development' },
]

export const ProjectContext = createContext<ProjectContextType>({
  projects: [],
  activeProject: null,
  activeEnv: 'production',
  setActiveProject: () => {},
  setActiveEnv: () => {},
  loading: true,
})

export function ProjectProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [activeProject, setActiveProjectState] = useState<Project | null>(null)
  const [activeEnv, setActiveEnvState] = useState<string>('production')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch('/api/v1/projects')
        let fetched: Project[] = []
        if (res.ok) {
          fetched = await res.json()
          // Ensure every project has environments; fall back to defaults
          fetched = fetched.map(p => ({
            ...p,
            environments: p.environments?.length ? p.environments : DEFAULT_ENVS,
          }))
        }
        // Always have at least a demo project so the UI isn't empty
        if (fetched.length === 0) {
          fetched = [{ id: 'demo', name: 'my-startup', slug: 'my-startup', environments: DEFAULT_ENVS }]
        }
        setProjects(fetched)

        // Restore persisted selections
        const savedId  = typeof window !== 'undefined' ? localStorage.getItem('tinai_project_id')  : null
        const savedEnv = typeof window !== 'undefined' ? localStorage.getItem('tinai_active_env')   : null

        const restoredProject = savedId ? fetched.find(p => p.id === savedId) ?? fetched[0] : fetched[0]
        const restoredEnv     = savedEnv ?? 'production'

        setActiveProjectState(restoredProject)
        setActiveEnvState(restoredEnv)
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  const setActiveProject = (p: Project) => {
    setActiveProjectState(p)
    if (typeof window !== 'undefined') localStorage.setItem('tinai_project_id', p.id)
    // Reset env to production when switching projects
    setActiveEnvState('production')
    if (typeof window !== 'undefined') localStorage.setItem('tinai_active_env', 'production')
  }

  const setActiveEnv = (e: string) => {
    setActiveEnvState(e)
    if (typeof window !== 'undefined') localStorage.setItem('tinai_active_env', e)
  }

  return (
    <ProjectContext.Provider value={{ projects, activeProject, activeEnv, setActiveProject, setActiveEnv, loading }}>
      {children}
    </ProjectContext.Provider>
  )
}

export const useProject = () => useContext(ProjectContext)
