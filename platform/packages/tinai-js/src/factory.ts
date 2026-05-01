import { TinaiClient } from './client.js';
import type { TinaiClientOptions } from './types.js';

/**
 * Create a new `TinaiClient` instance.
 *
 * @param apiUrl - Base URL of the Tinai REST API, e.g. `'https://api.tinai.cloud'`
 * @param options - Optional configuration including `realtimeUrl` and initial `token`
 *
 * @example
 * ```ts
 * import { createClient } from '@tinai/client'
 *
 * const tinai = createClient('https://api.tinai.cloud', {
 *   realtimeUrl: 'wss://realtime.tinai.cloud',
 *   token: 'my-jwt-token',   // optional — can sign in later
 * })
 * ```
 */
export function createClient(
  apiUrl: string,
  options?: TinaiClientOptions
): TinaiClient {
  if (!apiUrl) {
    throw new Error('[@tinai/client] createClient: apiUrl is required.');
  }
  return new TinaiClient(apiUrl, options);
}
