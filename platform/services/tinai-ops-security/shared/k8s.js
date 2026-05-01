// shared/k8s.js
// K8s API client for maintenance services.
// Uses in-cluster ServiceAccount token — no kubeconfig needed.

import { readFileSync } from 'fs';

const K8S_API = 'https://kubernetes.default.svc';

function token() {
  if (process.env.NODE_ENV === 'development') return process.env.K8S_TOKEN ?? 'dev';
  try { return readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf-8').trim(); }
  catch { return process.env.K8S_TOKEN ?? ''; }
}

export async function k8sGet(path) {
  const res = await fetch(`${K8S_API}${path}`, {
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`K8s GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function k8sPatch(path, body, contentType = 'application/merge-patch+json') {
  const res = await fetch(`${K8S_API}${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': contentType, Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`K8s PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function k8sPost(path, body) {
  const res = await fetch(`${K8S_API}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`K8s POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function k8sDelete(path) {
  const res = await fetch(`${K8S_API}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`K8s DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Convenience helpers ───────────────────────────────────────────────────────

export async function listNamespaces(labelSelector = '') {
  const path = `/api/v1/namespaces${labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : ''}`;
  const data = await k8sGet(path);
  return data.items ?? [];
}

export async function listNodes() {
  const data = await k8sGet('/api/v1/nodes');
  return data.items ?? [];
}

export async function listPods(namespace, labelSelector = '') {
  const path = `/api/v1/namespaces/${namespace}/pods${labelSelector ? `?labelSelector=${encodeURIComponent(labelSelector)}` : ''}`;
  const data = await k8sGet(path);
  return data.items ?? [];
}

export async function listPVCs(namespace = '') {
  const path = namespace
    ? `/api/v1/namespaces/${namespace}/persistentvolumeclaims`
    : '/api/v1/persistentvolumeclaims';
  const data = await k8sGet(path);
  return data.items ?? [];
}

export async function listDeployments(namespace) {
  const data = await k8sGet(`/apis/apps/v1/namespaces/${namespace}/deployments`);
  return data.items ?? [];
}

export async function listSecrets(namespace) {
  const data = await k8sGet(`/api/v1/namespaces/${namespace}/secrets`);
  return data.items ?? [];
}

export async function getCertificates(namespace = '') {
  const path = namespace
    ? `/apis/cert-manager.io/v1/namespaces/${namespace}/certificates`
    : '/apis/cert-manager.io/v1/certificates';
  const data = await k8sGet(path);
  return data.items ?? [];
}

export async function listCronJobs(namespace) {
  const data = await k8sGet(`/apis/batch/v1/namespaces/${namespace}/cronjobs`);
  return data.items ?? [];
}

export async function rolloutRestart(namespace, deploymentName) {
  return k8sPatch(
    `/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`,
    {
      spec: {
        template: {
          metadata: {
            annotations: { 'kubectl.kubernetes.io/restartedAt': new Date().toISOString() },
          },
        },
      },
    }
  );
}
