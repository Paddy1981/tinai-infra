// mrr-dashboard/src/index.js
// Service: MRR & Business Metrics API
//
// Aggregates data from Lago analytics API and exposes it as a clean
// JSON API for the Tinai Next.js dashboard and Grafana.
//
// Endpoints:
//   GET /api/mrr          — current MRR + trend
//   GET /api/revenue      — gross revenue by month
//   GET /api/tenants      — active, churned, trial counts
//   GET /api/arpu         — average revenue per user
//   GET /api/churn        — churn rate
//   GET /api/summary      — all metrics in one call (for dashboard home)
//
// Also publishes a daily digest to NATS (tinai.billing.audit)
// and sends a daily ops email to admin.

import Fastify from 'fastify';
import pino from 'pino';
import { config, timingSafeTokenCompare } from '../../shared/config.js';
import { connectNATS, publishAudit } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import {
  fetchMRRAnalytics,
  fetchGrossRevenue,
  fetchAllCustomers,
  fetchAllInvoicesInRange,
} from '../../shared/lago.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

// ── Cache (simple in-memory, refreshed every 30 min) ─────────────────────────
let cache = { data: null, lastUpdated: 0 };
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getMetrics(force = false) {
  if (!force && cache.data && (Date.now() - cache.lastUpdated) < CACHE_TTL_MS) {
    return cache.data;
  }

  const [mrrData, revenueData, customers] = await Promise.all([
    fetchMRRAnalytics(),
    fetchGrossRevenue(),
    fetchAllCustomers(),
  ]);

  // Current MRR (latest entry from Lago analytics)
  const sortedMRR = [...mrrData].sort((a, b) => new Date(b.month) - new Date(a.month));
  const currentMRR = parseFloat(sortedMRR[0]?.amount_cents ?? '0') / 100;
  const prevMRR    = parseFloat(sortedMRR[1]?.amount_cents ?? '0') / 100;
  const mrrGrowth  = prevMRR > 0 ? ((currentMRR - prevMRR) / prevMRR) * 100 : 0;

  // Tenant counts
  const activeCustomers = customers.filter(c => {
    // Has at least one paid/active subscription
    return c.active_subscriptions_count > 0;
  });
  const trialCustomers = customers.filter(c =>
    c.active_subscriptions_count === 0 && !c.deleted_at
  );

  // ARPU
  const arpu = activeCustomers.length > 0 ? currentMRR / activeCustomers.length : 0;

  // Churn (simplified: customers with 0 active subscriptions who had one last month)
  // In production: track this properly in your tenants PostgreSQL table
  const churnCount = 0; // TODO: real churn tracking
  const churnRate  = activeCustomers.length > 0 ? (churnCount / activeCustomers.length) * 100 : 0;

  // Revenue by month for chart
  const revenueByMonth = revenueData.map(r => ({
    month: r.month,
    amount: parseFloat(r.amount_cents ?? '0') / 100,
    currency: r.currency ?? 'INR',
  })).sort((a, b) => new Date(a.month) - new Date(b.month)).slice(-12); // last 12 months

  // MRR trend for chart
  const mrrTrend = sortedMRR.map(m => ({
    month: m.month,
    mrr: parseFloat(m.amount_cents ?? '0') / 100,
  })).reverse().slice(-12);

  const metrics = {
    mrr: {
      current: currentMRR,
      previous: prevMRR,
      growth: Math.round(mrrGrowth * 10) / 10,
      currency: 'INR',
    },
    tenants: {
      active: activeCustomers.length,
      trial: trialCustomers.length,
      total: customers.length,
      churn: churnCount,
      churnRate: Math.round(churnRate * 10) / 10,
    },
    arpu: Math.round(arpu * 100) / 100,
    revenueByMonth,
    mrrTrend,
    lastUpdated: new Date().toISOString(),
  };

  cache = { data: metrics, lastUpdated: Date.now() };
  return metrics;
}

