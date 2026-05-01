// shared/prometheus.js
// Prometheus query helpers for reporting services.

import { config } from './config.js';

export async function promInstant(query) {
  const url = new URL('/api/v1/query', config.prometheus.url);
  url.searchParams.set('query', query);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Prometheus query failed: ${res.status}`);
  const body = await res.json();
  return body.data?.result ?? [];
}

export async function promRange(query, start, end, step = '60') {
  const url = new URL('/api/v1/query_range', config.prometheus.url);
  url.searchParams.set('query', query);
  url.searchParams.set('start', Math.floor(start / 1000));
  url.searchParams.set('end', Math.floor(end / 1000));
  url.searchParams.set('step', step);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Prometheus range query failed: ${res.status}`);
  const body = await res.json();
  return body.data?.result ?? [];
}

// Per-namespace metric totals for a time window
export async function namespaceMetricTotal(namespace, metricQuery) {
  const results = await promInstant(metricQuery.replace('{NS}', namespace));
  const val = parseFloat(results?.[0]?.value?.[1] ?? '0');
  return isNaN(val) ? 0 : Math.max(0, val);
}

// All namespaces matching tenant prefix
export async function listTenantNamespaces(prefix = 'tenant-') {
  const url = new URL('/api/v1/label/namespace/values', config.prometheus.url);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  const body = await res.json();
  return (body.data ?? []).filter(ns => ns.startsWith(prefix));
}
