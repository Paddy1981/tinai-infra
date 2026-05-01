import type {
  RealtimeEventType,
  RealtimeCallback,
  Subscription,
} from './types.js';
import type { RealtimeClient } from './realtime.js';

// ---------------------------------------------------------------------------
// EventRegistry — collects .on() calls before .subscribe() is invoked
// ---------------------------------------------------------------------------

interface EventHandler {
  event: RealtimeEventType;
  callback: RealtimeCallback;
}

// ---------------------------------------------------------------------------
// TableSubscription — returned by DatabaseBuilder.subscribe()
// ---------------------------------------------------------------------------

class TableSubscription implements Subscription {
  private readonly cleanupFns: Array<() => void>;

  constructor(cleanupFns: Array<() => void>) {
    this.cleanupFns = cleanupFns;
  }

  /**
   * Cancel all event listeners registered via this subscription.
   */
  unsubscribe(): void {
    for (const fn of this.cleanupFns) {
      fn();
    }
    this.cleanupFns.length = 0;
  }
}

// ---------------------------------------------------------------------------
// DatabaseBuilder — fluent builder for table-level realtime subscriptions
// ---------------------------------------------------------------------------

/**
 * DatabaseBuilder provides a Supabase-compatible fluent API for subscribing
 * to row-level change events on a given database table.
 *
 * @example
 * const sub = tinai.db
 *   .from('orders')
 *   .on('INSERT', (payload) => console.log('new order', payload.record))
 *   .on('UPDATE', (payload) => console.log('order updated', payload))
 *   .subscribe()
 *
 * sub.unsubscribe()
 */
export class DatabaseBuilder {
  private readonly realtime: RealtimeClient;
  private readonly tenantId: string;

  constructor(realtime: RealtimeClient, tenantId: string) {
    this.realtime = realtime;
    this.tenantId = tenantId;
  }

  /**
   * Select the database table to listen on.
   * Returns a `TableBuilder` for registering event handlers.
   */
  from(table: string): TableBuilder {
    return new TableBuilder(table, this.realtime, this.tenantId);
  }
}

// ---------------------------------------------------------------------------
// TableBuilder — intermediate builder with .on() and .subscribe()
// ---------------------------------------------------------------------------

/**
 * Intermediate builder that accumulates event handlers for a specific table,
 * then activates them with `.subscribe()`.
 */
export class TableBuilder {
  private readonly table: string;
  private readonly realtime: RealtimeClient;
  private readonly tenantId: string;
  private readonly handlers: EventHandler[] = [];

  constructor(table: string, realtime: RealtimeClient, tenantId: string) {
    this.table = table;
    this.realtime = realtime;
    this.tenantId = tenantId;
  }

  /**
   * Register a handler for the given event type.
   *
   * @param event - `'INSERT'`, `'UPDATE'`, `'DELETE'`, or `'*'` for all events.
   * @param callback - Invoked with a `RealtimePayload` on each matching event.
   *
   * Returns `this` for method chaining.
   */
  on<T = Record<string, unknown>>(
    event: RealtimeEventType,
    callback: RealtimeCallback<T>
  ): this {
    this.handlers.push({ event, callback: callback as RealtimeCallback });
    return this;
  }

  /**
   * Activate the subscription. Registers all handlers with the
   * `RealtimeClient` and sends subscribe messages to the server.
   *
   * The channel name is derived automatically:
   * `tenant:{tenant_id}:{table}`
   *
   * @returns A `Subscription` with an `.unsubscribe()` method.
   */
  subscribe(): Subscription {
    if (this.handlers.length === 0) {
      throw new Error(
        '[@tinai/client] Call .on(event, callback) before .subscribe().'
      );
    }

    // Channel format: tenant:{tenant_id}:{table}
    const channel = this.tenantId
      ? `tenant:${this.tenantId}:${this.table}`
      : this.table;

    const cleanupFns: Array<() => void> = [];

    for (const handler of this.handlers) {
      const cleanup = this.realtime.addSubscription(
        channel,
        handler.event,
        handler.callback
      );
      cleanupFns.push(cleanup);
    }

    return new TableSubscription(cleanupFns);
  }
}
