'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  getBillingOverview,
  listInvoices,
  getPaymentMethods,
  createCheckoutSession,
  paiseToCurrency,
  BillingOverview,
  Invoice,
  PaymentMethod,
} from '@/lib/billing-api'

// ─── Status badge ─────────────────────────────────────────────────────────────

function invoiceStatusBadge(status: Invoice['status']) {
  const map: Record<Invoice['status'], { label: string; className: string }> = {
    draft: { label: 'Draft', className: 'bg-slate-500/10 text-slate-400 border border-slate-500/30' },
    open:  { label: 'Open',  className: 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/30' },
    paid:  { label: 'Paid',  className: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
    void:  { label: 'Void',  className: 'bg-red-500/10 text-red-400 border border-red-500/30' },
  }
  const { label, className } = map[status] ?? map.draft
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {label}
    </span>
  )
}

// ─── Product icon initial ─────────────────────────────────────────────────────

function productIcon(product: string) {
  const map: Record<string, { initial: string; className: string }> = {
    instances:  { initial: 'I', className: 'bg-slate-700 text-slate-300' },
    storage:    { initial: 'S', className: 'bg-blue-900/60 text-blue-300' },
    inference:  { initial: 'N', className: 'bg-purple-900/60 text-purple-300' },
    functions:  { initial: 'F', className: 'bg-emerald-900/60 text-emerald-300' },
  }
  const fallback = { initial: (product[0] ?? '?').toUpperCase(), className: 'bg-slate-700 text-slate-300' }
  const { initial, className } = map[product] ?? fallback
  return (
    <span className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-xs font-bold flex-shrink-0 ${className}`}>
      {initial}
    </span>
  )
}

// ─── Skeleton helper ──────────────────────────────────────────────────────────

function SkeletonRect({ className }: { className: string }) {
  return <div className={`animate-pulse bg-slate-800 rounded ${className}`} />
}

// ─── Period formatter ─────────────────────────────────────────────────────────

function formatPeriod(start: string, end: string): string {
  const fmt = (d: string) =>
    new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${fmt(start)} – ${fmt(end)}`
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BillingPage() {
  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checkoutLoading, setCheckoutLoading] = useState(false)

  useEffect(() => {
    Promise.all([getBillingOverview(), listInvoices(), getPaymentMethods()])
      .then(([ov, inv, pm]) => {
        setOverview(ov)
        setInvoices(inv)
        setPaymentMethods(pm)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // ── Derived values ──────────────────────────────────────────────────────────

  const currentMonthColor = (() => {
    if (!overview) return 'text-slate-200'
    const rupees = overview.current_month_paise / 100
    if (rupees < 500)  return 'text-emerald-400'
    if (rupees < 2000) return 'text-yellow-400'
    return 'text-red-400'
  })()

  const monthChange = (() => {
    if (!overview || overview.last_month_paise === 0) return null
    const delta = overview.current_month_paise - overview.last_month_paise
    const pct = Math.abs((delta / overview.last_month_paise) * 100).toFixed(1)
    return { delta, pct }
  })()

  const maxUsagePaise = overview
    ? Math.max(...overview.usage_by_product.map((u) => u.cost_paise), 1)
    : 1

  // ── Checkout handler ────────────────────────────────────────────────────────

  async function handleAddPaymentMethod() {
    setCheckoutLoading(true)
    try {
      const { url } = await createCheckoutSession()
      window.location.href = url
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setCheckoutLoading(false)
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Billing</h1>
          <p className="text-sm text-slate-500 mt-0.5">Usage, invoices, and payment methods</p>
        </div>
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1.5 rounded-lg bg-[#F97316] hover:bg-[#EA6C0A] px-4 py-2 text-sm font-semibold text-white transition-colors shadow-[0_0_16px_rgba(249,115,22,0.2)]"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
          Upgrade Plan
        </Link>
      </div>

      {/* Current plan card */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4 mb-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1">Current Plan</p>
            <p className="text-lg font-semibold text-slate-100">Starter</p>
            <p className="text-sm text-slate-400 mt-0.5">
              <span className="text-emerald-400 font-semibold tabular-nums">&#8377;499</span>/mo
            </p>
          </div>
          <div className="text-right">
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
              Active
            </span>
            <p className="text-xs text-slate-500 mt-2">
              <Link href="/pricing" className="text-[#F97316] hover:text-[#FDBA74] transition-colors">
                Compare plans &rarr;
              </Link>
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/30 px-4 py-3 text-sm text-red-400 mb-6">
          {error}
        </div>
      )}

      {/* Usage summary (always shown, even when billing data is sparse) */}
      {!loading && !overview?.usage_by_product?.length && (
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4 mb-6">
          <h2 className="text-sm font-semibold text-slate-200 mb-3">Usage Summary</h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              { label: 'Compute', value: '0 hrs', icon: 'dns' },
              { label: 'Storage', value: '0 GB', icon: 'database' },
              { label: 'Inference', value: '0 calls', icon: 'psychology' },
              { label: 'Functions', value: '0 invocations', icon: 'functions' },
            ].map(item => (
              <div key={item.label} className="text-center">
                <p className="text-xs text-slate-500 mb-1">{item.label}</p>
                <p className="text-sm font-medium text-slate-300 tabular-nums">{item.value}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-slate-600 mt-3 text-center">
            Usage resets at the start of each billing cycle. Starter plan includes generous free-tier limits.
          </p>
        </div>
      )}

      {/* ── Stat cards row ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 mb-6">
        {/* This Month */}
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">This Month</p>
          {loading ? (
            <SkeletonRect className="h-8 w-28" />
          ) : (
            <p className={`text-2xl font-semibold tabular-nums ${currentMonthColor}`}>
              {paiseToCurrency(overview?.current_month_paise ?? 0)}
            </p>
          )}
        </div>

        {/* Last Month */}
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Last Month</p>
          {loading ? (
            <SkeletonRect className="h-8 w-28" />
          ) : (
            <div>
              <p className="text-2xl font-semibold tabular-nums text-slate-200">
                {paiseToCurrency(overview?.last_month_paise ?? 0)}
              </p>
              {monthChange && (
                <div className={`flex items-center gap-1 mt-1 text-xs font-medium ${monthChange.delta <= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {monthChange.delta <= 0 ? (
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  ) : (
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    </svg>
                  )}
                  <span>{monthChange.pct}% vs this month</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Credit Balance */}
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Credit Balance</p>
          {loading ? (
            <SkeletonRect className="h-8 w-28" />
          ) : (
            <p className={`text-2xl font-semibold tabular-nums ${(overview?.credit_balance_paise ?? 0) > 0 ? 'text-emerald-400' : 'text-slate-200'}`}>
              {paiseToCurrency(overview?.credit_balance_paise ?? 0)}
            </p>
          )}
        </div>

        {/* Next Invoice */}
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-5 py-4">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-2">Next Invoice</p>
          {loading ? (
            <SkeletonRect className="h-8 w-36" />
          ) : (
            <p className="text-2xl font-semibold text-slate-200">
              {overview?.next_invoice_date
                ? new Date(overview.next_invoice_date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                : '—'}
            </p>
          )}
        </div>
      </div>

      {/* ── Usage breakdown ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-800 bg-slate-900 mb-6">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200">Usage This Month</h2>
        </div>
        <div className="px-5 py-4 space-y-4">
          {loading ? (
            <>
              <SkeletonRect className="h-6 w-full" />
              <SkeletonRect className="h-6 w-4/5" />
              <SkeletonRect className="h-6 w-3/5" />
            </>
          ) : overview && overview.usage_by_product.length > 0 ? (
            overview.usage_by_product.map((item) => {
              const barPct = Math.round((item.cost_paise / maxUsagePaise) * 100)
              return (
                <div key={item.product} className="flex items-center gap-3">
                  {productIcon(item.product)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-200 capitalize">{item.product}</span>
                        <span className="text-xs text-slate-500">{item.unit_label}</span>
                      </div>
                      <span className="text-sm font-medium text-slate-300 tabular-nums ml-4 flex-shrink-0">
                        {paiseToCurrency(item.cost_paise)}
                      </span>
                    </div>
                    <div className="h-1.5 w-full rounded-full bg-slate-800">
                      <div
                        className="h-1.5 rounded-full bg-emerald-600 transition-all"
                        style={{ width: `${barPct}%` }}
                      />
                    </div>
                  </div>
                </div>
              )
            })
          ) : (
            <p className="text-sm text-slate-500 py-2">No usage this month</p>
          )}
        </div>
      </div>

      {/* ── Invoices table ──────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-800 mb-6">
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-900">
          <h2 className="text-sm font-semibold text-slate-200">Invoices</h2>
        </div>

        {loading ? (
          <div className="bg-slate-900 px-5 py-4 space-y-3">
            <SkeletonRect className="h-10 w-full" />
            <SkeletonRect className="h-10 w-full" />
            <SkeletonRect className="h-10 w-4/5" />
          </div>
        ) : invoices.length === 0 ? (
          <div className="bg-slate-900 px-5 py-10 text-center">
            <p className="text-slate-400 text-sm">
              No invoices yet — your first invoice will appear at the end of the month.
            </p>
          </div>
        ) : (
          <div className="overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-900/60">
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Period</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Subtotal</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Tax</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Total</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {invoices.map((inv) => (
                  <tr key={inv.id} className="bg-slate-900 hover:bg-slate-800/60 transition-colors">
                    <td className="px-4 py-3 text-slate-300 whitespace-nowrap">
                      {formatPeriod(inv.period_start, inv.period_end)}
                    </td>
                    <td className="px-4 py-3">{invoiceStatusBadge(inv.status)}</td>
                    <td className="px-4 py-3 text-slate-300 tabular-nums">{paiseToCurrency(inv.subtotal_paise)}</td>
                    <td className="px-4 py-3 text-slate-400 tabular-nums">{paiseToCurrency(inv.tax_paise)}</td>
                    <td className="px-4 py-3 text-slate-200 font-medium tabular-nums">{paiseToCurrency(inv.total_paise)}</td>
                    <td className="px-4 py-3">
                      {inv.pdf_url ? (
                        <a
                          href={inv.pdf_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                          Download PDF
                        </a>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Payment Methods ─────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-slate-800 bg-slate-900">
        <div className="px-5 py-4 border-b border-slate-800">
          <h2 className="text-sm font-semibold text-slate-200">Payment Methods</h2>
        </div>
        <div className="px-5 py-4">
          {loading ? (
            <div className="space-y-3">
              <SkeletonRect className="h-14 w-full" />
              <SkeletonRect className="h-9 w-40" />
            </div>
          ) : paymentMethods.length === 0 ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-slate-400">No payment methods on file.</p>
              <button
                onClick={handleAddPaymentMethod}
                disabled={checkoutLoading}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-white transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {checkoutLoading ? 'Redirecting…' : 'Add Payment Method'}
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {paymentMethods.map((pm) => (
                <div
                  key={pm.id}
                  className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-800/40 px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-14 items-center justify-center rounded border border-slate-700 bg-slate-800">
                      <svg className="h-5 w-5 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                      </svg>
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-200 capitalize">
                        {pm.brand} &bull;&bull;&bull;&bull; {pm.last4}
                      </p>
                      <p className="text-xs text-slate-500">
                        Expires {String(pm.expiry_month).padStart(2, '0')}/{pm.expiry_year}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={handleAddPaymentMethod}
                disabled={checkoutLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 hover:border-slate-600 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-medium text-slate-200 transition-colors"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                {checkoutLoading ? 'Redirecting…' : 'Add Another Method'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
