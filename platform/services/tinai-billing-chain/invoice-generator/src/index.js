// invoice-generator/src/index.js
// Service: Invoice Generator
//
// Flow:
//   Lago webhook (invoice.finalized)
//     → verify HMAC signature
//     → fetch full invoice from Lago API
//     → generate PDF (GST-compliant for India, VAT-exempt for Qatar/UAE)
//     → email to tenant with PDF attachment
//     → publish tinai.billing.invoice.finalized to NATS
//
// Runs as a Deployment (always-on webhook receiver).
// Lago must be configured to POST to: https://api.tinai.cloud/webhooks/lago

import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import pino from 'pino';
import { config, validateRequired } from '../../shared/config.js';
import { connectNATS, publish, publishToDLQ, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { generateInvoicePDF } from './pdf-generator.js';
import { buildInvoiceEmail } from './email-templates.js';
import { fetchInvoiceFromLago } from './lago-client.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Lago webhook signature verification ──────────────────────────────────────
function verifyLagoSignature(rawBody, signatureHeader) {
  if (!config.lago.webhookSecret) return false; // reject if not configured
  const [, sig] = signatureHeader?.split('=') ?? [];
  if (!sig) return false;
  const expected = createHmac('sha256', config.lago.webhookSecret)
    .update(rawBody)
    .digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Main webhook handler ──────────────────────────────────────────────────────
async function handleInvoiceFinalized(payload, natsClient) {
  const { invoice } = payload;
  const invoiceId = invoice?.lago_id ?? invoice?.id;

  logger.info({ invoiceId }, 'Processing finalized invoice');

  // 1. Fetch full invoice details from Lago (webhook payload is minimal)
  const fullInvoice = await fetchInvoiceFromLago(invoiceId, logger);

  // 2. Determine tax regime based on tenant country
  const tenantCountry = fullInvoice.customer?.billing_configuration?.country ?? 'IN';
  const taxConfig = buildTaxConfig(tenantCountry);

  // 3. Generate PDF
  const pdfBuffer = await generateInvoicePDF(fullInvoice, taxConfig, logger);

  // 4. Send email with PDF attachment
  const emailData = buildInvoiceEmail(fullInvoice, taxConfig);
  await sendEmail({
    to: fullInvoice.customer?.email,
    subject: emailData.subject,
    html: emailData.html,
    attachments: [{
      filename: `tinai-invoice-${fullInvoice.number ?? invoiceId}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  }, logger);

  // 5. Publish to NATS for downstream consumers (MRR dashboard, compliance report)
  publish(natsClient, config.nats.subjects.invoiceFinalized, {
    invoiceId,
    invoiceNumber: fullInvoice.number,
    tenantId: fullInvoice.customer?.external_id,
    amount: fullInvoice.total_amount_cents / 100,
    currency: fullInvoice.currency,
    country: tenantCountry,
    issuedAt: new Date().toISOString(),
  }, logger);

  publishAudit(natsClient, {
    event: 'invoice.generated',
    invoiceId,
    tenantId: fullInvoice.customer?.external_id,
    amount: fullInvoice.total_amount_cents / 100,
  }, logger);

  logger.info({ invoiceId, tenant: fullInvoice.customer?.external_id }, 'Invoice processed');
}

function buildTaxConfig(country) {
  if (country === 'IN') {
    return {
      type: 'GST',
      rate: config.gst.gstRate,
      label: `GST @ ${config.gst.gstRate * 100}%`,
      gstin: config.gst.gstin,
      hsnCode: config.gst.hsnCode,
      showTaxBreakdown: true, // CGST + SGST or IGST
    };
  }
  // Qatar, UAE — zero-rated export of services
  return {
    type: 'VAT_EXEMPT',
    rate: 0,
    label: 'VAT exempt (export of services)',
    showTaxBreakdown: false,
  };
}

// ── Fastify server ────────────────────────────────────────────────────────────
async function main() {
  validateRequired(['lago.apiKey', 'lago.webhookSecret']);

  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });

  // Raw body needed for HMAC verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body;
    try { done(null, JSON.parse(body.toString())); }
    catch (e) { done(e); }
  });

  // ── Lago webhook endpoint ─────────────────────────────────────────────────
  app.post('/webhooks/lago', async (req, reply) => {
    const sig = req.headers['x-lago-signature'];
    if (!verifyLagoSignature(req.rawBody, sig)) {
      logger.warn('Invalid Lago webhook signature');
      return reply.code(401).send({ error: 'invalid signature' });
    }

    const { webhook_type, object_type } = req.body;
    logger.debug({ webhook_type, object_type }, 'Lago webhook received');

    // Respond immediately — process async to avoid Lago timeout
    reply.code(200).send({ received: true });

    // Handle async
    if (webhook_type === 'invoice.created' || webhook_type === 'invoice.finalized') {
      handleInvoiceFinalized(req.body, natsClient).catch(async err => {
        logger.error({ err: err.message }, 'Invoice processing failed');
        await publishToDLQ(natsClient, req.body, err, 'invoice-generator', logger);
      });
    }
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/health', async () => ({ status: 'ok', service: 'invoice-generator' }));

  await app.listen({ port: config.service.port, host: '0.0.0.0' });
  logger.info({ port: config.service.port }, 'Invoice generator listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
