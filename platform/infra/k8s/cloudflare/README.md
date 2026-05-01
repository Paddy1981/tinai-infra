# Cloudflare + Traefik Setup for tinai.cloud

## 1. DNS — Wildcard record for tenant apps

In the Cloudflare dashboard for `tinai.cloud`, create an **A record**:

- **Name:** `*.apps`
- **IPv4 address:** `<cluster load balancer IP>`
- **Proxy status:** Proxied (orange cloud)

This routes all `<appname>.apps.tinai.cloud` hostnames through Cloudflare and on to the cluster ingress.

## 2. SSL/TLS Mode

In **SSL/TLS > Overview**, set the encryption mode to **Full (strict)**.

- Cloudflare encrypts traffic to the origin using a valid certificate (issued by cert-manager / Let's Encrypt).
- Do **not** use "Flexible" — it terminates TLS at Cloudflare and sends plain HTTP to the origin, which breaks the cert-manager ACME HTTP-01 challenge and is insecure.

## 3. Always Use HTTPS

In **SSL/TLS > Edge Certificates**, enable **Always Use HTTPS**.

Traefik also enforces this redirect via the `--entrypoints.web.http.redirections` argument in `traefik-cloudflare-values.yaml`, providing a defence-in-depth redirect even if the Cloudflare setting is ever toggled off.

## 4. Tiered Cache for Indian PoPs

In **Caching > Tiered Cache**, enable **Smart Tiered Cache**. Cloudflare will automatically select the upper-tier PoP closest to the origin. For an origin cluster in India, this typically resolves to the **Chennai** or **Mumbai** PoP, reducing cache-miss latency for Indian end-users.

For explicit control, use the Cloudflare API to pin the upper-tier PoP:
```
PUT /zones/{zone_id}/argo/tiered_caching
{ "value": "on" }
```

## 5. Cloudflare Workers — Edge caching for static Next.js assets

Deploy a Worker to serve `/_next/static/*` assets from the edge cache:

```js
// worker.js (attach to *.apps.tinai.cloud route)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Cache static Next.js chunks at the edge for 1 year (they are content-addressed)
    if (url.pathname.startsWith('/_next/static/')) {
      const cache = caches.default;
      let response = await cache.match(request);
      if (!response) {
        response = await fetch(request);
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
        response = new Response(response.body, { ...response, headers });
        env.ctx.waitUntil(cache.put(request, response.clone()));
      }
      return response;
    }
    return fetch(request);
  },
};
```

## 6. Rate Limiting — Auth endpoints

In **Security > WAF > Rate Limiting Rules**, create a rule:

| Field          | Value                     |
|----------------|---------------------------|
| Expression     | `http.request.uri.path matches "^/api/v1/auth/"` |
| Action         | Block                     |
| Threshold      | 100 requests              |
| Period         | 60 seconds                |
| Counting scope | Per IP (`ip.src`)         |

This prevents credential-stuffing attacks on the authentication surface without impacting normal users.
