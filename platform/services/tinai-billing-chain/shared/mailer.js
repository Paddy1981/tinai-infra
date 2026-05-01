// shared/mailer.js
// Thin nodemailer wrapper pointing at self-hosted Stalwart SMTP.
// All transactional email in the billing chain flows through this.

import nodemailer from 'nodemailer';
import { config } from './config.js';

let _transport = null;

function getTransport() {
  if (!_transport) {
    _transport = nodemailer.createTransport({
      host: config.stalwart.smtpHost,
      port: config.stalwart.smtpPort,
      secure: false,
      auth: {
        user: config.stalwart.smtpUser,
        pass: config.stalwart.smtpPass,
      },
      tls: { rejectUnauthorized: process.env.NODE_ENV === 'production' },
    });
  }
  return _transport;
}

/**
 * Send a transactional email.
 * @param {object} opts
 * @param {string}   opts.to       - Recipient email
 * @param {string}   opts.subject  - Email subject
 * @param {string}   opts.html     - HTML body
 * @param {string}   [opts.text]   - Plain text fallback
 * @param {object[]} [opts.attachments] - nodemailer attachments array
 */
export async function sendEmail({ to, subject, html, text, attachments = [] }, logger) {
  const transport = getTransport();
  try {
    const info = await transport.sendMail({
      from: `"${config.stalwart.fromName}" <${config.stalwart.fromAddr}>`,
      to,
      subject,
      html,
      text: text ?? html.replace(/<[^>]+>/g, ''),
      attachments,
    });
    logger?.info({ to, subject, messageId: info.messageId }, 'Email sent');
    return info;
  } catch (err) {
    logger?.error({ to, subject, err: err.message }, 'Email send failed');
    throw err;
  }
}
