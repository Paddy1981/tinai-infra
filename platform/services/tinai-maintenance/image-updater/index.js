// image-updater/index.js
// Scans Harbor registry for newer versions of images used in K8s deployments.
// For each outdated image: opens a PR in Gitea via the Gitea API.
//
// This is the custom complement to Renovate Bot.
// Renovate handles: Helm chart updates, npm dependencies, base images in Dockerfiles.
// This handles: runtime images in K8s manifests that Renovate can't see (live cluster state).
//
// CronJob: daily at 04:00
// Also generates a renovate.json config for Gitea repos.

import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { listDeployments, listNamespaces } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const HARBOR_URL    = process.env.HARBOR_URL    ?? 'https://harbor.tinai.cloud';
const HARBOR_USER   = process.env.HARBOR_USER   ?? '';
const HARBOR_PASS   = process.env.HARBOR_PASS   ?? '';
const GITEA_URL     = process.env.GITEA_URL     ?? 'https://gitea.tinai.cloud';
const GITEA_TOKEN   = process.env.GITEA_TOKEN   ?? '';
const GITEA_ORG     = process.env.GITEA_ORG     ?? 'tinai';
const SKIP_NS       = new Set((process.env.SKIP_NAMESPACES ?? 'kube-system,kube-public').split(','));

// ── Harbor API ────────────────────────────────────────────────────────────────
async function harborAuth() {
  return 'Basic ' + Buffer.from(`${HARBOR_USER}:${HARBOR_PASS}`).toString('base64');
}

async function getLatestTag(project, repo) {
  const auth = await harborAuth();
  const url  = `${HARBOR_URL}/api/v2.0/projects/${project}/repositories/${encodeURIComponent(repo)}/artifacts?page_size=5&sort=-push_time`;
  try {
    const res  = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
    if (!res.ok) return null;
    const arts = await res.json();
    // Find latest semver tag (skip 'latest')
    for (const art of arts) {
      const tags = (art.tags ?? []).map(t => t.name).filter(t => t !== 'latest' && /^\d/.test(t));
      if (tags.length > 0) return tags[0];
    }
    return null;
  } catch { return null; }
}

// ── Parse image string ────────────────────────────────────────────────────────
function parseImage(imageStr) {
  // harbor.tinai.cloud/tinai/metering-bridge:abc12345
  const match = imageStr.match(/^([^/]+)\/([^/]+)\/([^:]+):?(.*)$/);
  if (!match) return null;
  return { registry: match[1], project: match[2], repo: match[3], tag: match[4] || 'latest' };
}

// ── Scan cluster for images ───────────────────────────────────────────────────
async function scanClusterImages() {
  const namespaces = await listNamespaces();
  const images = new Map(); // imageKey → { image, deployments[], currentTag }

  for (const ns of namespaces) {
    const nsName = ns.metadata.name;
    if (SKIP_NS.has(nsName)) continue;

    try {
      const deployments = await listDeployments(nsName);
      for (const dep of deployments) {
        const containers = [
          ...(dep.spec?.template?.spec?.containers ?? []),
          ...(dep.spec?.template?.spec?.initContainers ?? []),
        ];
        for (const container of containers) {
          const parsed = parseImage(container.image ?? '');
          if (!parsed || parsed.registry !== new URL(HARBOR_URL).hostname) continue;
          const key = `${parsed.project}/${parsed.repo}`;
          if (!images.has(key)) images.set(key, { ...parsed, deployments: [] });
          images.get(key).deployments.push(`${nsName}/${dep.metadata.name}`);
        }
      }
    } catch (err) {
      logger.debug({ namespace: nsName, err: err.message }, 'Could not scan namespace');
    }
  }

  return [...images.values()];
}

// ── Check for updates ─────────────────────────────────────────────────────────
async function checkForUpdates(images) {
  const updates = [];
  for (const img of images) {
    // Skip non-semver tags (sha hashes, 'latest')
    if (!/^\d/.test(img.tag) && img.tag !== 'latest') continue;
    const latestTag = await getLatestTag(img.project, img.repo);
    if (latestTag && latestTag !== img.tag) {
      updates.push({ ...img, latestTag });
      logger.info({ image: `${img.project}/${img.repo}`, current: img.tag, latest: latestTag }, 'Update available');
    }
  }
  return updates;
}

