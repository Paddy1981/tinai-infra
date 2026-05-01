#!/usr/bin/env bash
# One-time Vault bootstrap — run after helm install.
# This is a reference script; adapt as needed.
set -euo pipefail

VAULT_ADDR=${VAULT_ADDR:-https://vault.vault.svc.cluster.local:8200}

echo "==> Initializing Vault..."
vault operator init -key-shares=5 -key-threshold=3 \
  -format=json > /tmp/vault-init.json

echo "==> Store /tmp/vault-init.json securely and delete after unsealing!"

echo "==> Unsealing (enter 3 of 5 keys)..."
for i in 1 2 3; do
  KEY=$(jq -r ".unseal_keys_b64[$((i-1))]" /tmp/vault-init.json)
  vault operator unseal "$KEY"
done

ROOT_TOKEN=$(jq -r '.root_token' /tmp/vault-init.json)
export VAULT_TOKEN="$ROOT_TOKEN"

echo "==> Enabling KV v2 secrets engine..."
vault secrets enable -path=secret kv-v2

echo "==> Enabling Kubernetes auth..."
vault auth enable kubernetes
vault write auth/kubernetes/config \
  kubernetes_host="https://kubernetes.default.svc"

echo "==> Creating tinai-external-secrets policy..."
vault policy write tinai-external-secrets - <<'EOF'
path "secret/data/tinai/*" {
  capabilities = ["read"]
}
EOF

echo "==> Binding policy to Kubernetes service account..."
vault write auth/kubernetes/role/tinai-external-secrets \
  bound_service_account_names=external-secrets \
  bound_service_account_namespaces=external-secrets \
  policies=tinai-external-secrets \
  ttl=1h

echo "==> Writing initial secrets (replace values!)..."
vault kv put secret/tinai/auth \
  database_url="postgresql://tinai:CHANGE_ME@postgres:5432/tinai_auth" \
  jwt_secret="CHANGE_ME_$(openssl rand -hex 32)"

vault kv put secret/tinai/postgres \
  admin_password="CHANGE_ME_$(openssl rand -hex 16)" \
  app_password="CHANGE_ME_$(openssl rand -hex 16)"

vault kv put secret/tinai/redis \
  password="CHANGE_ME_$(openssl rand -hex 16)"

echo "==> Writing gateway API key placeholders..."
vault kv put secret/tinai/gateway \
  anthropic_api_key="CHANGE_ME" \
  gemini_api_key="CHANGE_ME" \
  sarvam_api_key="CHANGE_ME_get_from_api.sarvam.ai" \
  krutrim_api_key="CHANGE_ME_get_from_cloud.olakrutrim.com"
vault kv patch secret/tinai/gateway razorpay_webhook_secret="REPLACE_WITH_RAZORPAY_WEBHOOK_SECRET"

# Alerting credentials (Falco Sidekick → Slack + PagerDuty)
vault kv put secret/tinai/alerting \
  slack_webhook_url="REPLACE_WITH_SLACK_WEBHOOK_URL" \
  pagerduty_routing_key="REPLACE_WITH_PAGERDUTY_ROUTING_KEY"

echo "==> Writing PostgreSQL backup MinIO credentials..."
# PostgreSQL backup MinIO credentials
vault kv put secret/tinai/minio \
  pg_backup_access_key="REPLACE_WITH_MINIO_ACCESS_KEY" \
  pg_backup_secret_key="REPLACE_WITH_MINIO_SECRET_KEY"

echo "==> Bootstrap complete. Rotate the root token:"
echo "    vault token revoke \$VAULT_TOKEN"

# Storage provisioner secrets
# vault kv put secret/tinai/storage-provisioner \
#   database_url="postgresql://tinai:CHANGE_ME@tinai-db-rw.tinai-system.svc.cluster.local:5432/tinai" \
#   db_namespace="tinai-databases"
# Note: MINIO_URL/ACCESS_KEY/SECRET_KEY reuse secret/tinai/minio (already bootstrapped)
