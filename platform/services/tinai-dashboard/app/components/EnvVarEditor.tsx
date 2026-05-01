'use client'

import { useState, useRef } from 'react'

export interface EnvVar {
  key: string
  value: string
  is_secret: boolean
  id?: string
}

interface EnvVarEditorProps {
  vars: EnvVar[]
  onAdd: (v: EnvVar) => Promise<void>
  onUpdate: (key: string, v: Partial<EnvVar>) => Promise<void>
  onDelete: (key: string) => Promise<void>
  onBulkSave: (vars: EnvVar[]) => Promise<void>
  loading?: boolean
}

const inputStyle = {
  backgroundColor: 'var(--t-surface-2)',
  borderColor: 'var(--t-border)',
  color: 'var(--t-text)',
}

function maskValue(value: string): string {
  if (value.length <= 4) return '••••••••'
  return value.slice(0, 2) + '•'.repeat(Math.min(value.length - 2, 12)) + value.slice(-2)
}

function parseBulk(text: string): EnvVar[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const eqIdx = line.indexOf('=')
      if (eqIdx === -1) return null
      const key = line.slice(0, eqIdx).trim()
      const value = line.slice(eqIdx + 1).trim()
      if (!key) return null
      return { key, value, is_secret: false }
    })
    .filter(Boolean) as EnvVar[]
}

function toBulkText(vars: EnvVar[]): string {
  return vars.map(v => `${v.key}=${v.value}`).join('\n')
}

