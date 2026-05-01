// shared/lago.js
// Lago REST API client shared across all reporting services.

import { config } from './config.js';

async function lagoRequest(path, method = 'GET', body = null) {
  const res = await fetch(`${config.lago.url}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${config.lago.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Lago ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Invoices ──────────────────────────────────────────────────────────────────
export async function fetchInvoices({ fromDate, toDate, status, page = 1, perPage = 100 } = {}) {
  const params = new URLSearchParams({ page, per_page: perPage });
  if (fromDate) params.set('issuing_date_from', fromDate);
  if (toDate)   params.set('issuing_date_to', toDate);
  if (status)   params.set('payment_status', status);
  const data = await lagoRequest(`/invoices?${params}`);
  return data.invoices ?? [];
}

export async function fetchAllInvoicesInRange(fromDate, toDate) {
  const all = [];
  let page = 1;
  while (true) {
    const batch = await fetchInvoices({ fromDate, toDate, page, perPage: 100 });
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

// ── Customers / Subscriptions ─────────────────────────────────────────────────
export async function fetchAllCustomers() {
  const all = [];
  let page = 1;
  while (true) {
    const data = await lagoRequest(`/customers?page=${page}&per_page=100`);
    const batch = data.customers ?? [];
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return all;
}

export async function fetchSubscriptions(externalCustomerId) {
  const data = await lagoRequest(`/subscriptions?external_customer_id=${externalCustomerId}`);
  return data.subscriptions ?? [];
}

// ── Usage / Events ────────────────────────────────────────────────────────────
export async function fetchCustomerUsage(externalCustomerId, externalSubscriptionId) {
  const data = await lagoRequest(
    `/customers/${externalCustomerId}/current_usage?external_subscription_id=${externalSubscriptionId}`
  );
  return data.customer_usage ?? data;
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export async function fetchMRRAnalytics() {
  const data = await lagoRequest('/analytics/mrr');
  return data.mrr ?? [];
}

export async function fetchRevenueAnalytics({ fromDate, toDate } = {}) {
  const params = new URLSearchParams();
  if (fromDate) params.set('from_date', fromDate);
  if (toDate)   params.set('to_date', toDate);
  const data = await lagoRequest(`/analytics/revenue_streams?${params}`);
  return data.revenue_streams ?? [];
}

export async function fetchInvoicedUsageAnalytics() {
  const data = await lagoRequest('/analytics/invoiced_usage');
  return data.invoiced_usage ?? [];
}

export async function fetchGrossRevenue() {
  const data = await lagoRequest('/analytics/gross_revenue');
  return data.gross_revenue ?? [];
}
