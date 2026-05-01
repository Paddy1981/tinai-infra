'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const PUBLIC_ROUTES = ['/', '/login', '/signup', '/onboarding']

const NAV_SECTIONS = [
  {
    label: null,
    items: [
      { href: '/dashboard',  label: 'Dashboard',  icon: 'grid_view' },
      { href: '/projects',   label: 'Projects',   icon: 'folder' },
    ],
  },
  {
    label: 'Compute',
    items: [
      { href: '/instances',  label: 'Instances',  icon: 'dns' },
      { href: '/workloads',  label: 'Workloads',  icon: 'rocket_launch' },
      { href: '/apps',       label: 'Apps',        icon: 'apps' },
      { href: '/inference',  label: 'Inference',   icon: 'psychology' },
    ],
  },
  {
    label: 'Platform',
    items: [
      { href: '/storage',    label: 'Storage',    icon: 'database' },
      { href: '/templates',  label: 'Templates',  icon: 'workspaces' },
      { href: '/gateway',    label: 'Gateway',    icon: 'router' },
    ],
  },
  {
    label: 'Products',
    items: [
      { href: '/mail',       label: 'Mail',       icon: 'mail' },
      { href: '/coll',       label: 'COLL',       icon: 'forum' },
      { href: '/admin/forge', label: 'Forge',     icon: 'build' },
      { href: '/space',      label: 'Space',      icon: 'satellite_alt' },
    ],
  },
  {
    label: 'AI',
    items: [
      { href: '/copilot',    label: 'Copilot',    icon: 'assistant' },
      { href: '/generate',   label: 'Generate',   icon: 'bolt' },
    ],
  },
]

const NAV_BOTTOM = [
  { href: '/billing',      label: 'Billing',    icon: 'payments' },
  { href: '/compliance',   label: 'Compliance', icon: 'verified_user' },
  { href: '/admin/health',    label: 'Health',     icon: 'monitor_heart' },
  { href: '/admin/hardware',  label: 'Hardware',   icon: 'memory' },
  { href: '/admin/users',     label: 'Admin',      icon: 'admin_panel_settings' },
  { href: '/settings',     label: 'Settings',   icon: 'settings' },
]

function TmarkLogo({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M 8,4 H 24 Q 29,4 29,9 V 14 H 20 V 28 Q 20,32 16,32 Q 12,32 12,28 V 14 H 3 V 9 Q 3,4 8,4 Z"
        fill="currentColor"
      />
    </svg>
  )
}

function NavLink({ href, label, icon, active }: { href: string; label: string; icon: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
        active
          ? 'text-[#F97316] border-l-2 border-[#F97316] bg-gradient-to-r from-[#F97316]/8 to-transparent pl-3.5'
          : 'border-l-2 border-transparent pl-3.5'
      }`}
      style={active ? {} : { color: 'var(--t-text-muted)' }}
      onMouseEnter={e => { if (!active) { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' } }}
      onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' } }}
    >
      <span className="material-symbols-outlined shrink-0" style={{ fontSize: 18 }}>
        {icon}
      </span>
      {label}
    </Link>
  )
}

export default function Sidebar() {
  const pathname = usePathname()

  if (PUBLIC_ROUTES.includes(pathname)) return null

  const isActive = (href: string) => pathname === href || (href !== '/' && pathname.startsWith(href))

  return (
    <aside
      className="fixed left-0 top-0 h-full w-64 z-40 flex flex-col border-r t-sidebar"
      style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
    >
      {/* Logo */}
      <div className="px-6 py-8 shrink-0">
        <Link href="/" className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#F97316] flex items-center justify-center shrink-0 shadow-[0_0_16px_rgba(249,115,22,0.35)]">
            <span className="text-white" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <TmarkLogo size={16} />
            </span>
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight font-headline leading-none t-text" style={{ color: 'var(--t-text)' }}>
              <span className="font-bold">tinai</span>
              <span className="font-light" style={{ color: 'var(--t-text-muted)' }}>.cloud</span>
            </h1>
            <p className="text-[9px] uppercase tracking-widest font-medium mt-0.5 t-text-dim" style={{ color: 'var(--t-text-dim)' }}>
              Sovereign AI
            </p>
          </div>
        </Link>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-4 overflow-y-auto">
        {NAV_SECTIONS.map((section, i) => (
          <div key={section.label ?? 'top'} className={i > 0 ? 'mt-4' : ''}>
            {section.label && (
              <p
                className="px-4 mb-1 text-[10px] uppercase tracking-widest font-semibold"
                style={{ color: 'var(--t-text-dim)' }}
              >
                {section.label}
              </p>
            )}
            <div className="space-y-0.5">
              {section.items.map(({ href, label, icon }) => (
                <NavLink key={href} href={href} label={label} icon={icon} active={isActive(href)} />
              ))}
            </div>
          </div>
        ))}

        <div className="my-3 border-t t-border" style={{ borderColor: 'var(--t-border)' }} />

        <div className="space-y-0.5">
          {NAV_BOTTOM.map(({ href, label, icon }) => (
            <NavLink key={href} href={href} label={label} icon={icon} active={isActive(href)} />
          ))}
        </div>
      </nav>

      {/* User footer */}
      <div className="px-4 py-5 shrink-0 border-t t-border" style={{ borderColor: 'var(--t-border)' }}>
        <div className="flex items-center gap-3 px-2 py-2 rounded-lg">
          <div className="w-7 h-7 rounded-full bg-[#F97316] flex items-center justify-center shrink-0">
            <span className="text-white text-xs font-bold font-headline">T</span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold truncate t-text" style={{ color: 'var(--t-text)' }}>tinai-admin</p>
            <p className="text-[9px] truncate t-text-dim" style={{ color: 'var(--t-text-dim)' }}>India · IN</p>
          </div>
          <button
            onClick={async () => {
              await fetch('/api/auth/session', { method: 'DELETE' })
              window.location.href = '/login'
            }}
            title="Log out"
            className="p-1 rounded hover:bg-red-900/30 transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#ef4444' }}>
              logout
            </span>
          </button>
        </div>
      </div>
    </aside>
  )
}
