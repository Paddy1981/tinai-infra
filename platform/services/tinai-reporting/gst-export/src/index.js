// gst-export/src/index.js
// Service: GST Filing Data Export
//
// CronJob: runs on 5th of each month (gives 5 days buffer after invoice month end)
// Generates GSTR-1 compatible CSV of all INR invoices from previous month.
// Emails to billing admin (you) + stores in MinIO for CA access.
//
// GSTR-1 columns (B2B supply):
//   GSTIN, Invoice No, Date, Value, Tax Rate, IGST, CGST, SGST, Cess, Place of Supply

import pino from 'pino';
import { createObjectCsvStringifier } from 'csv-writer';
import { config, validateTenantId } from '../../shared/config.js';
import { connectNATS, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { fetchAllInvoicesInRange } from '../../shared/lago.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Date helpers ──────────────────────────────────────────────────────────────
function getPreviousMonth() {
  const now = new Date();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();

  const fromDate = new Date(year, month - 1, 1);
  const toDate   = new Date(year, month, 0);

  return {
    fromDate:  fromDate.toISOString().slice(0, 10),
    toDate:    toDate.toISOString().slice(0, 10),
    label:     fromDate.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
    gstrPeriod: `${String(month).padStart(2, '0')}${year}`, // MMYYYY format for GSTR
    year, month,
  };
}

// ── Invoice → GSTR-1 row mapper ───────────────────────────────────────────────
function invoiceToGSTR1Row(invoice) {
  const customer  = invoice.customer ?? {};
  if (customer.external_id) validateTenantId(customer.external_id);
  const subtotal  = (invoice.sub_total_excluding_taxes_amount_cents ?? invoice.amount_cents ?? 0) / 100;
  const gstRate   = config.gst.gstRate; // 18%
  const gstAmount = subtotal * gstRate;

  // Determine IGST vs CGST+SGST based on place of supply
  // Simplified: if customer state != Karnataka (or your state), use IGST
  // In production: compare supplier state code vs customer state code
  const isInterState = true; // most SaaS is inter-state; adjust per your CA
  const igst  = isInterState ? gstAmount : 0;
  const cgst  = isInterState ? 0 : gstAmount / 2;
  const sgst  = isInterState ? 0 : gstAmount / 2;
  const total = subtotal + gstAmount;

  return {
    'GSTIN of Recipient':  customer.tax_identification_number ?? '',
    'Receiver Name':       customer.name ?? customer.external_id ?? '',
    'Invoice Number':      invoice.number ?? invoice.lago_id ?? '',
    'Invoice Date':        formatGSTDate(invoice.issuing_date),
    'Invoice Value':       total.toFixed(2),
    'Place of Supply':     customer.billing_configuration?.state ?? '29', // 29 = Karnataka
    'Reverse Charge':      'N',
    'Applicable Tax Rate': `${(gstRate * 100).toFixed(0)}%`,
    'Taxable Value':       subtotal.toFixed(2),
    'IGST Amount':         igst.toFixed(2),
    'CGST Amount':         cgst.toFixed(2),
    'SGST/UTGST Amount':   sgst.toFixed(2),
    'Cess Amount':         '0.00',
    'HSN/SAC':             config.gst.hsnCode,
    'Currency':            invoice.currency ?? 'INR',
    'Tenant ID':           customer.external_id ?? '',
  };
}

function formatGSTDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
}

// ── Summary statistics ────────────────────────────────────────────────────────
function buildSummary(invoices, rows) {
  const totalTaxable = rows.reduce((s, r) => s + parseFloat(r['Taxable Value'] ?? '0'), 0);
  const totalIGST    = rows.reduce((s, r) => s + parseFloat(r['IGST Amount']   ?? '0'), 0);
  const totalCGST    = rows.reduce((s, r) => s + parseFloat(r['CGST Amount']   ?? '0'), 0);
  const totalSGST    = rows.reduce((s, r) => s + parseFloat(r['SGST/UTGST Amount'] ?? '0'), 0);
  const totalGST     = totalIGST + totalCGST + totalSGST;
  const grandTotal   = totalTaxable + totalGST;

  return { invoiceCount: invoices.length, totalTaxable, totalIGST, totalCGST, totalSGST, totalGST, grandTotal };
}

