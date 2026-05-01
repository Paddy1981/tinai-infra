export interface Invoice {
  id: string
  period_start: string
  period_end: string
  subtotal_paise: number
  tax_paise: number
  total_paise: number
  status: 'draft' | 'open' | 'paid' | 'void'
  pdf_url: string | null
  created_at: string
}

export interface UsageSummary {
  product: string        // 'instances' | 'storage' | 'inference' | 'functions'
  cost_paise: number
  unit_label: string     // e.g. "12 GPU-hours", "45 GB-months"
}

export interface BillingOverview {
  current_month_paise: number
  last_month_paise: number
  credit_balance_paise: number
  next_invoice_date: string
  usage_by_product: UsageSummary[]
}

export interface PaymentMethod {
  id: string
  last4: string
  expiry_month: number
  expiry_year: number
  brand: string
}

/** Formats a paise integer as ₹1,234.56 */
export function paiseToCurrency(paise: number): string {
  const rupees = paise / 100
  return '₹' + rupees.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export async function getBillingOverview(): Promise<BillingOverview> {
  const res = await fetch('/api/v1/billing/overview', { cache: 'no-store' })
  if (!res.ok) throw new Error(`Failed to load billing overview: ${res.status}`)
  return res.json()
}

export async function listInvoices(): Promise<Invoice[]> {
  const res = await fetch('/api/v1/billing/invoices', { cache: 'no-store' })
  if (!res.ok) throw new Error(`Failed to list invoices: ${res.status}`)
  return res.json()
}

export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  const res = await fetch('/api/v1/billing/payment-methods', { cache: 'no-store' })
  if (!res.ok) throw new Error(`Failed to load payment methods: ${res.status}`)
  return res.json()
}

export async function createCheckoutSession(): Promise<{ url: string }> {
  const res = await fetch('/api/v1/billing/checkout-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tinai-csrf': '1' },
  })
  if (!res.ok) throw new Error(`Failed to create checkout session: ${res.status}`)
  return res.json()
}
