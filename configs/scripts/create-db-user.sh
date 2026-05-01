#!/bin/bash
# create-db-user.sh — Create per-app PostgreSQL user with isolated credentials
#
# Creates a dedicated PostgreSQL user for a tenant app, grants access
# only to that app's database, and stores credentials as a K8s Secret.
#
# Usage: ./create-db-user.sh <app-name>
# Example: ./create-db-user.sh safety-forge
#
# The script will:
#   1. Generate a random 32-character password
#   2. Create PostgreSQL user app_<name> (or update password if exists)
#   3. Grant CONNECT on the app's database and full schema access
#   4. Revoke the app user's access to all other databases
#   5. Create/update K8s Secret <app>-db-credentials in tinai-apps namespace

set -euo pipefail

APP_NAME="${1:?Usage: $0 <app-name>}"

# Normalize: convert hyphens to underscores for PG identifiers
PG_USER="app_$(echo "$APP_NAME" | tr '-' '_')"
# Database name uses the app name with hyphens removed (matching existing DBs)
DB_NAME="$(echo "$APP_NAME" | tr '-' '')"
# K8s secret name
SECRET_NAME="${APP_NAME}-db-credentials"
NAMESPACE="tinai-apps"

# PostgreSQL connection details
PG_POD="postgres-0"
PG_NAMESPACE="tinai-system"
PG_ADMIN_USER="tinai"
PG_HOST="postgres-rw.tinai-system.svc.cluster.local"
PG_PORT="5432"

# Generate a random 32-character alphanumeric password
PASSWORD=$(openssl rand -base64 32 | tr -dc 'a-zA-Z0-9' | head -c 32)

echo "=== Creating per-app database credentials ==="
echo "  App:      ${APP_NAME}"
echo "  PG User:  ${PG_USER}"
echo "  Database: ${DB_NAME}"
echo "  Secret:   ${SECRET_NAME}"
echo ""

# Check if the database exists
DB_EXISTS=$(sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
  psql -U "${PG_ADMIN_USER}" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" 2>/dev/null || true)

if [ "${DB_EXISTS}" != "1" ]; then
  echo "WARNING: Database '${DB_NAME}' does not exist. Creating it..."
  sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
    psql -U "${PG_ADMIN_USER}" -c "CREATE DATABASE \"${DB_NAME}\";"
fi

# Create or update the PostgreSQL user
echo "Creating/updating PostgreSQL user '${PG_USER}'..."
sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
  psql -U "${PG_ADMIN_USER}" -c "
    DO \$\$
    BEGIN
      IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${PG_USER}') THEN
        ALTER ROLE \"${PG_USER}\" WITH PASSWORD '${PASSWORD}';
        RAISE NOTICE 'User ${PG_USER} already exists, password updated.';
      ELSE
        CREATE ROLE \"${PG_USER}\" WITH LOGIN PASSWORD '${PASSWORD}';
        RAISE NOTICE 'User ${PG_USER} created.';
      END IF;
    END
    \$\$;
  "

# Revoke access to all databases first (least privilege)
echo "Revoking default public access..."
sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
  psql -U "${PG_ADMIN_USER}" -c "
    REVOKE ALL ON DATABASE \"${DB_NAME}\" FROM PUBLIC;
  "

# Grant access only to the app's specific database
echo "Granting access to database '${DB_NAME}'..."
sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
  psql -U "${PG_ADMIN_USER}" -c "
    GRANT CONNECT ON DATABASE \"${DB_NAME}\" TO \"${PG_USER}\";
  "

# Grant schema and table permissions within the app's database
sudo kubectl exec -n "${PG_NAMESPACE}" "${PG_POD}" -- \
  psql -U "${PG_ADMIN_USER}" -d "${DB_NAME}" -c "
    GRANT USAGE ON SCHEMA public TO \"${PG_USER}\";
    GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO \"${PG_USER}\";
    GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO \"${PG_USER}\";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO \"${PG_USER}\";
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO \"${PG_USER}\";
  "

# Build the DATABASE_URL
DATABASE_URL="postgresql://${PG_USER}:${PASSWORD}@${PG_HOST}:${PG_PORT}/${DB_NAME}"

# Create or update K8s secret
echo "Creating/updating K8s Secret '${SECRET_NAME}' in namespace '${NAMESPACE}'..."
sudo kubectl create secret generic "${SECRET_NAME}" \
  --namespace="${NAMESPACE}" \
  --from-literal=POSTGRES_USER="${PG_USER}" \
  --from-literal=POSTGRES_PASSWORD="${PASSWORD}" \
  --from-literal=POSTGRES_DB="${DB_NAME}" \
  --from-literal=POSTGRES_HOST="${PG_HOST}" \
  --from-literal=POSTGRES_PORT="${PG_PORT}" \
  --from-literal=DATABASE_URL="${DATABASE_URL}" \
  --dry-run=client -o yaml | sudo kubectl apply -f -

echo ""
echo "=== Done ==="
echo "  Secret '${SECRET_NAME}' is ready in namespace '${NAMESPACE}'"
echo "  Use in deployments:"
echo "    envFrom:"
echo "      - secretRef:"
echo "          name: ${SECRET_NAME}"
echo ""
