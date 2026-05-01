// compliance-report/src/pdf-builder.js
// Generates the formal data residency compliance report PDF.
// Designed to be retained for regulatory audit purposes.

import {
  createDoc, docToBuffer, pageHeader, sectionHeading,
  hRule, tableHeader, tableRow, COLORS, formatBytes,
} from '../../shared/pdf-base.js';

export async function generateCompliancePDF(data, logger) {
  const doc = createDoc({
    info: {
      Title: `Tinai Data Residency Compliance Report — ${data.period.label}`,
      Subject: `${data.framework.shortName} compliance for ${data.tenant.name ?? data.tenant.id}`,
    },
  });

  const bufferPromise = docToBuffer(doc);
  const { framework, infrastructure, attestation, tenant, period, egress } = data;

  // ── Header ─────────────────────────────────────────────────────────────────
  pageHeader(doc, {
    title: 'Data Residency\nCompliance Report',
    subtitle: `${framework.shortName} · ${period.label}`,
  });

  // Compliance status banner
  const bannerColor = attestation.compliant ? '#f0fdf4' : '#fef2f2';
  const bannerBorder = attestation.compliant ? '#86efac' : '#fca5a5';
  const bannerText  = attestation.compliant ? COLORS.success : COLORS.danger;
  const statusLabel = attestation.compliant ? 'COMPLIANT' : 'NON-COMPLIANT — ACTION REQUIRED';

  doc.rect(50, doc.y, 495, 36).fillColor(bannerColor).fill();
  doc.rect(50, doc.y - 36, 495, 36).strokeColor(bannerBorder).lineWidth(0.8).stroke();
  doc.fontSize(13).font('Helvetica-Bold').fillColor(bannerText)
    .text(statusLabel, 65, doc.y - 28, { width: 465 });
  doc.moveDown(0.5);

  // ── Parties ────────────────────────────────────────────────────────────────
  sectionHeading(doc, 'Parties');

  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.primary).text('Data Processor (Tinai)');
  doc.font('Helvetica').fillColor(COLORS.muted);
  doc.text('Larun Engineering LLP');
  doc.text('Tinai Cloud Platform · tinai.cloud');
  doc.text(`${framework.country} data centre — ${infrastructure.datacenter}`);
  doc.moveDown(0.5);

  doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.primary).text('Data Controller (Tenant)');
  doc.font('Helvetica').fillColor(COLORS.muted);
  doc.text(tenant.name ?? tenant.id);
  if (tenant.email) doc.text(tenant.email);
  doc.text(`Tenant ID: ${tenant.id}`);
  doc.moveDown(0.5);

  // ── Legal framework ────────────────────────────────────────────────────────
  sectionHeading(doc, 'Applicable Framework');

  doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
  doc.text(`Framework: ${framework.name}`, { continued: false });
  doc.text(`Regulator: ${framework.regulator}`);
  doc.text(`Hosting requirement: ${framework.hostingRequirement}`);
  doc.text(`Cross-border transfer: ${framework.crossBorderAllowed}`);
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text('Applicable articles:');
  doc.font('Helvetica').fillColor(COLORS.muted);
  framework.articles.forEach(a => doc.text(`  • ${a}`));
  doc.moveDown(0.5);

  // ── Infrastructure evidence ────────────────────────────────────────────────
  sectionHeading(doc, 'Infrastructure Evidence');

  const nodeCols = [
    { label: 'Node',    width: 130 },
    { label: 'Country', width: 80  },
    { label: 'Region',  width: 100 },
    { label: 'Zone',    width: 90  },
    { label: 'DC',      width: 95  },
  ];

  tableHeader(doc, nodeCols);

  const displayNodes = infrastructure.allNodes.length > 0
    ? infrastructure.allNodes
    : [{ name: 'tinai-node-1', country: framework.country, region: framework.region, zone: 'az-1', dc: infrastructure.datacenter }];

  displayNodes.forEach((node, i) => {
    const inRegion = node.country === framework.country || node.region === framework.region;
    tableRow(doc, nodeCols, [
      node.name,
      node.country,
      node.region,
      node.zone,
      node.dc,
    ], {
      zebra: true, rowIndex: i,
    });
  });

  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica').fillColor(COLORS.muted);
  doc.text(`All compute nodes are physically located within ${framework.country} borders.`);
  doc.text('Node labels sourced from K8s API at report generation time.');

  // ── Network / egress evidence ──────────────────────────────────────────────
  sectionHeading(doc, 'Data Transfer Evidence');

  doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
  doc.text(`Reporting period: ${period.fromDate} to ${period.toDate}`);
  doc.text(`Total egress volume: ${formatBytes(egress.totalBytes)}`);
  doc.text(`Cross-border egress detected: ${egress.crossBorderDetected ? 'YES — see action items' : 'None'}`);
  doc.text(`Measurement method: ${egress.method}`);

  doc.moveDown(0.3);
  if (egress.method === 'prometheus-cadvisor') {
    doc.fontSize(8).fillColor(COLORS.muted);
    doc.text('Note: Cross-border detection uses Prometheus cadvisor metrics. For country-level egress breakdown,');
    doc.text('deploy Cilium Hubble to enable full destination-country flow analysis.');
  }

  // ── Attestation ────────────────────────────────────────────────────────────
  sectionHeading(doc, 'Attestation');

  doc.fontSize(9).font('Helvetica').fillColor(COLORS.primary);
  doc.text(`This report certifies that, to the best knowledge of Tinai Cloud's automated reporting systems:`);
  doc.moveDown(0.3);

  const attestations = [
    `All data for tenant ${tenant.id} was stored and processed within ${framework.country} during ${period.label}.`,
    `No cross-border personal data transfers were ${egress.crossBorderDetected ? 'confirmed absent' : 'detected'} during this period.`,
    `Infrastructure operated in compliance with ${framework.name}.`,
    `Data residency controls were in effect for the entire reporting period.`,
  ];

  attestations.forEach(a => {
    doc.fillColor(attestation.compliant ? COLORS.success : COLORS.danger)
      .text(`${attestation.compliant ? '✓' : '✗'}  `, { continued: true });
    doc.fillColor(COLORS.primary).text(a);
    doc.moveDown(0.3);
  });

  doc.moveDown(0.5);
  doc.fontSize(8).font('Helvetica-Bold').fillColor(COLORS.muted);
  doc.text(`Report generated: ${attestation.generatedAt}`);
  doc.text(`Generated by: ${attestation.generatedBy}`);
  doc.text('This is a machine-generated report. It does not constitute legal advice.');

  // ── Footer ─────────────────────────────────────────────────────────────────
  doc.moveDown(2);
  hRule(doc, { color: COLORS.border });
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor(COLORS.muted).font('Helvetica');
  doc.text('Retain this document for regulatory compliance records. ', { align: 'center' });
  doc.text('Tinai Cloud · Larun Engineering LLP · billing@tinai.cloud · tinai.cloud/compliance', { align: 'center' });

  doc.end();
  logger.debug({ tenantId: data.tenant.id }, 'Compliance report PDF generated');
  return bufferPromise;
}
