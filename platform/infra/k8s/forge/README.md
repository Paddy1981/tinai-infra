# TinAI Forge - Kubernetes Infrastructure

This directory contains all Kubernetes manifests and deployment scripts for TinAI Forge on E2E Networks Kubernetes cluster.

## Directory Structure

```
forge/
├── 00-namespace.yaml          # Namespaces: tinai-forge, tinai-forge-test
├── 01-rbac.yaml              # ServiceAccount, ClusterRole, ClusterRoleBinding
├── 02-secrets.yaml           # Secrets: tinai-forge-config, tinai-registry-credentials
├── 03-configmap.yaml         # ConfigMap: forge configuration
├── 04-deployment.yaml        # Main tinai-forge deployment
├── 05-service.yaml           # ClusterIP service + internal proxy service
├── 06-networkpolicy.yaml     # Egress/Ingress policies for isolation
├── 07-cronjob.yaml           # Version check CronJob (every 6 hours)
├── 08-ingress.yaml           # HTTPS ingress at forge.tinai.cloud
├── 09-postgres-db.yaml       # Database initialization ConfigMap
├── deploy.sh                 # Automated deployment script (executable)
├── helm/
│   ├── Chart.yaml            # Helm chart metadata
│   └── values.yaml           # Helm default values
└── README.md                 # This file
```

## Prerequisites

- kubectl configured with `kubernetes-admin@kubernetes` context
- Access to E2E Networks Kubernetes cluster
- Existing namespaces: `tinai-system`, `forgejo`, `tinai-build`, `tinai-staging`
- Docker registry credentials for `registry.e2enetworks.net`
- PostgreSQL connection to CloudNativePG cluster

## Quick Start

### 1. Prepare Secrets

Update the secret values in `02-secrets.yaml` with real credentials:

```bash
# Edit the file with actual values
nano 02-secrets.yaml
```

Required secrets:
- `FORGE_DB_URL`: PostgreSQL connection string
- `FORGE_API_KEY`: Authentication key for forge API
- `FORGE_GITHUB_TOKEN`: (optional) GitHub token for higher rate limits
- Docker registry credentials (base64 encoded)

### 2. Deploy

```bash
# Automated deployment
./deploy.sh

# Or manual step-by-step:
kubectl apply -f 00-namespace.yaml
kubectl apply -f 01-rbac.yaml
kubectl apply -f 02-secrets.yaml
kubectl apply -f 03-configmap.yaml
kubectl apply -f 06-networkpolicy.yaml
kubectl apply -f 07-cronjob.yaml
kubectl apply -f 05-service.yaml
kubectl apply -f 08-ingress.yaml
kubectl apply -f 04-deployment.yaml
```

### 3. Verify Deployment

```bash
# Check pod status
kubectl get pods -n tinai-forge

# Watch logs
kubectl logs -n tinai-forge deploy/tinai-forge -f

# Check health
kubectl port-forward -n tinai-forge svc/tinai-forge 8090:8090
curl http://localhost:8090/healthz
```

## Configuration

All configuration is managed through ConfigMap `tinai-forge-config`:

```yaml
CHECK_INTERVAL_HOURS: "6"          # Version check frequency
AUTO_BUILD_PATCH: "true"           # Auto-build patch releases
AUTO_BUILD_MINOR: "false"          # Auto-build minor releases
REGISTRY_HOST: "registry.e2enetworks.net"
REGISTRY_PROJECT: "tinai"
KUBE_NAMESPACE: "tinai-forge"      # Deployment namespace
TEST_NAMESPACE: "tinai-forge-test" # Test jobs namespace
PROMETHEUS_URL: "..."              # Metrics endpoint
API_PORT: "8090"                   # Service port
WATCHED_PRODUCTS: "..."            # Comma-separated product list
```

To update: Edit `03-configmap.yaml` and reapply:

```bash
kubectl apply -f 03-configmap.yaml
kubectl rollout restart deployment/tinai-forge -n tinai-forge
```

## RBAC Permissions

The `tinai-forge` ServiceAccount has permissions to:

