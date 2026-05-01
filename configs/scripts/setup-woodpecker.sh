#!/usr/bin/env bash
# setup-woodpecker.sh — Deploy Woodpecker CI on K3s with Forgejo integration
#
# Prerequisites:
#   - K3s running with kubectl access
#   - Forgejo running at localhost:3010 with admin user tinai-admin
#   - jq installed
#
# Usage:
#   bash ~/tinai/configs/scripts/setup-woodpecker.sh
set -euo pipefail

FORGEJO_URL="http://localhost:3010"
FORGEJO_INTERNAL_URL="http://forgejo.tinai-system.svc.cluster.local:3000"
FORGEJO_USER="tinai-admin"
FORGEJO_PASS="${FORGEJO_PASS:-tinai-admin}"
WOODPECKER_HOST="http://localhost:8000"
MANIFEST_DIR="$HOME/tinai/configs/k3s"

echo "=========================================="
echo " Woodpecker CI Setup for Tinai PaaS"
echo "=========================================="

# ── Step 1: Generate agent secret ──────────────────────────────────
AGENT_SECRET=$(openssl rand -hex 32)
echo "[1/6] Generated agent secret: ${AGENT_SECRET:0:8}..."

# ── Step 2: Create Forgejo API token ───────────────────────────────
echo "[2/6] Creating Forgejo API token..."

# Delete existing token if present (idempotent)
curl -sf -X DELETE \
  -u "${FORGEJO_USER}:${FORGEJO_PASS}" \
  "${FORGEJO_URL}/api/v1/users/${FORGEJO_USER}/tokens/woodpecker-ci" 2>/dev/null || true

TOKEN_RESPONSE=$(curl -sf -X POST \
  -u "${FORGEJO_USER}:${FORGEJO_PASS}" \
  -H "Content-Type: application/json" \
  -d '{"name":"woodpecker-ci","scopes":["all"]}' \
  "${FORGEJO_URL}/api/v1/users/${FORGEJO_USER}/tokens")

FORGEJO_TOKEN=$(echo "${TOKEN_RESPONSE}" | jq -r '.sha1 // .token // empty')
if [ -z "${FORGEJO_TOKEN}" ]; then
  echo "[ERROR] Failed to create Forgejo API token. Response: ${TOKEN_RESPONSE}"
  exit 1
fi
echo "  Token created: ${FORGEJO_TOKEN:0:8}..."

# ── Step 3: Create OAuth2 app in Forgejo for Woodpecker ───────────
echo "[3/6] Creating Forgejo OAuth2 application..."

# Check if OAuth app already exists
EXISTING_APPS=$(curl -sf \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_URL}/api/v1/user/applications/oauth2" 2>/dev/null || echo "[]")

EXISTING_ID=$(echo "${EXISTING_APPS}" | jq -r '.[] | select(.name == "Woodpecker CI") | .id // empty')
if [ -n "${EXISTING_ID}" ]; then
  echo "  Deleting existing OAuth app id=${EXISTING_ID}..."
  curl -sf -X DELETE \
    -H "Authorization: token ${FORGEJO_TOKEN}" \
    "${FORGEJO_URL}/api/v1/user/applications/oauth2/${EXISTING_ID}" || true
fi

OAUTH_RESPONSE=$(curl -sf -X POST \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"Woodpecker CI\",
    \"redirect_uris\": [\"${WOODPECKER_HOST}/authorize\"],
    \"confidential_client\": true
  }" \
  "${FORGEJO_URL}/api/v1/user/applications/oauth2")

OAUTH_CLIENT_ID=$(echo "${OAUTH_RESPONSE}" | jq -r '.client_id // empty')
OAUTH_CLIENT_SECRET=$(echo "${OAUTH_RESPONSE}" | jq -r '.client_secret // empty')

if [ -z "${OAUTH_CLIENT_ID}" ] || [ -z "${OAUTH_CLIENT_SECRET}" ]; then
  echo "[ERROR] Failed to create OAuth2 app. Response: ${OAUTH_RESPONSE}"
  exit 1
fi
echo "  OAuth Client ID: ${OAUTH_CLIENT_ID}"
echo "  OAuth Client Secret: ${OAUTH_CLIENT_SECRET:0:8}..."

# ── Step 4: Patch secrets in manifest ──────────────────────────────
echo "[4/6] Updating K8s manifest with credentials..."

# Use sed to replace placeholder values in the woodpecker manifest
WOODPECKER_YAML="${MANIFEST_DIR}/woodpecker.yaml"
cp "${WOODPECKER_YAML}" "${WOODPECKER_YAML}.bak"

