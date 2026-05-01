// cert-renewal/index.js
// Monitors all cert-manager Certificate resources cluster-wide.
// cert-manager handles actual renewal automatically (30 days before expiry).
// This service adds:
//   - Expiry alerts when cert is < 14 days from expiry AND renewal hasn't triggered
//   - Slack/email alert on renewal failure (CertificateNotReady condition)
//   - Daily digest of all cert statuses to ops email
//   - Publishes cert health to NATS for dashboard
//
// CronJob: daily at 05:00
// Also run after any deployment to catch new certs.

import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { getCertificates } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const ALERT_THRESHOLD_DAYS = 14;  // alert if expiry < 14 days
const CRITICAL_THRESHOLD_DAYS = 3; // critical alert < 3 days

function parseCertStatus(cert) {
  const name      = cert.metadata.name;
  const namespace = cert.metadata.namespace;
  const notAfter  = cert.status?.notAfter;
  const conditions = cert.status?.conditions ?? [];

  const readyCond  = conditions.find(c => c.type === 'Ready');
  const isReady    = readyCond?.status === 'True';
  const failReason = readyCond?.reason;
  const failMsg    = readyCond?.message;

  const expiresAt   = notAfter ? new Date(notAfter) : null;
  const daysUntilExpiry = expiresAt
    ? Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const status =
    !isReady                               ? 'not-ready'   :
    daysUntilExpiry === null               ? 'unknown'     :
    daysUntilExpiry < CRITICAL_THRESHOLD_DAYS ? 'critical' :
    daysUntilExpiry < ALERT_THRESHOLD_DAYS    ? 'warning'  :
    'ok';

  return { name, namespace, isReady, expiresAt, daysUntilExpiry, status, failReason, failMsg,
    dnsNames: cert.spec?.dnsNames ?? [], secretName: cert.spec?.secretName ?? '' };
}

function buildCertAlertEmail(certs) {
  const critical = certs.filter(c => c.status === 'critical');
  const warnings = certs.filter(c => c.status === 'warning');
  const notReady = certs.filter(c => c.status === 'not-ready');

  const rows = [...critical, ...warnings, ...notReady].map(c => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">${c.namespace}/${c.name}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5">${c.dnsNames.join(', ')}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e5e5;color:${c.status === 'critical' ? '#dc2626' : c.status === 'warning' ? '#d97706' : '#7c3aed'}">
        ${c.status === 'not-ready' ? `Not ready: ${c.failReason ?? 'unknown'}` : `${c.daysUntilExpiry}d remaining`}
      </td>
    </tr>`).join('');

  return {
    subject: `⚠ Cert alert: ${critical.length} critical, ${warnings.length} warning, ${notReady.length} not-ready · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:28px">
  <p style="font-size:18px;font-weight:600;color:#dc2626;margin:0 0 16px">TLS Certificate Alert</p>
  <p style="color:#444;font-size:14px;margin:0 0 16px">The following certificates require attention:</p>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f8fafc">
      <th style="padding:8px;text-align:left;color:#64748b">Certificate</th>
      <th style="padding:8px;text-align:left;color:#64748b">Domains</th>
      <th style="padding:8px;text-align:left;color:#64748b">Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:20px">
    cert-manager renews automatically 30 days before expiry.<br>
    If renewal failed, check: <code>kubectl describe certificate -n &lt;ns&gt; &lt;name&gt;</code>
  </p>
</div></body></html>`,
  };
}

function buildDailyDigestEmail(certs) {
  const ok       = certs.filter(c => c.status === 'ok').length;
  const warning  = certs.filter(c => c.status === 'warning').length;
  const critical = certs.filter(c => c.status === 'critical').length;
  const notReady = certs.filter(c => c.status === 'not-ready').length;

  const rows = certs
    .sort((a, b) => (a.daysUntilExpiry ?? 999) - (b.daysUntilExpiry ?? 999))
    .map(c => `<tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${c.namespace}/${c.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${c.dnsNames[0] ?? '—'}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:${
        c.status === 'critical' ? '#dc2626' : c.status === 'warning' ? '#d97706' : c.status === 'not-ready' ? '#7c3aed' : '#16a34a'
      }">${c.daysUntilExpiry !== null ? `${c.daysUntilExpiry}d` : c.status}</td>
    </tr>`).join('');

  return {
    subject: `Cert digest: ${ok} ok · ${warning} warn · ${critical} crit · ${notReady} not-ready — Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">Daily TLS Certificate Status</p>
  <div style="display:flex;gap:12px;margin-bottom:20px">
    ${[['OK',ok,'#16a34a'],['Warning',warning,'#d97706'],['Critical',critical,'#dc2626'],['Not Ready',notReady,'#7c3aed']]
      .map(([l,v,c])=>`<div style="flex:1;background:#f8fafc;border-radius:6px;padding:10px 14px;border:1px solid #e2e8f0">
        <p style="color:#64748b;font-size:11px;margin:0">${l}</p>
        <p style="color:${c};font-size:20px;font-weight:700;margin:2px 0 0">${v}</p>
      </div>`).join('')}
  </div>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f8fafc">
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Certificate</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Domain</th>
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Expires in</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div></body></html>`,
  };
}

async function main() {
  logger.info('Cert renewal check starting');
  const natsClient = await connectNATS(logger);

  const rawCerts = await getCertificates();
  const certs    = rawCerts.map(parseCertStatus);

  logger.info({ total: certs.length }, 'Certificates found');

  const needsAlert = certs.filter(c => ['critical','warning','not-ready'].includes(c.status));
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  // Alert email if any cert needs attention
  if (needsAlert.length > 0) {
    logger.warn({ count: needsAlert.length }, 'Certs need attention — sending alert');
    await sendEmail({ to: adminEmail, ...buildCertAlertEmail(certs) }, logger);
  }

  // Daily digest always (gives you full picture)
  const isDailyDigest = process.env.RUN_MODE !== 'alert-only';
  if (isDailyDigest) {
    await sendEmail({ to: adminEmail, ...buildDailyDigestEmail(certs) }, logger);
  }

  // Publish cert health to NATS
  publish(natsClient, 'tinai.maintenance.certs', {
    timestamp: new Date().toISOString(),
    total: certs.length,
    ok: certs.filter(c => c.status === 'ok').length,
    warning: certs.filter(c => c.status === 'warning').length,
    critical: certs.filter(c => c.status === 'critical').length,
    notReady: certs.filter(c => c.status === 'not-ready').length,
    certs: certs.map(c => ({ name: c.name, namespace: c.namespace, status: c.status, daysUntilExpiry: c.daysUntilExpiry })),
  }, logger);

  publishAudit(natsClient, { event: 'cert.check', total: certs.length, needsAlert: needsAlert.length }, logger);

  const hasCritical = certs.some(c => c.status === 'critical' || c.status === 'not-ready');
  if (natsClient) await natsClient.drain();
  process.exit(hasCritical ? 1 : 0); // non-zero exit triggers K8s job failure alert
}

main().catch(err => { logger.fatal(err); process.exit(1); });
