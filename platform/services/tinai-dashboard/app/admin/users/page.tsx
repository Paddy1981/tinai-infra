'use client'

import { useEffect, useState, useCallback } from 'react'

type Role = 'admin' | 'tenant'

interface User {
  id: string
  email: string
  role: Role
  tenant_id?: string
  created_at: string
  last_login?: string
}

const ROLE_BADGE: Record<Role, string> = {
  admin:  'text-[#F97316] bg-[#F97316]/10 border-[#F97316]/30',
  tenant: 'text-blue-400 bg-blue-400/10 border-blue-800/40',
}

const ALL_ROLES: Role[] = ['admin', 'tenant']

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filterRole, setFilterRole] = useState<Role | 'all'>('all')
  const [changingRole, setChangingRole] = useState<string | null>(null)
  const [confirmChange, setConfirmChange] = useState<{ user: User; newRole: Role } | null>(null)
  const [roleSuccess, setRoleSuccess] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/admin/users')
      if (res.status === 403) {
        setError('Access denied. Admin role required.')
        return
      }
      if (!res.ok) throw new Error('Failed to load users')
      const data = await res.json()
      setUsers(Array.isArray(data) ? data : data.users ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load users')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const changeRole = async (user: User, newRole: Role) => {
    setChangingRole(user.id)
    try {
      const res = await fetch(`/api/v1/admin/users/${user.id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update role')
      setUsers(prev => prev.map(u => u.id === user.id ? { ...u, role: newRole } : u))
      setRoleSuccess(user.id)
      setTimeout(() => setRoleSuccess(null), 2500)
    } catch {
      // silently ignore; could surface via toast
    } finally {
      setChangingRole(null)
      setConfirmChange(null)
    }
  }

  const deleteUser = async (user: User) => {
    if (!confirm(`Delete user "${user.email}"? This cannot be undone.`)) return
    try {
      const res = await fetch(`/api/v1/admin/users/${user.id}`, {
        method: 'DELETE',
        headers: { 'x-tinai-csrf': '1' },
      })
      if (!res.ok && res.status !== 204) throw new Error('Failed to delete user')
      await load()
    } catch {
      // silently ignore
    }
  }

  const filtered = users.filter(u => {
    const matchSearch = !search || u.email.toLowerCase().includes(search.toLowerCase()) || (u.tenant_id ?? '').toLowerCase().includes(search.toLowerCase())
    const matchRole = filterRole === 'all' || u.role === filterRole
    return matchSearch && matchRole
  })

  const stats = {
    total: users.length,
    admin: users.filter(u => u.role === 'admin').length,
    tenant: users.filter(u => u.role === 'tenant').length,
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="material-symbols-outlined text-[#F97316]" style={{ fontSize: 20 }}>admin_panel_settings</span>
            <h1 className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>User Management</h1>
          </div>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>
            Manage tenant users and role-based access control
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors"
          style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' }}
        >
          <span className="material-symbols-outlined" style={{ fontSize: 14 }}>refresh</span>
          Refresh
        </button>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {[
          { label: 'Total users', value: stats.total, icon: 'group' },
          { label: 'Admins', value: stats.admin, icon: 'shield_person' },
          { label: 'Tenants', value: stats.tenant, icon: 'person' },
        ].map(stat => (
          <div
            key={stat.label}
            className="p-4 rounded-xl border"
            style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}
          >
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined" style={{ fontSize: 16, color: '#F97316' }}>{stat.icon}</span>
              <span className="text-xs" style={{ color: 'var(--t-text-dim)' }}>{stat.label}</span>
            </div>
            <p className="text-2xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-5">
        <div className="flex-1 max-w-sm flex items-center gap-2 px-3 py-2 rounded-lg border"
          style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined shrink-0" style={{ fontSize: 16, color: 'var(--t-text-dim)' }}>search</span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by email or tenant..."
            className="flex-1 bg-transparent text-sm outline-none"
            style={{ color: 'var(--t-text)' }}
          />
        </div>
        <select
          value={filterRole}
          onChange={e => setFilterRole(e.target.value as Role | 'all')}
          className="rounded-lg px-3 py-2 text-sm outline-none border"
          style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)', color: 'var(--t-text)' }}
        >
          <option value="all">All roles</option>
          {ALL_ROLES.map(r => (
            <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
          ))}
        </select>
      </div>

      {/* Role change confirmation modal */}
      {confirmChange && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-sm mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-base font-bold mb-2" style={{ color: 'var(--t-text)' }}>Change role?</h3>
            <p className="text-sm mb-4" style={{ color: 'var(--t-text-muted)' }}>
              Set <span className="text-[#F97316]">{confirmChange.user.email}</span> role to{' '}
              <span className={`px-1.5 py-0.5 rounded text-xs font-medium border ${ROLE_BADGE[confirmChange.newRole]}`}>
                {confirmChange.newRole}
              </span>
              ?
            </p>
            {confirmChange.newRole === 'admin' && (
              <p className="text-xs text-amber-400 mb-4 flex items-start gap-1.5">
                <span className="material-symbols-outlined mt-0.5 shrink-0" style={{ fontSize: 14 }}>warning</span>
                Admin role grants full platform access including billing and user management.
              </p>
            )}
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmChange(null)}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={() => changeRole(confirmChange.user, confirmChange.newRole)}
                disabled={changingRole === confirmChange.user.id}
                className="flex-1 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A] transition-colors"
              >
                {changingRole === confirmChange.user.id ? 'Saving...' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Users table */}
      {loading ? (
        <div className="py-20 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading users...</div>
      ) : error ? (
        <div className="py-20 text-center">
          <span className="material-symbols-outlined block mb-3 text-red-400" style={{ fontSize: 40 }}>lock</span>
          <p className="text-sm text-red-400">{error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div className="py-16 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined block mb-3" style={{ fontSize: 40, color: 'var(--t-text-dim)' }}>person_search</span>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No users match your search</p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
          {/* Header */}
          <div
            className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] gap-4 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide border-b"
            style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)', color: 'var(--t-text-dim)' }}
          >
            <span></span>
            <span>Email</span>
            <span>Role</span>
            <span>Tenant ID</span>
            <span>Joined</span>
            <span>Last login</span>
            <span></span>
          </div>

          {filtered.map((u, i) => {
            const initials = u.email.slice(0, 2).toUpperCase()
            return (
              <div
                key={u.id}
                className="grid grid-cols-[auto_1fr_auto_auto_auto_auto_auto] gap-4 items-center px-4 py-3.5 border-b last:border-b-0"
                style={{
                  borderColor: 'var(--t-border)',
                  backgroundColor: i % 2 === 0 ? 'var(--t-surface)' : 'var(--t-surface-2)',
                }}
              >
                {/* Avatar */}
                <div className="w-8 h-8 rounded-full bg-[#F97316]/20 flex items-center justify-center shrink-0">
                  <span className="text-[#F97316] text-xs font-bold font-headline">{initials}</span>
                </div>

                {/* Email */}
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--t-text)' }}>
                    {u.email}
                    {roleSuccess === u.id && (
                      <span className="ml-2 text-xs text-emerald-400 inline-flex items-center gap-0.5">
                        <span className="material-symbols-outlined" style={{ fontSize: 12 }}>check_circle</span>
                        Updated
                      </span>
                    )}
                  </p>
                </div>

                {/* Role selector */}
                <div className="shrink-0">
                  <select
                    value={u.role}
                    onChange={e => setConfirmChange({ user: u, newRole: e.target.value as Role })}
                    disabled={changingRole === u.id}
                    className={`text-xs px-2 py-1 rounded-full border font-medium outline-none cursor-pointer disabled:opacity-50 ${ROLE_BADGE[u.role] ?? 'text-slate-400 bg-slate-400/10 border-slate-700/40'}`}
                    style={{ backgroundColor: 'transparent' }}
                  >
                    {ALL_ROLES.map(r => (
                      <option key={r} value={r} style={{ backgroundColor: 'var(--t-surface)', color: 'var(--t-text)' }}>
                        {r}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Tenant ID */}
                <span className="text-xs font-mono shrink-0 truncate max-w-[120px]" style={{ color: 'var(--t-text-dim)' }} title={u.tenant_id ?? ''}>
                  {u.tenant_id ?? '--'}
                </span>

                {/* Joined */}
                <span className="text-xs shrink-0" style={{ color: 'var(--t-text-dim)' }}>
                  {new Date(u.created_at).toLocaleDateString('en-IN')}
                </span>

                {/* Last login */}
                <span className="text-xs shrink-0" style={{ color: 'var(--t-text-dim)' }}>
                  {u.last_login ? new Date(u.last_login).toLocaleDateString('en-IN') : '--'}
                </span>

                {/* Delete */}
                <button
                  onClick={() => deleteUser(u)}
                  title="Delete user"
                  className="p-1.5 rounded-md transition-colors hover:text-red-400"
                  style={{ color: 'var(--t-text-dim)' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(239,68,68,0.1)' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                >
                  <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Footer count */}
      {!loading && !error && (
        <p className="text-xs mt-4 text-right" style={{ color: 'var(--t-text-dim)' }}>
          Showing {filtered.length} of {users.length} users
        </p>
      )}
    </div>
  )
}
