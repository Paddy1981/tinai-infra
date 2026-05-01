'use client'

import { usePathname } from 'next/navigation'
import Sidebar from './Sidebar'

const PUBLIC_ROUTES = ['/', '/login', '/signup', '/onboarding']

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isPublic = PUBLIC_ROUTES.includes(pathname)

  if (isPublic) {
    return <>{children}</>
  }

  const segment = pathname.split('/').filter(Boolean)[0] ?? 'dashboard'
  const pageTitle = segment.charAt(0).toUpperCase() + segment.slice(1)

  return (
    <>
      <Sidebar />

      {/* Fixed top header */}
      <header
        className="fixed top-0 left-64 right-0 h-16 z-30 flex items-center gap-4 px-6 backdrop-blur-xl border-b"
        style={{ backgroundColor: 'color-mix(in srgb, var(--t-bg) 85%, transparent)', borderColor: 'var(--t-border)' }}
      >
        <span className="text-sm font-semibold font-headline tracking-tight" style={{ color: 'var(--t-text)' }}>
          {pageTitle}
        </span>

        {/* Search */}
        <div className="flex-1 max-w-sm ml-4">
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border"
            style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: 'var(--t-text-dim)' }}>
              search
            </span>
            <input
              type="text"
              placeholder="Search..."
              className="flex-1 bg-transparent text-xs outline-none"
              style={{ color: 'var(--t-text)', caretColor: 'var(--t-text)' }}
            />
            <kbd
              className="text-[9px] font-mono px-1 py-0.5 rounded"
              style={{ color: 'var(--t-text-dim)', backgroundColor: 'var(--t-bg)' }}
            >
              ⌘K
            </kbd>
          </div>
        </div>

        <div className="flex-1" />

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ color: 'var(--t-text-dim)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = '#F97316' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>notifications</span>
          </button>
          <button
            className="flex items-center justify-center w-8 h-8 rounded-lg transition-colors"
            style={{ color: 'var(--t-text-dim)' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = '#F97316' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 18 }}>help_outline</span>
          </button>
          <div className="w-7 h-7 rounded-full bg-[#F97316] flex items-center justify-center cursor-pointer ml-1 shadow-[0_0_12px_rgba(249,115,22,0.3)]">
            <span className="text-white text-xs font-bold font-headline">T</span>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="ml-64 pt-16 min-h-screen">
        {children}
      </main>
    </>
  )
}
