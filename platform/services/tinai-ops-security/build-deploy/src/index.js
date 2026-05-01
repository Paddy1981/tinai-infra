// build-deploy/src/index.js
// Service: Build & Deploy Pipeline Controller
//
// Flow: git push → Gitea webhook → this service
//   1. Clone repo + detect runtime (Nixpacks)
//   2. Build Docker image
//   3. Push to Harbor
//   4. Apply K8s Deployment manifest
//   5. Monitor rollout
//   6. Notify tenant (success/failure webhook + email)
//   7. Auto-rollback if health checks fail
//
// Runs as a Deployment (always-on webhook receiver).
// Actual build runs as a K8s Job per deploy to isolate resources.

import Fastify from 'fastify';
import { createHmac, timingSafeEqual } from 'crypto';
import { randomUUID } from 'crypto';
import pino from 'pino';
import { config } from '../../shared/config.js';
import { connectNATS, publish, publishAudit, publishToDLQ } from '../../shared/nats.js';
import { sendEmail } from '../../shared/mailer.js';
import { k8sPost, k8sGet, k8sPatch, k8sDelete } from '../../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const HARBOR_URL       = process.env.HARBOR_URL       ?? 'https://harbor.tinai.cloud';
const HARBOR_USER      = process.env.HARBOR_USER      ?? '';
const HARBOR_PASS      = process.env.HARBOR_PASS      ?? '';
const GITEA_WEBHOOK_SECRET = process.env.GITEA_WEBHOOK_SECRET ?? '';
const BUILD_NAMESPACE  = process.env.BUILD_NAMESPACE  ?? 'build-system';
const BUILDER_IMAGE    = process.env.BUILDER_IMAGE    ?? 'harbor.tinai.cloud/tinai/nixpacks-builder:latest';
const ROLLOUT_TIMEOUT  = parseInt(process.env.ROLLOUT_TIMEOUT_MS ?? String(5 * 60 * 1000), 10);

// In-memory build state (use Redis in production for multi-replica)
const builds = new Map();

