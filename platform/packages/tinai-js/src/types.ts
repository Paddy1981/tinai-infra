/**
 * Shared types and interfaces for the @tinai/client SDK.
 */

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export interface TinaiSession {
  token: string;
  tenant_id: string;
  email?: string;
  expires_at?: number; // Unix timestamp (ms)
}

export interface SignInOptions {
  email: string;
  password: string;
}

export interface SignInWithOtpOptions {
  email: string;
}

export interface VerifyOtpOptions {
  email: string;
  token: string;
}

export type AuthChangeEvent = 'SIGNED_IN' | 'SIGNED_OUT';

export interface AuthStateChange {
  event: AuthChangeEvent;
  session: TinaiSession | null;
}

export type AuthStateChangeCallback = (change: AuthStateChange) => void;

// ---------------------------------------------------------------------------
// Auth API response shapes
// ---------------------------------------------------------------------------

export interface AuthLoginResponse {
  token: string;
  tenant_id: string;
  email?: string;
  expires_at?: number;
}

// ---------------------------------------------------------------------------
// Realtime types
// ---------------------------------------------------------------------------

export type RealtimeEventType = 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export interface RealtimePayload<T = Record<string, unknown>> {
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: T;
  old_record: T | null;
  channel: string;
}

export type RealtimeCallback<T = Record<string, unknown>> = (
  payload: RealtimePayload<T>
) => void;

// Hub protocol messages (PG NOTIFY relay)
export interface HubSubscribeMessage {
  action: 'subscribe' | 'unsubscribe';
  channel: string;
}

// NATS bridge messages
export interface NatsBridgeMessage {
  type: 'subscribe' | 'unsubscribe';
  tenant_id: string;
}

// Inbound server message
export interface ServerMessage<T = Record<string, unknown>> {
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  table: string;
  record: T;
  old_record: T | null;
}

// ---------------------------------------------------------------------------
// Channel types
// ---------------------------------------------------------------------------

export type ChannelEventType = 'broadcast' | 'INSERT' | 'UPDATE' | 'DELETE' | '*';

export type ChannelCallback<T = Record<string, unknown>> = (payload: T) => void;

// ---------------------------------------------------------------------------
// Client config
// ---------------------------------------------------------------------------

export interface TinaiClientOptions {
  /** WebSocket URL for the realtime service, e.g. wss://realtime.tinai.cloud */
  realtimeUrl?: string;
  /** Optional JWT token — can also be set later via auth.signIn() */
  token?: string;
}

// ---------------------------------------------------------------------------
// Subscription handle
// ---------------------------------------------------------------------------

export interface Subscription {
  /** Unsubscribe from this channel/table combination. */
  unsubscribe(): void;
}
