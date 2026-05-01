import type {
  RealtimeEventType,
  RealtimeCallback,
  RealtimePayload,
  ServerMessage,
  HubSubscribeMessage,
} from './types.js';

// ---------------------------------------------------------------------------
// WebSocket abstraction — browser uses native, Node uses the `ws` package.
// ---------------------------------------------------------------------------

type WsConstructor = new (url: string) => WebSocket;

/**
 * Returns the WebSocket constructor appropriate for the current runtime.
 * In the browser the global WebSocket is used; in Node.js the `ws` package
 * is imported dynamically so it remains an optional peer dependency.
 */
async function resolveWebSocket(): Promise<WsConstructor> {
  if (typeof WebSocket !== 'undefined') {
    return WebSocket as unknown as WsConstructor;
  }
  try {
    // Dynamic import keeps browser bundles clean — bundlers tree-shake this.
    const { default: WS } = await import('ws');
    return WS as unknown as WsConstructor;
  } catch {
    throw new Error(
      '[@tinai/client] WebSocket is not available. ' +
      'In Node.js environments install the `ws` package: npm install ws'
    );
  }
}

// ---------------------------------------------------------------------------
// Internal subscription record
// ---------------------------------------------------------------------------

interface SubscriptionRecord {
  channel: string;
  event: RealtimeEventType;
  callback: RealtimeCallback;
}

// ---------------------------------------------------------------------------
// RealtimeClient
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const INITIAL_BACKOFF_MS = 100;

/**
 * Manages a WebSocket connection to the Tinai realtime service.
 *
 * Features:
 * - Auto-reconnect with exponential backoff (100 ms → 30 s)
 * - Heartbeat ping every 30 s to detect dead connections
 * - Queues subscribe/unsubscribe calls made before the socket opens
 * - Dispatches inbound messages to registered callbacks by channel + event
 */
export class RealtimeClient {
  private readonly baseUrl: string;
  private token: string | null = null;

  private ws: WebSocket | null = null;
  private WsClass: WsConstructor | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Messages buffered while the socket is not yet open. */
  private messageQueue: string[] = [];

  /** All active subscriptions. */
  private subscriptions: SubscriptionRecord[] = [];

  /** Channels that have had a subscribe message sent to the server. */
  private subscribedChannels = new Set<string>();

  constructor(realtimeUrl: string, token?: string) {
    // Normalise trailing slash and append /ws if needed.
    const base = realtimeUrl.replace(/\/$/, '');
    this.baseUrl = base.endsWith('/ws') ? base : `${base}/ws`;
    this.token = token ?? null;
  }

  // ---------------------------------------------------------------------------
  // Public API (used by DatabaseBuilder / Channel)
  // ---------------------------------------------------------------------------

  /**
   * Update the JWT token used for authenticating the WebSocket connection.
   * If a connection is already open it will be closed and re-established with
   * the new token.
   */
  setToken(token: string | null): void {
    const changed = token !== this.token;
    this.token = token;
    if (changed && this.ws) {
      // Reconnect with the new token.
      this.ws.close();
    }
  }

  /**
   * Register interest in messages on a channel+event pair.
   * Returns a cleanup function that removes the record.
   */
  addSubscription(
    channel: string,
    event: RealtimeEventType,
    callback: RealtimeCallback
  ): () => void {
    const record: SubscriptionRecord = { channel, event, callback };
    this.subscriptions.push(record);

    // Ensure the WebSocket is open.
    this._ensureConnected();

    // Send subscribe message to the hub (if not already subscribed).
    if (!this.subscribedChannels.has(channel)) {
      this.subscribedChannels.add(channel);
      this._send<HubSubscribeMessage>({ action: 'subscribe', channel });
    }

    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s !== record);
      // Only unsubscribe from the hub when no listeners remain for this channel.
      const remaining = this.subscriptions.filter((s) => s.channel === channel);
      if (remaining.length === 0) {
        this.subscribedChannels.delete(channel);
        this._send<HubSubscribeMessage>({ action: 'unsubscribe', channel });
      }
    };
  }

  /**
   * Gracefully close the connection and prevent any further reconnect attempts.
   */
  disconnect(): void {
    this.shouldReconnect = false;
    this._clearTimers();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  private async _ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) return;
    if (this.isConnecting) return;
    await this._connect();
  }

  private async _connect(): Promise<void> {
    this.isConnecting = true;

    try {
      if (!this.WsClass) {
        this.WsClass = await resolveWebSocket();
      }

      const url = this.token
        ? `${this.baseUrl}?token=${encodeURIComponent(this.token)}`
        : this.baseUrl;

      const ws = new this.WsClass(url) as WebSocket;
      this.ws = ws;

      ws.onopen = () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this._flushQueue();
        this._resubscribeAll();
        this._startHeartbeat();
      };

      ws.onmessage = (event: MessageEvent) => {
        this._handleMessage(event.data as string);
      };

      ws.onerror = () => {
        // onerror is always followed by onclose; handle reconnect there.
      };

      ws.onclose = () => {
        this.isConnecting = false;
        this._clearTimers();
        this.ws = null;
        if (this.shouldReconnect) {
          this._scheduleReconnect();
        }
      };
    } catch (err) {
      this.isConnecting = false;
      console.error('[@tinai/client] RealtimeClient connect error:', err);
      if (this.shouldReconnect) {
        this._scheduleReconnect();
      }
    }
  }

  private _scheduleReconnect(): void {
    const delay = Math.min(
      INITIAL_BACKOFF_MS * Math.pow(2, this.reconnectAttempts),
      MAX_BACKOFF_MS
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      void this._connect();
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // Heartbeat
  // ---------------------------------------------------------------------------

  private _startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === 1 /* OPEN */) {
        try {
          this.ws.send(JSON.stringify({ action: 'ping' }));
        } catch {
          // If send fails the onclose handler will trigger reconnect.
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private _clearTimers(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  private _handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return; // Ignore non-JSON frames (e.g. pong).
    }

    if (!msg.event || !msg.table) return;

    // Build the channel name from the message table so we can match it.
    // The server sends per-table messages; we match by table name and event.
    for (const sub of this.subscriptions) {
      const tableMatchesChannel =
        sub.channel.endsWith(`:${msg.table}`) || sub.channel === msg.table;

      if (!tableMatchesChannel) continue;

      const eventMatches = sub.event === '*' || sub.event === msg.event;
      if (!eventMatches) continue;

      const payload: RealtimePayload = {
        event: msg.event,
        table: msg.table,
        record: msg.record,
        old_record: msg.old_record,
        channel: sub.channel,
      };

      try {
        sub.callback(payload);
      } catch (err) {
        console.error('[@tinai/client] Realtime callback error:', err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private _send<T>(data: T): void {
    const serialised = JSON.stringify(data);
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(serialised);
    } else {
      this.messageQueue.push(serialised);
    }
  }

  private _flushQueue(): void {
    while (this.messageQueue.length > 0) {
      const msg = this.messageQueue.shift()!;
      if (this.ws && this.ws.readyState === 1 /* OPEN */) {
        this.ws.send(msg);
      }
    }
  }

  /** Re-send subscribe messages for all active channels after reconnection. */
  private _resubscribeAll(): void {
    for (const channel of this.subscribedChannels) {
      this._send<HubSubscribeMessage>({ action: 'subscribe', channel });
    }
  }
}
