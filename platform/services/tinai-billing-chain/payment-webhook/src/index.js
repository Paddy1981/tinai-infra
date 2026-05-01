// payment-webhook/src/index.js
// Service: Payment Webhook Handler
//
// Handles payment events from both Razorpay (India/INR tenants)
// and Stripe (Qatar/UAE/USD tenants).
//
// Flow:
//   Razorpay webhook → verify signature → handle event → NATS
//   Stripe webhook   → verify signature → handle event → NATS
//
// On payment.success: publish NATS event → send receipt email
// On payment.failed:  publish NATS event → send failure email → update retry state in DB
// On payment.failure_after_retries: suspend namespace via K8s API

import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import pino from 'pino';
import { config, validateRequired } from '../../shared/config.js';
import { connectNATS, publish, publishToDLQ, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { suspendNamespace, tenantToNamespace } from '../../shared/k8s-namespace.js';
import {
  buildPaymentSuccessEmail,
  buildPaymentFailedEmail,
  buildSuspensionWarningEmail,
} from '../../invoice-generator/src/email-templates.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Retry state (in-memory; use Redis/Postgres in production) ─────────────────
// Tracks consecutive payment failures per tenant to drive escalation.
const retryState = new Map(); // tenantId → { attempts, lastFailedAt }
const MAX_RETRY_ATTEMPTS = 3;
const SUSPEND_AFTER_DAYS = 3;

// ── Idempotency — prevent duplicate event processing ─────────────────────────
const processedEvents = new Map(); // eventId → timestamp
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function isDuplicate(eventId) {
  if (!eventId) return false;
  const now = Date.now();
  // Prune stale entries periodically
  if (processedEvents.size > 10000) {
    for (const [id, ts] of processedEvents) {
      if (now - ts > DEDUP_WINDOW_MS) processedEvents.delete(id);
    }
  }
  if (processedEvents.has(eventId)) return true;
  processedEvents.set(eventId, now);
  return false;
}

// ── Razorpay signature verification ──────────────────────────────────────────
function verifyRazorpay(rawBody, signature) {
  const expected = createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Stripe signature verification ─────────────────────────────────────────────
const STRIPE_TIMESTAMP_TOLERANCE_SECS = 300; // 5 minutes

function verifyStripe(rawBody, signatureHeader) {
  if (!signatureHeader) return false;
  // Stripe uses: t=timestamp,v1=sig format
  const parts = Object.fromEntries(
    signatureHeader.split(',').map(p => p.split('='))
  );
  if (!parts.t || !parts.v1) return false;

  // Reject replayed webhooks older than 5 minutes
  const timestamp = parseInt(parts.t, 10);
  if (isNaN(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > STRIPE_TIMESTAMP_TOLERANCE_SECS) {
    return false;
  }

  const payload = `${parts.t}.${rawBody}`;
  const expected = createHmac('sha256', config.stripe.webhookSecret)
    .update(payload)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

// ── Event handlers ────────────────────────────────────────────────────────────

async function handlePaymentSuccess(tenantId, amount, currency, invoiceNumber, natsClient) {
  logger.info({ tenantId, amount, currency }, 'Payment success');

  // Clear retry state
  retryState.delete(tenantId);

  // Publish to NATS
  publish(natsClient, config.nats.subjects.paymentSuccess, {
    tenantId, amount, currency, invoiceNumber,
    timestamp: new Date().toISOString(),
  }, logger);

  publishAudit(natsClient, {
    event: 'payment.success',
    tenantId, amount, currency, invoiceNumber,
  }, logger);

  // Send receipt email
  // In production: fetch tenant email from your PostgreSQL tenants table
  const tenantEmail = await fetchTenantEmail(tenantId);
  if (tenantEmail) {
    const email = buildPaymentSuccessEmail(tenantId, amount, currency, invoiceNumber);
    await sendEmail({ to: tenantEmail, ...email }, logger);
  }
}

async function handlePaymentFailed(tenantId, amount, currency, invoiceNumber, natsClient) {
  // Increment retry counter
  const state = retryState.get(tenantId) ?? { attempts: 0, firstFailedAt: Date.now() };
  state.attempts += 1;
  state.lastFailedAt = Date.now();
  retryState.set(tenantId, state);

  const daysSinceFirst = (Date.now() - state.firstFailedAt) / (1000 * 60 * 60 * 24);

  logger.warn({ tenantId, attempts: state.attempts, daysSinceFirst: daysSinceFirst.toFixed(1) }, 'Payment failed');

  publish(natsClient, config.nats.subjects.paymentFailed, {
    tenantId, amount, currency, invoiceNumber,
    attempt: state.attempts,
    daysSinceFirst: Math.round(daysSinceFirst),
    timestamp: new Date().toISOString(),
  }, logger);

  const tenantEmail = await fetchTenantEmail(tenantId);
  const daysUntilSuspend = Math.max(0, SUSPEND_AFTER_DAYS - Math.floor(daysSinceFirst));

  if (tenantEmail) {
    if (daysUntilSuspend <= 1) {
      // Send suspension warning instead of generic failure email
      const email = buildSuspensionWarningEmail(tenantId, daysUntilSuspend);
      await sendEmail({ to: tenantEmail, ...email }, logger);
    } else {
      const email = buildPaymentFailedEmail(tenantId, amount, currency, state.attempts, MAX_RETRY_ATTEMPTS, daysUntilSuspend);
      await sendEmail({ to: tenantEmail, ...email }, logger);
    }
  }

  // Suspend namespace if past threshold
  if (daysSinceFirst >= SUSPEND_AFTER_DAYS) {
    logger.warn({ tenantId, daysSinceFirst }, 'Suspending namespace due to payment failure');
    const namespace = tenantToNamespace(tenantId, config.k8s.tenantNsPrefix);
    try {
      await suspendNamespace(namespace, logger);
      publish(natsClient, config.nats.subjects.namespaceSuspended, {
        tenantId, namespace, reason: 'payment_failure',
        timestamp: new Date().toISOString(),
      }, logger);
    } catch (err) {
      logger.error({ err: err.message, namespace }, 'Namespace suspension failed');
      await publishToDLQ(natsClient, { tenantId, action: 'suspend' }, err, 'payment-webhook', logger);
    }
  }
}

// ── Razorpay event mapper ─────────────────────────────────────────────────────
async function handleRazorpayEvent(event, natsClient) {
  const { event: eventType, payload } = event;

  // Razorpay subscription payment success
  if (eventType === 'subscription.charged') {
    const sub = payload.subscription?.entity;
    const payment = payload.payment?.entity;
    await handlePaymentSuccess(
      sub?.notes?.tenant_id ?? sub?.id,
      (payment?.amount ?? 0) / 100,
      payment?.currency ?? 'INR',
      payment?.invoice_id ?? payment?.id,
      natsClient
    );
    return;
  }

  // Razorpay payment failed
  if (eventType === 'payment.failed') {
    const payment = payload.payment?.entity;
    await handlePaymentFailed(
      payment?.notes?.tenant_id ?? payment?.subscription_id,
      (payment?.amount ?? 0) / 100,
      payment?.currency ?? 'INR',
      payment?.invoice_id ?? payment?.id,
      natsClient
    );
    return;
  }

  logger.debug({ eventType }, 'Unhandled Razorpay event — ignored');
}

// ── Stripe event mapper ───────────────────────────────────────────────────────
async function handleStripeEvent(event, natsClient) {
  const { type, data } = event;

  if (type === 'invoice.payment_succeeded') {
    const inv = data.object;
    await handlePaymentSuccess(
      inv.customer_email ?? inv.customer,
      (inv.amount_paid ?? 0) / 100,
      inv.currency?.toUpperCase() ?? 'USD',
      inv.number ?? inv.id,
      natsClient
    );
    return;
  }

  if (type === 'invoice.payment_failed') {
    const inv = data.object;
    await handlePaymentFailed(
      inv.customer_email ?? inv.customer,
      (inv.amount_due ?? 0) / 100,
      inv.currency?.toUpperCase() ?? 'USD',
      inv.number ?? inv.id,
      natsClient
    );
    return;
  }

  logger.debug({ type }, 'Unhandled Stripe event — ignored');
}

// ── Stub: fetch tenant email from PostgreSQL ──────────────────────────────────
// Replace with actual DB query using your postgres client
async function fetchTenantEmail(tenantId) {
  // TODO: implement with postgres.js
  // const result = await db.query('SELECT email FROM tenants WHERE external_id = $1', [tenantId]);
  // return result.rows[0]?.email;
  logger.debug({ tenantId }, 'fetchTenantEmail: stub — implement DB lookup');
  return null;
}

// ── Fastify server ────────────────────────────────────────────────────────────
async function main() {
  validateRequired(['razorpay.keySecret', 'razorpay.webhookSecret']);

  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });

  // Raw body parser for HMAC verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body.toString();
    try { done(null, JSON.parse(req.rawBody)); }
    catch (e) { done(e); }
  });

  // ── Razorpay webhook ──────────────────────────────────────────────────────
  app.post('/webhooks/razorpay', async (req, reply) => {
    const sig = req.headers['x-razorpay-signature'];
    if (!verifyRazorpay(req.rawBody, sig)) {
      logger.warn('Invalid Razorpay signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    // Idempotency: reject duplicate events
    const rzpEventId = req.body?.event_id ?? req.headers['x-razorpay-event-id'];
    if (isDuplicate(rzpEventId)) {
      logger.debug({ eventId: rzpEventId }, 'Duplicate Razorpay event — skipping');
      return reply.code(200).send({ received: true, duplicate: true });
    }
    reply.code(200).send({ received: true });
    handleRazorpayEvent(req.body, natsClient).catch(async err => {
      logger.error({ err: err.message }, 'Razorpay handler failed');
      await publishToDLQ(natsClient, req.body, err, 'payment-webhook/razorpay', logger);
    });
  });

  // ── Stripe webhook ────────────────────────────────────────────────────────
  app.post('/webhooks/stripe', async (req, reply) => {
    const sig = req.headers['stripe-signature'];
    if (!verifyStripe(req.rawBody, sig)) {
      logger.warn('Invalid Stripe signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }
    // Idempotency: reject duplicate events
    const stripeEventId = req.body?.id;
    if (isDuplicate(stripeEventId)) {
      logger.debug({ eventId: stripeEventId }, 'Duplicate Stripe event — skipping');
      return reply.code(200).send({ received: true, duplicate: true });
    }
    reply.code(200).send({ received: true });
    handleStripeEvent(req.body, natsClient).catch(async err => {
      logger.error({ err: err.message }, 'Stripe handler failed');
      await publishToDLQ(natsClient, req.body, err, 'payment-webhook/stripe', logger);
    });
  });

  app.get('/health', async () => ({ status: 'ok', service: 'payment-webhook' }));

  await app.listen({ port: config.service.port, host: '0.0.0.0' });
  logger.info({ port: config.service.port }, 'Payment webhook handler listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
