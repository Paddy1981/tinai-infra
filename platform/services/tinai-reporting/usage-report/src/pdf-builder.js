// usage-report/src/pdf-builder.js
// Generates the monthly usage report PDF for a single tenant.

import {
  createDoc, docToBuffer, pageHeader, sectionHeading,
  metricBox, tableHeader, tableRow, hRule,
  formatCurrency, formatBytes, formatDuration,
  COLORS,
} from '../../shared/pdf-base.js';

export async function generateUsageReportPDF(data, logger) {
  const doc = createDoc({
    info: {
      Title: `Tinai Usage Report — ${data.window.label}`,
      Subject: `Usage report for ${data.tenant.name ?? data.tenant.id}`,
    },
  });

  const bufferPromise = docToBuffer(doc);

  // ── Cover / Header ─────────────────────────────────────────────────────────
  pageHeader(doc, {
    title: 'Monthly Usage Report',
    subtitle: data.window.label,
  });

  // Tenant details row
  doc.fontSize(9).font('Helvetica').fillColor(COLORS.muted);
  doc.text(`Tenant: ${data.tenant.name ?? data.tenant.id}`, 50, doc.y);
  doc.text(`Plan: ${data.tenant.plan.toUpperCase()}`, 200, doc.y - doc.currentLineHeight());
  doc.text(`Period: ${data.window.fromDate} → ${data.window.toDate}`, 350, doc.y - doc.currentLineHeight());
  doc.moveDown(1.2);

  // ── Summary metric boxes ───────────────────────────────────────────────────
  sectionHeading(doc, 'Usage Summary');

  const boxY = doc.y;
  const boxW = 94;
  const gap  = 5;

  const boxes = [
    { label: 'Compute', value: `${(data.metrics.computeSeconds / 3600).toFixed(1)}`, unit: 'core·hours', color: COLORS.accent },
    { label: 'Memory',  value: `${(data.metrics.memoryGbSeconds / 3600).toFixed(1)}`, unit: 'GB·hours',  color: '#8b5cf6' },
    { label: 'Storage', value: `${data.metrics.storageGbHours.toFixed(1)}`,            unit: 'GB·hours',  color: '#f59e0b' },
    { label: 'Egress',  value: `${(data.metrics.egressBytes / (1024 ** 3)).toFixed(2)}`, unit: 'GB out', color: '#10b981' },
    { label: 'Builds',  value: `${formatDuration(data.metrics.buildSeconds)}`,           unit: 'build time', color: COLORS.muted },
  ];

  boxes.forEach((b, i) => {
    metricBox(doc, { ...b, x: 50 + i * (boxW + gap), y: boxY, width: boxW });
  });

  doc.y = boxY + 62;

  // ── Cost breakdown table ───────────────────────────────────────────────────
  sectionHeading(doc, 'Cost Breakdown');

  const costCols = [
    { label: 'Metric',    width: 160 },
    { label: 'Usage',     width: 120 },
    { label: 'Unit rate', width: 120 },
    { label: 'Amount',    width: 95, align: 'right' },
  ];

  tableHeader(doc, costCols);

  const rows = [
    ['Compute (CPU)',  `${(data.metrics.computeSeconds / 3600).toFixed(2)} core·hrs`,  '₹0.0036/core·hr',  formatCurrency(data.costs.compute,  data.currency)],
    ['Memory (RAM)',   `${(data.metrics.memoryGbSeconds / 3600).toFixed(2)} GB·hrs`,   '₹0.0018/GB·hr',    formatCurrency(data.costs.memory,   data.currency)],
    ['Storage (PVC)',  `${data.metrics.storageGbHours.toFixed(2)} GB·hrs`,             '₹0.001/GB·hr',     formatCurrency(data.costs.storage,  data.currency)],
    ['Network egress', `${(data.metrics.egressBytes / (1024**3)).toFixed(3)} GB`,      '₹10/GB',           formatCurrency(data.costs.egress,   data.currency)],
    ['Build time',     `${formatDuration(data.metrics.buildSeconds)}`,                 '₹0.0018/build·hr', formatCurrency(data.costs.build,    data.currency)],
  ];

  rows.forEach((row, i) => tableRow(doc, costCols, row, { zebra: true, rowIndex: i }));

  // Subtotal row
  doc.moveDown(0.3);
  hRule(doc);
  doc.moveDown(0.2);
  const totalRows = [
    { label: 'Subtotal (usage)',  val: formatCurrency(data.totalCost, data.currency) },
    { label: 'GST / VAT',        val: data.currency === 'INR' ? formatCurrency(data.totalCost * 0.18, data.currency) : '—' },
    { label: 'Total invoiced',   val: formatCurrency(data.invoiceAmount, data.currency), bold: true },
  ];

  for (const r of totalRows) {
    doc.fontSize(9).font(r.bold ? 'Helvetica-Bold' : 'Helvetica').fillColor(COLORS.primary);
    doc.text(r.label, 320, doc.y, { width: 130 });
    doc.text(r.val, 450, doc.y - doc.currentLineHeight(), { width: 95, align: 'right' });
    doc.moveDown(0.4);
  }

  // ── Daily usage chart (text sparkline — no canvas needed) ─────────────────
  sectionHeading(doc, 'Notes');

  doc.fontSize(9).font('Helvetica').fillColor(COLORS.muted);
  doc.text('• Usage is metered every 15 minutes from Prometheus and reported to Lago billing engine.');
  doc.text('• Compute is measured as CPU core-seconds consumed by all containers in your namespace.');
  doc.text('• Memory is measured as working set bytes (RSS + cache) averaged over the billing period.');
  doc.text('• Storage reflects average PVC capacity provisioned, not data actually written.');
  doc.text('• Egress counts bytes transmitted from your pods; intra-cluster traffic is not billed.');
  if (data.invoiceNumber) {
    doc.moveDown(0.5);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.primary);
    doc.text(`Invoice reference: ${data.invoiceNumber}`);
    doc.font('Helvetica').fillColor(COLORS.muted).fontSize(9);
    doc.text('Your invoice PDF was sent separately and is available at tinai.cloud/billing.');
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  doc.moveDown(2);
  hRule(doc, { color: COLORS.border });
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica');
  doc.text(`Generated: ${new Date().toISOString()} | Tinai Cloud / Larun Engineering LLP`, { align: 'center' });
  doc.text('For queries: billing@tinai.cloud | tinai.cloud/billing', { align: 'center' });

  doc.end();
  logger.debug({ tenantId: data.tenant.id }, 'Usage report PDF generated');
  return bufferPromise;
}
