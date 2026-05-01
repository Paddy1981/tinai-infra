import { AuthClient } from './auth.js';
import { RealtimeClient } from './realtime.js';
import { DatabaseBuilder } from './database.js';
import { Channel } from './channel.js';
import type { TinaiClientOptions, TinaiSession } from './types.js';

/**
 * TinaiClient is the main entry-point for the @tinai/client SDK.
 * Instantiate it via the `createClient` factory function.
 *
 * @example
 * import { createClient } from '@tinai/client'
 *
 * const tinai = createClient('https://api.tinai.cloud', {
 *   realtimeUrl: 'wss://realtime.tinai.cloud',
 *   token: 'optional-jwt',
 * })
 */
export class TinaiClient {
  /** Authentication client — sign in, out, OTP, session management. */
  readonly auth: AuthClient;

  /** Database builder — fluent realtime subscriptions per table. */
  readonly db: DatabaseBuilder;

  private readonly realtime: RealtimeClient;

  constructor(apiUrl: string, options: TinaiClientOptions = {}) {
    const { realtimeUrl = 'wss://realtime.tinai.cloud', token } = options;

    // Initialise auth. Auth will call onSessionChange when the session updates.
    this.auth = new AuthClient(apiUrl, token);

    // Determine the initial token from either the option or a stored session.
    const initialToken = token ?? this.auth.getSession()?.token ?? undefined;

    // Initialise realtime with the best token we have at construction time.
    this.realtime = new RealtimeClient(realtimeUrl, initialToken);

    // Wire auth session changes → realtime token updates.
    this.auth.onSessionChange = (session: TinaiSession | null) => {
      this.realtime.setToken(session?.token ?? null);
    };

    // Initialise the database builder. The tenant_id is resolved lazily so
    // that subscriptions created after signIn() use the correct tenant.
    this.db = this._createDatabaseBuilder();
  }

  // ---------------------------------------------------------------------------
  // Channel API
  // ---------------------------------------------------------------------------

  /**
   * Create a named channel for broadcast pub/sub.
   *
   * @param name - Full channel name, e.g. `'tenant:acme:logs'`
   *
   * @example
   * const sub = tinai.channel('tenant:acme:logs')
   *   .on('broadcast', (payload) => console.log(payload))
   *   .subscribe()
   */
  channel(name: string): Channel {
    return new Channel(name, this.realtime);
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Creates a `DatabaseBuilder` that resolves the tenant_id from the current
   * session at the time `.from()` is called, enabling subscriptions created
   * after `signIn()` to automatically use the correct tenant.
   */
  private _createDatabaseBuilder(): DatabaseBuilder {
    const self = this;

    // We use a Proxy so that each call to .from() reads the live tenant_id.
    return new Proxy(new DatabaseBuilder(this.realtime, ''), {
      get(target, prop, receiver) {
        if (prop === 'from') {
          return (table: string) => {
            const tenantId = self.auth.getSession()?.tenant_id ?? '';
            // Create a fresh DatabaseBuilder with the current tenant_id.
            const builder = new DatabaseBuilder(self.realtime, tenantId);
            return builder.from(table);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }
}
