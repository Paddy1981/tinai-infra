// config/index.js
// All configuration sourced from environment variables.
// Defaults are safe for local dev; override in K8s via ConfigMap + Secret.

export const config = {
  // ── Service identity ─────────────────────────────────────────────────────
  service: {
    name: 'tinai-metering-bridge',
    version: process.env.npm_package_version ?? '0.1.0',
    port: parseInt(process.env.PORT ?? '3100', 10),
    logLevel: process.env.LOG_LEVEL ?? 'info',
  },

  // ── Prometheus ────────────────────────────────────────────────────────────
  // The in-cluster Prometheus service URL. Adjust if you use Thanos/VictoriaMetrics.
  prometheus: {
    url: process.env.PROMETHEUS_URL ?? 'http://prometheus-server.monitoring.svc.cluster.local:9090',
    timeout: parseInt(process.env.PROMETHEUS_TIMEOUT_MS ?? '10000', 10),
    // Step for range queries (should match scrape interval)
    step: process.env.PROMETHEUS_STEP ?? '60',
  },

  // ── Lago billing engine ───────────────────────────────────────────────────
  lago: {
    url: process.env.LAGO_API_URL ?? 'http://lago-api.billing.svc.cluster.local:3000',
    apiKey: process.env.LAGO_API_KEY ?? '', // Required — injected via K8s Secret
    // Lago charges batching: max events per POST /events/batch
    batchSize: parseInt(process.env.LAGO_BATCH_SIZE ?? '100', 10),
    // Retry config for failed Lago POSTs
    retryAttempts: parseInt(process.env.LAGO_RETRY_ATTEMPTS ?? '3', 10),
    retryDelayMs: parseInt(process.env.LAGO_RETRY_DELAY_MS ?? '2000', 10),
  },

  // ── NATS ──────────────────────────────────────────────────────────────────
  nats: {
    servers: (process.env.NATS_SERVERS ?? 'nats://nats.core.svc.cluster.local:4222').split(','),
    // Subject for metering audit events (consumed by compliance reporter)
    auditSubject: process.env.NATS_AUDIT_SUBJECT ?? 'tinai.metering.audit',
    // Subject for DLQ — failed events land here for investigation
    dlqSubject: process.env.NATS_DLQ_SUBJECT ?? 'tinai.metering.dlq',
  },

  // ── Collection schedule ───────────────────────────────────────────────────
  schedule: {
    // How often the metering job runs (ms). Default 15 minutes.
    intervalMs: parseInt(process.env.METERING_INTERVAL_MS ?? String(15 * 60 * 1000), 10),
    // On startup, collect metrics from this far back (catches cold-start gap)
    lookbackMs: parseInt(process.env.METERING_LOOKBACK_MS ?? String(20 * 60 * 1000), 10),
  },

  // ── Tenant discovery ──────────────────────────────────────────────────────
  // Namespaces matching this prefix are treated as tenant workload namespaces.
  // System namespaces (kube-system, monitoring, etc.) are excluded.
  tenants: {
    namespacePrefix: process.env.TENANT_NS_PREFIX ?? 'tenant-',
    // Comma-separated list of namespaces to always exclude
    excludeNamespaces: (process.env.EXCLUDE_NAMESPACES ?? 'kube-system,kube-public,monitoring,cert-manager,argo,core,billing').split(','),
  },
};

// Validate required secrets at startup
export function validateConfig() {
  const errors = [];
  if (!config.lago.apiKey) errors.push('LAGO_API_KEY is required');
  if (errors.length) {
    throw new Error(`Configuration errors:\n${errors.map(e => `  • ${e}`).join('\n')}`);
  }
}
