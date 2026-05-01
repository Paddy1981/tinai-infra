import type { ChannelEventType, ChannelCallback, Subscription } from './types.js';
import type { RealtimeClient } from './realtime.js';

interface ChannelHandler {
  event: ChannelEventType;
  callback: ChannelCallback;
}

/**
 * Channel represents a named pub/sub channel on the Tinai realtime service.
 * Mirrors the Supabase-style fluent API for easy migration.
 *
 * @example
 * const sub = tinai.channel('tenant:acme:logs')
 *   .on('broadcast', (payload) => console.log(payload))
 *   .subscribe()
 *
 * sub.unsubscribe()
 */
export class Channel {
  private readonly channelName: string;
  private readonly realtime: RealtimeClient;
  private readonly handlers: ChannelHandler[] = [];
  private cleanupFns: Array<() => void> = [];
  private subscribed = false;

  constructor(channelName: string, realtime: RealtimeClient) {
    this.channelName = channelName;
    this.realtime = realtime;
  }

  /**
   * Register a handler for a given event type on this channel.
   * `'broadcast'` catches all message types; otherwise use
   * `'INSERT'`, `'UPDATE'`, or `'DELETE'`.
   *
   * Returns `this` for method chaining.
   */
  on<T = Record<string, unknown>>(
    event: ChannelEventType,
    callback: ChannelCallback<T>
  ): this {
    if (this.subscribed) {
      throw new Error(
        '[@tinai/client] Cannot add handlers after calling subscribe(). ' +
        'Call on() before subscribe().'
      );
    }
    this.handlers.push({ event, callback: callback as ChannelCallback });
    return this;
  }

  /**
   * Activate the channel subscription. Sends subscribe messages to the
   * realtime service and begins dispatching inbound messages to registered
   * handlers.
   *
   * Returns a `Subscription` object with an `unsubscribe()` method.
   */
  subscribe(): Subscription {
    if (this.subscribed) {
      throw new Error('[@tinai/client] Channel is already subscribed.');
    }
    this.subscribed = true;

    for (const handler of this.handlers) {
      // Map 'broadcast' → '*' so the realtime client treats it as a wildcard.
      const realtimeEvent =
        handler.event === 'broadcast' ? '*' : handler.event;

      const cleanup = this.realtime.addSubscription(
        this.channelName,
        realtimeEvent as '*' | 'INSERT' | 'UPDATE' | 'DELETE',
        // Wrap: channel callbacks receive the raw record payload, not the
        // full RealtimePayload envelope, to keep the API simple.
        (payload) => {
          try {
            handler.callback(payload as unknown as Record<string, unknown>);
          } catch (err) {
            console.error('[@tinai/client] Channel handler error:', err);
          }
        }
      );

      this.cleanupFns.push(cleanup);
    }

    return {
      unsubscribe: () => this.unsubscribe(),
    };
  }

  /**
   * Remove all handlers and send unsubscribe messages to the server.
   */
  unsubscribe(): void {
    for (const cleanup of this.cleanupFns) {
      cleanup();
    }
    this.cleanupFns = [];
    this.subscribed = false;
  }
}
