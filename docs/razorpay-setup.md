# Razorpay Setup for Tinai Cloud

## When company registration is complete:

### 1. Create Razorpay Account
- Go to https://razorpay.com
- Sign up with company details
- Complete KYC verification

### 2. Get API Keys
- Dashboard → Settings → API Keys → Generate Key
- Save: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET

### 3. Create Webhook
- Dashboard → Webhooks → Create Webhook
- URL: https://api.tinai.cloud/api/v1/payments/webhook
- Events: payment.captured, subscription.activated, subscription.cancelled
- Save the webhook secret

### 4. Configure on Server
```bash
# Add to tinai-api secrets
sudo kubectl create secret generic tinai-razorpay \
  --namespace tinai-system \
  --from-literal=RAZORPAY_KEY_ID="rzp_live_xxxxx" \
  --from-literal=RAZORPAY_KEY_SECRET="xxxxx" \
  --from-literal=RAZORPAY_WEBHOOK_SECRET="xxxxx" \
  --dry-run=client -o yaml | sudo kubectl apply -f -

# Add env vars to API deployment
sudo kubectl set env deployment/tinai-api -n tinai-system --from=secret/tinai-razorpay

# Restart API
sudo kubectl rollout restart deployment/tinai-api -n tinai-system
```

### 5. Add Razorpay checkout script to dashboard
Add to `app/layout.tsx`:
```html
<script src="https://checkout.razorpay.com/v1/checkout.js" async></script>
```

### 6. Test
- Visit https://tinai.cloud/pricing
- Click Upgrade on Starter plan
- Use Razorpay test card: 4111 1111 1111 1111

## Pricing Plans

| Plan | Monthly | Yearly | Features |
|------|---------|--------|----------|
| Free | ₹0 | ₹0 | 3 apps, 1 DB, 1 GB storage |
| Starter | ₹499 | ₹4,999 | 10 apps, 3 DBs, 10 GB storage |
| Pro | ₹1,999 | ₹19,999 | 20 apps, 5 DBs, 50 GB storage |
| Enterprise | Custom | Custom | Unlimited everything |

All prices + 18% GST
