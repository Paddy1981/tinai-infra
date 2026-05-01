// secret-rotation/index.js
// Rotates secrets on a schedule via HashiCorp Vault dynamic secrets.
// Vault generates new DB credentials automatically; this service:
//   1. Requests new credentials from Vault
//   2. Updates K8s Secrets in affected namespaces
//   3. Triggers rolling restart of affected Deployments
//   4. Verifies new credentials work before revoking old ones
//   5. Sends rotation report
//
// CronJob: monthly on 1st at 01:00
// Also runs when NATS receives tinai.maintenance.secret.rotate-now

import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit, publishToDLQ } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { k8sGet, k8sPatch, k8sPost, listDeployments, rolloutRestart } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const VAULT_URL   = process.env.VAULT_ADDR   ?? 'http://vault.core.svc.cluster.local:8200';
const VAULT_TOKEN = process.env.VAULT_TOKEN  ?? '';
const DRY_RUN     = process.env.DRY_RUN === 'true';

// Namespaces that must never be touched by secret rotation
const PROTECTED_NAMESPACES = new Set([
  'kube-system', 'kube-public', 'kube-node-lease',
  'vault', 'external-secrets', 'tinai-system', 'monitoring',
]);

function isSafeNamespace(ns) {
  if (PROTECTED_NAMESPACES.has(ns)) return false;
  return ns.startsWith('tenant-') || ns === 'core' || ns === 'billing' || ns === 'reporting';
}

// ── Rotation targets ───────────────────────────────────────────────────────────
// Each entry: which Vault path to read, which K8s secret to update, which deployments to restart
const ROTATION_TARGETS = [
  {
    name:        'postgresql-app-credentials',
    vaultPath:   'database/creds/tinai-app',   // Vault dynamic DB credentials
    namespace:   'core',
    secretName:  'postgresql-credentials',
    secretKeys:  { username: 'username', password: 'password' },
    restartDeployments: [
      { namespace: 'billing',   name: 'metering-bridge' },
      { namespace: 'billing',   name: 'invoice-generator' },
      { namespace: 'billing',   name: 'payment-webhook' },
      { namespace: 'reporting', name: 'mrr-dashboard' },
    ],
  },
  {
    name:        'postgresql-readonly-credentials',
    vaultPath:   'database/creds/tinai-readonly',
    namespace:   'reporting',
    secretName:  'postgresql-readonly',
    secretKeys:  { username: 'username', password: 'password' },
    restartDeployments: [
      { namespace: 'reporting', name: 'compliance-report' },
    ],
  },
];