// ── Gitea webhook signature verification ──────────────────────────────────────
function verifyGiteaSignature(rawBody, signature) {
  if (!GITEA_WEBHOOK_SECRET) return true;
  const expected = createHmac('sha256', GITEA_WEBHOOK_SECRET).update(rawBody).digest('hex');
  try { return timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex')); }
  catch { return false; }
}

// ── Derive tenant ID from repo name ──────────────────────────────────────────
const TENANT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

function repoToTenantId(repoName) {
  // Convention: repo name matches tenant ID exactly
  if (!TENANT_ID_RE.test(repoName)) {
    throw new Error(`Invalid tenant ID derived from repo name: ${repoName}`);
  }
  return repoName;
}

// ── Build Job spec ─────────────────────────────────────────────────────────────
function buildJobSpec(buildId, tenantId, repoCloneUrl, commitSha, branch) {
  const imageTag   = commitSha.slice(0, 8);
  const imageName  = `${HARBOR_URL}/${tenantId}/app:${imageTag}`;
  const jobName    = `build-${buildId.slice(0, 8)}`;
  const namespace  = `tenant-${tenantId}`;

  return {
    jobName,
    imageName,
    job: {
      apiVersion: 'batch/v1', kind: 'Job',
      metadata: {
        name: jobName,
        namespace: BUILD_NAMESPACE,
        labels: { 'tinai.cloud/build-id': buildId, 'tinai.cloud/tenant-id': tenantId },
        annotations: { 'tinai.cloud/image-name': imageName, 'tinai.cloud/deploy-namespace': namespace },
      },
      spec: {
        backoffLimit: 0,
        activeDeadlineSeconds: 1800, // 30 min max build
        ttlSecondsAfterFinished: 3600,
        template: {
          spec: {
            restartPolicy: 'Never',
            serviceAccountName: 'build-system',
            containers: [{
              name: 'builder',
              image: BUILDER_IMAGE,
              env: [
                { name: 'REPO_URL',       value: repoCloneUrl },
                { name: 'COMMIT_SHA',     value: commitSha },
                { name: 'IMAGE_NAME',     value: imageName },
                { name: 'HARBOR_USER',    value: HARBOR_USER },
                { name: 'HARBOR_PASS',    valueFrom: { secretKeyRef: { name: 'harbor-credentials', key: 'password' } } },
                { name: 'HARBOR_REGISTRY', value: HARBOR_URL },
              ],
              // Builder runs: git clone → nixpacks build → docker push
              command: ['/bin/sh', '-c', [
                'git clone --depth 1 --branch $COMMIT_SHA $REPO_URL /workspace || git clone $REPO_URL /workspace && cd /workspace && git checkout $COMMIT_SHA',
                'cd /workspace',
                'echo $HARBOR_PASS | docker login $HARBOR_REGISTRY -u $HARBOR_USER --password-stdin',
                'nixpacks build . --name $IMAGE_NAME --platform linux/amd64,linux/arm64',
                'docker push $IMAGE_NAME',
              ].join(' && ')],
              resources: {
                requests: { cpu: '500m',   memory: '512Mi' },
                limits:   { cpu: '2000m',  memory: '2Gi'   },
              },
              volumeMounts: [
                { name: 'workspace',   mountPath: '/workspace' },
              ],
            }],
            volumes: [
              { name: 'workspace',   emptyDir: {} },
            ],
          },
        },
      },
    },
  };
}

// ── Wait for build job to complete ───────────────────────────────────────────
async function waitForJob(jobName, namespace, timeoutMs = 1800_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10_000));
    try {
      const job = await k8sGet(`/apis/batch/v1/namespaces/${namespace}/jobs/${jobName}`);
      if (job.status?.succeeded > 0) return { success: true };
      if (job.status?.failed    > 0) return { success: false, reason: 'build failed' };
    } catch (err) {
      logger.warn({ err: err.message }, 'Job poll error');
    }
  }
  return { success: false, reason: 'timeout' };
}

// ── Apply/update K8s Deployment ───────────────────────────────────────────────
async function deployToK8s(tenantId, imageName, commitSha) {
  const namespace   = `tenant-${tenantId}`;
  const deployName  = 'app';

  const deploySpec = {
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: deployName, namespace,
      annotations: {
        'tinai.cloud/deployed-at':  new Date().toISOString(),
        'tinai.cloud/commit-sha':   commitSha,
        'tinai.cloud/deployed-by':  'tinai-build-deploy',
      },
    },
    spec: {
      replicas: 1,
      selector: { matchLabels: { app: 'app' } },
      strategy: { type: 'RollingUpdate', rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } },
      template: {
        metadata: { labels: { app: 'app' } },
        spec: {
          serviceAccountName: 'tenant-workload',
          containers: [{
            name:  'app',
            image: imageName,
            ports: [{ containerPort: 3000 }],
            livenessProbe:  { httpGet: { path: '/health', port: 3000 }, initialDelaySeconds: 15, periodSeconds: 10 },
            readinessProbe: { httpGet: { path: '/health', port: 3000 }, initialDelaySeconds: 5,  periodSeconds: 5  },
            resources: {
              requests: { cpu: '50m',  memory: '64Mi'  },
              limits:   { cpu: '500m', memory: '512Mi' },
            },
          }],
        },
      },
    },
  };

  try {
    // Try patch first (update)
    await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`, deploySpec);
  } catch (err) {
    if (err.message.includes('404')) {
      await k8sPost(`/apis/apps/v1/namespaces/${namespace}/deployments`, deploySpec);
    } else throw err;
  }
  logger.info({ namespace, deployName, imageName }, 'Deployment applied');
}

// ── Monitor rollout health ────────────────────────────────────────────────────
async function waitForRollout(tenantId, timeoutMs) {
  const namespace   = `tenant-${tenantId}`;
  const deployName  = 'app';
  const deadline    = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5_000));
    try {
      const dep = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`);
      const desired   = dep.spec?.replicas ?? 1;
      const updated   = dep.status?.updatedReplicas ?? 0;
      const available = dep.status?.availableReplicas ?? 0;
      if (updated >= desired && available >= desired) return { success: true };
    } catch (err) {
      logger.warn({ err: err.message }, 'Rollout poll error');
    }
  }
  return { success: false, reason: 'rollout timeout — health checks failing' };
}