// ── Gitea PR ──────────────────────────────────────────────────────────────────
async function openGiteaPR(update) {
  if (!GITEA_TOKEN) {
    logger.warn({ image: update.repo }, 'GITEA_TOKEN not set — skipping PR');
    return null;
  }

  const title = `chore: update ${update.repo} from ${update.tag} to ${update.latestTag}`;
  const body  = `## Image update\n\n` +
    `**Image:** \`${HARBOR_URL}/${update.project}/${update.repo}\`\n` +
    `**Current:** \`${update.tag}\`\n` +
    `**Latest:** \`${update.latestTag}\`\n\n` +
    `**Deployments using this image:**\n${update.deployments.map(d => `- \`${d}\``).join('\n')}\n\n` +
    `_Opened automatically by Tinai image-updater._`;

  const res = await fetch(`${GITEA_URL}/api/v1/repos/${GITEA_ORG}/tinai-platform/issues`, {
    method: 'POST',
    headers: {
      Authorization: `token ${GITEA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body, labels: ['dependencies', 'image-update'] }),
  });

  if (!res.ok) {
    logger.warn({ status: res.status, image: update.repo }, 'Gitea issue creation failed');
    return null;
  }

  const issue = await res.json();
  logger.info({ issue: issue.number, image: update.repo }, 'Gitea issue opened');
  return issue.html_url;
}

// ── Email digest ──────────────────────────────────────────────────────────────
function buildImageUpdateEmail(updates, scanned) {
  const rows = updates.map(u => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${u.project}/${u.repo}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#64748b">${u.tag}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#16a34a;font-weight:600">${u.latestTag}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${u.deployments.join(', ')}</td>
    </tr>`).join('');

  return {
    subject: updates.length > 0
      ? `${updates.length} image update(s) available · Tinai`
      : `Image scan complete — all images current · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:700px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 8px">Daily Image Update Scan</p>
  <p style="color:#64748b;font-size:13px;margin:0 0 20px">Scanned ${scanned} images · Found ${updates.length} update(s)</p>
  ${updates.length > 0 ? `
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead><tr style="background:#f8fafc">
      <th style="padding:8px;text-align:left;color:#64748b;font-size:11px">Image</th>
      <th style="padding:8px;text-align:left;color:#64748b;font-size:11px">Current</th>
      <th style="padding:8px;text-align:left;color:#64748b;font-size:11px">Latest</th>
      <th style="padding:8px;text-align:left;color:#64748b;font-size:11px">Deployments</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="color:#64748b;font-size:12px;margin-top:16px">Gitea issues opened for each update. Review, merge, and Woodpecker CI will build + deploy.</p>
  ` : `<p style="color:#16a34a;font-size:14px">All images are up to date ✓</p>`}
</div></body></html>`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('Image update scan starting');
  const natsClient = await connectNATS(logger);
  const adminEmail = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;

  const images  = await scanClusterImages();
  logger.info({ count: images.length }, 'Images found in cluster');

  const updates = await checkForUpdates(images);

  // Open Gitea issues for each update
  const prUrls = [];
  for (const update of updates) {
    const url = await openGiteaPR(update);
    if (url) prUrls.push(url);
  }

  await sendEmail({ to: adminEmail, ...buildImageUpdateEmail(updates, images.length) }, logger);

  publish(natsClient, 'tinai.maintenance.images', {
    timestamp: new Date().toISOString(),
    scanned: images.length,
    updatesAvailable: updates.length,
    updates: updates.map(u => ({ repo: u.repo, current: u.tag, latest: u.latestTag })),
  }, logger);

  publishAudit(natsClient, { event: 'image.scan', scanned: images.length, updates: updates.length }, logger);

  logger.info({ scanned: images.length, updates: updates.length }, 'Image scan complete');
  if (natsClient) await natsClient.drain();
  process.exit(0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
