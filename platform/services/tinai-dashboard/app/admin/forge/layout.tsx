'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const navItems = [
  { href: '/admin/forge', label: 'Dashboard', icon: 'speed' },
  { href: '/admin/forge/builds', label: 'Builds', icon: 'build' },
  { href: '/admin/forge/rollouts', label: 'Rollouts', icon: 'rocket_launch' },
  { href: '/admin/forge/patches', label: 'Patches', icon: 'palette' },
  { href: '/admin/forge/setup', label: 'Setup', icon: 'settings' },
]

export default function ForgeLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  const isActive = (href: string) =>
    href === '/admin/forge' ? pathname === href : pathname.startsWith(href)

  return (
    <div className="p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm mb-1" style={{ color: 'var(--t-text-muted)' }}>
          <Link href="/admin/health" className="hover:text-white transition-colors">Admin</Link>
          <span>/</span>
          <span style={{ color: 'var(--t-text)' }}>Forge</span>
        </div>
        <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>
          Forge Pipeline Manager
        </h1>
        <p className="text-sm mt-0.5" style={{ color: 'var(--t-text-muted)' }}>
          White-label automation for upstream open-source components
        </p>
      </div>

      {/* Horizontal tabs */}
      <div className="flex gap-1 border-b mb-6" style={{ borderColor: 'var(--t-border)' }}>
        {navItems.map(item => (
          <Link
            key={item.href}
            href={item.href}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px ${
              isActive(item.href)
                ? 'border-[#F97316] text-[#F97316]'
                : 'border-transparent hover:border-[#F97316]/30'
            }`}
            style={isActive(item.href) ? {} : { color: 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16 }}>{item.icon}</span>
            {item.label}
          </Link>
        ))}
      </div>

      {/* Content */}
      {children}
    </div>
  )
}