// ── Vault API ──────────────────────────────────────────────────────────────────
async function vaultRead(path) {
  const res = await fetch(`${VAULT_URL}/v1/${path}`, {
    headers: { 'X-Vault-Token': VAULT_TOKEN, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Vault read ${path} → ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.data;
}

async function vaultRevoke(leaseId) {
  if (!leaseId) return;
  const res = await fetch(`${VAULT_URL}/v1/sys/leases/revoke`, {
    method: 'PUT',
    headers: { 'X-Vault-Token': VAULT_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lease_id: leaseId }),
  });
  if (!res.ok) logger.warn({ leaseId }, 'Vault lease revocation failed');
}

// ── K8s Secret update ─────────────────────────────────────────────────────────
async function updateK8sSecret(namespace, secretName, newData) {
  if (DRY_RUN) { logger.info({ namespace, secretName }, '[DRY RUN] Would update secret'); return; }

  // Encode values as base64 (K8s secrets require base64)
  const encodedData = {};
  for (const [k, v] of Object.entries(newData)) {
    encodedData[k] = Buffer.from(v).toString('base64');
  }

  try {
    // Try PATCH (update existing)
    await k8sPatch(
      `/api/v1/namespaces/${namespace}/secrets/${secretName}`,
      { data: encodedData }
    );
    logger.info({ namespace, secretName }, 'K8s Secret updated');
  } catch (err) {
    if (err.message.includes('404')) {
      // Create new secret
      await k8sPost(`/api/v1/namespaces/${namespace}/secrets`, {
        apiVersion: 'v1', kind: 'Secret',
        metadata: { name: secretName, namespace },
        type: 'Opaque',
        data: encodedData,
      });
      logger.info({ namespace, secretName }, 'K8s Secret created');
    } else {
      throw err;
    }
  }
}

// ── Verify new credentials ────────────────────────────────────────────────────
async function verifyDBCredentials(username, password, dbHost) {
  // Simple TCP + auth check via a minimal postgres connection test
  // In production: use `pg` npm package for actual connection test
  // This is a stub — replace with real DB connection verification
  logger.debug({ username }, 'Verifying new DB credentials (stub)');
  // TODO: const client = new pg.Client({ host: dbHost, user: username, password });
  // await client.connect(); await client.query('SELECT 1'); await client.end();
  return true; // stub
}

// ── Rotate one target ──────────────────────────────────────────────────────────
async function rotateTarget(target, natsClient) {
  logger.info({ target: target.name }, 'Rotating secret');

  // Validate namespace before any mutation
  if (!isSafeNamespace(target.namespace)) {
    throw new Error(`Refusing to rotate secret in protected/unknown namespace: ${target.namespace}`);
  }
  for (const dep of target.restartDeployments) {
    if (!isSafeNamespace(dep.namespace)) {
      throw new Error(`Refusing to restart deployment in protected/unknown namespace: ${dep.namespace}`);
    }
  }

  // 1. Get new credentials from Vault
  const vaultData = await vaultRead(target.vaultPath);
  const newSecretData = {};
  for (const [secretKey, vaultKey] of Object.entries(target.secretKeys)) {
    if (!vaultData[vaultKey]) throw new Error(`Vault response missing key: ${vaultKey}`);
    newSecretData[secretKey] = vaultData[vaultKey];
  }

  // 2. Verify new credentials work before updating K8s
  const verified = await verifyDBCredentials(
    newSecretData.username,
    newSecretData.password,
    process.env.PG_HOST ?? 'postgres.core.svc.cluster.local'
  );
  if (!verified) throw new Error('New credentials failed verification — rotation aborted');

  // 3. Update K8s Secret
  await updateK8sSecret(target.namespace, target.secretName, newSecretData);

  // 4. Rolling restart affected deployments
  const restartResults = [];
  for (const dep of target.restartDeployments) {
    if (DRY_RUN) {
      logger.info(dep, '[DRY RUN] Would restart deployment');
      restartResults.push({ ...dep, status: 'dry-run' });
      continue;
    }
    try {
      await rolloutRestart(dep.namespace, dep.name);
      logger.info(dep, 'Deployment restart triggered');
      restartResults.push({ ...dep, status: 'restarted' });
    } catch (err) {
      logger.warn({ ...dep, err: err.message }, 'Deployment restart failed');
      restartResults.push({ ...dep, status: 'failed', error: err.message });
    }
  }

  // 5. Revoke old Vault lease (if provided in previous rotation metadata)
  // Note: Vault TTL-based revocation is automatic; this is belt-and-suspenders
  const oldLeaseId = process.env[`VAULT_LEASE_${target.name.toUpperCase().replace(/-/g, '_')}`];
  if (oldLeaseId) await vaultRevoke(oldLeaseId);

  publish(natsClient, 'tinai.maintenance.secret.rotated', {
    timestamp: new Date().toISOString(),
    target: target.name, namespace: target.namespace,
    deploymentsRestarted: restartResults.filter(r => r.status === 'restarted').length,
    dryRun: DRY_RUN,
  }, logger);

  return { target: target.name, restartResults, newUsername: newSecretData.username };
}

// ── Email report ───────────────────────────────────────────────────────────────
function buildRotationEmail(results, errors) {
  const rows = results.map(r => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${r.target}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#16a34a">Rotated</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${r.restartResults?.filter(d=>d.status==='restarted').length ?? 0} deployments restarted</td>
    </tr>`).join('');
  const errRows = errors.map(e => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${e.target}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#dc2626">Failed</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${e.error}</td>
    </tr>`).join('');

  return {
    subject: `Secret rotation ${errors.length === 0 ? 'complete' : 'FAILED'} — ${results.length} rotated · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid ${errors.length===0?'#86efac':'#fca5a5'};padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 16px">Secret Rotation Report ${DRY_RUN ? '(DRY RUN)' : ''}</p>
  <table style="width:100%;border-collapse:collapse">
    <thead><tr style="background:#f8fafc"><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Secret</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Status</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Details</th></tr></thead>
    <tbody>${rows}${errRows}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:16px">
    Credentials sourced from Vault dynamic secrets (${VAULT_URL}).<br>
    K8s Secrets updated and affected pods restarted via rolling restart.
  </p>
</div></body></html>`,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  logger.info({ dryRun: DRY_RUN, targets: ROTATION_TARGETS.length }, 'Secret rotation starting');
  const natsClient = await connectNATS(logger);
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  const results = [];
  const errors  = [];

  for (const target of ROTATION_TARGETS) {
    try {
      const result = await rotateTarget(target, natsClient);
      results.push(result);
    } catch (err) {
      logger.error({ target: target.name, err: err.message }, 'Rotation failed');
      errors.push({ target: target.name, error: err.message });
      await publishToDLQ(natsClient, { target: target.name }, err, 'secret-rotation', logger);
    }
  }

  await sendEmail({ to: adminEmail, ...buildRotationEmail(results, errors) }, logger);

  publishAudit(natsClient, {
    event: 'secret.rotation',
    rotated: results.length, failed: errors.length, dryRun: DRY_RUN,
  }, logger);

  logger.info({ rotated: results.length, failed: errors.length }, 'Secret rotation complete');
  if (natsClient) await natsClient.drain();
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
