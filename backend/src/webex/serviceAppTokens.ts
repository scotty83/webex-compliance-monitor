/**
 * Service-app credential lifecycle.
 *
 * - getAccessToken(): cached access token; refreshes via
 *   POST {webexApiBase}/access_token when missing or near expiry.
 * - SINGLE-FLIGHT: concurrent callers share one in-flight refresh.
 * - Rotation: the refresh token returned by Webex is persisted to the sqlite
 *   service_tokens table; the env bootstrap value is used only while the
 *   table is empty.
 * - Failure = total integration outage → fail LOUD: status() 'failed',
 *   capped-backoff retry gate (fail-fast inside the window), never silent.
 */
import type { DB } from '../db/index.js';
import { getServiceRefreshToken, saveServiceRefreshToken } from '../db/serviceTokens.js';

export class WebexTokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebexTokenRefreshError';
  }
}

export interface ServiceAppTokensDeps {
  db: DB;
  clientId: string;
  clientSecret: string;
  /** Env WEBEX_SA_REFRESH_TOKEN — used ONLY while service_tokens is empty. */
  bootstrapRefreshToken: string;
  /** All URLs route through this (WEBEX_API_BASE constraint). */
  webexApiBase: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Backoff after a failed refresh. Defaults: baseDelayMs=5_000, maxDelayMs=300_000. */
  backoff?: { baseDelayMs?: number; maxDelayMs?: number };
}

export interface ServiceAppTokens {
  /** Valid access token; refreshes (single-flight) when missing or near
   *  expiry. Throws WebexTokenRefreshError while the integration is down. */
  getAccessToken(): Promise<string>;
  /** 'failed' while the latest refresh attempt failed — feeds webex_integration. */
  status(): 'ok' | 'failed';
}

const EXPIRY_SKEW_MS = 60_000; // refresh a minute early — never serve a dying token

export function createServiceAppTokens(deps: ServiceAppTokensDeps): ServiceAppTokens {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const baseDelayMs = deps.backoff?.baseDelayMs ?? 5_000;
  const maxDelayMs = deps.backoff?.maxDelayMs ?? 300_000;

  let cached: { accessToken: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;
  let statusValue: 'ok' | 'failed' = 'ok';
  let failCount = 0;
  let nextAttemptAt = 0;
  let lastError: WebexTokenRefreshError | undefined;

  function fail(message: string): never {
    statusValue = 'failed';
    failCount += 1;
    const delay = Math.min(baseDelayMs * 2 ** (failCount - 1), maxDelayMs);
    nextAttemptAt = now() + delay;
    lastError = new WebexTokenRefreshError(message);
    // Total integration outage — LOUD, never silent.
    console.error(`[serviceAppTokens] LOUD: ${message} — next refresh attempt in ${delay} ms`);
    throw lastError;
  }

  async function refresh(): Promise<string> {
    const stored = getServiceRefreshToken(deps.db);
    const refreshToken = stored?.refreshToken ?? deps.bootstrapRefreshToken;
    let res: Response;
    try {
      res = await doFetch(`${deps.webexApiBase}/access_token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: deps.clientId,
          client_secret: deps.clientSecret,
          refresh_token: refreshToken, // credential — never log
        }),
      });
    } catch (err) {
      fail(`token refresh request failed: ${String(err)}`);
    }
    if (!res.ok) fail(`token refresh failed: HTTP ${res.status}`);
    // A 200 whose body is not JSON (proxy interstitial, HTML error page) is
    // still a total outage — route it through fail() like an HTTP 500.
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      fail('token refresh failed: invalid response body (not JSON)');
    }
    // Validate shape before use — a parseable-but-malformed body must never
    // poison the cache (expiresAt = NaN) or persist a bogus refresh token.
    const json = parsed as {
      access_token?: unknown;
      expires_in?: unknown;
      refresh_token?: unknown;
    };
    if (
      typeof json.access_token !== 'string' ||
      typeof json.expires_in !== 'number' ||
      (json.refresh_token !== undefined && typeof json.refresh_token !== 'string')
    ) {
      fail('token refresh failed: malformed response body (missing/invalid fields)');
    }
    // Webex rotates the refresh token — persist it so the env bootstrap is
    // never needed again (bootstrap-only-when-empty rule).
    if (json.refresh_token !== undefined) {
      saveServiceRefreshToken(deps.db, json.refresh_token, now());
    }
    cached = { accessToken: json.access_token, expiresAt: now() + json.expires_in * 1000 };
    statusValue = 'ok';
    failCount = 0;
    nextAttemptAt = 0;
    lastError = undefined;
    return json.access_token;
  }

  return {
    async getAccessToken(): Promise<string> {
      if (cached && now() < cached.expiresAt - EXPIRY_SKEW_MS) return cached.accessToken;
      // Capped backoff: inside the window, fail FAST with the last error —
      // callers (calendar sync / roster polls) stay loud without hammering.
      if (lastError && now() < nextAttemptAt) throw lastError;
      inflight ??= refresh().finally(() => { inflight = undefined; });
      return inflight;
    },
    status: () => statusValue,
  };
}
