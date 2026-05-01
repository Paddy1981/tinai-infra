#!/usr/bin/env bash
# DEPRECATED: This script is superseded by the Tenant Operator CRD.
# Use: kubectl apply -f - <<EOF
# apiVersion: tinai.cloud/v1alpha1
# kind: Tenant
# metadata:
#   name: <tenant-name>
# spec:
#   displayName: "<display>"
#   owner: "<email>"
#   plan: starter
# EOF
# Or: tinai tenant create <name> --plan=starter --owner=<email>
echo "ERROR: provision-tenant.sh is deprecated. Use 'tinai tenant create' or apply a Tenant CR." >&2
exit 1

# ---------------------------------------------------------------------------
# Original script preserved below for reference (no longer executed)
# ---------------------------------------------------------------------------
# provision-tenant.sh — Provision a new Tinai tenant namespace with all guardrails.
#
# Usage: ./provision-tenant.sh <tenant-name> <region: in|qa|ae>
#
# Creates:
#   - Namespace tinai-tenant-<tenant>
#   - Labels: tinai.cloud/tenant, tinai.cloud/region
#   - ResourceQuota  (4 CPU, 8Gi RAM, 50Gi storage, 20 pods)
#   - LimitRange     (default 100m/128Mi request; max 2000m/4Gi per container)
#   - NetworkPolicy  (deny-all ingress + egress, except traefik + DNS + cluster DNS)
#   - ServiceAccount tinai-tenant-<tenant>
#   - RoleBinding    (view role for tenant service account)
#
# Requirements: kubectl configured against the target cluster, with cluster-admin rights.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <tenant-name> <region: in|qa|ae>" >&2
  exit 1
fi

TENANT="$1"
REGION="$2"

# Validate tenant name: lowercase alphanumeric + hyphens, max 40 chars
if ! [[ "$TENANT" =~ ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$ ]]; then
  echo "Error: tenant name must be lowercase alphanumeric/hyphens, 1–40 chars." >&2
  exit 1
fi

# Validate region
case "$REGION" in
  in|qa|ae) ;;
  *)
    echo "Error: region must be one of: in, qa, ae" >&2
    exit 1
    ;;
esac

NAMESPACE="tinai-tenant-${TENANT}"
SA_NAME="tinai-tenant-${TENANT}"

echo "==> Provisioning tenant '${TENANT}' in region '${REGION}' (namespace: ${NAMESPACE})"

# ---------------------------------------------------------------------------
# 1. Namespace
# ---------------------------------------------------------------------------
echo "--> Creating namespace ${NAMESPACE}"
kubectl create namespace "${NAMESPACE}" --dry-run=client -o yaml | kubectl apply -f -

echo "--> Labelling namespace"
kubectl label namespace "${NAMESPACE}" \
  "tinai.cloud/tenant=${TENANT}" \
  "tinai.cloud/region=${REGION}" \
  "tinai.cloud/managed-by=provision-tenant" \
  --overwrite

# ---------------------------------------------------------------------------
# 2. ResourceQuota — hard limits per tenant namespace
# ---------------------------------------------------------------------------
echo "--> Applying ResourceQuota"
kubectl apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: tinai-tenant-quota
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
spec:
  hard:
    requests.cpu: "4"
    requests.memory: 8Gi
    limits.cpu: "8"
    limits.memory: 16Gi
    requests.storage: 50Gi
    persistentvolumeclaims: "10"
    pods: "20"
    services: "10"
    secrets: "20"
    configmaps: "20"
EOF

# ---------------------------------------------------------------------------
# 3. LimitRange — default + max per container
# ---------------------------------------------------------------------------
echo "--> Applying LimitRange"
kubectl apply -f - <<EOF
apiVersion: v1
kind: LimitRange
metadata:
  name: tinai-tenant-limits
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
spec:
  limits:
    - type: Container
      default:
        cpu: "200m"
        memory: 256Mi
      defaultRequest:
        cpu: "100m"
        memory: 128Mi
      max:
        cpu: "2000m"
        memory: 4Gi
      min:
        cpu: "50m"
        memory: 64Mi
    - type: PersistentVolumeClaim
      max:
        storage: 20Gi
      min:
        storage: 1Gi
EOF

# ---------------------------------------------------------------------------
# 4. NetworkPolicy — default deny-all, allow only necessary traffic
# ---------------------------------------------------------------------------
echo "--> Applying NetworkPolicy (deny-all default)"
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tinai-tenant-deny-all
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
spec:
  podSelector: {}
  policyTypes:
    - Ingress
    - Egress
EOF

echo "--> Applying NetworkPolicy (allow ingress from traefik)"
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tinai-tenant-allow-ingress-traefik
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
spec:
  podSelector: {}
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: traefik
EOF

echo "--> Applying NetworkPolicy (allow egress: DNS + cluster)"
kubectl apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tinai-tenant-allow-egress-dns-cluster
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
spec:
  podSelector: {}
  policyTypes:
    - Egress
  egress:
    # Allow DNS lookups via kube-dns / CoreDNS
    - ports:
        - port: 53
          protocol: UDP
        - port: 53
          protocol: TCP
    # Allow intra-namespace communication (pod to pod within same tenant)
    - to:
        - podSelector: {}
    # Allow access to Tinai platform services (tinai-system namespace)
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: tinai-system
EOF

# ---------------------------------------------------------------------------
# 5. ServiceAccount + RoleBinding
# ---------------------------------------------------------------------------
echo "--> Creating ServiceAccount ${SA_NAME}"
kubectl create serviceaccount "${SA_NAME}" \
  --namespace "${NAMESPACE}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "--> Applying RoleBinding (view role for tenant service account)"
kubectl apply -f - <<EOF
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: tinai-tenant-view
  namespace: ${NAMESPACE}
  labels:
    tinai.cloud/tenant: "${TENANT}"
subjects:
  - kind: ServiceAccount
    name: ${SA_NAME}
    namespace: ${NAMESPACE}
roleRef:
  kind: ClusterRole
  name: view
  apiGroup: rbac.authorization.k8s.io
EOF

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "==> Tenant '${TENANT}' provisioned successfully."
echo "    Namespace : ${NAMESPACE}"
echo "    Region    : ${REGION}"
echo "    SA        : ${SA_NAME}"
echo ""
echo "Next steps:"
echo "  1. Deploy database/cache: kubectl apply -f k8s/templates/<db>-tenant.yaml (after substituting TENANT_NAME)"
echo "  2. Deploy app: kubectl apply -f k8s/keda/scaledobject-apps.yaml (after substituting APP_NAME)"
echo "  3. Check quota: kubectl describe resourcequota tinai-tenant-quota -n ${NAMESPACE}"
