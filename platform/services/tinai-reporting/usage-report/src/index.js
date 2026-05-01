// usage-report/src/index.js
// Service: Monthly Usage Report Generator
//
// CronJob: runs on 1st of each month at 06:00
// For each tenant: generates a PDF usage summary and emails it.
//
// Report includes:
//   - Compute (CPU core-seconds)
//   - Memory (GB·seconds)
//   - Storage (GB·hours)
//   - Egress (bytes transferred)
//   - Build time (seconds)
//   - Cost breakdown per metric
//   - Month-over-month comparison
//   - Lago invoice reference

import pino from 'pino';
import { config, validateTenantId } from '../../shared/config.js';
import { connectNATS, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { fetchAllCustomers, fetchCustomerUsage, fetchSubscriptions, fetchAllInvoicesInRange } from '../../shared/lago.js';
import { listTenantNamespaces } from '../../shared/prometheus.js';
import { generateUsageReportPDF } from './pdf-builder.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Date helpers ──────────────────────────────────────────────────────────────
function getReportingWindow() {
  // Report covers the previous calendar month
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed; this is the PREVIOUS month

  const fromDate = new Date(year, month - 1, 1);
  const toDate   = new Date(year, month, 0); // last day of prev month

  return {
    fromDate: fromDate.toISOString().slice(0, 10),
    toDate:   toDate.toISOString().slice(0, 10),
    label:    fromDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    year:     fromDate.getFullYear(),
    month:    fromDate.getMonth() + 1,
  };
}

// ── Fetch Prometheus metrics for the month ────────────────────────────────────
async function fetchMonthlyMetrics(namespace, fromDate, toDate) {
  // Build a Prometheus instant query using increase() over the full month window
  const windowSecs = (new Date(toDate) - new Date(fromDate)) / 1000 + 86400; // +1 day
  const range = `${Math.ceil(windowSecs)}s`;

  async function queryMetric(promql) {
    try {
      const { promInstant } = await import('../../shared/prometheus.js');
      const results = await promInstant(promql);
      const val = parseFloat(results?.[0]?.value?.[1] ?? '0');
      return isNaN(val) ? 0 : Math.max(0, val);
    } catch { return 0; }
  }

  const [computeSeconds, memoryGbSeconds, storageGbHours, egressBytes, buildSeconds] = await Promise.all([
    queryMetric(`sum(increase(container_cpu_usage_seconds_total{namespace="${namespace}",container!=""}[${range}]))`),
    queryMetric(`sum(avg_over_time(container_memory_working_set_bytes{namespace="${namespace}",container!=""}[${range}])) / 1073741824 * ${windowSecs}`),
    queryMetric(`sum(avg_over_time(kubelet_volume_stats_capacity_bytes{namespace="${namespace}"}[${range}])) / 1073741824 / 3600 * ${windowSecs / 3600}`),
    queryMetric(`sum(increase(container_network_transmit_bytes_total{namespace="${namespace}"}[${range}]))`),
    queryMetric(`sum(increase(woodpecker_pipeline_duration_seconds{namespace="${namespace}"}[${range}]))`),
  ]);

  return { computeSeconds, memoryGbSeconds, storageGbHours, egressBytes, buildSeconds };
}

// ── Unit pricing (must match Lago plan pricing) ───────────────────────────────
const UNIT_PRICES = {
  compute_seconds:   0.000001,   // ₹0.000001 per CPU-second
  memory_gb_seconds: 0.0000005,  // ₹0.0000005 per GB·second
  storage_gb_hours:  0.001,      // ₹0.001 per GB·hour
  egress_bytes:      0.00000001, // ₹0.00000001 per byte (₹10/GB)
  build_seconds:     0.0000005,  // ₹0.0000005 per build-second
};

function calculateCosts(metrics) {
  return {
    compute:  metrics.computeSeconds   * UNIT_PRICES.compute_seconds,
    memory:   metrics.memoryGbSeconds  * UNIT_PRICES.memory_gb_seconds,
    storage:  metrics.storageGbHours   * UNIT_PRICES.storage_gb_hours,
    egress:   metrics.egressBytes      * UNIT_PRICES.egress_bytes,
    build:    metrics.buildSeconds     * UNIT_PRICES.build_seconds,
  };
}

// ── Process one tenant ────────────────────────────────────────────────────────
async function processOneTenant(customer, window, invoices, natsClient) {
  const tenantId = customer.external_id;
  validateTenantId(tenantId);
  const namespace = `${config.k8s.tenantNsPrefix}${tenantId}`;

  logger.debug({ tenantId }, 'Generating usage report');

  // Fetch subscriptions to get current plan
  const subscriptions = await fetchSubscriptions(tenantId);
  const activeSub = subscriptions.find(s => s.status === 'active');

  // Fetch Prometheus metrics
  const metrics = await fetchMonthlyMetrics(namespace, window.fromDate, window.toDate);
  const costs = calculateCosts(metrics);
  const totalCost = Object.values(costs).reduce((a, b) => a + b, 0);

  // Find invoice for this tenant in this period
  const tenantInvoice = invoices.find(inv =>
    inv.customer?.external_id === tenantId &&
    inv.issuing_date >= window.fromDate &&
    inv.issuing_date <= window.toDate
  );

  const reportData = {
    tenant: {
      id: tenantId,
      name: customer.name,
      email: customer.email,
      plan: activeSub?.plan_code ?? 'unknown',
    },
    window,
    metrics,
    costs,
    totalCost,
    currency: customer.currency ?? 'INR',
    invoiceNumber: tenantInvoice?.number ?? null,
    invoiceAmount: tenantInvoice ? (tenantInvoice.total_amount_cents / 100) : totalCost,
  };

  // Generate PDF
  const pdfBuffer = await generateUsageReportPDF(reportData, logger);

  // Email to tenant
  if (customer.email) {
    const symbol = reportData.currency === 'INR' ? '₹' : '$';
    await sendEmail({
      to: customer.email,
      subject: `Your Tinai usage report — ${window.label}`,
      html: buildUsageReportEmail(reportData),
      attachments: [{
        filename: `tinai-usage-${window.year}-${String(window.month).padStart(2, '0')}-${tenantId}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      }],
    }, logger);
  }

  publishAudit(natsClient, {
    event: 'usage_report.sent',
    tenantId,
    period: window.label,
    totalCost,
  }, logger);

  logger.info({ tenantId, period: window.label, totalCost: totalCost.toFixed(2) }, 'Usage report sent');
  return reportData;
}

function buildUsageReportEmail(data) {
  const symbol = data.currency === 'INR' ? '₹' : '$';
  return `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5">
  <div style="background:#0f172a;padding:20px 32px;border-radius:8px 8px 0 0">
    <p style="color:#fff;font-size:16px;font-weight:600;margin:0">Tinai</p>
    <p style="color:#94a3b8;font-size:12px;margin:2px 0 0">Monthly Usage Report · ${data.window.label}</p>
  </div>
  <div style="padding:28px 32px">
    <p style="color:#111;font-size:15px;margin:0 0 20px">Hi ${data.tenant.name ?? data.tenant.id},</p>
    <p style="color:#444;font-size:14px;margin:0 0 20px">Here's your usage summary for <strong>${data.window.label}</strong>. Full breakdown is in the attached PDF.</p>
    <div style="background:#f8fafc;border-radius:6px;padding:16px 20px;margin-bottom:20px">
      <table style="width:100%;font-size:13px;border-collapse:collapse">
        <tr><td style="color:#64748b;padding:3px 0">Compute</td><td style="text-align:right">${(data.metrics.computeSeconds / 3600).toFixed(1)} core·hours</td></tr>
        <tr><td style="color:#64748b;padding:3px 0">Memory</td><td style="text-align:right">${(data.metrics.memoryGbSeconds / 3600).toFixed(1)} GB·hours</td></tr>
        <tr><td style="color:#64748b;padding:3px 0">Storage</td><td style="text-align:right">${data.metrics.storageGbHours.toFixed(1)} GB·hours</td></tr>
        <tr><td style="color:#64748b;padding:3px 0">Egress</td><td style="text-align:right">${(data.metrics.egressBytes / (1024**3)).toFixed(2)} GB</td></tr>
        <tr style="border-top:1px solid #e2e8f0"><td style="color:#111;font-weight:600;padding:6px 0 3px">Total billed</td><td style="text-align:right;font-size:16px;font-weight:700">${symbol}${data.invoiceAmount.toFixed(2)}</td></tr>
      </table>
    </div>
    ${data.invoiceNumber ? `<p style="color:#444;font-size:13px">Invoice reference: <strong>${data.invoiceNumber}</strong></p>` : ''}
    <a href="https://tinai.cloud/dashboard" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px">View dashboard</a>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #e5e5e5;background:#f8fafc;border-radius:0 0 8px 8px">
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center">Tinai Cloud · billing@tinai.cloud · tinai.cloud</p>
  </div>
</div></body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const window = getReportingWindow();
  logger.info({ period: window.label }, 'Usage report run starting');

  const natsClient = await connectNATS(logger);

  const [customers, invoices] = await Promise.all([
    fetchAllCustomers(),
    fetchAllInvoicesInRange(window.fromDate, window.toDate),
  ]);

  logger.info({ customers: customers.length, invoices: invoices.length }, 'Data fetched from Lago');

  const results = await Promise.allSettled(
    customers.map(c => processOneTenant(c, window, invoices, natsClient))
  );

  const succeeded = results.filter(r => r.status === 'fulfilled').length;
  const failed    = results.filter(r => r.status === 'rejected').length;
  const errors    = results.filter(r => r.status === 'rejected').map(r => r.reason?.message);

  if (errors.length) logger.error({ errors }, 'Some tenants failed');

  publishAudit(natsClient, {
    event: 'usage_report.batch_complete',
    period: window.label,
    total: customers.length, succeeded, failed,
  }, logger);

  logger.info({ period: window.label, succeeded, failed }, 'Usage report run complete');

  if (natsClient) await natsClient.drain();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