export default function EnvVarEditor({
  vars,
  onAdd,
  onUpdate,
  onDelete,
  onBulkSave,
  loading = false,
}: EnvVarEditorProps) {
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [showAdd, setShowAdd] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newIsSecret, setNewIsSecret] = useState(false)
  const [addLoading, setAddLoading] = useState(false)
  const [addError, setAddError] = useState('')
  const [showBulk, setShowBulk] = useState(false)
  const [bulkText, setBulkText] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkError, setBulkError] = useState('')
  const editRef = useRef<HTMLInputElement>(null)

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const startEdit = (v: EnvVar) => {
    setEditingKey(v.key)
    setEditValue(v.value)
    setTimeout(() => editRef.current?.focus(), 50)
  }

  const commitEdit = async (key: string) => {
    if (editValue !== vars.find(v => v.key === key)?.value) {
      await onUpdate(key, { value: editValue })
    }
    setEditingKey(null)
  }

  const handleAdd = async () => {
    if (!newKey.trim()) { setAddError('Key is required'); return }
    if (vars.some(v => v.key === newKey.trim())) { setAddError('Key already exists'); return }
    setAddLoading(true)
    setAddError('')
    try {
      await onAdd({ key: newKey.trim(), value: newValue, is_secret: newIsSecret })
      setNewKey('')
      setNewValue('')
      setNewIsSecret(false)
      setShowAdd(false)
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : 'Failed to add')
    } finally {
      setAddLoading(false)
    }
  }

  const handleBulkOpen = () => {
    setBulkText(toBulkText(vars))
    setBulkError('')
    setShowBulk(true)
  }

  const handleBulkSave = async () => {
    const parsed = parseBulk(bulkText)
    if (parsed.length === 0 && bulkText.trim().length > 0) {
      setBulkError('No valid KEY=VALUE pairs found')
      return
    }
    setBulkSaving(true)
    setBulkError('')
    try {
      await onBulkSave(parsed)
      setShowBulk(false)
    } catch (e: unknown) {
      setBulkError(e instanceof Error ? e.message : 'Bulk save failed')
    } finally {
      setBulkSaving(false)
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center justify-between mb-4">
        <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
          {vars.length} variable{vars.length !== 1 ? 's' : ''}
        </p>
        <div className="flex gap-2">
          <button
            onClick={handleBulkOpen}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors"
            style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-muted)' }}
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>edit_note</span>
            Bulk edit
          </button>
          <button
            onClick={() => { setShowAdd(true); setAddError('') }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#F97316] text-white hover:bg-[#EA6C0A] transition-colors"
          >
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>add</span>
            Add variable
          </button>
        </div>
      </div>

      {/* Table */}
      {loading ? (
        <div className="py-12 text-center text-sm" style={{ color: 'var(--t-text-muted)' }}>Loading…</div>
      ) : vars.length === 0 && !showAdd ? (
        <div className="py-12 text-center border border-dashed rounded-xl" style={{ borderColor: 'var(--t-border)' }}>
          <span className="material-symbols-outlined block mb-2" style={{ fontSize: 36, color: 'var(--t-text-dim)' }}>key</span>
          <p className="text-sm" style={{ color: 'var(--t-text-muted)' }}>No environment variables</p>
          <p className="text-xs mt-1" style={{ color: 'var(--t-text-dim)' }}>Add a KEY=VALUE pair to get started</p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--t-border)' }}>
          {/* Header row */}
          <div
            className="grid grid-cols-[1fr_2fr_auto] gap-0 text-xs font-semibold uppercase tracking-wide px-4 py-2.5 border-b"
            style={{ backgroundColor: 'var(--t-surface-2)', borderColor: 'var(--t-border)', color: 'var(--t-text-dim)' }}
          >
            <span>Key</span>
            <span>Value</span>
            <span className="text-right">Actions</span>
          </div>

          {/* Rows */}
          {vars.map((v, i) => {
            const isRevealed = revealed.has(v.key)
            const isEditing = editingKey === v.key
            return (
              <div
                key={v.key}
                className={`grid grid-cols-[1fr_2fr_auto] gap-0 items-center px-4 py-3 border-b last:border-b-0 transition-colors ${i % 2 === 1 ? '' : ''}`}
                style={{
                  borderColor: 'var(--t-border)',
                  backgroundColor: i % 2 === 0 ? 'var(--t-surface)' : 'var(--t-surface-2)',
                }}
              >
                {/* Key */}
                <div className="flex items-center gap-2 pr-4 min-w-0">
                  {v.is_secret && (
                    <span className="material-symbols-outlined text-amber-400 shrink-0" style={{ fontSize: 14 }}>lock</span>
                  )}
                  <code className="text-xs font-mono truncate" style={{ color: 'var(--t-text)' }}>{v.key}</code>
                </div>

                {/* Value */}
                <div className="pr-4 min-w-0">
                  {isEditing ? (
                    <input
                      ref={editRef}
                      value={editValue}
                      onChange={e => setEditValue(e.target.value)}
                      onBlur={() => commitEdit(v.key)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitEdit(v.key)
                        if (e.key === 'Escape') setEditingKey(null)
                      }}
                      className="w-full rounded-md px-2 py-1 text-xs font-mono outline-none border focus:border-[#F97316]/50"
                      style={inputStyle}
                    />
                  ) : (
                    <div
                      className="flex items-center gap-2 cursor-text"
                      onClick={() => startEdit(v)}
                      title="Click to edit"
                    >
                      <code
                        className="text-xs font-mono truncate"
                        style={{ color: isRevealed ? 'var(--t-text)' : 'var(--t-text-dim)' }}
                      >
                        {isRevealed ? v.value : maskValue(v.value)}
                      </code>
                      <span className="material-symbols-outlined shrink-0 opacity-0 group-hover:opacity-100" style={{ fontSize: 12, color: 'var(--t-text-dim)' }}>edit</span>
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-0.5">
                  <button
                    onClick={() => toggleReveal(v.key)}
                    title={isRevealed ? 'Hide value' : 'Reveal value'}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                      {isRevealed ? 'visibility_off' : 'visibility'}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      onUpdate(v.key, { is_secret: !v.is_secret })
                    }}
                    title={v.is_secret ? 'Mark as plain' : 'Mark as secret'}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: v.is_secret ? '#F59E0B' : 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                      {v.is_secret ? 'lock' : 'lock_open'}
                    </span>
                  </button>
                  <button
                    onClick={() => setConfirmDelete(v.key)}
                    title="Delete variable"
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(239,68,68,0.1)'; (e.currentTarget as HTMLElement).style.color = '#f87171' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>delete</span>
                  </button>
                </div>
              </div>
            )
          })}

          {/* Add new row inline */}
          {showAdd && (
            <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--t-border)', backgroundColor: 'var(--t-surface)' }}>
              <div className="grid grid-cols-[1fr_2fr_auto] gap-3 items-start">
                <div>
                  <input
                    autoFocus
                    value={newKey}
                    onChange={e => { setNewKey(e.target.value); setAddError('') }}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowAdd(false) }}
                    className="w-full rounded-md px-2 py-1.5 text-xs font-mono outline-none border focus:border-[#F97316]/50"
                    style={inputStyle}
                    placeholder="VARIABLE_NAME"
                  />
                </div>
                <div>
                  <input
                    value={newValue}
                    onChange={e => setNewValue(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowAdd(false) }}
                    className="w-full rounded-md px-2 py-1.5 text-xs font-mono outline-none border focus:border-[#F97316]/50"
                    style={inputStyle}
                    placeholder="value"
                  />
                  {addError && <p className="text-[10px] text-red-400 mt-1">{addError}</p>}
                </div>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={() => setNewIsSecret(s => !s)}
                    title={newIsSecret ? 'Marked as secret' : 'Mark as secret'}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: newIsSecret ? '#F59E0B' : 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>
                      {newIsSecret ? 'lock' : 'lock_open'}
                    </span>
                  </button>
                  <button
                    onClick={handleAdd}
                    disabled={addLoading || !newKey.trim()}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold bg-[#F97316] text-white hover:bg-[#EA6C0A] disabled:opacity-50 transition-colors"
                  >
                    {addLoading ? '…' : 'Save'}
                  </button>
                  <button
                    onClick={() => { setShowAdd(false); setNewKey(''); setNewValue(''); setAddError('') }}
                    className="p-1.5 rounded-md transition-colors"
                    style={{ color: 'var(--t-text-dim)' }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)'; (e.currentTarget as HTMLElement).style.color = 'var(--t-text)' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = ''; (e.currentTarget as HTMLElement).style.color = 'var(--t-text-dim)' }}
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: 15 }}>close</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-sm mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-base font-bold mb-2" style={{ color: 'var(--t-text)' }}>Delete variable?</h3>
            <p className="text-sm mb-1" style={{ color: 'var(--t-text-muted)' }}>
              This will permanently remove:
            </p>
            <code className="text-sm font-mono text-red-400 block mb-4">{confirmDelete}</code>
            <div className="flex gap-3">
              <button
                onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  await onDelete(confirmDelete)
                  setConfirmDelete(null)
                }}
                className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg text-sm font-semibold hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk edit modal */}
      {showBulk && (
        <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center">
          <div className="rounded-xl p-6 w-full max-w-2xl mx-4 border" style={{ backgroundColor: 'var(--t-surface)', borderColor: 'var(--t-border)' }}>
            <h3 className="text-base font-bold mb-1" style={{ color: 'var(--t-text)' }}>Bulk Edit Variables</h3>
            <p className="text-xs mb-4" style={{ color: 'var(--t-text-muted)' }}>
              Edit all variables as KEY=VALUE pairs, one per line. Lines starting with # are ignored.
              This will replace all current variables.
            </p>
            <textarea
              value={bulkText}
              onChange={e => { setBulkText(e.target.value); setBulkError('') }}
              rows={14}
              className="w-full rounded-lg px-3 py-2.5 text-sm font-mono outline-none border focus:border-[#F97316]/50 resize-none"
              style={inputStyle}
              placeholder={'DATABASE_URL=postgres://...\nREDIS_URL=redis://...\n# This is a comment\nAPI_KEY=secret123'}
              spellCheck={false}
            />
            {bulkError && <p className="text-xs text-red-400 mt-2">{bulkError}</p>}
            <div className="flex gap-3 mt-4">
              <button
                onClick={() => { setShowBulk(false); setBulkError('') }}
                className="flex-1 px-4 py-2 rounded-lg text-sm border"
                style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-muted)', backgroundColor: 'transparent' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--t-surface-2)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent' }}
              >
                Cancel
              </button>
              <button
                onClick={handleBulkSave}
                disabled={bulkSaving}
                className="flex-1 px-4 py-2 bg-[#F97316] text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-[#EA6C0A] transition-colors"
              >
                {bulkSaving ? 'Saving…' : 'Save All Variables'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
