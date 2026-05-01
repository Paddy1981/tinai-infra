// storage-cleanup/index.js
// Finds orphaned PVCs (not bound to any active tenant namespace or pod).
// Workflow:
//   1. Scan all PVCs across cluster
//   2. Cross-reference against active tenant list
//   3. Tag orphaned PVCs with annotation + timestamp
//   4. Email report to admin
//   5. After 7-day confirmation window, delete tagged PVCs
//
// CronJob: weekly Sunday 04:00
// Safe: never deletes without 7-day grace period.

import pino from 'pino';
import { config } from '../shared/config.js';
import { connectNATS, publish, publishAudit } from '../shared/nats.js';
import { sendEmail } from '../shared/mailer.js';
import { listPVCs, listNamespaces, listPods, k8sPatch, k8sDelete } from '../shared/k8s.js';

const logger = pino({
  level: config.service.logLevel,
  ...(process.env.NODE_ENV !== 'production' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

const TENANT_PREFIX      = process.env.TENANT_NS_PREFIX ?? 'tenant-';
const GRACE_PERIOD_DAYS  = parseInt(process.env.ORPHAN_GRACE_DAYS ?? '7', 10);
const ORPHAN_ANNOTATION  = 'tinai.cloud/orphaned-at';
const DRY_RUN            = process.env.DRY_RUN === 'true';

// ── PVC analysis ──────────────────────────────────────────────────────────────
async function getActiveTenantNamespaces() {
  const namespaces = await listNamespaces();
  return new Set(
    namespaces
      .filter(ns => ns.metadata.name.startsWith(TENANT_PREFIX))
      .map(ns => ns.metadata.name)
  );
}

async function getPVCsWithPodUsage(namespace) {
  const [pvcs, pods] = await Promise.all([
    listPVCs(namespace),
    listPods(namespace),
  ]);

  // Build set of PVC names actually mounted by pods
  const mountedPVCs = new Set();
  for (const pod of pods) {
    for (const vol of (pod.spec?.volumes ?? [])) {
      if (vol.persistentVolumeClaim?.claimName) {
        mountedPVCs.add(vol.persistentVolumeClaim.claimName);
      }
    }
  }

  return pvcs.map(pvc => ({
    name:       pvc.metadata.name,
    namespace:  pvc.metadata.namespace,
    phase:      pvc.status?.phase ?? 'Unknown',
    sizeGi:     pvc.spec?.resources?.requests?.storage ?? 'unknown',
    storageClass: pvc.spec?.storageClassName ?? 'unknown',
    isMounted:  mountedPVCs.has(pvc.metadata.name),
    orphanedAt: pvc.metadata.annotations?.[ORPHAN_ANNOTATION] ?? null,
    createdAt:  pvc.metadata.creationTimestamp,
  }));
}

async function tagOrphanedPVC(namespace, pvcName) {
  if (DRY_RUN) { logger.info({ namespace, pvcName }, '[DRY RUN] Would tag PVC'); return; }
  await k8sPatch(
    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${pvcName}`,
    { metadata: { annotations: { [ORPHAN_ANNOTATION]: new Date().toISOString() } } }
  );
  logger.info({ namespace, pvcName }, 'PVC tagged as orphaned');
}

async function deleteOrphanedPVC(namespace, pvcName) {
  if (DRY_RUN) { logger.info({ namespace, pvcName }, '[DRY RUN] Would delete PVC'); return; }
  await k8sDelete(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${pvcName}`);
  logger.info({ namespace, pvcName }, 'Orphaned PVC deleted');
}

// ── Email builder ─────────────────────────────────────────────────────────────
function buildStorageEmail(newOrphans, deletedPVCs, totalScanned, totalSizeGi) {
  const orphanRows = newOrphans.map(p => `
    <tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${p.namespace}/${p.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${p.sizeGi}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#d97706">
        Will delete in ${GRACE_PERIOD_DAYS} days
      </td>
    </tr>`).join('');

  const deletedRows = deletedPVCs.map(p => `
    <tr>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${p.namespace}/${p.name}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px">${p.sizeGi}</td>
      <td style="padding:5px 8px;border-bottom:1px solid #f1f5f9;font-size:12px;color:#dc2626">Deleted</td>
    </tr>`).join('');

  return {
    subject: `Storage cleanup: ${newOrphans.length} new orphans, ${deletedPVCs.length} deleted · Tinai`,
    html: `
<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;background:#f5f5f5;padding:32px 16px">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;border:1px solid #e5e5e5;padding:28px">
  <p style="font-size:16px;font-weight:600;margin:0 0 4px">Weekly Storage Cleanup Report</p>
  <p style="color:#64748b;font-size:13px;margin:0 0 20px">Scanned ${totalScanned} PVCs · ${newOrphans.length} newly tagged · ${deletedPVCs.length} deleted</p>
  
  ${newOrphans.length > 0 ? `
  <p style="font-weight:600;font-size:13px;margin:0 0 8px;color:#d97706">Newly tagged orphaned PVCs (grace period: ${GRACE_PERIOD_DAYS} days)</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <thead><tr style="background:#fefce8"><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">PVC</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Size</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Action</th></tr></thead>
    <tbody>${orphanRows}</tbody>
  </table>` : ''}

  ${deletedPVCs.length > 0 ? `
  <p style="font-weight:600;font-size:13px;margin:0 0 8px;color:#dc2626">PVCs deleted (${GRACE_PERIOD_DAYS}-day grace period elapsed)</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:20px">
    <thead><tr style="background:#fef2f2"><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">PVC</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Size</th><th style="padding:6px 8px;text-align:left;color:#64748b;font-size:11px">Status</th></tr></thead>
    <tbody>${deletedRows}</tbody>
  </table>` : ''}

  ${newOrphans.length === 0 && deletedPVCs.length === 0 ? `<p style="color:#16a34a">No orphaned PVCs found. Storage is clean ✓</p>` : ''}
  
  <p style="color:#64748b;font-size:12px;margin-top:16px">
    ${DRY_RUN ? '⚠ DRY RUN — no actual changes made. Set DRY_RUN=false to enable.' : ''}
    To cancel a deletion, remove the <code>${ORPHAN_ANNOTATION}</code> annotation before the grace period ends.
  </p>
</div></body></html>`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  logger.info({ dryRun: DRY_RUN }, 'Storage cleanup starting');
  const natsClient   = await connectNATS(logger);
  const adminEmail   = process.env.ADMIN_EMAIL ?? config.stalwart.fromAddr;
  const activeTenantNs = await getActiveTenantNamespaces();

  // Scan all namespaces
  const namespaces  = await listNamespaces();
  let totalScanned  = 0;
  const newOrphans  = [];
  const deletedPVCs = [];

  for (const ns of namespaces) {
    const nsName = ns.metadata.name;
    // Only scan tenant namespaces and suspended ones
    if (!nsName.startsWith(TENANT_PREFIX)) continue;

    try {
      const pvcs = await getPVCsWithPodUsage(nsName);
      totalScanned += pvcs.length;

      for (const pvc of pvcs) {
        const isOrphanNS  = !activeTenantNs.has(nsName); // namespace itself inactive
        const isUnmounted = !pvc.isMounted;               // PVC not mounted by any pod

        if (isOrphanNS || isUnmounted) {
          if (pvc.orphanedAt) {
            // Already tagged — check if grace period elapsed
            const daysSinceTag = (Date.now() - new Date(pvc.orphanedAt)) / (1000 * 60 * 60 * 24);
            if (daysSinceTag >= GRACE_PERIOD_DAYS) {
              await deleteOrphanedPVC(nsName, pvc.name);
              deletedPVCs.push(pvc);
            } else {
              logger.debug({ namespace: nsName, pvc: pvc.name, daysLeft: GRACE_PERIOD_DAYS - daysSinceTag }, 'PVC in grace period');
            }
          } else {
            // Not yet tagged — tag it now
            await tagOrphanedPVC(nsName, pvc.name);
            newOrphans.push(pvc);
          }
        }
      }
    } catch (err) {
      logger.warn({ namespace: nsName, err: err.message }, 'Could not scan namespace PVCs');
    }
  }

  const totalSizeGi = [...newOrphans, ...deletedPVCs]
    .map(p => parseFloat(p.sizeGi) || 0)
    .reduce((a, b) => a + b, 0);

  await sendEmail({ to: adminEmail, ...buildStorageEmail(newOrphans, deletedPVCs, totalScanned, totalSizeGi) }, logger);

  publish(natsClient, 'tinai.maintenance.storage', {
    timestamp: new Date().toISOString(), totalScanned,
    newOrphans: newOrphans.length, deleted: deletedPVCs.length, dryRun: DRY_RUN,
  }, logger);
  publishAudit(natsClient, { event: 'storage.cleanup', newOrphans: newOrphans.length, deleted: deletedPVCs.length }, logger);

  logger.info({ totalScanned, newOrphans: newOrphans.length, deleted: deletedPVCs.length }, 'Storage cleanup complete');
  if (natsClient) await natsClient.drain();
  process.exit(0);
}

main().catch(err => { logger.fatal(err); process.exit(1); });
