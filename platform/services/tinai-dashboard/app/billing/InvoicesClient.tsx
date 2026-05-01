'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Invoice } from '@/lib/api'

const API_URL = ''

function inr(paise: number) {
  return '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })
}

function monthLabel(dateStr: string) {
  return new Date(dateStr).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function statusBadge(status: string) {
  const s = { paid: 'text-emerald-400', draft: 'text-amber-400', overdue: 'text-red-400' }
  return <span className={(s[status as keyof typeof s] ?? 'text-slate-400') + ' text-xs'}>{status}</span>
}

function paymentStatusBadge(ps: Invoice['payment_status']) {
  if (!ps || ps === 'pending') return <span className="text-xs text-slate-500">pending</span>
  if (ps === 'captured')       return <span className="text-xs text-emerald-400">paid</span>
  if (ps === 'failed')         return <span className="text-xs text-red-400">failed</span>
  return <span className="text-xs text-slate-500">{ps}</span>
}

interface Props {
  invoices: Invoice[]
}

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => { open: () => void }
  }
}

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById('razorpay-checkout-js')) { resolve(); return }
    const script = document.createElement('script')
    script.id  = 'razorpay-checkout-js'
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.onload  = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Razorpay checkout script'))
    document.body.appendChild(script)
  })
}

export default function InvoicesClient({ invoices: initial }: Props) {
  const router   = useRouter()
  const [paying, setPaying] = useState<string | null>(null)
  const [error,  setError]  = useState<string | null>(null)

  async function handlePayNow(inv: Invoice) {
    setError(null)
    setPaying(inv.id)
    try {
      await loadRazorpayScript()

      const res = await fetch(`${API_URL}/api/v1/billing/payment-orders`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body:    JSON.stringify({ invoice_id: inv.id }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error((err as any).error ?? `Server error ${res.status}`)
      }
      const { order_id, amount, currency, key_id } = await res.json() as {
        order_id: string; amount: number; currency: string; key_id: string
      }

      const rzp = new window.Razorpay({
        key:         key_id,
        order_id,
        amount,
        currency,
        name:        'Tinai',
        description: `Invoice — ${monthLabel(inv.month)}`,
        theme:       { color: '#6366f1' },
        handler: () => {
          // Payment captured — webhook will update DB; refresh page to show new status
          router.refresh()
        },
        modal: {
          ondismiss: () => { setPaying(null) },
        },
      })
      rzp.open()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Payment failed')
      setPaying(null)
    }
  }

  return (
    <>
      {error && (
        <p className="mb-3 text-xs text-red-400">{error}</p>
      )}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500 border-b border-slate-800">
            <th className="pb-2 font-medium">Month</th>
            <th className="pb-2 font-medium">Subtotal</th>
            <th className="pb-2 font-medium">GST (18%)</th>
            <th className="pb-2 font-medium">Total</th>
            <th className="pb-2 font-medium">Status</th>
            <th className="pb-2 font-medium">Payment</th>
            <th className="pb-2 font-medium"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800/50">
          {initial.map(inv => {
            const isPaid   = inv.status === 'paid' || inv.payment_status === 'captured'
            const isPaying = paying === inv.id
            return (
              <tr key={inv.id} className="text-slate-300">
                <td className="py-2 text-xs">{monthLabel(inv.month)}</td>
                <td className="py-2 text-xs">{inr(inv.subtotal_paise)}</td>
                <td className="py-2 text-xs">{inr(inv.gst_paise)}</td>
                <td className="py-2 text-xs font-medium">{inr(inv.total_paise)}</td>
                <td className="py-2">{statusBadge(inv.status)}</td>
                <td className="py-2">{paymentStatusBadge(inv.payment_status)}</td>
                <td className="py-2 text-right">
                  {!isPaid && (
                    <button
                      onClick={() => handlePayNow(inv)}
                      disabled={isPaying}
                      className="rounded px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500
                                 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                    >
                      {isPaying ? 'Opening…' : 'Pay Now'}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}
