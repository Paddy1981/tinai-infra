#!/usr/bin/env bash
# =============================================================================
# vault-bootstrap.sh — Load all Tinai credentials into Vault
# =============================================================================
# Run ONCE after Vault init on E2E node.
# Prerequisites:
#   - Vault is running and unsealed
#   - VAULT_ADDR and VAULT_TOKEN are set
#   - credentials-e2e.env exists at ~/tinai-e2e/credentials-e2e.env
#
# Usage:
#   export VAULT_ADDR=http://127.0.0.1:8200
#   export VAULT_TOKEN=<root-token-from-init>
#   ./scripts/vault-bootstrap.sh
#
# After running:
#   1. Verify: vault kv list secret/tinai
#   2. DELETE credentials-e2e.env from disk
#   3. Never store this script's output
# =============================================================================

set -euo pipefail

CREDS_FILE="${1:-$HOME/tinai-e2e/credentials-e2e.env}"

if [ ! -f "$CREDS_FILE" ]; then
  echo "ERROR: Credentials file not found: $CREDS_FILE"
  echo "Usage: $0 [path-to-credentials-e2e.env]"
  exit 1
fi

if [ -z "${VAULT_ADDR:-}" ] || [ -z "${VAULT_TOKEN:-}" ]; then
  echo "ERROR: VAULT_ADDR and VAULT_TOKEN must be set"
  echo "  export VAULT_ADDR=http://127.0.0.1:8200"
  echo "  export VAULT_TOKEN=<root-token>"
  exit 1
fi

# Source the credentials file
set -a
source "$CREDS_FILE"
set +a

echo "=== Vault Bootstrap: Loading Tinai credentials ==="
echo "Vault: $VAULT_ADDR"
echo ""

# Enable KV v2 secrets engine if not already enabled
vault secrets enable -path=secret kv-v2 2>/dev/null || echo "KV v2 already enabled at secret/"

# --- PostgreSQL ---
echo "[1/9] Loading PostgreSQL credentials..."
vault kv put secret/tinai/postgres \
  POSTGRES_USER="$POSTGRES_USER" \
  POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  POSTGRES_REPLICATION_PASSWORD="$POSTGRES_REPLICATION_PASSWORD" \
  DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@postgres.tinai-system.svc.cluster.local:5432/tinai?sslmode=require"

# --- Redis ---
echo "[2/9] Loading Redis credentials..."
vault kv put secret/tinai/redis \
  REDIS_PASSWORD="$REDIS_PASSWORD" \
  REDIS_URL="redis://:${REDIS_PASSWORD}@redis.tinai-system.svc.cluster.local:6379"

# --- MinIO ---
echo "[3/9] Loading MinIO credentials..."
vault kv put secret/tinai/minio \
  MINIO_ROOT_USER="$MINIO_ROOT_USER" \
  MINIO_ROOT_PASSWORD="$MINIO_ROOT_PASSWORD"

# --- Auth / JWT ---
echo "[4/9] Loading Auth credentials..."
vault kv put secret/tinai/auth \
  JWT_SECRET="$JWT_SECRET" \
  CSRF_SECRET="$CSRF_SECRET" \
  SESSION_SECRET="$SESSION_SECRET"

# --- Forgejo ---
echo "[5/9] Loading Forgejo credentials..."
vault kv put secret/tinai/forgejo \
  FORGEJO_ADMIN_USER="$FORGEJO_ADMIN_USER" \
  FORGEJO_ADMIN_PASSWORD="$FORGEJO_ADMIN_PASSWORD" \
  FORGEJO_ADMIN_TOKEN="$FORGEJO_ADMIN_TOKEN" \
  FORGEJO_WEBHOOK_SECRET="$FORGEJO_WEBHOOK_SECRET" \
  FORGEJO_RUNNER_TOKEN="$FORGEJO_RUNNER_TOKEN"

# --- Forge Engine ---
echo "[6/9] Loading Forge credentials..."
vault kv put secret/tinai/forge \
  FORGE_API_KEY="$FORGE_API_KEY"

# --- Woodpecker CI ---
echo "[7/9] Loading Woodpecker credentials..."
vault kv put secret/tinai/woodpecker \
  WOODPECKER_AGENT_SECRET="$WOODPECKER_AGENT_SECRET" \
  WOODPECKER_GITEA_CLIENT="$WOODPECKER_GITEA_CLIENT" \
  WOODPECKER_GITEA_SECRET="$WOODPECKER_GITEA_SECRET"

# --- Grafana ---
echo "[8/9] Loading Grafana credentials..."
vault kv put secret/tinai/grafana \
  GRAFANA_ADMIN_USER="$GRAFANA_ADMIN_USER" \
  GRAFANA_ADMIN_PASSWORD="$GRAFANA_ADMIN_PASSWORD"

# --- Stalwart Mail ---
echo "[9/9] Loading Stalwart credentials..."
vault kv put secret/tinai/stalwart \
  STALWART_ADMIN_USER="$STALWART_ADMIN_USER" \
  STALWART_ADMIN_PASSWORD="$STALWART_ADMIN_PASSWORD"

# --- External API keys (placeholder — update when you have real keys) ---
vault kv put secret/tinai/external-apis \
  ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  SARVAM_API_KEY="$SARVAM_API_KEY" \
  KRUTRIM_API_KEY="$KRUTRIM_API_KEY" \
  POSTMARK_API_KEY="$POSTMARK_API_KEY" \
  MSG91_API_KEY="$MSG91_API_KEY"

# --- Billing (placeholder) ---
vault kv put secret/tinai/billing \
  LAGO_API_KEY="$LAGO_API_KEY" \
  RAZORPAY_KEY_ID="$RAZORPAY_KEY_ID" \
  RAZORPAY_KEY_SECRET="$RAZORPAY_KEY_SECRET"

echo ""
echo "=== Vault Bootstrap Complete ==="
echo ""
echo "Verify with: vault kv list secret/tinai"
echo ""
echo "IMPORTANT: Now delete the credentials file:"
echo "  rm $CREDS_FILE"
echo ""

# List what was stored
vault kv list secret/tinai
