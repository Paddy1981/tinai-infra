# IndiaAI Sovereign Gateway — Setup Guide

## Overview

The sovereign gateway routes to:
- **Sarvam AI**: Vikram-105B and Vikram-8B (api.sarvam.ai)
- **Krutrim**: Krutrim-Pro and Krutrim-2 (cloud.olakrutrim.com)

Endpoint: `POST /sovereign/v1/chat/completions`
Models list: `GET /sovereign/models`
Response header: `X-Tinai-Sovereign: true`

## Getting API Keys

### Sarvam AI
1. Register at https://dashboard.sarvam.ai
2. Create an API key under Settings → API Keys
3. Pricing: Vikram-105B ₹1.80/1K input, ₹9.00/1K output

### Krutrim
1. Register at https://cloud.olakrutrim.com
2. Create API key under your account
3. Pricing: Krutrim-Pro ₹1.20/1K input, ₹6.00/1K output

## Provisioning in Vault

Run after bootstrap.sh:
```bash
vault kv patch secret/tinai/gateway \
  sarvam_api_key="your-sarvam-key-here" \
  krutrim_api_key="your-krutrim-key-here"
```

ESO will sync to the `tinai-gateway-secrets` Kubernetes Secret within 1 hour
(or immediately: `kubectl annotate externalsecret tinai-gateway-secrets -n tinai-system force-sync=$(date +%s)`).

## Verifying

```bash
# Check sovereign models
curl -H "Authorization: Bearer $JWT" https://gateway.tinai.cloud/sovereign/models

# Test a sovereign request
curl -X POST https://gateway.tinai.cloud/sovereign/v1/chat/completions \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"model":"sarvam-vikram-8b","messages":[{"role":"user","content":"नमस्ते"}]}'
```

## Model Reference

| Model ID | Provider | Input (₹/1K) | Output (₹/1K) |
|---|---|---|---|
| sarvam-vikram-105b | Sarvam AI | 1.80 | 9.00 |
| sarvam-vikram-8b | Sarvam AI | 0.60 | 3.00 |
| krutrim-pro | Krutrim | 1.20 | 6.00 |
| krutrim-2 | Krutrim | 2.00 | 10.00 |
