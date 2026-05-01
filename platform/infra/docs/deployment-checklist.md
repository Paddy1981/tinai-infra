# TinAI First-Cluster Deployment Checklist

Work through these steps in order. Each step depends on the previous.

---

## 1. Vault Bootstrap

```bash
# From inside the cluster (exec into a temp pod with vault CLI, or use port-forward)
export VAULT_ADDR=https://vault.vault.svc.cluster.local:8200
bash k8s/vault/bootstrap.sh
```

- Saves unseal keys + root token to `/tmp/vault-init.json`
- Store the five unseal keys and root token in a password manager **before** deleting the file
- The script writes placeholder secrets for: `auth`, `postgres`, `redis`, and `gateway`

After bootstrap, rotate placeholder values:

```bash
# Postgres passwords
vault kv patch secret/tinai/postgres \
  admin_password="$(openssl rand -hex 24)" \
  app_password="$(openssl rand -hex 24)"

# Redis password
vault kv patch secret/tinai/redis \
  password="$(openssl rand -hex 24)"

# Auth JWT secret
vault kv patch secret/tinai/auth \
  jwt_secret="$(openssl rand -hex 32)"
```

---

## 2. External Secrets Operator (ESO) Install

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm install external-secrets external-secrets/external-secrets \
  -n external-secrets --create-namespace \
  --set installCRDs=true
```

Apply the ClusterSecretStore and all ExternalSecrets:

```bash
kubectl apply -f k8s/vault/cluster-secret-store.yaml
kubectl apply -f k8s/vault/external-secrets.yaml
```

Verify all ExternalSecrets are synced:

```bash
kubectl get externalsecrets -n tinai-system
# All should show READY=True and STATUS=SecretSynced
```

---

## 3. ArgoCD Bootstrap

```bash
helm repo add argo https://argoproj.github.io/argo-helm
helm install argocd argo/argo-cd \
  -n argocd --create-namespace \
  -f k8s/argocd/values.yaml

# Apply the root App-of-Apps
kubectl apply -f k8s/argocd/app-of-apps.yaml
```

Retrieve initial admin password:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath="{.data.password}" | base64 -d
```

---

## 4. Sarvam AI + Krutrim API Keys in Vault

Get keys from the provider dashboards (see `docs/sovereign-gateway-setup.md`), then:

```bash
vault kv patch secret/tinai/gateway \
  sarvam_api_key="your-sarvam-key-here" \
  krutrim_api_key="your-krutrim-key-here"
```

Force an immediate ESO sync:

```bash
kubectl annotate externalsecret tinai-gateway-secrets \
  -n tinai-system \
  force-sync=$(date +%s) --overwrite
```

---

## 5. Postgres Credentials Secret

Ensure the `postgres-credentials` ExternalSecret synced correctly (step 2). Confirm
the CloudNativePG cluster can read it:

```bash
kubectl get secret postgres-credentials -n tinai-system -o jsonpath='{.data}' | jq 'keys'
# Expected: ["password", "postgres-password"]
```

---

## 6. Redis Credentials Secret

Confirm the `redis-credentials` secret synced:

```bash
kubectl get secret redis-credentials -n tinai-system -o jsonpath='{.data}' | jq 'keys'
# Expected: ["redis-password"]
```

---

## 7. OIDC Provider Environment Variables

The auth service requires OIDC client credentials for Google/GitHub SSO. Patch them
into Vault (they are not written by bootstrap.sh because they require external
registration first):

```bash
vault kv patch secret/tinai/auth \
  google_client_id="your-google-client-id" \
  google_client_secret="your-google-client-secret" \
  github_client_id="your-github-client-id" \
  github_client_secret="your-github-client-secret" \
  public_url="https://auth.tinai.cloud"
```

Then add these keys to `k8s/vault/external-secrets.yaml` under `tinai-auth-secrets`
if not already present, and re-apply.

---

## 8. Woodpecker CI — Forgejo OAuth App Registration

1. In Forgejo, go to **Site Administration → Applications → OAuth2 Applications**
2. Create a new application:
   - Name: `Woodpecker CI`
   - Redirect URI: `https://ci.tinai.cloud/authorize`
3. Copy the Client ID and Client Secret
4. Write them to Vault:

```bash
vault kv put secret/tinai/woodpecker \
  forgejo_client_id="your-client-id" \
  forgejo_client_secret="your-client-secret" \
  agent_secret="$(openssl rand -hex 32)"
```

5. Add a corresponding ExternalSecret to `k8s/vault/external-secrets.yaml` for
   `woodpecker-secrets` targeting `secret/tinai/woodpecker`.

---

## Post-Deploy Smoke Tests

```bash
# Gateway sovereign models endpoint
curl -H "Authorization: Bearer $JWT" https://gateway.tinai.cloud/sovereign/models

# Auth health
curl https://auth.tinai.cloud/health

# API health
curl https://api.tinai.cloud/health
```

---

## Quick-Reference: Vault Paths

| Path | Contents |
|---|---|
| `secret/tinai/auth` | database_url, jwt_secret, google/github OIDC creds, public_url |
| `secret/tinai/api` | database_url, jwt_secret, minio credentials |
| `secret/tinai/postgres` | admin_password, app_password |
| `secret/tinai/redis` | password |
| `secret/tinai/gateway` | anthropic_api_key, gemini_api_key, sarvam_api_key, krutrim_api_key |
| `secret/tinai/minio` | root_password |
| `secret/tinai/backup` | database_url |
| `secret/tinai/woodpecker` | forgejo_client_id, forgejo_client_secret, agent_secret |
