// shared/config.js
// Shared configuration for all billing chain services.
// Each service imports only what it needs.

import crypto from 'crypto';

export const config = {
  nats: {
    servers: (process.env.NATS_SERVERS ?? 'nats://nats.core.svc.cluster.local:4222').split(','),
    subjects: {
      // Published by Lago webhook handler when invoice is finalized
      invoiceFinalized:   'tinai.billing.invoice.finalized',
      // Published when payment succeeds
      paymentSuccess:     'tinai.billing.payment.success',
      // Published when payment fails (after all retries)
      paymentFailed:      'tinai.billing.payment.failed',
      // Published when tenant trial expires
      trialExpired:       'tinai.tenant.trial.expired',
      // Published when tenant upgrades/downgrades plan
      planChanged:        'tinai.tenant.plan.changed',
      // Published when namespace is suspended
      namespaceSuspended: 'tinai.tenant.namespace.suspended',
      // DLQ for any billing chain failure
      dlq:                'tinai.billing.dlq',
      // Audit trail for compliance
      audit:              'tinai.billing.audit',
    },
  },

  lago: {
    url:    process.env.LAGO_API_URL    ?? 'http://lago-api.billing.svc.cluster.local:3000',
    apiKey: process.env.LAGO_API_KEY    ?? '',
    webhookSecret: process.env.LAGO_WEBHOOK_SECRET ?? '',
  },

  razorpay: {
    keyId:     process.env.RAZORPAY_KEY_ID     ?? '',
    keySecret: process.env.RAZORPAY_KEY_SECRET ?? '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? '',
  },

  stripe: {
    secretKey:     process.env.STRIPE_SECRET_KEY     ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },

  stalwart: {
    // Stalwart SMTP submission endpoint (self-hosted mail server)
    smtpHost: process.env.SMTP_HOST     ?? 'stalwart.core.svc.cluster.local',
    smtpPort: parseInt(process.env.SMTP_PORT ?? '587', 10),
    smtpUser: process.env.SMTP_USER     ?? '',
    smtpPass: process.env.SMTP_PASS     ?? '',
    fromAddr: process.env.EMAIL_FROM    ?? 'billing@tinai.cloud',
    fromName: process.env.EMAIL_FROM_NAME ?? 'Tinai Billing',
  },

  prometheus: {
    url: process.env.PROMETHEUS_URL ?? 'http://prometheus-server.monitoring.svc.cluster.local:9090',
  },

  postgres: {
    url: process.env.DATABASE_URL ?? 'postgresql://tinai:password@postgres.core.svc.cluster.local:5432/tinai',
  },

  k8s: {
    // In-cluster config — ServiceAccount token mounted automatically
    inCluster: process.env.K8S_IN_CLUSTER !== 'false',
    namespace:  process.env.K8S_NAMESPACE  ?? 'billing',
    tenantNsPrefix: process.env.TENANT_NS_PREFIX ?? 'tenant-',
  },

  gst: {
    // Your GSTIN for tax invoice generation
    gstin:   process.env.COMPANY_GSTIN    ?? '',
    hsnCode: process.env.GST_HSN_CODE     ?? '998313', // IT services HSN
    gstRate: parseFloat(process.env.GST_RATE ?? '0.18'), // 18%
    legalName: process.env.COMPANY_LEGAL_NAME ?? 'Larun Engineering LLP',
    address:   process.env.COMPANY_ADDRESS    ?? 'Doha, Qatar',
  },

  service: {
    logLevel: process.env.LOG_LEVEL ?? 'info',
    port:     parseInt(process.env.PORT ?? '3101', 10),
    adminToken: process.env.ADMIN_TOKEN ?? '',
  },
};

export function validateRequired(keys) {
  const missing = keys.filter(k => {
    const parts = k.split('.');
    let val = config;
    for (const p of parts) val = val?.[p];
    return !val;
  });
  if (missing.length) throw new Error(`Missing required config: ${missing.join(', ')}`);
}

const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function validateTenantId(tenantId) {
  if (typeof tenantId !== 'string' || !TENANT_ID_RE.test(tenantId)) {
    throw new Error(`Invalid tenantId: ${String(tenantId).slice(0, 80)}`);
  }
  return tenantId;
}

/**
 * Timing-safe comparison for bearer/admin tokens.
 * Handles length mismatch by hashing both sides.
 */
export function timingSafeTokenCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}
