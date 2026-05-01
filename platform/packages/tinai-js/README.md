# @tinai/client

TypeScript client SDK for the [Tinai Cloud Platform](https://tinai.cloud) — India-sovereign PaaS.

Works in **browsers** and **Node.js** (≥ 18).

---

## Installation

```bash
npm install @tinai/client
# Node.js environments also need the ws package:
npm install ws
```

---

## Quick start

```ts
import { createClient } from '@tinai/client'

const tinai = createClient('https://api.tinai.cloud', {
  realtimeUrl: 'wss://realtime.tinai.cloud',
  // token: 'jwt...',  // optional at init — use auth.signIn() instead
})
```

---

## Authentication

```ts
// Email + password
const { session, error } = await tinai.auth.signIn({
  email: 'user@example.com',
  password: 'secret',
})

// Magic link / OTP — step 1: request the email
await tinai.auth.signInWithOtp({ email: 'user@example.com' })

// Magic link / OTP — step 2: verify the code
const { session } = await tinai.auth.verifyOtp({
  email: 'user@example.com',
  token: '123456',
})

// Get current session
const session = tinai.auth.getSession()  // TinaiSession | null

// Listen for auth changes
const { unsubscribe } = tinai.auth.onAuthStateChange(({ event, session }) => {
  if (event === 'SIGNED_IN')  console.log('Signed in:', session)
  if (event === 'SIGNED_OUT') console.log('Signed out')
})

// Sign out
tinai.auth.signOut()
```

Sessions are persisted in `localStorage` (browser) or in-memory (Node.js).

---

## Realtime — table-level subscriptions

```ts
const sub = tinai.db
  .from('orders')
  .on('INSERT', (payload) => {
    console.log('New order:', payload.record)
  })
  .on('UPDATE', (payload) => {
    console.log('Updated order:', payload.record, 'was:', payload.old_record)
  })
  .on('DELETE', (payload) => {
    console.log('Deleted order:', payload.old_record)
  })
  .subscribe()

// Channel auto-derived as tenant:{tenant_id}:orders

// Later:
sub.unsubscribe()
```

The `payload` object has the shape:

```ts
interface RealtimePayload<T> {
  event: 'INSERT' | 'UPDATE' | 'DELETE'
  table: string
  record: T
  old_record: T | null
  channel: string
}
```

---

## Realtime — channel-level subscriptions

```ts
const sub = tinai.channel('tenant:acme:logs')
  .on('broadcast', (payload) => console.log(payload))
  .subscribe()

sub.unsubscribe()
```

---

## RealtimeClient details

| Feature | Detail |
|---|---|
| Auto-reconnect | Exponential backoff: 100 ms → 200 ms → … → 30 s |
| Heartbeat | Ping every 30 s to detect dead connections |
| Pre-connection queue | subscribe/unsubscribe calls buffered until socket opens |
| Token update | Closing + reopening socket with new JWT after `signIn()` |
| Protocol | Hub: `{ action, channel }` · NATS bridge: `{ type, tenant_id }` |

---

## API reference

### `createClient(apiUrl, options?)`

| Param | Type | Description |
|---|---|---|
| `apiUrl` | `string` | Base URL of the Tinai REST API |
| `options.realtimeUrl` | `string` | WebSocket URL (default `wss://realtime.tinai.cloud`) |
| `options.token` | `string` | Optional JWT for pre-authenticated clients |

Returns a `TinaiClient`.

---

## License

MIT © Tinai
