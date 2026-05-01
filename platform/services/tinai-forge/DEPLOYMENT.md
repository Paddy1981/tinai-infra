# TinAI Forge Deployment Guide

## Prerequisites

- Kubernetes cluster (1.25+)
- PostgreSQL database (14+)
- Docker registry (e.g., E2E Networks registry)
- Kubernetes namespace: `tinai-forge`
- Prometheus for metrics (optional but recommended)

## Build Steps

### 1. Build Binary Locally

```bash
make build
# Output: bin/forge-server
```

### 2. Build Docker Image

```bash
# Using Makefile
make docker DOCKER_IMAGE=registry.e2enetworks.net/tinai/forge DOCKER_TAG=latest

# Or manually
docker build -t registry.e2enetworks.net/tinai/forge:latest .
docker push registry.e2enetworks.net/tinai/forge:latest
```

## Kubernetes Deployment

### 1. Create Namespace

```bash
kubectl create namespace tinai-forge
```

### 2. Create ConfigMap for Patches

```bash
# Create directories for product patches
mkdir -p patches/{forgejo,grafana,prometheus,woodpecker}

# Add your custom branding patches
# patches/forgejo/templates/
# patches/grafana/provisioning/
# etc.

# Create ConfigMap
kubectl create configmap tinai-patches \
  --from-file=patches/forgejo=patches/forgejo \
  --from-file=patches/grafana=patches/grafana \
  -n tinai-forge
```

### 3. Create Secrets

```bash
# GitHub API token (optional, for higher rate limits)
kubectl create secret generic github-credentials \
  --from-literal=token=ghp_XXXXXXXXXXXXXXXXXXXX \
  -n tinai-forge

# Registry credentials for Docker push
kubectl create secret docker-registry registry-credentials \
  --docker-server=registry.e2enetworks.net \
  --docker-username=<username> \
  --docker-password=<password> \
  -n tinai-forge

# API key for dashboard access
kubectl create secret generic forge-api-key \
  --from-literal=api-key=forge-secret-key-here \
  -n tinai-forge
```

### 4. Create ServiceAccount and RBAC

```bash
kubectl create serviceaccount tinai-forge-builder -n tinai-forge

# Grant permissions for building and testing
kubectl create role tinai-forge-builder \
  --verb=create,get,list,watch,delete \
  --resource=jobs,pods,secrets \
  -n tinai-forge

kubectl create rolebinding tinai-forge-builder \
  --serviceaccount=tinai-forge:tinai-forge-builder \
  --role=tinai-forge-builder \
  -n tinai-forge
```

### 5. PostgreSQL Setup

```bash
# Create database
psql -U postgres -h postgres-host -c "CREATE DATABASE tinai_forge;"

# Connect and verify
psql -U postgres -h postgres-host -d tinai_forge

# Schema will be initialized automatically by the application
```

### 6. Deploy Forge Server

Create `deployment.yaml`:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: forge-config
  namespace: tinai-forge
data:
  FORGE_KUBE_NAMESPACE: tinai-forge
  FORGE_TEST_NAMESPACE: tinai-forge-test
  FORGE_REGISTRY_HOST: registry.e2enetworks.net
  FORGE_REGISTRY_PROJECT: tinai
  FORGE_CHECK_INTERVAL_HOURS: "6"
  FORGE_AUTO_BUILD_PATCH: "true"
  FORGE_AUTO_BUILD_MINOR: "false"
  FORGE_API_PORT: "8090"
  FORGE_PROMETHEUS_URL: "http://kube-prometheus-stack-prometheus.monitoring:9090"

---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tinai-forge
  namespace: tinai-forge
  labels:
    app: tinai-forge
spec:
  replicas: 1
  selector:
    matchLabels:
      app: tinai-forge
  template:
    metadata:
      labels:
        app: tinai-forge
    spec:
      serviceAccountName: tinai-forge-builder
      containers:
      - name: forge
        image: registry.e2enetworks.net/tinai/forge:latest
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 8090
          name: api
          protocol: TCP
        envFrom:
        - configMapRef:
            name: forge-config
        env:
        - name: FORGE_DB_URL
          valueFrom:
            secretKeyRef:
              name: forge-db
              key: url
        - name: FORGE_GITHUB_TOKEN
          valueFrom:
            secretKeyRef:
              name: github-credentials
              key: token
              optional: true
        - name: FORGE_API_KEY
          valueFrom:
            secretKeyRef:
              name: forge-api-key
              key: api-key
              optional: true
        livenessProbe:
          httpGet:
            path: /health
            port: 8090
          initialDelaySeconds: 30
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health
            port: 8090
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
        resources:
          requests:
            cpu: 100m
            memory: 128Mi
          limits:
            cpu: 500m
            memory: 512Mi
        volumeMounts:
        - name: patches
          mountPath: /app/patches
          readOnly: true
      volumes:
      - name: patches
        configMap:
          name: tinai-patches
          optional: true

