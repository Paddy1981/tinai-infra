// src/collectors/prometheus.js
// Queries Prometheus for per-namespace resource usage metrics.
// Each metric maps directly to a Lago billable metric code.

import { config } from '../../config/index.js';

/** Sanitize namespace to prevent PromQL injection. */
function sanitizeNamespace(ns) {
  return ns.replace(/[^a-z0-9-]/g, '');
}

/**
 * Prometheus metric queries.
 *
 * Metric design principles:
 *  - All queries are range_query over the collection window (start → now)
 *  - We use `sum_over_time` / `increase` to get total consumed units,
 *    not instantaneous values — billing is always about consumption, not state.
 *  - Namespace label is `namespace` in kube-state-metrics / cadvisor.
 *
 * Lago billable metric codes (must match what you configured in Lago):
 *  - compute_seconds    → CPU core-seconds consumed
 *  - memory_gb_seconds  → GB of RAM × seconds
 *  - storage_gb_hours   → GB of PVC storage × hours (sampled, not delta)
 *  - egress_bytes       → bytes transferred out of cluster
 *  - build_seconds      → CI/CD build time (from Woodpecker job labels)
 */
const QUERIES = {
  // Total CPU core-seconds consumed in window
  // container != "" excludes pause containers
  compute_seconds: (ns, start, end) =>
    `sum(increase(container_cpu_usage_seconds_total{namespace="${ns}",container!=""}[${rangeStr(start, end)}]))`,

  // RAM GB·seconds — avg memory used × window duration
  memory_gb_seconds: (ns, start, end) =>
    `sum(avg_over_time(container_memory_working_set_bytes{namespace="${ns}",container!=""}[${rangeStr(start, end)}])) / 1073741824 * ${windowSeconds(start, end)}`,

  // Storage GB·hours — avg PVC size × window in hours
  // PVC capacity is a gauge — we sample average, not delta
  storage_gb_hours: (ns, start, end) =>
    `sum(avg_over_time(kubelet_volume_stats_capacity_bytes{namespace="${ns}"}[${rangeStr(start, end)}])) / 1073741824 * ${windowSeconds(start, end)} / 3600`,

  // Egress bytes — total bytes transmitted out via pod network interfaces
  // This uses container_network_transmit_bytes_total; for accurate external-only
  // egress, replace with Cilium hubble metrics when available.
  egress_bytes: (ns, start, end) =>
    `sum(increase(container_network_transmit_bytes_total{namespace="${ns}"}[${rangeStr(start, end)}]))`,

  // Build seconds — total Woodpecker CI pipeline duration for this tenant
  // Requires Woodpecker to expose metrics with a `namespace` label matching tenant ns
  build_seconds: (ns, start, end) =>
    `sum(increase(woodpecker_pipeline_duration_seconds{namespace="${ns}"}[${rangeStr(start, end)}]))`,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function rangeStr(start, end) {
  const secs = Math.ceil((end - start) / 1000);
  return `${secs}s`;
}

function windowSeconds(start, end) {
  return Math.ceil((end - start) / 1000);
}

async function promQuery(query, logger) {
  const url = new URL('/api/v1/query', config.prometheus.url);
  url.searchParams.set('query', query);

  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(config.prometheus.timeout),
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Prometheus HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }

  const body = await res.json();

  if (body.status !== 'success') {
    throw new Error(`Prometheus query failed: ${body.error ?? 'unknown'}`);
  }

  // Instant query returns result[0].value[1]; handle empty gracefully
  const raw = body.data?.result?.[0]?.value?.[1];
  const value = raw !== undefined ? parseFloat(raw) : 0;
  return isNaN(value) ? 0 : Math.max(0, value); // never return negative
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Discover all tenant namespaces from Prometheus label values.
 * This avoids needing K8s API permissions in the bridge itself.
 */
export async function discoverTenantNamespaces(logger) {
  const url = new URL('/api/v1/label/namespace/values', config.prometheus.url);
  const res = await fetch(url.toString(), {
    signal: AbortSignal.timeout(config.prometheus.timeout),
  });

  if (!res.ok) {
    throw new Error(`Namespace discovery failed: HTTP ${res.status}`);
  }

  const body = await res.json();
  const allNamespaces = body.data ?? [];

  const tenantNamespaces = allNamespaces
    .map(sanitizeNamespace)
    .filter(ns =>
      ns.startsWith(config.tenants.namespacePrefix) &&
      !config.tenants.excludeNamespaces.includes(ns)
    );

  logger.debug({ count: tenantNamespaces.length, namespaces: tenantNamespaces }, 'Discovered tenant namespaces');
  return tenantNamespaces;
}

/**
 * Collect all billable metrics for a single namespace over [start, end].
 * Returns an object keyed by Lago metric code, values are floats.
 *
 * Returns null if the namespace has zero activity (saves Lago API calls).
 */
export async function collectNamespaceMetrics(namespace, start, end, logger) {
  const results = {};
  let totalActivity = 0;

  for (const [metricCode, queryFn] of Object.entries(QUERIES)) {
    try {
      const query = queryFn(namespace, start, end);
      const value = await promQuery(query, logger);
      results[metricCode] = value;
      totalActivity += value;
      logger.trace({ namespace, metricCode, value }, 'Metric collected');
    } catch (err) {
      logger.warn({ namespace, metricCode, err: err.message }, 'Metric query failed — defaulting to 0');
      results[metricCode] = 0;
    }
  }

  // Skip namespaces with zero usage across all metrics (e.g. idle/suspended tenants)
  if (totalActivity === 0) {
    logger.debug({ namespace }, 'Zero activity — skipping Lago event');
    return null;
  }

  return results;
}