- **Jobs**: Create, read, list, watch, delete, patch in `tinai-forge` and `tinai-forge-test`
- **Pods**: Create, read, list, watch, delete in `tinai-forge-test`
- **Services**: Create, read, list, delete in `tinai-forge-test`
- **Secrets/ConfigMaps**: Read in `tinai-forge` namespace
- **Deployments**: Read, list, patch, update
- **Pod Logs**: Read

## Network Policies

### tinai-forge egress rules:
- DNS (UDP/TCP 53)
- Kubernetes API (TCP 6443)
- Docker registry (TCP 80, 443)
- GitHub API (TCP 443)
- PostgreSQL (TCP 5432)

### tinai-forge-test isolation:
- Only ingress from `tinai-forge` namespace
- Egress to DNS, pod-to-pod, and registry

## Database Setup

PostgreSQL database configuration is stored in ConfigMap `tinai-forge-db-init` (in `tinai-system` namespace).

To initialize the database:

```bash
# Connect to PostgreSQL and execute init script
kubectl apply -f 09-postgres-db.yaml
# Then run the SQL commands from the ConfigMap
```

## Helm Deployment

Alternative deployment using Helm:

```bash
helm install tinai-forge ./helm \
  --namespace tinai-forge \
  --set image.tag=v1.0.0 \
  --set config.checkIntervalHours=6
```

## Monitoring

The deployment exposes Prometheus metrics on port 8090:

- Scrape target: `http://tinai-forge.tinai-forge.svc.cluster.local:8090/metrics`
- Prometheus annotations enabled in deployment

## Ingress Configuration

Ingress is configured for `forge.tinai.cloud`:
- HTTPS with Let's Encrypt certificate
- Basic authentication (requires `tinai-forge-basic-auth` secret)
- NGINX ingress controller required

To set up basic auth:

```bash
# Create basic auth secret
htpasswd -c auth username
kubectl create secret generic tinai-forge-basic-auth -n tinai-forge --from-file=auth
```

## Troubleshooting

### Pod not starting
```bash
kubectl describe pod -n tinai-forge -l app=tinai-forge
kubectl logs -n tinai-forge deploy/tinai-forge
```

### Registry authentication issues
Check the `tinai-registry-credentials` secret:
```bash
kubectl get secret tinai-registry-credentials -n tinai-forge -o jsonpath='{.data.\.dockerconfigjson}' | base64 -d | jq .
```

### Database connectivity
Check the database URL in secret:
```bash
kubectl get secret tinai-forge-config -n tinai-forge -o jsonpath='{.data.FORGE_DB_URL}' | base64 -d
```

### Network policy issues
Check if policies are blocking traffic:
```bash
kubectl describe networkpolicy tinai-forge-egress -n tinai-forge
kubectl describe networkpolicy tinai-forge-test-isolation -n tinai-forge-test
```

## Maintenance

### Updating the image
```bash
kubectl set image deployment/tinai-forge -n tinai-forge \
  forge=registry.e2enetworks.net/tinai/tinai-forge:v1.0.0
```

### Scaling (note: singleton application)
```bash
# tinai-forge is designed as a singleton (replicas: 1)
# Do not scale to multiple replicas without refactoring for distributed operation
```

### Backup/Export manifests
```bash
# Export current state
kubectl get all -n tinai-forge -o yaml > forge-backup.yaml

# Export specific resource types
kubectl get deployment,service,configmap,secret -n tinai-forge -o yaml > forge-resources.yaml
```

## Uninstall

```bash
# Remove all resources
kubectl delete -f 04-deployment.yaml
kubectl delete -f 08-ingress.yaml
kubectl delete -f 05-service.yaml
kubectl delete -f 07-cronjob.yaml
kubectl delete -f 06-networkpolicy.yaml
kubectl delete -f 03-configmap.yaml
kubectl delete -f 02-secrets.yaml
kubectl delete -f 01-rbac.yaml
kubectl delete -f 00-namespace.yaml
```

## Next Steps

1. Configure secrets with real credentials
2. Initialize PostgreSQL database
3. Build and push tinai-forge container image
4. Run `./deploy.sh`
5. Verify pod is running and accessible
6. Configure DNS for `forge.tinai.cloud`
7. Set up monitoring in Prometheus
8. Enable audit logging if needed
