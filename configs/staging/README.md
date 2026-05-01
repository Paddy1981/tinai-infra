# Tinai Staging Environment — Ryzen Node

## Quick Start Prompt for Claude Code

When you SSH into tinai-node1 and start Claude Code, use this prompt:

> "Set up Tinai staging on ryzen-node. The production system is running on tinai-node1 in namespaces tinai-system and tinai-apps. Create a tinai-staging namespace, deploy copies of the core services (postgres, redis, api, auth, dashboard) on ryzen-node using nodeSelector tinai.cloud/role=compute. Use different hostPorts (4000-4099 range) so they don't conflict with production. Point staging.tinai.cloud to the staging dashboard via Cloudflare Tunnel."

## Architecture

```
tinai-node1 (always on)          ryzen-node (on when needed)
├── tinai-system (PROD)          ├── tinai-staging
│   ├── postgres :5432           │   ├── postgres-staging :4432
│   ├── redis :6379              │   ├── redis-staging :4379
│   ├── tinai-api :3001          │   ├── tinai-api-staging :4001
│   ├── tinai-auth :3002         │   ├── tinai-auth-staging :4002
│   ├── tinai-dashboard :3000    │   ├── tinai-dashboard-staging :4000
│   └── ...                      │   └── ...
├── tinai-apps (PROD)            ├── tinai-staging-apps
│   ├── laruneng-com :3030       │   ├── laruneng-com-staging :4030
│   └── ...                      │   └── ...
└── monitoring                   └── (shares production monitoring)
```

## Key Decisions

- Staging gets its OWN PostgreSQL (not shared with prod)
- Staging uses port range 4000-4099 (prod uses 3000-3099)
- Images are the same (test before promoting to prod)
- Staging namespace: tinai-staging + tinai-staging-apps
- Node selector: tinai.cloud/role=compute (ryzen-node only)
- Staging domains: staging.tinai.cloud, staging-api.tinai.cloud

## Ryzen Node Info

- Tailscale IP: 100.92.239.124
- WSL2 Ubuntu 24.04, K3s agent v1.31.6
- 8 cores (Ryzen 9 7950X), 12GB RAM allocated
- Labels: tinai.cloud/role=compute, location=home
- Auto-starts: Tailscale + K3s agent on WSL boot
- vmIdleTimeout=-1 (WSL stays running)

## Production Manifests Reference

All production K3s manifests: ~/tinai/configs/k3s/
- postgres.yaml, redis.yaml, minio.yaml, forgejo.yaml
- core-services.yaml (api, auth, gateway, dashboard, etc.)
- laruneng.yaml, safetyforge.yaml, sattrack.yaml, astrodata.yaml
- larun-apps.yaml (coll, larun-se, larun-space)
- monitoring.yaml, ingress.yaml

## Workflow

1. Turn on Ryzen PC → WSL + K3s auto-start
2. Deploy/test changes in tinai-staging namespace
3. Verify at staging.tinai.cloud
4. If good → promote images to production
5. Turn off Ryzen PC when done