---
apiVersion: v1
kind: Service
metadata:
  name: tinai-forge
  namespace: tinai-forge
  labels:
    app: tinai-forge
spec:
  type: ClusterIP
  ports:
  - port: 8090
    targetPort: 8090
    name: api
  selector:
    app: tinai-forge
```

Deploy:

```bash
kubectl apply -f deployment.yaml
```

### 7. Create Test Namespace

```bash
kubectl create namespace tinai-forge-test
```

### 8. Ingress (Optional)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: tinai-forge
  namespace: tinai-forge
spec:
  ingressClassName: nginx
  rules:
  - host: forge.tinai.local
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: tinai-forge
            port:
              number: 8090
```

## Environment Variables (Complete Reference)

### Required
- `FORGE_DB_URL` - PostgreSQL connection string

### Database (Alternative to FORGE_DB_URL)
- `PGUSER` - Default: forge
- `PGPASSWORD` - Database password
- `PGHOST` - Default: localhost
- `PGPORT` - Default: 5432
- `PGDATABASE` - Default: tinai_forge

### Kubernetes
- `FORGE_KUBE_NAMESPACE` - Default: tinai-forge
- `FORGE_TEST_NAMESPACE` - Default: tinai-forge-test
- `KUBECONFIG` - Optional, empty = use in-cluster config

### Registry
- `FORGE_REGISTRY_HOST` - Default: registry.e2enetworks.net
- `FORGE_REGISTRY_PROJECT` - Default: tinai

### GitHub
- `FORGE_GITHUB_TOKEN` - Optional, for higher rate limits

### Monitoring
- `FORGE_PROMETHEUS_URL` - Default: http://kube-prometheus-stack-prometheus.monitoring:9090

### Watcher
- `FORGE_CHECK_INTERVAL_HOURS` - Default: 6
- `FORGE_AUTO_BUILD_PATCH` - Default: true
- `FORGE_AUTO_BUILD_MINOR` - Default: false

### API
- `FORGE_API_PORT` - Default: 8090
- `FORGE_API_KEY` - Optional, for API authentication

## Verification

### 1. Check Deployment

```bash
kubectl get deployment -n tinai-forge
kubectl get pods -n tinai-forge
```

### 2. Check Logs

```bash
kubectl logs -n tinai-forge -l app=tinai-forge -f
```

### 3. Test API

```bash
# Port-forward to the service
kubectl port-forward -n tinai-forge svc/tinai-forge 8090:8090

# Health check
curl http://localhost:8090/health

# List products
curl http://localhost:8090/api/forge/products
```

### 4. Test Database Connection

```bash
# Connect to pod and test
kubectl exec -it -n tinai-forge deployment/tinai-forge -- sh

# Inside pod:
psql $FORGE_DB_URL -c "SELECT * FROM forge_products;"
```

## Monitoring Setup

### Prometheus Rules (Optional)

Create ServiceMonitor for Prometheus:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: tinai-forge
  namespace: tinai-forge
spec:
  selector:
    matchLabels:
      app: tinai-forge
  endpoints:
  - port: api
    interval: 30s
```

### Grafana Dashboard

Create dashboards for:
- Build success/failure rates
- Rollout progress
- CVE detections
- Upstream version checks

## Troubleshooting

### Pod fails to start

```bash
# Check pod events
kubectl describe pod -n tinai-forge <pod-name>

# Check logs
kubectl logs -n tinai-forge <pod-name>

# Check database connection
FORGE_DB_URL=... psql -c "SELECT 1"
```

### Cannot reach API

```bash
# Check service
kubectl get svc -n tinai-forge

# Test DNS
kubectl exec -it -n tinai-forge pod/<pod-name> -- nslookup tinai-forge

# Port-forward and test
kubectl port-forward -n tinai-forge svc/tinai-forge 8090:8090
curl http://localhost:8090/health
```

### GitHub rate limits

- Add `FORGE_GITHUB_TOKEN` environment variable
- Increases limit from 60 to 5000 requests/hour

### Database schema issues

- Check database logs
- Manually run schema.sql if initialization fails
- Verify FORGE_DB_URL is correct

## Scaling

For production:

1. Use 3+ replicas (with leader election for scheduler)
2. Use RWO volumes for patch files
3. Configure PDB for zero-downtime updates
4. Set up log aggregation
5. Configure backup strategy for PostgreSQL

## Cleanup

```bash
# Delete all resources
kubectl delete namespace tinai-forge

# Or selectively
kubectl delete deployment tinai-forge -n tinai-forge
kubectl delete svc tinai-forge -n tinai-forge
kubectl delete configmap tinai-patches -n tinai-forge
```

## Next Steps

1. Configure custom patches for your products
2. Set up dashboard/UI for monitoring
3. Integrate with your tenant management system
4. Configure auto-promotion workflows
5. Set up alerting for failed builds/tests