// ── Rollback ──────────────────────────────────────────────────────────────────
async function rollback(tenantId, logger) {
  const namespace  = `tenant-${tenantId}`;
  const deployName = 'app';
  // Trigger rollback by patching with a null image update annotation
  // K8s will use the previous ReplicaSet
  await k8sPatch(`/apis/apps/v1/namespaces/${namespace}/deployments/${deployName}`, {
    metadata: { annotations: { 'tinai.cloud/rolled-back-at': new Date().toISOString() } },
    spec: { rollbackTo: { revision: 0 } }, // 0 = previous revision
  });
  logger.warn({ namespace, deployName }, 'Rollback triggered');
}

// ── Tenant notification ───────────────────────────────────────────────────────
async function notifyTenant(tenantId, email, success, details) {
  const { commitSha, branch, repoName, durationMs, error } = details;
  const mins = Math.round((durationMs ?? 0) / 60000);
  const secs = Math.round(((durationMs ?? 0) % 60000) / 1000);

  if (email) {
    await sendEmail({
      to: email,
      subject: `${success ? '✓ Deployed' : '✗ Deploy failed'} — ${repoName}@${commitSha?.slice(0,7)} · Tinai`,
      html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid ${success?'#86efac':'#fca5a5'};padding:28px">
  <p style="font-size:18px;font-weight:600;color:${success?'#16a34a':'#dc2626'};margin:0 0 16px">
    ${success ? 'Deploy successful' : 'Deploy failed'}
  </p>
  <div style="background:#f8fafc;border-radius:6px;padding:14px 18px;font-size:13px;margin-bottom:16px">
    <table style="width:100%;border-collapse:collapse">
      <tr><td style="color:#64748b;padding:3px 0">Repository</td><td style="text-align:right">${repoName}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Branch</td><td style="text-align:right">${branch}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Commit</td><td style="text-align:right;font-family:monospace">${commitSha?.slice(0,7)}</td></tr>
      <tr><td style="color:#64748b;padding:3px 0">Duration</td><td style="text-align:right">${mins}m ${secs}s</td></tr>
      ${success ? `<tr><td style="color:#64748b;padding:3px 0">URL</td><td style="text-align:right"><a href="https://${tenantId}.app.tinai.cloud" style="color:#0ea5e9">https://${tenantId}.app.tinai.cloud</a></td></tr>` : ''}
    </table>
  </div>
  ${error ? `<p style="color:#dc2626;font-size:13px;background:#fef2f2;padding:12px;border-radius:6px">${error}</p>` : ''}
  <a href="https://app.tinai.cloud/deploys" style="display:inline-block;background:#0f172a;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px">View deploy logs</a>
</div></body></html>`,
    }, logger);
  }
}

// ── Main pipeline orchestrator ────────────────────────────────────────────────
async function runPipeline(payload, natsClient) {
  const buildId   = randomUUID();
  const tenantId  = repoToTenantId(payload.repository?.name);
  const commitSha = payload.after ?? payload.head_commit?.id ?? 'unknown';
  const branch    = payload.ref?.replace('refs/heads/', '') ?? 'main';
  const repoName  = payload.repository?.name ?? tenantId;
  const cloneUrl  = payload.repository?.clone_url ?? '';
  const email     = payload.pusher?.email ?? null;

  const startedAt = Date.now();

  builds.set(buildId, { tenantId, commitSha, branch, status: 'building', startedAt });

  publish(natsClient, 'tinai.build.started', { buildId, tenantId, commitSha, branch, timestamp: new Date().toISOString() }, logger);
  logger.info({ buildId, tenantId, commitSha, branch }, 'Pipeline started');

  try {
    // 1. Create build Job
    const { jobName, imageName, job } = buildJobSpec(buildId, tenantId, cloneUrl, commitSha, branch);
    await k8sPost(`/apis/batch/v1/namespaces/${BUILD_NAMESPACE}/jobs`, job);
    builds.get(buildId).status = 'building';

    // 2. Wait for build
    const buildResult = await waitForJob(jobName, BUILD_NAMESPACE);
    if (!buildResult.success) throw new Error(`Build failed: ${buildResult.reason}`);
    builds.get(buildId).status = 'deploying';
    logger.info({ buildId, imageName }, 'Build complete — deploying');

    // 3. Deploy to K8s
    await deployToK8s(tenantId, imageName, commitSha);

    // 4. Wait for rollout
    const rolloutResult = await waitForRollout(tenantId, ROLLOUT_TIMEOUT);
    if (!rolloutResult.success) {
      // Auto-rollback
      await rollback(tenantId, logger);
      throw new Error(`Rollout failed: ${rolloutResult.reason} — auto-rolled back`);
    }

    const durationMs = Date.now() - startedAt;
    builds.get(buildId).status   = 'success';
    builds.get(buildId).durationMs = durationMs;

    publish(natsClient, 'tinai.build.success', { buildId, tenantId, commitSha, imageName, durationMs, timestamp: new Date().toISOString() }, logger);
    publishAudit(natsClient, { event: 'deploy.success', tenantId, commitSha, durationMs }, logger);

    await notifyTenant(tenantId, email, true, { commitSha, branch, repoName, durationMs });
    logger.info({ buildId, tenantId, durationMs }, 'Pipeline complete');

  } catch (err) {
    const durationMs = Date.now() - startedAt;
    builds.get(buildId).status  = 'failed';
    builds.get(buildId).error   = err.message;

    logger.error({ buildId, tenantId, err: err.message }, 'Pipeline failed');
    publish(natsClient, 'tinai.build.failed', { buildId, tenantId, commitSha, error: err.message, durationMs, timestamp: new Date().toISOString() }, logger);
    await notifyTenant(tenantId, email, false, { commitSha, branch, repoName, durationMs, error: err.message });
    await publishToDLQ(natsClient, { buildId, tenantId, commitSha }, err, 'build-deploy', logger);
  }
}

// ── Server ────────────────────────────────────────────────────────────────────
async function main() {
  const natsClient = await connectNATS(logger);
  const app = Fastify({ logger: false });

  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    req.rawBody = body.toString();
    try { done(null, JSON.parse(req.rawBody)); } catch (e) { done(e); }
  });

  app.post('/webhooks/gitea', async (req, reply) => {
    const sig = req.headers['x-gitea-signature'] ?? req.headers['x-hub-signature-256']?.replace('sha256=', '');
    if (!verifyGiteaSignature(req.rawBody, sig)) return reply.code(401).send({ error: 'invalid signature' });
    if (req.headers['x-gitea-event'] !== 'push') return reply.code(200).send({ ignored: true });
    reply.code(202).send({ status: 'accepted' });
    runPipeline(req.body, natsClient).catch(err => logger.error({ err: err.message }, 'Pipeline error'));
  });

  app.get('/builds/:buildId', async (req, reply) => {
    const build = builds.get(req.params.buildId);
    if (!build) return reply.code(404).send({ error: 'not found' });
    return build;
  });

  app.get('/health', async () => ({ status: 'ok', service: 'build-deploy', activeBuilds: [...builds.values()].filter(b => b.status === 'building' || b.status === 'deploying').length }));

  await app.listen({ port: parseInt(process.env.PORT ?? '3401', 10), host: '0.0.0.0' });
  logger.info('Build & deploy controller listening');
}

main().catch(err => { logger.fatal(err); process.exit(1); });
