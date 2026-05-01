'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Plan {
  id: string
  name: string
  price_inr: number
  price_monthly_paise: number
  price_yearly_paise: number
  description: string
  features: string[]
  sort_order: number
}

type Cycle = 'monthly' | 'yearly'

export default function PricingPage() {
  const router = useRouter()
  const [plans, setPlans] = useState<Plan[]>([])
  const [cycle, setCycle] = useState<Cycle>('monthly')
  const [loading, setLoading] = useState(true)
  const [upgrading, setUpgrading] = useState<string | null>(null)
  const [currentPlan, setCurrentPlan] = useState<string>('free')

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/billing/plans').then(r => r.ok ? r.json() : []),
      fetch('/api/v1/billing/overview').then(r => r.ok ? r.json() : { plan_id: 'free' }),
    ]).then(([planData, overview]) => {
      setPlans(Array.isArray(planData) ? planData : [])
      setCurrentPlan(overview?.plan_id ?? 'free')
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const handleUpgrade = async (planId: string) => {
    if (planId === 'free' || planId === 'enterprise') return
    setUpgrading(planId)
    try {
      const res = await fetch('/api/v1/payments/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
        body: JSON.stringify({ plan_id: planId, billing_cycle: cycle }),
      })
      const data = await res.json()

      if (data.manual_upgrade) {
        alert('Payment gateway is being set up. Contact admin@tinai.cloud for plan upgrades.')
        return
      }

      if (!data.order_id) {
        alert(data.error ?? 'Failed to create order')
        return
      }

      // Open Razorpay checkout
      const options = {
        key: data.key_id,
        amount: data.amount,
        currency: data.currency,
        name: 'Tinai Cloud',
        description: `${data.notes.plan} Plan (${data.notes.cycle})`,
        order_id: data.order_id,
        prefill: data.prefill,
        theme: { color: '#F97316' },
        handler: async (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
          await fetch('/api/v1/payments/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
            body: JSON.stringify({
              order_id: response.razorpay_order_id,
              payment_id: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            }),
          })
          router.push('/billing?upgraded=true')
        },
      }

      const rzp = new (window as any).Razorpay(options)
      rzp.open()
    } catch {
      alert('Failed to initiate payment')
    } finally {
      setUpgrading(null)
    }
  }

  const formatPrice = (plan: Plan) => {
    if (plan.id === 'free') return { amount: '0', period: 'forever' }
    if (plan.id === 'enterprise') return { amount: 'Custom', period: '' }
    const paise = cycle === 'yearly' ? plan.price_yearly_paise : plan.price_monthly_paise
    const inr = Math.round(paise / 100)
    return {
      amount: inr.toLocaleString('en-IN'),
      period: cycle === 'yearly' ? '/year' : '/month',
    }
  }

  const PLAN_ACCENT: Record<string, string> = {
    free: 'border-slate-700',
    starter: 'border-[#F97316]',
    pro: 'border-emerald-500',
    enterprise: 'border-purple-500',
  }

  if (loading) return <div className="p-8 text-center" style={{ color: 'var(--t-text-muted)' }}>Loading plans...</div>

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-bold font-headline" style={{ color: 'var(--t-text)' }}>
          Simple, transparent pricing
        </h1>
        <p className="text-sm mt-2" style={{ color: 'var(--t-text-muted)' }}>
          All plans include Indian data residency, automatic HTTPS, and daily backups
        </p>

        {/* Billing cycle toggle */}
        <div className="flex items-center justify-center gap-3 mt-6">
          <span className={`text-sm ${cycle === 'monthly' ? 'text-white font-semibold' : ''}`}
            style={cycle !== 'monthly' ? { color: 'var(--t-text-dim)' } : {}}>Monthly</span>
          <button onClick={() => setCycle(c => c === 'monthly' ? 'yearly' : 'monthly')}
            className="relative w-12 h-6 rounded-full transition-colors"
            style={{ backgroundColor: cycle === 'yearly' ? '#F97316' : 'var(--t-surface-2)' }}>
            <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
              cycle === 'yearly' ? 'left-[26px]' : 'left-0.5'}`} />
          </button>
          <span className={`text-sm ${cycle === 'yearly' ? 'text-white font-semibold' : ''}`}
            style={cycle !== 'yearly' ? { color: 'var(--t-text-dim)' } : {}}>
            Yearly <span className="text-emerald-400 text-xs ml-1">Save 17%</span>
          </span>
        </div>
      </div>

      {/* Plans grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {plans.sort((a, b) => a.sort_order - b.sort_order).map(plan => {
          const price = formatPrice(plan)
          const isCurrent = plan.id === currentPlan
          const isPopular = plan.id === 'starter'
          return (
            <div key={plan.id} className={`relative rounded-xl border-2 p-5 flex flex-col ${PLAN_ACCENT[plan.id] ?? 'border-slate-700'}`}
              style={{ backgroundColor: 'var(--t-surface)' }}>
              {isPopular && (
                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-3 py-0.5 rounded-full bg-[#F97316] text-white text-xs font-semibold">
                  Most Popular
                </div>
              )}
              <h3 className="text-lg font-bold" style={{ color: 'var(--t-text)' }}>{plan.name}</h3>
              <p className="text-xs mt-1 min-h-[2.5rem]" style={{ color: 'var(--t-text-muted)' }}>{plan.description}</p>

              <div className="mt-4 mb-4">
                {plan.id === 'enterprise' ? (
                  <span className="text-2xl font-bold" style={{ color: 'var(--t-text)' }}>Custom</span>
                ) : (
                  <>
                    <span className="text-sm" style={{ color: 'var(--t-text-dim)' }}>₹</span>
                    <span className="text-3xl font-bold" style={{ color: 'var(--t-text)' }}>{price.amount}</span>
                    <span className="text-sm" style={{ color: 'var(--t-text-dim)' }}>{price.period}</span>
                  </>
                )}
              </div>

              {/* CTA Button */}
              {isCurrent ? (
                <button disabled className="w-full py-2 rounded-lg text-sm font-medium border"
                  style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-dim)' }}>
                  Current Plan
                </button>
              ) : plan.id === 'enterprise' ? (
                <a href="mailto:admin@tinai.cloud?subject=Enterprise%20Plan%20Inquiry"
                  className="block w-full py-2 rounded-lg text-sm font-semibold text-center border border-purple-500 text-purple-400 hover:bg-purple-500/10 transition-colors">
                  Contact Sales
                </a>
              ) : plan.id === 'free' ? (
                <button disabled className="w-full py-2 rounded-lg text-sm font-medium border"
                  style={{ borderColor: 'var(--t-border)', color: 'var(--t-text-dim)' }}>
                  Free Forever
                </button>
              ) : (
                <button onClick={() => handleUpgrade(plan.id)} disabled={!!upgrading}
                  className={`w-full py-2 rounded-lg text-sm font-semibold text-white transition-colors ${
                    plan.id === 'starter' ? 'bg-[#F97316] hover:bg-[#EA6C0A]' : 'bg-emerald-600 hover:bg-emerald-500'
                  } disabled:opacity-50`}>
                  {upgrading === plan.id ? 'Processing...' : 'Upgrade'}
                </button>
              )}

              {/* Features */}
              <ul className="mt-5 space-y-2 flex-1">
                {(plan.features || []).map((f, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--t-text-muted)' }}>
                    <span className="text-emerald-400 mt-0.5">✓</span>
                    {f}
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>

      <div className="text-center mt-8 space-y-2">
        <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
          All prices exclude GST (18%). Data stored in India. SOC 2 compliance available on Pro and Enterprise.
        </p>
        <p className="text-xs" style={{ color: 'var(--t-text-dim)' }}>
          Payment powered by Razorpay. UPI, cards, net banking accepted.
        </p>
      </div>
    </div>
  )
}
