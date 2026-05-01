#!/bin/bash
# TinAI Forge Deployment Script
set -euo pipefail

echo "=== TinAI Forge Deployment ==="

# Check prerequisites
kubectl config current-context | grep -q "kubernetes-admin@kubernetes" || {
    echo "ERROR: Wrong kubectl context. Expected: kubernetes-admin@kubernetes"
    exit 1
}

# Create namespaces
echo "Creating namespaces..."
kubectl apply -f 00-namespace.yaml

# Apply RBAC
echo "Applying RBAC..."
kubectl apply -f 01-rbac.yaml

# Check if secrets exist, don't overwrite if they do
if ! kubectl get secret tinai-forge-config -n tinai-forge &>/dev/null; then
    echo "WARNING: tinai-forge-config secret not found."
    echo "Please create it manually with:"
    echo "  kubectl create secret generic tinai-forge-config -n tinai-forge \\"
    echo "    --from-literal=FORGE_DB_URL=postgresql://forge:PASSWORD@cnpg-cluster-rw.tinai-system:5432/tinai_forge \\"
    echo "    --from-literal=FORGE_API_KEY=your-api-key \\"
    echo "    --from-literal=FORGE_GITHUB_TOKEN=optional-token"
    echo ""
    echo "Applying template secret (CHANGE VALUES BEFORE USE)..."
    kubectl apply -f 02-secrets.yaml
fi

# ConfigMap
echo "Applying ConfigMap..."
kubectl apply -f 03-configmap.yaml

# Network policies
echo "Applying NetworkPolicies..."
kubectl apply -f 06-networkpolicy.yaml

# CronJob
echo "Applying CronJob..."
kubectl apply -f 07-cronjob.yaml

# Service
echo "Applying Services..."
kubectl apply -f 05-service.yaml

# Ingress
echo "Applying Ingress..."
kubectl apply -f 08-ingress.yaml

# Deployment (last, after all dependencies)
echo "Deploying tinai-forge..."
kubectl apply -f 04-deployment.yaml

# Wait for rollout
echo "Waiting for deployment..."
kubectl rollout status deployment/tinai-forge -n tinai-forge --timeout=120s

echo ""
echo "=== TinAI Forge Deployed Successfully ==="
echo "API endpoint: https://forge.tinai.cloud"
echo "Internal: http://tinai-forge.tinai-forge.svc.cluster.local:8090"
echo ""
echo "Next steps:"
echo "  1. Update secret values in 02-secrets.yaml and re-apply"
echo "  2. Initialize database: kubectl exec -n tinai-forge deploy/tinai-forge -- ./forge-server --migrate"
echo "  3. Check logs: kubectl logs -n tinai-forge deploy/tinai-forge -f"
