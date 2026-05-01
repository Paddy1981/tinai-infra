// invoice-generator/src/pdf-generator.js
// Generates GST-compliant PDF invoices using PDFKit.
// Supports: India (GST with CGST/SGST/IGST), Qatar/UAE (VAT-exempt export).
//
// Install: npm install pdfkit

import PDFDocument from 'pdfkit';
import { config } from '../../shared/config.js';

/**
 * Generate a PDF invoice buffer.
 * @param {object} invoice   - Full invoice object from Lago API
 * @param {object} taxConfig - Tax regime config from buildTaxConfig()
 * @param {object} logger
 * @returns {Promise<Buffer>}
 */
export async function generateInvoicePDF(invoice, taxConfig, logger) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const customer = invoice.customer ?? {};
    const subtotalCents = invoice.sub_total_excluding_taxes_amount_cents ?? invoice.total_amount_cents ?? 0;
    const subtotal = subtotalCents / 100;
    const taxAmount = subtotal * taxConfig.rate;
    const total = subtotal + taxAmount;
    const currency = invoice.currency ?? 'INR';
    const currencySymbol = currency === 'INR' ? '₹' : currency === 'USD' ? '$' : currency;

    // ── Header ──────────────────────────────────────────────────────────────
    doc.fontSize(20).font('Helvetica-Bold').text('TAX INVOICE', { align: 'right' });
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#555');
    doc.text(`Invoice #: ${invoice.number ?? invoice.lago_id}`, { align: 'right' });
    doc.text(`Date: ${formatDate(invoice.issuing_date ?? new Date())}`, { align: 'right' });
    doc.text(`Due: ${formatDate(invoice.payment_due_date ?? new Date())}`, { align: 'right' });
    doc.fillColor('#000');

    doc.moveDown(1);
    drawHRule(doc);

    // ── Supplier (Tinai / Larun) ─────────────────────────────────────────────
    doc.moveDown(0.5);
    doc.fontSize(12).font('Helvetica-Bold').text('From');
    doc.fontSize(10).font('Helvetica');
    doc.text(config.gst.legalName);
    doc.text('Tinai Cloud Platform');
    doc.text(config.gst.address);
    if (taxConfig.type === 'GST' && config.gst.gstin) {
      doc.text(`GSTIN: ${config.gst.gstin}`);
    }
    doc.text('billing@tinai.cloud');

    // ── Customer ─────────────────────────────────────────────────────────────
    const customerTop = doc.y;
    doc.moveUp(5);
    doc.fontSize(12).font('Helvetica-Bold').text('Bill To', 300);
    doc.fontSize(10).font('Helvetica');
    doc.text(customer.name ?? customer.external_id ?? 'Tenant', 300);
    if (customer.email) doc.text(customer.email, 300);
    if (customer.billing_configuration?.document_locale) {
      doc.text(`Tax ID: ${customer.billing_configuration.tax_identification_number ?? '-'}`, 300);
    }
    doc.y = Math.max(doc.y, customerTop);

    doc.moveDown(1.5);
    drawHRule(doc);

    // ── Line items ───────────────────────────────────────────────────────────
    doc.moveDown(0.5);
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Description', 50, doc.y, { width: 280 });
    doc.text('Qty', 330, doc.y - doc.currentLineHeight(), { width: 60, align: 'right' });
    doc.text('Rate', 390, doc.y - doc.currentLineHeight(), { width: 70, align: 'right' });
    doc.text('Amount', 460, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    doc.moveDown(0.3);
    drawHRule(doc);

    doc.font('Helvetica').fontSize(9);
    const fees = invoice.fees ?? [];
    for (const fee of fees) {
      const feeAmount = (fee.amount_cents ?? 0) / 100;
      const desc = fee.charge?.billable_metric?.name
        ?? fee.item_description
        ?? fee.item_code
        ?? 'Platform usage';
      const qty = fee.units ?? 1;
      const rate = qty > 0 ? feeAmount / qty : feeAmount;

      doc.moveDown(0.3);
      doc.text(desc, 50, doc.y, { width: 280 });
      doc.text(qty.toFixed(4), 330, doc.y - doc.currentLineHeight(), { width: 60, align: 'right' });
      doc.text(`${currencySymbol}${rate.toFixed(6)}`, 390, doc.y - doc.currentLineHeight(), { width: 70, align: 'right' });
      doc.text(`${currencySymbol}${feeAmount.toFixed(2)}`, 460, doc.y - doc.currentLineHeight(), { width: 80, align: 'right' });
    }

    doc.moveDown(0.5);
    drawHRule(doc);

    // ── Totals ────────────────────────────────────────────────────────────────
    doc.moveDown(0.3);
    const totalsX = 350;
    doc.font('Helvetica').fontSize(10);

    addTotalRow(doc, 'Subtotal', `${currencySymbol}${subtotal.toFixed(2)}`, totalsX);

    if (taxConfig.type === 'GST') {
      // Intra-state: CGST + SGST; Inter-state: IGST
      // Simplified: always show IGST (adjust per your CA's advice)
      addTotalRow(doc, `IGST (${(taxConfig.rate * 100).toFixed(0)}%)`, `${currencySymbol}${taxAmount.toFixed(2)}`, totalsX);
      if (taxConfig.hsnCode) {
        doc.fontSize(8).fillColor('#888');
        doc.text(`HSN/SAC: ${taxConfig.hsnCode}`, totalsX, doc.y);
        doc.fillColor('#000').fontSize(10);
      }
    } else {
      addTotalRow(doc, taxConfig.label, `${currencySymbol}0.00`, totalsX);
    }

    doc.moveDown(0.2);
    drawHRule(doc, totalsX);
    doc.font('Helvetica-Bold');
    addTotalRow(doc, 'Total Due', `${currencySymbol}${total.toFixed(2)}`, totalsX);

    // ── Footer ────────────────────────────────────────────────────────────────
    doc.moveDown(2);
    drawHRule(doc);
    doc.moveDown(0.5);
    doc.fontSize(8).fillColor('#666').font('Helvetica');
    doc.text('Payment terms: Due on receipt. Late payments subject to 1.5% monthly interest.', { align: 'center' });
    doc.text('For queries: billing@tinai.cloud | tinai.cloud/billing', { align: 'center' });
    if (taxConfig.type === 'GST') {
      doc.moveDown(0.3);
      doc.text('This is a computer-generated invoice. No signature required.', { align: 'center' });
    }
    if (taxConfig.type === 'VAT_EXEMPT') {
      doc.moveDown(0.3);
      doc.text('Export of services — VAT exempt per applicable regulations.', { align: 'center' });
    }

    doc.end();
    logger.debug({ invoiceId: invoice.lago_id }, 'PDF generated');
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function drawHRule(doc, x = 50) {
  doc.moveTo(x, doc.y).lineTo(545, doc.y).strokeColor('#ccc').lineWidth(0.5).stroke();
}

function addTotalRow(doc, label, value, x) {
  doc.moveDown(0.3);
  doc.text(label, x, doc.y, { width: 120 });
  doc.text(value, x + 120, doc.y - doc.currentLineHeight(), { width: 75, align: 'right' });
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}
