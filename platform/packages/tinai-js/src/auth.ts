import type {
  TinaiSession,
  SignInOptions,
  SignInWithOtpOptions,
  VerifyOtpOptions,
  AuthStateChangeCallback,
  AuthStateChange,
  AuthLoginResponse,
} from './types.js';

const SESSION_STORAGE_KEY = 'tinai_session';

/**
 * Detects whether we are running in a browser environment.
 */
function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

/**
 * AuthClient manages authentication state, session persistence,
 * and communicates session changes to other SDK modules.
 */
export class AuthClient {
  private readonly apiUrl: string;
  private session: TinaiSession | null = null;
  private listeners: AuthStateChangeCallback[] = [];

  /**
   * Called by TinaiClient whenever the session token must be propagated
   * to the RealtimeClient (or any other dependant module).
   */
  onSessionChange?: (session: TinaiSession | null) => void;

  constructor(apiUrl: string, initialToken?: string) {
    this.apiUrl = apiUrl;

    // Restore session from persistent storage on initialisation.
    const stored = this._loadSession();
    if (stored) {
      this.session = stored;
    } else if (initialToken) {
      // Token provided at client creation — wrap it in a minimal session.
      this.session = { token: initialToken, tenant_id: '' };
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Sign in with email and password.
   * Stores the returned session and notifies listeners.
   */
  async signIn(options: SignInOptions): Promise<{ session: TinaiSession; error: null } | { session: null; error: Error }> {
    try {
      const response = await fetch(`${this.apiUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: options.email, password: options.password }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${response.status}`);
      }

      const data: AuthLoginResponse = await response.json();
      const session: TinaiSession = {
        token: data.token,
        tenant_id: data.tenant_id,
        email: data.email ?? options.email,
        ...(data.expires_at !== undefined ? { expires_at: data.expires_at } : {}),
      };

      this._setSession(session);
      return { session, error: null };
    } catch (err) {
      return { session: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * Request a magic link / OTP email.
   */
  async signInWithOtp(options: SignInWithOtpOptions): Promise<{ error: null } | { error: Error }> {
    try {
      const response = await fetch(`${this.apiUrl}/auth/magic-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: options.email }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${response.status}`);
      }

      return { error: null };
    } catch (err) {
      return { error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * Verify a one-time password / magic-link token.
   * Stores the returned session and notifies listeners.
   */
  async verifyOtp(options: VerifyOtpOptions): Promise<{ session: TinaiSession; error: null } | { session: null; error: Error }> {
    try {
      const response = await fetch(`${this.apiUrl}/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: options.email, token: options.token }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `HTTP ${response.status}`);
      }

      const data: AuthLoginResponse = await response.json();
      const session: TinaiSession = {
        token: data.token,
        tenant_id: data.tenant_id,
        email: data.email ?? options.email,
        ...(data.expires_at !== undefined ? { expires_at: data.expires_at } : {}),
      };

      this._setSession(session);
      return { session, error: null };
    } catch (err) {
      return { session: null, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /**
   * Clear the current session and notify listeners.
   */
  signOut(): void {
    this._clearSession();
  }

  /**
   * Return the currently active session, or null if not authenticated.
   */
  getSession(): TinaiSession | null {
    return this.session;
  }

  /**
   * Register a callback that fires whenever auth state changes.
   * Returns a function to remove the listener.
   *
   * @example
   * const { unsubscribe } = tinai.auth.onAuthStateChange(({ event, session }) => {
   *   console.log(event, session)
   * })
   */
  onAuthStateChange(callback: AuthStateChangeCallback): { unsubscribe: () => void } {
    this.listeners.push(callback);
    return {
      unsubscribe: () => {
        this.listeners = this.listeners.filter((l) => l !== callback);
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private _setSession(session: TinaiSession): void {
    this.session = session;
    this._persistSession(session);
    this.onSessionChange?.(session);
    this._emit({ event: 'SIGNED_IN', session });
  }

  private _clearSession(): void {
    this.session = null;
    this._removePersistedSession();
    this.onSessionChange?.(null);
    this._emit({ event: 'SIGNED_OUT', session: null });
  }

  private _emit(change: AuthStateChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // Listeners must not crash the auth flow.
      }
    }
  }

  private _persistSession(session: TinaiSession): void {
    try {
      if (isBrowser()) {
        window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
      }
    } catch {
      // Silently ignore — quota exceeded or private mode.
    }
  }

  private _loadSession(): TinaiSession | null {
    try {
      if (isBrowser()) {
        const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as TinaiSession;
          // Discard expired sessions.
          if (parsed.expires_at && Date.now() > parsed.expires_at) {
            window.localStorage.removeItem(SESSION_STORAGE_KEY);
            return null;
          }
          return parsed;
        }
      }
    } catch {
      // JSON parse error or storage not available.
    }
    return null;
  }

  private _removePersistedSession(): void {
    try {
      if (isBrowser()) {
        window.localStorage.removeItem(SESSION_STORAGE_KEY);
      }
    } catch {
      // Ignore.
    }
  }
}
