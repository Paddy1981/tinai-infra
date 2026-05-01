// shared/pdf-base.js
// Base PDF building utilities shared across all report generators.
// Uses PDFKit. Install: npm install pdfkit

import PDFDocument from 'pdfkit';

export const COLORS = {
  primary:  '#0f172a',
  accent:   '#0ea5e9',
  success:  '#16a34a',
  warning:  '#d97706',
  danger:   '#dc2626',
  muted:    '#64748b',
  border:   '#e2e8f0',
  bg:       '#f8fafc',
};

export function createDoc(options = {}) {
  return new PDFDocument({
    size: 'A4',
    margin: 50,
    info: {
      Creator: 'Tinai Cloud Platform',
      Producer: 'Tinai Reporting Engine',
      ...options.info,
    },
    ...options,
  });
}

export function docToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

// ── Layout helpers ────────────────────────────────────────────────────────────

export function hRule(doc, { x = 50, y = doc.y, color = COLORS.border } = {}) {
  doc.moveTo(x, y).lineTo(545, y).strokeColor(color).lineWidth(0.5).stroke();
}

export function pageHeader(doc, { title, subtitle, logo = 'Tinai' }) {
  // Left: logo + title
  doc.fontSize(18).font('Helvetica-Bold').fillColor(COLORS.primary).text(logo, 50, 45);
  doc.fontSize(10).font('Helvetica').fillColor(COLORS.muted).text(subtitle ?? '', 50, 67);

  // Right: title
  doc.fontSize(14).font('Helvetica-Bold').fillColor(COLORS.primary)
    .text(title, 0, 45, { align: 'right' });

  doc.y = 95;
  hRule(doc, { color: COLORS.primary });
  doc.moveDown(0.8);
}

export function sectionHeading(doc, text) {
  doc.moveDown(0.8);
  doc.fontSize(11).font('Helvetica-Bold').fillColor(COLORS.primary).text(text.toUpperCase());
  doc.moveDown(0.2);
  hRule(doc, { color: COLORS.accent });
  doc.moveDown(0.5);
}

export function metricBox(doc, { label, value, unit = '', x, y, width = 115, color = COLORS.accent }) {
  doc.rect(x, y, width, 52).fillColor(COLORS.bg).fill();
  doc.rect(x, y, width, 52).strokeColor(COLORS.border).lineWidth(0.5).stroke();
  doc.rect(x, y, 3, 52).fillColor(color).fill(); // left accent bar

  doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
    .text(label, x + 10, y + 8, { width: width - 14 });
  doc.fontSize(16).font('Helvetica-Bold').fillColor(COLORS.primary)
    .text(value, x + 10, y + 22, { width: width - 14 });
  if (unit) {
    doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted)
      .text(unit, x + 10, y + 40, { width: width - 14 });
  }
}

export function tableHeader(doc, columns) {
  const startY = doc.y;
  doc.rect(50, startY, 495, 20).fillColor(COLORS.bg).fill();
  doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.muted);
  let x = 54;
  for (const col of columns) {
    doc.text(col.label.toUpperCase(), x, startY + 6, { width: col.width, align: col.align ?? 'left' });
    x += col.width;
  }
  doc.y = startY + 20;
  hRule(doc);
}

export function tableRow(doc, columns, values, { zebra = false, rowIndex = 0 } = {}) {
  const rowHeight = 18;
  const startY = doc.y;

  if (zebra && rowIndex % 2 === 0) {
    doc.rect(50, startY, 495, rowHeight).fillColor('#fafafa').fill();
  }

  doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
  let x = 54;
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const val = values[i] ?? '—';
    doc.fillColor(col.color ?? COLORS.primary);
    doc.text(String(val), x, startY + 4, { width: col.width, align: col.align ?? 'left' });
    x += col.width;
  }
  doc.y = startY + rowHeight;
}

export function pageFooter(doc, { pageNum, totalPages, generatedAt }) {
  const y = 800;
  hRule(doc, { y, color: COLORS.border });
  doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted);
  doc.text(`Generated: ${generatedAt}`, 50, y + 6);
  doc.text(`Page ${pageNum} of ${totalPages}`, 0, y + 6, { align: 'right' });
  doc.text('Tinai Cloud · tinai.cloud · billing@tinai.cloud', 0, y + 16, { align: 'center' });
}

export function formatCurrency(amount, currency = 'INR') {
  const symbol = currency === 'INR' ? '₹' : '$';
  return `${symbol}${Number(amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  return `${(seconds / 3600).toFixed(2)}h`;
}