// ── Daily digest email ────────────────────────────────────────────────────────
async function sendDailyDigest(metrics, natsClient) {
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
  const mrrSymbol  = '₹';

  await sendEmail({
    to: adminEmail,
    subject: `Tinai daily digest — MRR ${mrrSymbol}${metrics.mrr.current.toFixed(0)} · ${metrics.tenants.active} tenants`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5">
  <div style="background:#0f172a;padding:20px 32px;border-radius:8px 8px 0 0">
    <p style="color:#fff;font-size:16px;font-weight:600;margin:0">Tinai Daily Digest</p>
    <p style="color:#94a3b8;font-size:12px;margin:2px 0 0">${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p>
  </div>
  <div style="padding:24px 32px">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:24px">
      ${statCard('MRR', `${mrrSymbol}${metrics.mrr.current.toFixed(0)}`, metrics.mrr.growth >= 0 ? `+${metrics.mrr.growth}% MoM` : `${metrics.mrr.growth}% MoM`, metrics.mrr.growth >= 0)}
      ${statCard('Active tenants', String(metrics.tenants.active), `${metrics.tenants.trial} on trial`, true)}
      ${statCard('ARPU', `${mrrSymbol}${metrics.arpu.toFixed(0)}`, 'avg revenue/user', true)}
      ${statCard('Churn', `${metrics.tenants.churnRate}%`, `${metrics.tenants.churn} this month`, metrics.tenants.churnRate < 5)}
    </div>
    <p style="color:#64748b;font-size:12px;text-align:center;margin:0">
      Data from Lago analytics API · tinai.cloud/dashboard
    </p>
  </div>
</div></body></html>`,
  }, logger);

  publishAudit(natsClient, {
    event: 'daily_digest.sent',
    mrr: metrics.mrr.current,
    activeTenants: metrics.tenants.active,
  }, logger);
}

function statCard(label, value, sub, positive = true) {
  return `
<div style="background:#f8fafc;border-radius:6px;padding:14px 16px;border:1px solid #e2e8f0">
  <p style="color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;margin:0 0 4px">${label}</p>
  <p style="color:#0f172a;font-size:20px;font-weight:700;margin:0 0 2px">${value}</p>
  <p style="color:${positive ? '#16a34a' : '#dc2626'};font-size:11px;margin:0">${sub}</p>
</div>`;
}

// ── Fastify server ────────────────────────────────────────────────────────────
async function main() {
  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });

  // CORS for Next.js dashboard
  app.addHook('onSend', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN ?? 'https://app.tinai.cloud');
    reply.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  });
  app.options('*', async (req, reply) => reply.code(204).send());

  // Simple auth middleware
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/health') return;
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!timingSafeTokenCompare(token ?? '', config.service.adminToken) && process.env.NODE_ENV === 'production') {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ status: 'ok', service: 'mrr-dashboard' }));

  app.get('/api/summary', async (req, reply) => {
    const force = req.query.refresh === 'true';
    return getMetrics(force);
  });

  app.get('/api/mrr', async () => {
    const m = await getMetrics();
    return { mrr: m.mrr, trend: m.mrrTrend };
  });

  app.get('/api/revenue', async () => {
    const m = await getMetrics();
    return { revenueByMonth: m.revenueByMonth };
  });

  app.get('/api/tenants', async () => {
    const m = await getMetrics();
    return { tenants: m.tenants };
  });

  app.get('/api/arpu', async () => {
    const m = await getMetrics();
    return { arpu: m.arpu, currency: 'INR' };
  });

  // Daily digest trigger (called by CronJob daily at 07:00)
  app.post('/digest', async (req, reply) => {
    const token = req.headers['x-admin-token'];
    if (!token || !timingSafeTokenCompare(token, config.service.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
    const metrics = await getMetrics(true);
    await sendDailyDigest(metrics, natsClient);
    return reply.send({ sent: true });
  });

  await app.listen({ port: config.service.port, host: '0.0.0.0' });
  logger.info({ port: config.service.port }, 'MRR dashboard API listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
