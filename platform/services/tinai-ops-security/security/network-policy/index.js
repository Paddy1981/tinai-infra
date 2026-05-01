// security/network-policy/index.js
// Service: Network Policy Enforcer
//
// CronJob: daily — validates all tenant namespaces have required NetworkPolicies.
// If a namespace is missing a policy (e.g. created manually), applies it.
// Works alongside Kyverno which enforces at admission time.
// This is the drift-detection + remediation layer.

import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { listNamespaces, k8sGet, k8sPost } from '../../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const TENANT_PREFIX = process.env.TENANT_NS_PREFIX ?? 'tenant-';
const ADMIN_EMAIL   = process.env.ADMIN_EMAIL      ?? config.stalwart.fromAddr;

// Required NetworkPolicy names per tenant namespace
const REQUIRED_POLICIES = ['tenant-isolation'];

// ── Check + remediate one namespace ──────────────────────────────────────────
async function enforceNamespacePolicies(namespace) {
  const result = { namespace, missing: [], remediated: [], errors: [] };

  let existing;
  try {
    const data = await k8sGet(`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`);
    existing = new Set((data.items ?? []).map(p => p.metadata.name));
  } catch (err) {
    result.errors.push(`Could not list policies: ${err.message}`);
    return result;
  }

  for (const required of REQUIRED_POLICIES) {
    if (!existing.has(required)) {
      result.missing.push(required);
      logger.warn({ namespace, policy: required }, 'Required NetworkPolicy missing — applying');

      try {
        await k8sPost(
          `/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`,
          buildTenantIsolationPolicy(namespace)
        );
        result.remediated.push(required);
        logger.info({ namespace, policy: required }, 'NetworkPolicy applied');
      } catch (err) {
        result.errors.push(`Failed to apply ${required}: ${err.message}`);
      }
    }
  }

  return result;
}

function buildTenantIsolationPolicy(namespace) {
  return {
    apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
    metadata: {
      name: 'tenant-isolation', namespace,
      annotations: {
        'tinai.cloud/applied-by': 'network-policy-enforcer',
        'tinai.cloud/applied-at': new Date().toISOString(),
      },
    },
    spec: {
      podSelector: {},
      policyTypes: ['Ingress', 'Egress'],
      ingress: [
        { from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'traefik' } } }] },
        { from: [{ podSelector: {} }] },
      ],
      egress: [
        { ports: [{ port: 53, protocol: 'UDP' }, { port: 53, protocol: 'TCP' }] },
        { ports: [{ port: 443, protocol: 'TCP' }] },
        { ports: [{ port: 80,  protocol: 'TCP' }] },
        { to: [{ podSelector: {} }] },
      ],
    },
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('Network policy enforcement check starting');
  const natsClient = await connectNATS(logger);

  const namespaces = await listNamespaces();
  const tenantNS   = namespaces
    .map(n => n.metadata.name)
    .filter(n => n.startsWith(TENANT_PREFIX));

  logger.info({ count: tenantNS.length }, 'Tenant namespaces to check');

  const results = await Promise.all(tenantNS.map(enforceNamespacePolicies));

  const violations   = results.filter(r => r.missing.length > 0);
  const remediated   = results.filter(r => r.remediated.length > 0);
  const errored      = results.filter(r => r.errors.length > 0);
  const fullyClean   = results.filter(r => r.missing.length === 0 && r.errors.length === 0);

  logger.info({
    total: tenantNS.length, violations: violations.length,
    remediated: remediated.length, clean: fullyClean.length,
  }, 'Network policy check complete');

  if (violations.length > 0 || errored.length > 0) {
    await sendEmail({
      to: ADMIN_EMAIL,
      subject: `Network policy: ${violations.length} violations, ${remediated.length} auto-fixed · Tinai`,
      html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fbbf24;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">Network Policy Enforcement Report</p>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:20px">
    <div style="background:#fef2f2;border-radius:6px;padding:10px;text-align:center">
      <p style="font-size:20px;font-weight:700;color:#dc2626;margin:0">${violations.length}</p>
      <p style="font-size:11px;color:#64748b;margin:2px 0 0">VIOLATIONS</p>
    </div>
    <div style="background:#f0fdf4;border-radius:6px;padding:10px;text-align:center">
      <p style="font-size:20px;font-weight:700;color:#16a34a;margin:0">${remediated.length}</p>
      <p style="font-size:11px;color:#64748b;margin:2px 0 0">AUTO-FIXED</p>
    </div>
    <div style="background:#f8fafc;border-radius:6px;padding:10px;text-align:center">
      <p style="font-size:20px;font-weight:700;color:#475569;margin:0">${fullyClean.length}</p>
      <p style="font-size:11px;color:#64748b;margin:2px 0 0">CLEAN</p>
    </div>
  </div>
  ${violations.length > 0 ? `<p style="font-weight:600;font-size:13px;margin:0 0 8px">Namespaces with violations (auto-remediated):</p>
  <ul style="font-size:13px;color:#444;margin:0 0 16px">${violations.map(r=>`<li>${r.namespace}: missing ${r.missing.join(', ')} → ${r.remediated.join(', ')} applied</li>`).join('')}</ul>` : ''}
  ${errored.length > 0 ? `<p style="font-weight:600;font-size:13px;color:#dc2626;margin:0 0 8px">Errors (manual review required):</p>
  <ul style="font-size:13px;color:#dc2626;margin:0 0 16px">${errored.map(r=>`<li>${r.namespace}: ${r.errors.join('; ')}</li>`).join('')}</ul>` : ''}
</div></body></html>`,
    }, logger);
  }

  publish(natsClient, 'tinai.security.network-policy', {
    timestamp: new Date().toISOString(),
    total: tenantNS.length, violations: violations.length,
    remediated: remediated.length, clean: fullyClean.length,
  }, logger);
  publishAudit(natsClient, { event: 'security.network-policy.check', violations: violations.length, remediated: remediated.length }, logger);

  if (natsClient) await natsClient.drain();
  process.exit(errored.length > 0 ? 1 : 0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
