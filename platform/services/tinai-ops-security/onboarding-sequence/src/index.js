// onboarding-sequence/src/index.js
// Service: Tenant Onboarding Email Sequence
//
// Triggered by NATS: tinai.tenant.provisioned
// Drives a 7-step onboarding journey over 7 days.
//
// Day 0:  Welcome + credentials + quick start
// Day 0+2h: DNS setup reminder (if not configured)
// Day 1:  First deploy guide
// Day 2:  Custom domain + HTTPS setup
// Day 3:  Database + environment variables
// Day 5:  Monitoring + logs walkthrough
// Day 7:  "You've been live 7 days" + tips + upgrade prompt

import pino from 'pino';
import { connect, JSONCodec } from 'nats';
import { config } from '../../shared/config.js';
import { publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const jc = JSONCodec();

// ── Email templates ────────────────────────────────────────────────────────────
const SEQUENCE = [
  {
    delayMs: 0,
    subject: (t) => `Welcome to Tinai, ${t.name ?? t.tenantId}! Your cloud is ready.`,
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5">
  <div style="background:#0f172a;padding:24px 32px;border-radius:8px 8px 0 0">
    <p style="color:#fff;font-size:20px;font-weight:700;margin:0">Welcome to Tinai</p>
    <p style="color:#94a3b8;font-size:13px;margin:4px 0 0">Your sovereign cloud is ready</p>
  </div>
  <div style="padding:28px 32px">
    <p style="font-size:15px;margin:0 0 16px">Hi ${t.name ?? t.tenantId}!</p>
    <p style="color:#444;font-size:14px;line-height:1.6">Your Tinai namespace is live. Here's what you have:</p>
    <div style="background:#f8fafc;border-radius:6px;padding:16px 20px;margin:16px 0;font-size:13px">
      <p style="margin:0 0 6px;font-weight:600">Your resources</p>
      <p style="margin:2px 0;color:#444">📦 Namespace: <code style="background:#e2e8f0;padding:1px 6px;border-radius:3px">tenant-${t.tenantId}</code></p>
      <p style="margin:2px 0;color:#444">🗃️ Git repo: <a href="${t.giteaUrl ?? '#'}" style="color:#0ea5e9">${t.giteaUrl ?? 'Setting up...'}</a></p>
      <p style="margin:2px 0;color:#444">🐳 Registry: <code style="background:#e2e8f0;padding:1px 6px;border-radius:3px">${t.harborUrl ?? 'harbor.tinai.cloud/' + t.tenantId}</code></p>
      <p style="margin:2px 0;color:#444">🌐 App URL: <a href="https://${t.tenantId}.app.tinai.cloud" style="color:#0ea5e9">https://${t.tenantId}.app.tinai.cloud</a></p>
    </div>
    <p style="font-weight:600;font-size:14px;margin:20px 0 8px">Deploy in 3 steps:</p>
    <div style="background:#f0f9ff;border-left:3px solid #0ea5e9;padding:12px 16px;font-family:monospace;font-size:12px;margin-bottom:20px">
      <p style="margin:2px 0">git remote add tinai ${t.giteaUrl ?? 'https://gitea.tinai.cloud/tinai-tenants/' + t.tenantId}</p>
      <p style="margin:2px 0">git push tinai main</p>
      <p style="margin:2px 0"># That's it — Tinai builds and deploys automatically</p>
    </div>
    <a href="https://app.tinai.cloud/dashboard" style="display:inline-block;background:#0f172a;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:14px">Open dashboard →</a>
  </div>
  <div style="padding:16px 32px;border-top:1px solid #e5e5e5;background:#f8fafc;border-radius:0 0 8px 8px">
    <p style="color:#94a3b8;font-size:11px;margin:0;text-align:center">Tinai Cloud · Reply to this email for help · tinai.cloud</p>
  </div>
</div></body></html>`,
  },
  {
    delayMs: 2 * 60 * 60 * 1000, // 2 hours
    subject: (t) => 'Quick tip: set up your custom domain',
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 12px">Your app is live — point your domain to it</p>
  <p style="color:#444;font-size:14px;line-height:1.6">Add a CNAME record pointing to <code style="background:#e2e8f0;padding:1px 6px;border-radius:3px">${t.tenantId}.app.tinai.cloud</code> and Tinai handles TLS automatically via Let's Encrypt.</p>
  <div style="background:#f8fafc;border-radius:6px;padding:12px 16px;margin:16px 0;font-family:monospace;font-size:12px">
    Type: CNAME<br>Name: @ (or www)<br>Value: ${t.tenantId}.app.tinai.cloud<br>TTL: 3600
  </div>
  <a href="https://docs.tinai.cloud/custom-domains" style="color:#0ea5e9;font-size:13px">Custom domain docs →</a>
</div></body></html>`,
  },
  {
    delayMs: 24 * 60 * 60 * 1000, // Day 1
    subject: (t) => 'Day 1 with Tinai — push your first real deploy',
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 12px">Day 1 — time to deploy something real</p>
  <p style="color:#444;font-size:14px;line-height:1.6">Tinai auto-detects your runtime (Node.js, Python, Go, Ruby, PHP) using Nixpacks. No Dockerfile needed.</p>
  <p style="color:#444;font-size:14px">Just make sure your app:</p>
  <ul style="color:#444;font-size:14px;line-height:1.8">
    <li>Listens on port <strong>3000</strong> (or set PORT env var)</li>
    <li>Has a <code>/health</code> endpoint returning 200</li>
    <li>Reads config from environment variables</li>
  </ul>
  <a href="https://docs.tinai.cloud/deploy" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;margin-top:8px">Deploy guide →</a>
</div></body></html>`,
  },
  {
    delayMs: 3 * 24 * 60 * 60 * 1000, // Day 3
    subject: (t) => 'Add a database to your Tinai app',
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 12px">Add PostgreSQL in one click</p>
  <p style="color:#444;font-size:14px;line-height:1.6">Tinai offers managed PostgreSQL with daily backups, connection pooling via pgBouncer, and automatic SSL.</p>
  <div style="background:#f0f9ff;border-left:3px solid #0ea5e9;padding:12px 16px;font-family:monospace;font-size:12px;margin:16px 0">
    tinai db create my-db --plan starter
  </div>
  <p style="color:#444;font-size:13px">The <code>DATABASE_URL</code> env var is automatically injected into your deployment.</p>
  <a href="https://docs.tinai.cloud/databases" style="color:#0ea5e9;font-size:13px">Database docs →</a>
</div></body></html>`,
  },
  {
    delayMs: 5 * 24 * 60 * 60 * 1000, // Day 5
    subject: (t) => 'See your app metrics and logs',
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 12px">Your app's health at a glance</p>
  <p style="color:#444;font-size:14px;line-height:1.6">Tinai automatically collects CPU, memory, request latency, and error rates. View logs in real-time from your dashboard.</p>
  <div style="display:flex;gap:12px;margin:16px 0">
    <a href="https://app.tinai.cloud/metrics" style="flex:1;display:block;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;text-decoration:none;text-align:center">
      <p style="color:#0f172a;font-weight:600;font-size:13px;margin:0">📊 Metrics</p>
    </a>
    <a href="https://app.tinai.cloud/logs" style="flex:1;display:block;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;text-decoration:none;text-align:center">
      <p style="color:#0f172a;font-weight:600;font-size:13px;margin:0">📋 Logs</p>
    </a>
  </div>
</div></body></html>`,
  },
  {
    delayMs: 7 * 24 * 60 * 60 * 1000, // Day 7
    subject: (t) => `7 days on Tinai — here's what's next`,
    html: (t) => `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 12px">🎉 You've been live for 7 days</p>
  <p style="color:#444;font-size:14px;line-height:1.6">Congrats on your first week on Tinai! Here are some things to explore next:</p>
  <ul style="color:#444;font-size:14px;line-height:2">
    <li><strong>PR previews</strong> — auto-deploy every pull request to a unique URL</li>
    <li><strong>Autoscaling</strong> — scale to zero when idle, scale up on traffic</li>
    <li><strong>Compliance report</strong> — download your DPDP / PDPPL data residency cert</li>
    <li><strong>Team access</strong> — invite collaborators to your namespace</li>
  </ul>
  ${t.plan === 'starter' ? `
  <div style="background:#f0f9ff;border-radius:6px;padding:16px;margin-top:20px">
    <p style="font-weight:600;font-size:14px;margin:0 0 8px">Ready to scale up?</p>
    <p style="color:#444;font-size:13px;margin:0 0 12px">Upgrade to Pro for 4× more CPU, memory, and storage — ₹1,999/month.</p>
    <a href="https://app.tinai.cloud/upgrade" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px">Upgrade to Pro</a>
  </div>` : ''}
</div></body></html>`,
  },
];

// ── Schedule email sequence for one tenant ────────────────────────────────────
async function scheduleOnboardingSequence(tenantData, nc) {
  const { tenantId, email, name } = tenantData;
  if (!email) { logger.warn({ tenantId }, 'No email — skipping onboarding sequence'); return; }

  logger.info({ tenantId, steps: SEQUENCE.length }, 'Scheduling onboarding sequence');

  for (const step of SEQUENCE) {
    setTimeout(async () => {
      try {
        await sendEmail({
          to: email,
          subject: step.subject(tenantData),
          html:    step.html(tenantData),
        }, logger);

        publishAudit(nc ? { publish: (s, d) => nc.publish(s, jc.encode(d)) } : null, {
          event: 'onboarding.email.sent',
          tenantId, step: step.delayMs, subject: step.subject(tenantData),
        }, logger);

        logger.info({ tenantId, delayMs: step.delayMs }, 'Onboarding email sent');
      } catch (err) {
        logger.error({ tenantId, delayMs: step.delayMs, err: err.message }, 'Onboarding email failed');
      }
    }, step.delayMs);
  }
}

// ── NATS subscriber ────────────────────────────────────────────────────────────
async function main() {
  const nc = await connect({ servers: config.nats.servers, reconnect: true, maxReconnectAttempts: -1 });
  logger.info('Onboarding sequence service started — listening for tenant.provisioned');

  const sub = nc.subscribe('tinai.tenant.provisioned');
  for await (const msg of sub) {
    try {
      const tenant = jc.decode(msg.data);
      await scheduleOnboardingSequence(tenant, nc);
    } catch (err) {
      logger.error({ err: err.message }, 'Onboarding trigger failed');
    }
  }
}

main().catch(err => { logger.fatal(err); process.exit(1); });
