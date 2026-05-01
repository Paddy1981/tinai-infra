// invoice-generator/src/email-templates.js
// HTML email templates for billing notifications.
// Kept intentionally simple — no external CSS framework needed.

/**
 * Build invoice email content.
 */
export function buildInvoiceEmail(invoice, taxConfig) {
  const customer = invoice.customer ?? {};
  const amount = ((invoice.total_amount_cents ?? 0) / 100).toFixed(2);
  const currency = invoice.currency ?? 'INR';
  const symbol = currency === 'INR' ? '₹' : '$';
  const name = customer.name ?? customer.external_id ?? 'there';

  return {
    subject: `Your Tinai invoice ${invoice.number} — ${symbol}${amount}`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;margin:0;padding:32px 16px">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;border:1px solid #e5e5e5">
    
    <div style="background:#0f172a;padding:24px 32px">
      <p style="color:#fff;font-size:20px;font-weight:600;margin:0">Tinai</p>
      <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">Sovereign Cloud Platform</p>
    </div>

    <div style="padding:32px">
      <p style="color:#111;font-size:16px;margin:0 0 8px">Hi ${name},</p>
      <p style="color:#444;font-size:14px;line-height:1.6;margin:0 0 24px">
        Your invoice for this billing period is ready. Please find the PDF attached.
      </p>

      <div style="background:#f8fafc;border-radius:6px;padding:20px;margin-bottom:24px;border:1px solid #e2e8f0">
        <table style="width:100%;font-size:14px;border-collapse:collapse">
          <tr>
            <td style="color:#64748b;padding:4px 0">Invoice number</td>
            <td style="text-align:right;color:#111;font-weight:500">${invoice.number ?? invoice.lago_id}</td>
          </tr>
          <tr>
            <td style="color:#64748b;padding:4px 0">Amount due</td>
            <td style="text-align:right;color:#111;font-size:18px;font-weight:700">${symbol}${amount}</td>
          </tr>
          <tr>
            <td style="color:#64748b;padding:4px 0">Currency</td>
            <td style="text-align:right;color:#111">${currency}${taxConfig.type === 'GST' ? ' + GST' : ''}</td>
          </tr>
          <tr>
            <td style="color:#64748b;padding:4px 0">Due date</td>
            <td style="text-align:right;color:#111">${formatDate(invoice.payment_due_date)}</td>
          </tr>
        </table>
      </div>

      <p style="color:#444;font-size:13px;line-height:1.6;margin:0 0 8px">
        Payment will be automatically collected from your registered payment method.
        If payment fails, you will receive a separate notification.
      </p>

      <p style="color:#444;font-size:13px;line-height:1.6;margin:0 0 24px">
        Questions? Reply to this email or visit 
        <a href="https://tinai.cloud/billing" style="color:#0ea5e9">tinai.cloud/billing</a>.
      </p>
    </div>

    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e5e5e5">
      <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center">
        Tinai Cloud · billing@tinai.cloud · tinai.cloud<br>
        ${taxConfig.type === 'GST' ? `GSTIN: ${taxConfig.gstin} · HSN/SAC: ${taxConfig.hsnCode}` : 'VAT exempt — export of services'}
      </p>
    </div>

  </div>
</body>
</html>`,
  };
}

/**
 * Payment success email.
 */
export function buildPaymentSuccessEmail(tenant, amount, currency, invoiceNumber) {
  const symbol = currency === 'INR' ? '₹' : '$';
  return {
    subject: `Payment received — ${symbol}${amount} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px">
  <p style="font-size:32px;margin:0 0 16px">✓</p>
  <p style="font-size:18px;font-weight:600;margin:0 0 8px">Payment received</p>
  <p style="color:#444;font-size:14px">We've received your payment of <strong>${symbol}${amount} ${currency}</strong> for invoice ${invoiceNumber}. Thank you!</p>
  <p style="color:#444;font-size:14px">Your services remain active. <a href="https://tinai.cloud/billing" style="color:#0ea5e9">View billing history</a></p>
  <p style="color:#94a3b8;font-size:12px;margin-top:32px">Tinai Cloud · billing@tinai.cloud</p>
</div></body></html>`,
  };
}

/**
 * Payment failed email.
 */
export function buildPaymentFailedEmail(tenant, amount, currency, attempt, maxAttempts, daysUntilSuspend) {
  const symbol = currency === 'INR' ? '₹' : '$';
  const urgent = daysUntilSuspend <= 1;
  return {
    subject: `Action required: Payment failed — ${symbol}${amount} · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px">
  ${urgent ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:6px;padding:12px 16px;margin-bottom:24px;color:#991b1b;font-size:14px;font-weight:500">⚠ Your account will be suspended in ${daysUntilSuspend} day(s) if payment is not resolved.</div>` : ''}
  <p style="font-size:18px;font-weight:600;margin:0 0 8px">Payment failed</p>
  <p style="color:#444;font-size:14px">We were unable to collect <strong>${symbol}${amount} ${currency}</strong> (attempt ${attempt} of ${maxAttempts}).</p>
  <p style="color:#444;font-size:14px">Please update your payment method to avoid service interruption.</p>
  <a href="https://tinai.cloud/billing/payment" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;margin:16px 0">Update payment method</a>
  <p style="color:#94a3b8;font-size:12px;margin-top:32px">Tinai Cloud · billing@tinai.cloud</p>
</div></body></html>`,
  };
}

/**
 * Suspension warning email.
 */
export function buildSuspensionWarningEmail(tenant, daysUntilSuspend) {
  return {
    subject: `Your Tinai account will be suspended in ${daysUntilSuspend} day(s)`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:32px">
  <p style="font-size:18px;font-weight:600;color:#991b1b;margin:0 0 16px">Account suspension notice</p>
  <p style="color:#444;font-size:14px">Your Tinai account has an outstanding payment. If not resolved within <strong>${daysUntilSuspend} day(s)</strong>, your namespace will be suspended and workloads paused.</p>
  <p style="color:#444;font-size:14px">Your data will be retained for 30 days after suspension.</p>
  <a href="https://tinai.cloud/billing/payment" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;margin:16px 0">Resolve payment now</a>
  <p style="color:#94a3b8;font-size:12px;margin-top:32px">Tinai Cloud · billing@tinai.cloud</p>
</div></body></html>`,
  };
}

/**
 * Trial expiry email sequence templates.
 */
export const trialEmails = {
  day7Warning: (tenant, daysLeft) => ({
    subject: `Your Tinai trial ends in ${daysLeft} days`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:32px">
  <p style="font-size:18px;font-weight:600;margin:0 0 8px">Your trial ends in ${daysLeft} days</p>
  <p style="color:#444;font-size:14px">Enjoying Tinai? Upgrade now to keep your workloads running and retain all your data.</p>
  <a href="https://tinai.cloud/upgrade" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;margin:16px 0">Upgrade now</a>
  <p style="color:#94a3b8;font-size:12px;margin-top:32px">Questions? Reply to this email.</p>
</div></body></html>`,
  }),

  dayOfExpiry: (tenant) => ({
    subject: 'Your Tinai trial has ended — upgrade to continue',
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fbbf24;padding:32px">
  <p style="font-size:18px;font-weight:600;margin:0 0 8px">Your trial has ended</p>
  <p style="color:#444;font-size:14px">Your workloads have been paused. Your data is safely retained for 30 days.</p>
  <a href="https://tinai.cloud/upgrade" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;margin:16px 0">Upgrade to reactivate</a>
</div></body></html>`,
  }),

  day25DataWarning: (tenant) => ({
    subject: 'Your Tinai data will be deleted in 5 days',
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #fca5a5;padding:32px">
  <p style="font-size:18px;font-weight:600;color:#991b1b;margin:0 0 8px">Data deletion in 5 days</p>
  <p style="color:#444;font-size:14px">Your trial ended 25 days ago. Your namespace and all data will be permanently deleted in 5 days unless you upgrade.</p>
  <a href="https://tinai.cloud/upgrade" style="display:inline-block;background:#dc2626;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px;margin:16px 0">Upgrade now to save your data</a>
</div></body></html>`,
  }),
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatDate(dateStr) {
  if (!dateStr) return 'on receipt';
  return new Date(dateStr).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
