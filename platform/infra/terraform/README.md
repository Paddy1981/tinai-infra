# tinai.cloud — Multi-Region Terraform IaC

Provisions k3s clusters on Hetzner Cloud for three sovereign regions.

## Regions

| Code | Location | Hetzner DC | CIDR |
|------|----------|------------|------|
| `in` | India | Singapore (sin) | 10.10.0.0/16 |
| `qa` | Qatar / Gulf | Falkenstein (fsn1) | 10.20.0.0/16 |
| `ae` | UAE | Nuremberg (nbg1) | 10.30.0.0/16 |

## Prerequisites

- [OpenTofu](https://opentofu.org/) ≥ 1.7 (or Terraform ≥ 1.7)
- Hetzner Cloud API token (per-region or shared)
- SSH key uploaded to Hetzner Cloud as `tinai-ops`
- MinIO bucket `tinai-tf-state` accessible at `minio.tinai.cloud`

## Deploy a region

```bash
cd environments/in
tofu init -backend-config="access_key=MINIO_KEY" -backend-config="secret_key=MINIO_SECRET"
tofu plan -var="hcloud_token=$HCLOUD_TOKEN_IN"
tofu apply -var="hcloud_token=$HCLOUD_TOKEN_IN"
```

## After apply

Retrieve the kubeconfig:
```bash
tofu output -raw kubeconfig_command | bash > ~/.kube/tinai-in.yaml
```

## Module structure

```
modules/
  hetzner-network/   — VPC, subnet, firewall
  k3s-cluster/       — control-plane + workers, floating IP, cloud-init
  cloudflare-dns/    — Cloudflare geo-steering load balancer (api.tinai.cloud)
environments/
  in/               — India production cluster (Hetzner Singapore)
  qa/               — Qatar production cluster (Hetzner Falkenstein)
  ae/               — UAE production cluster (Hetzner Nuremberg)
  global/           — Cloudflare geo-routing DNS (apply after all three clusters)
```

## Global environment — Cloudflare geo-routing

After deploying all three region clusters, run `tofu apply` in `environments/global/`
with the three ingress IPs as variables:

```bash
cd environments/global
tofu init -backend-config="access_key=MINIO_KEY" -backend-config="secret_key=MINIO_SECRET"

tofu apply \
  -var="cloudflare_api_token=$CF_API_TOKEN" \
  -var="cloudflare_account_id=$CF_ACCOUNT_ID" \
  -var="cloudflare_zone_id=$CF_ZONE_ID" \
  -var="in_ip=$(tofu -chdir=../in output -raw ingress_ip)" \
  -var="qa_ip=$(tofu -chdir=../qa output -raw ingress_ip)" \
  -var="ae_ip=$(tofu -chdir=../ae output -raw ingress_ip)"
```

### Geo-steering rules

| Traffic origin | Routed to pool | Notes |
|----------------|---------------|-------|
| Asia / Oceania (SEAS, NEAS, OC) | `tinai-in` (Singapore) | Primary region |
| Middle East (ME) | `tinai-qa` (Falkenstein) | Nearest Hetzner to MENA |
| Europe (WEU, EEU, NEU) | `tinai-qa` (Falkenstein) | EU traffic via Frankfurt |
| Default / everywhere else | `tinai-in` (Singapore) | Global fallback |

Health check: HTTPS GET `/healthz` → expect HTTP 200, interval 60 s, timeout 10 s.
