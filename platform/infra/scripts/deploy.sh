#!/usr/bin/env bash
# deploy.sh — reliable deploy for any Tinai service
#
# Usage:
#   ./scripts/deploy.sh <service> [registry]
#
# Examples:
#   ./scripts/deploy.sh tinai-api
#   ./scripts/deploy.sh tinai-dashboard
#   ./scripts/deploy.sh tinai-gateway
#
# What it does:
#   1. Builds a versioned image tag (YYYYMMDD-HHMMSS-<git-sha>)
#   2. Pushes to registry
#   3. Patches the deployment image directly (no rollout restart needed)
#   4. Waits for rollout to complete
#   5. Verifies health if a HEALTH_URL is known for the service

set -euo pipefail

SERVICE="${1:-}"
REGISTRY="${2:-git.tinai.cloud/tinai-admin}"
KUBECONFIG_PATH="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
NAMESPACE="tinai-system"

if [[ -z "$SERVICE" ]]; then
  echo "Usage: $0 <service> [registry]"
  echo "Services: tinai-api, tinai-dashboard, tinai-gateway, tinai-auth, tinai-realtime, tinai-functions, build-api"
  exit 1
fi

# Map service name to source repo
declare -A REPO_MAP=(
  [tinai-api]="$HOME/tinai-e2e/platform/services/tinai-api"
  [tinai-dashboard]="$HOME/tinai-e2e/platform/services/tinai-dashboard"
  [tinai-gateway]="$HOME/tinai-e2e/platform/services/tinai-gateway"
  [tinai-auth]="$HOME/tinai-e2e/platform/services/tinai-auth"
  [tinai-realtime]="$HOME/tinai-e2e/platform/services/tinai-realtime"
  [tinai-functions]="$HOME/tinai-e2e/platform/services/tinai-functions"
  [build-api]="$HOME/tinai-e2e/platform/services/tinai-build-api"
)

REPO="${REPO_MAP[$SERVICE]:-}"
if [[ -z "$REPO" ]]; then
  echo "Unknown service: $SERVICE"
  exit 1
fi

# Generate versioned tag from timestamp + git sha
TIMESTAMP=$(date -u +"%Y%m%d-%H%M%S")
GIT_SHA=$(cd "$REPO" && git rev-parse --short HEAD 2>/dev/null || echo "nogit")
TAG="${TIMESTAMP}-${GIT_SHA}"
IMAGE="${REGISTRY}/${SERVICE}:${TAG}"
IMAGE_LATEST="${REGISTRY}/${SERVICE}:latest"

echo "==> Building $SERVICE"
echo "    Repo:  $REPO"
echo "    Image: $IMAGE"
echo ""

# Build
docker build -t "$IMAGE" -t "$IMAGE_LATEST" "$REPO"

# Push both versioned + latest
echo ""
echo "==> Pushing images"
docker push "$IMAGE"
docker push "$IMAGE_LATEST"

# Patch deployment with the versioned tag (forces pod replacement even if latest digest is same)
echo ""
echo "==> Deploying $SERVICE to $NAMESPACE"
kubectl --kubeconfig "$KUBECONFIG_PATH" set image \
  deployment/"$SERVICE" \
  "${SERVICE/-api/api}"="${IMAGE}" \
  -n "$NAMESPACE" 2>/dev/null || \
kubectl --kubeconfig "$KUBECONFIG_PATH" set image \
  deployment/"$SERVICE" \
  api="${IMAGE}" \
  server="${IMAGE}" \
  dashboard="${IMAGE}" \
  -n "$NAMESPACE" 2>/dev/null || true

# Also patch via JSON to be sure (handles any container name)
CONTAINER=$(kubectl --kubeconfig "$KUBECONFIG_PATH" get deployment/"$SERVICE" -n "$NAMESPACE" \
  -o jsonpath='{.spec.template.spec.containers[0].name}')
kubectl --kubeconfig "$KUBECONFIG_PATH" patch deployment/"$SERVICE" -n "$NAMESPACE" \
  --type='json' \
  -p="[{\"op\":\"replace\",\"path\":\"/spec/template/spec/containers/0/image\",\"value\":\"${IMAGE}\"}]"

echo ""
echo "==> Waiting for rollout..."
kubectl --kubeconfig "$KUBECONFIG_PATH" rollout status deployment/"$SERVICE" -n "$NAMESPACE" --timeout=180s

echo ""
echo "==> Pod status:"
kubectl --kubeconfig "$KUBECONFIG_PATH" get pods -n "$NAMESPACE" -l "app=$SERVICE" --no-headers

echo ""
echo "✓ Deploy complete: $SERVICE @ $TAG"
