#!/usr/bin/env bash
# Tinai Guard — Tenant Provisioning Script
# Usage: ./provision-tenant.sh <slug> <name> <admin-email> <site-name>
# Example: ./provision-tenant.sh acme-retail "Acme Retail" admin@acme.com "Main Warehouse"

set -euo pipefail

SLUG="${1:?Usage: $0 <slug> <name> <admin_email> <site_name>}"
NAME="${2:?missing name}"
EMAIL="${3:?missing email}"
SITE="${4:?missing site name}"
API_URL="${TINAI_GUARD_API:-https://guard.tinai.cloud}"
PLATFORM_TOKEN="${TINAI_PLATFORM_TOKEN:?set TINAI_PLATFORM_TOKEN}"

echo "Provisioning tenant: $NAME ($SLUG)"

RESPONSE=$(curl -sf -X POST "$API_URL/api/v1/admin/provision" \
  -H "Authorization: Bearer $PLATFORM_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"tenant_name\": \"$NAME\",
    \"tenant_slug\": \"$SLUG\",
    \"admin_email\": \"$EMAIL\",
    \"admin_password\": \"$(openssl rand -base64 16)\",
    \"site_name\": \"$SITE\"
  }")

TENANT_ID=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['tenant_id'])")
HS_KEY=$(echo "$RESPONSE"   | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['hs_preauth_key'])")

echo ""
echo "✓ Tenant created"
echo "  Tenant ID:     $TENANT_ID"
echo "  Headscale key: $HS_KEY"
echo ""
echo "Edge device .env snippet:"
echo "─────────────────────────"
cat << ENV
HEADSCALE_URL=https://hs.tinai.cloud
HEADSCALE_PREAUTH_KEY=$HS_KEY
CLOUD_API_URL=$API_URL
DEVICE_TOKEN=<generate with: openssl rand -hex 32>
CAMERA_PASSWORD=<your camera RTSP password>
ENV
echo ""
echo "Next: flash edge device, copy .env, run: docker compose up -d"