sed -i "s|REPLACE_WITH_OAUTH_CLIENT_ID|${OAUTH_CLIENT_ID}|g" "${WOODPECKER_YAML}"
sed -i "s|REPLACE_WITH_OAUTH_CLIENT_SECRET|${OAUTH_CLIENT_SECRET}|g" "${WOODPECKER_YAML}"
sed -i "s|REPLACE_WITH_AGENT_SECRET|${AGENT_SECRET}|g" "${WOODPECKER_YAML}"

echo "  Manifest updated: ${WOODPECKER_YAML}"

# ── Step 5: Apply K8s manifests ────────────────────────────────────
echo "[5/6] Applying Woodpecker manifests to K3s..."

kubectl apply -f "${WOODPECKER_YAML}"

echo "  Waiting for woodpecker-server to be ready..."
kubectl rollout status deployment/woodpecker-server -n woodpecker --timeout=120s || {
  echo "[WARN] Server not ready yet. Check: kubectl logs -n woodpecker -l app=woodpecker-server"
}

echo "  Waiting for woodpecker-agent to be ready..."
kubectl rollout status deployment/woodpecker-agent -n woodpecker --timeout=120s || {
  echo "[WARN] Agent not ready yet. Check: kubectl logs -n woodpecker -l app=woodpecker-agent"
}

# ── Step 6: Register webhooks in Forgejo repos ────────────────────
echo "[6/6] Registering webhooks in Forgejo repositories..."

HOOK_URL="http://woodpecker-server.woodpecker.svc.cluster.local:8000/hook"
REPOS="hello-tinai"

# Also register for any repos under the 'tinai' org if they exist
ORG_REPOS=$(curl -sf \
  -H "Authorization: token ${FORGEJO_TOKEN}" \
  "${FORGEJO_URL}/api/v1/orgs/tinai/repos" 2>/dev/null | jq -r '.[].name' 2>/dev/null || echo "")

if [ -n "${ORG_REPOS}" ]; then
  for r in ${ORG_REPOS}; do
    REPOS="${REPOS} ${r}"
  done
fi

# De-duplicate
REPOS=$(echo "${REPOS}" | tr ' ' '\n' | sort -u | tr '\n' ' ')

for REPO in ${REPOS}; do
  # Try user repo first, then org repo
  for OWNER in "${FORGEJO_USER}" "tinai"; do
    API_PATH="/api/v1/repos/${OWNER}/${REPO}/hooks"

    EXISTING=$(curl -sf \
      -H "Authorization: token ${FORGEJO_TOKEN}" \
      "${FORGEJO_URL}${API_PATH}" 2>/dev/null) || continue

    if echo "${EXISTING}" | grep -qF "${HOOK_URL}"; then
      echo "  [SKIP] ${OWNER}/${REPO}: webhook already exists"
      continue
    fi

    PAYLOAD=$(cat <<EOJSON
{
  "type": "gitea",
  "config": {
    "url": "${HOOK_URL}",
    "content_type": "json"
  },
  "events": ["push", "pull_request"],
  "active": true
}
EOJSON
)
    RESPONSE=$(curl -sf -X POST \
      -H "Authorization: token ${FORGEJO_TOKEN}" \
      -H "Content-Type: application/json" \
      -d "${PAYLOAD}" \
      "${FORGEJO_URL}${API_PATH}" 2>/dev/null) && {
      HOOK_ID=$(echo "${RESPONSE}" | jq -r '.id // empty')
      echo "  [CREATED] ${OWNER}/${REPO}: hook id=${HOOK_ID}"
    } || echo "  [SKIP] ${OWNER}/${REPO}: not found or no permission"
  done
done

echo ""
echo "=========================================="
echo " Woodpecker CI setup complete!"
echo "=========================================="
echo ""
echo " Server UI:    ${WOODPECKER_HOST}"
echo " Login:        Click 'Login with Gitea' -> use tinai-admin credentials"
echo " Forgejo:      ${FORGEJO_URL}"
echo ""
echo " Verify:"
echo "   kubectl get pods -n woodpecker"
echo "   kubectl get pods -n tinai-build"
echo "   kubectl logs -n woodpecker -l app=woodpecker-server --tail=20"
echo ""
echo " To add a pipeline to a repo:"
echo "   1. Copy ~/tinai/configs/woodpecker/sample-pipeline.yml to .woodpecker.yml in the repo root"
echo "   2. git add .woodpecker.yml && git commit -m 'Add CI pipeline' && git push"
echo "   3. Open ${WOODPECKER_HOST} to see the build"
echo ""
