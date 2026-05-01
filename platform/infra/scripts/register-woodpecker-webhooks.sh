#!/usr/bin/env bash
# register-woodpecker-webhooks.sh
# Registers Woodpecker CI webhooks for all tinai org repos in Forgejo.
# Usage: FORGEJO_TOKEN=<token> [FORGEJO_URL=https://git.tinai.cloud] [WOODPECKER_WEBHOOK_SECRET=<secret>] ./register-woodpecker-webhooks.sh

set -euo pipefail

FORGEJO_URL="${FORGEJO_URL:-https://git.tinai.cloud}"
FORGEJO_TOKEN="${FORGEJO_TOKEN:?FORGEJO_TOKEN env var is required}"
WOODPECKER_WEBHOOK_SECRET="${WOODPECKER_WEBHOOK_SECRET:-}"
WOODPECKER_HOOK_URL="${WOODPECKER_HOOK_URL:-http://woodpecker-server.woodpecker.svc.cluster.local:8000/hook}"
ORG="tinai"

REPOS=(
  tinai-api
  tinai-dashboard
  tinai-gateway
  tinai-auth
  tinai-realtime
  tinai-functions
  tinai-build-api
)

# ── helpers ────────────────────────────────────────────────────────────────────

forgejo_get() {
  curl -sf \
    -H "Authorization: token ${FORGEJO_TOKEN}" \
    -H "Content-Type: application/json" \
    "${FORGEJO_URL}${1}"
}

forgejo_post() {
  local path="$1"
  local body="$2"
  curl -sf \
    -X POST \
    -H "Authorization: token ${FORGEJO_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "${body}" \
    "${FORGEJO_URL}${path}"
}

# ── main loop ──────────────────────────────────────────────────────────────────

echo "Forgejo base URL : ${FORGEJO_URL}"
echo "Org              : ${ORG}"
echo "Woodpecker hook  : ${WOODPECKER_HOOK_URL}"
echo "---------------------------------------------------------------"

for REPO in "${REPOS[@]}"; do
  API_PATH="/api/v1/repos/${ORG}/${REPO}/hooks"

  # ---- check existing hooks --------------------------------------------------
  EXISTING=""
  EXISTING=$(forgejo_get "${API_PATH}" 2>/dev/null) || {
    echo "[ERROR] ${REPO}: failed to fetch hooks (check token / repo exists)"
    continue
  }

  # Check whether the Woodpecker hook URL is already registered
  if echo "${EXISTING}" | grep -qF "${WOODPECKER_HOOK_URL}"; then
    echo "[SKIP]    ${REPO}: webhook already exists"
    continue
  fi

  # ---- build payload ---------------------------------------------------------
  PAYLOAD=$(cat <<EOF
{
  "type": "gitea",
  "config": {
    "url": "${WOODPECKER_HOOK_URL}",
    "content_type": "json",
    "secret": "${WOODPECKER_WEBHOOK_SECRET}"
  },
  "events": ["push", "pull_request"],
  "active": true
}
EOF
)

  # ---- create hook -----------------------------------------------------------
  RESPONSE=""
  if RESPONSE=$(forgejo_post "${API_PATH}" "${PAYLOAD}" 2>/dev/null); then
    HOOK_ID=$(echo "${RESPONSE}" | grep -o '"id":[0-9]*' | head -1 | cut -d: -f2)
    echo "[CREATED] ${REPO}: hook id=${HOOK_ID}"
  else
    echo "[ERROR]   ${REPO}: failed to create webhook"
  fi
done

echo "---------------------------------------------------------------"
echo "Done."
