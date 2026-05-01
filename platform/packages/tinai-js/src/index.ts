/**
 * @tinai/client — TypeScript client SDK for the Tinai Cloud Platform.
 *
 * @example
 * ```ts
 * import { createClient } from '@tinai/client'
 *
 * const tinai = createClient('https://api.tinai.cloud', {
 *   realtimeUrl: 'wss://realtime.tinai.cloud',
 *   token: 'optional-jwt',
 * })
 *
 * // Auth
 * await tinai.auth.signIn({ email: 'user@example.com', password: 'secret' })
 *
 * // Realtime (table-level)
 * const sub = tinai.db
 *   .from('orders')
 *   .on('INSERT', (payload) => console.log(payload))
 *   .subscribe()
 *
 * sub.unsubscribe()
 *
 * // Realtime (channel-level)
 * const sub2 = tinai.channel('tenant:acme:logs')
 *   .on('broadcast', (payload) => console.log(payload))
 *   .subscribe()
 * ```
 */

export { createClient } from './factory.js';
export { TinaiClient } from './client.js';
export { AuthClient } from './auth.js';
export { RealtimeClient } from './realtime.js';
export { DatabaseBuilder, TableBuilder } from './database.js';
export { Channel } from './channel.js';

// Type-only exports — no runtime overhead.
export type {
  TinaiClientOptions,
  TinaiSession,
  SignInOptions,
  SignInWithOtpOptions,
  VerifyOtpOptions,
  AuthChangeEvent,
  AuthStateChange,
  AuthStateChangeCallback,
  RealtimeEventType,
  RealtimePayload,
  RealtimeCallback,
  ChannelEventType,
  ChannelCallback,
  Subscription,
  ServerMessage,
  HubSubscribeMessage,
  NatsBridgeMessage,
} from './types.js';
