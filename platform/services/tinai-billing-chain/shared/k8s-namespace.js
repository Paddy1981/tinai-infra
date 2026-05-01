// shared/k8s-namespace.js
// Manages tenant K8s namespace lifecycle:
//   suspend  — scale all deployments to 0 (data preserved)
//   resume   — restore replica counts
//   delete   — remove namespace entirely (irreversible)
//
// Uses the K8s API via in-cluster ServiceAccount token.
// The billing-chain ServiceAccount needs these RBAC permissions:
//   - deployments: get, list, patch (in tenant namespaces)
//   - namespaces: get, delete

const K8S_API = 'https://kubernetes.default.svc';
const TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';
const CA_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt';

import { readFileSync } from 'fs';

function getToken() {
  if (process.env.NODE_ENV === 'development') return process.env.K8S_TOKEN ?? 'dev-token';
  return readFileSync(TOKEN_PATH, 'utf-8').trim();
}

async function k8sRequest(path, method = 'GET', body = null, logger) {
  const token = getToken();
  const contentType = method === 'PATCH' ? 'application/merge-patch+json' : 'application/json';
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
      Accept: 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${K8S_API}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`K8s API ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json();
}

/**
 * Suspend a tenant namespace — scale all Deployments to 0.
 * Annotates each Deployment with its previous replica count for resume.
 */
export async function suspendNamespace(namespace, logger) {
  logger?.info({ namespace }, 'Suspending namespace');

  // List all deployments in the namespace
  const { items: deployments } = await k8sRequest(
    `/apis/apps/v1/namespaces/${namespace}/deployments`,
    'GET', null, logger
  );

  for (const dep of deployments) {
    const name = dep.metadata.name;
    const currentReplicas = dep.spec.replicas ?? 1;

    // Annotate with current replica count before zeroing
    await k8sRequest(
      `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
      'PATCH',
      {
        metadata: {
          annotations: {
            'tinai.cloud/pre-suspend-replicas': String(currentReplicas),
            'tinai.cloud/suspended-at': new Date().toISOString(),
          },
        },
        spec: { replicas: 0 },
      },
      logger
    );

    logger?.debug({ namespace, deployment: name, was: currentReplicas }, 'Deployment scaled to 0');
  }

  logger?.info({ namespace, deployments: deployments.length }, 'Namespace suspended');
  return { namespace, deploymentsScaled: deployments.length };
}

/**
 * Resume a previously suspended namespace — restore replica counts from annotations.
 */
export async function resumeNamespace(namespace, logger) {
  logger?.info({ namespace }, 'Resuming namespace');

  const { items: deployments } = await k8sRequest(
    `/apis/apps/v1/namespaces/${namespace}/deployments`,
    'GET', null, logger
  );

  for (const dep of deployments) {
    const name = dep.metadata.name;
    const prevReplicas = parseInt(dep.metadata.annotations?.['tinai.cloud/pre-suspend-replicas'] ?? '1', 10);

    await k8sRequest(
      `/apis/apps/v1/namespaces/${namespace}/deployments/${name}`,
      'PATCH',
      { spec: { replicas: prevReplicas } },
      logger
    );

    logger?.debug({ namespace, deployment: name, replicas: prevReplicas }, 'Deployment resumed');
  }

  logger?.info({ namespace, deployments: deployments.length }, 'Namespace resumed');
  return { namespace, deploymentsRestored: deployments.length };
}

/**
 * Delete a tenant namespace entirely.
 * IRREVERSIBLE — only call after data retention period has passed.
 */
export async function deleteNamespace(namespace, logger) {
  logger?.warn({ namespace }, 'Deleting namespace — IRREVERSIBLE');
  await k8sRequest(`/api/v1/namespaces/${namespace}`, 'DELETE', null, logger);
  logger?.info({ namespace }, 'Namespace deleted');
  return { namespace, deleted: true };
}

/**
 * Derive K8s namespace name from tenant/subscription ID.
 * e.g. 'acme-corp' → 'tenant-acme-corp'
 */
export function tenantToNamespace(tenantId, prefix = 'tenant-') {
  if (!tenantId || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantId)) {
    throw new Error(`Invalid tenantId for namespace: ${tenantId}`);
  }
  return `${prefix}${tenantId}`;
}