// ── CSV generator ─────────────────────────────────────────────────────────────
function buildCSV(rows) {
  if (rows.length === 0) return 'No INR invoices in this period.\n';

  const headers = Object.keys(rows[0]).map(key => ({ id: key, title: key }));
  const stringifier = createObjectCsvStringifier({ header: headers });
  return stringifier.getHeaderString() + stringifier.stringifyRecords(rows);
}

// ── Email to admin (you) ──────────────────────────────────────────────────────
function buildGSTEmail(period, summary) {
  return {
    subject: `GST export ready — ${period.label} (${summary.invoiceCount} invoices) · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px">
  <p style="font-size:18px;font-weight:600;margin:0 0 16px">GST Filing Export — ${period.label}</p>
  <p style="color:#444;font-size:14px;margin:0 0 16px">GSTR-1 compatible CSV is attached. GSTR period: <strong>${period.gstrPeriod}</strong></p>
  
  <div style="background:#f8fafc;border-radius:6px;padding:16px 20px;margin-bottom:20px">
    <table style="width:100%;font-size:13px;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Invoices</td><td style="text-align:right;font-weight:600">${summary.invoiceCount}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Taxable value</td><td style="text-align:right">₹${summary.totalTaxable.toFixed(2)}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">IGST</td><td style="text-align:right">₹${summary.totalIGST.toFixed(2)}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">CGST</td><td style="text-align:right">₹${summary.totalCGST.toFixed(2)}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">SGST</td><td style="text-align:right">₹${summary.totalSGST.toFixed(2)}</td></tr>
      <tr style="border-top:1px solid #e2e8f0">
        <td style="color:#111;font-weight:600;padding:6px 0 3px">Total GST collected</td>
        <td style="text-align:right;font-weight:700;font-size:15px">₹${summary.totalGST.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="color:#111;font-weight:600;padding:3px 0">Grand total (incl. GST)</td>
        <td style="text-align:right;font-weight:700">₹${summary.grandTotal.toFixed(2)}</td>
      </tr>
    </table>
  </div>

  <p style="color:#64748b;font-size:13px;margin:0">
    File this with your CA for GSTR-1 submission. Due date: 11th of next month.<br>
    GSTIN: ${config.gst.gstin} · HSN/SAC: ${config.gst.hsnCode}
  </p>
</div></body></html>`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const period = getPreviousMonth();
  logger.info({ period: period.label }, 'GST export starting');

  const natsClient = await connectNATS(logger);

  // Fetch all invoices from previous month in INR only
  const allInvoices = await fetchAllInvoicesInRange(period.fromDate, period.toDate);
  const inrInvoices = allInvoices.filter(inv =>
    (inv.currency ?? 'INR') === 'INR' &&
    inv.payment_status === 'succeeded'
  );

  logger.info({ total: allInvoices.length, inr: inrInvoices.length }, 'Invoices fetched');

  // Map to GSTR-1 rows
  const rows    = inrInvoices.map(invoiceToGSTR1Row);
  const summary = buildSummary(inrInvoices, rows);
  const csv     = buildCSV(rows);

  // Also build a summary CSV row at the bottom
  const csvWithSummary = csv + `\nSUMMARY,,,,,,,,,,,,,,\n` +
    `Total,,,,${summary.grandTotal.toFixed(2)},,,,${summary.totalTaxable.toFixed(2)},${summary.totalIGST.toFixed(2)},${summary.totalCGST.toFixed(2)},${summary.totalSGST.toFixed(2)},0.00,,\n`;

  // Email to admin
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
  const email = buildGSTEmail(period, summary);
  await sendEmail({
    to: adminEmail,
    ...email,
    attachments: [
      {
        filename: `tinai-gstr1-${period.gstrPeriod}.csv`,
        content: Buffer.from(csvWithSummary, 'utf-8'),
        contentType: 'text/csv',
      },
    ],
  }, logger);

  // TODO: also upload to MinIO for CA access
  // const minio = new MinioClient(...);
  // await minio.putObject('gst-exports', `${period.gstrPeriod}/gstr1.csv`, csv);

  publishAudit(natsClient, {
    event: 'gst_export.complete',
    period: period.label,
    gstrPeriod: period.gstrPeriod,
    invoiceCount: summary.invoiceCount,
    totalGST: summary.totalGST,
  }, logger);

  logger.info({ period: period.label, invoiceCount: summary.invoiceCount, totalGST: summary.totalGST.toFixed(2) }, 'GST export complete');

  if (natsClient) await natsClient.drain();
  process.exit(0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
