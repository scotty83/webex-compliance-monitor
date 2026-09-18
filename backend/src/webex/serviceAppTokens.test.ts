import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../db/index.js';
import { getServiceRefreshToken, saveServiceRefreshToken } from '../db/serviceTokens.js';
import { createServiceAppTokens, WebexTokenRefreshError } from './serviceAppTokens.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const OK_BODY = { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-rotated' };

/** Scripted-fetch harness with a manual clock. `script[i]` answers call i;
 *  the last entry repeats. `rawBody` (when set) wins over `body` and is sent
 *  verbatim as text/html — simulates a proxy interstitial on a 200. */
function harness(opts: {
  script: Array<{ status: number; body?: unknown; rawBody?: string }>;
  seedRefreshToken?: string;
}) {
  const db = openDb();
  if (opts.seedRefreshToken !== undefined) {
    saveServiceRefreshToken(db, opts.seedRefreshToken, 1);
  }
  const calls: Array<{ url: string; body: URLSearchParams }> = [];
  let i = 0;
  let clock = 1_000_000;
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body as URLSearchParams });
    const r = opts.script[Math.min(i, opts.script.length - 1)];
    i += 1;
    if (r.rawBody !== undefined) {
      return new Response(r.rawBody, {
        status: r.status,
        headers: { 'Content-Type': 'text/html' },
      });
    }
    return jsonResponse(r.status, r.body);
  }) as unknown as typeof fetch;
  const tokens = createServiceAppTokens({
    db,
    clientId: 'ci',
    clientSecret: 'cs',
    bootstrapRefreshToken: 'boot-rt',
    webexApiBase: 'https://fake.example/v1',
    fetchImpl,
    now: () => clock,
    backoff: { baseDelayMs: 1_000, maxDelayMs: 4_000 },
  });
  return { db, tokens, calls, fetchImpl, advance: (ms: number) => { clock += ms; } };
}

describe('createServiceAppTokens', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('bootstrap token used only when the table is empty; rotation persisted', async () => {
    const h = harness({ script: [{ status: 200, body: OK_BODY }] });
    await expect(h.tokens.getAccessToken()).resolves.toBe('at-1');
    expect(h.calls[0].url).toBe('https://fake.example/v1/access_token');
    expect(h.calls[0].body.get('grant_type')).toBe('refresh_token');
    expect(h.calls[0].body.get('refresh_token')).toBe('boot-rt');
    expect(getServiceRefreshToken(h.db)?.refreshToken).toBe('rt-rotated');
    expect(h.tokens.status()).toBe('ok');
  });

  it('a stored (rotated) token wins over the env bootstrap', async () => {
    const h = harness({ script: [{ status: 200, body: OK_BODY }], seedRefreshToken: 'db-rt' });
    await h.tokens.getAccessToken();
    expect(h.calls[0].body.get('refresh_token')).toBe('db-rt');
  });

  it('the next refresh (after expiry) uses the rotated token', async () => {
    const h = harness({
      script: [
        { status: 200, body: { access_token: 'at-1', expires_in: 3600, refresh_token: 'rt-2' } },
        { status: 200, body: { access_token: 'at-2', expires_in: 3600, refresh_token: 'rt-3' } },
      ],
    });
    await h.tokens.getAccessToken();
    h.advance(3_600_000); // past expiry
    await expect(h.tokens.getAccessToken()).resolves.toBe('at-2');
    expect(h.calls[1].body.get('refresh_token')).toBe('rt-2');
    expect(getServiceRefreshToken(h.db)?.refreshToken).toBe('rt-3');
  });

  it('caches until near expiry — a second call performs no fetch', async () => {
    const h = harness({ script: [{ status: 200, body: OK_BODY }] });
    await h.tokens.getAccessToken();
    await h.tokens.getAccessToken();
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('single-flight: concurrent callers share ONE refresh request', async () => {
    const db = openDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return jsonResponse(200, OK_BODY);
    }) as unknown as typeof fetch;
    const tokens = createServiceAppTokens({
      db, clientId: 'ci', clientSecret: 'cs', bootstrapRefreshToken: 'boot-rt',
      webexApiBase: 'https://fake.example/v1', fetchImpl, now: () => 0,
    });
    const a = tokens.getAccessToken();
    const b = tokens.getAccessToken();
    release();
    await expect(a).resolves.toBe('at-1');
    await expect(b).resolves.toBe('at-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refresh failure: status failed, named error, capped-backoff fail-fast, recovery', async () => {
    // Suppress the module's intentional fail-LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      script: [
        { status: 500, body: { message: 'boom' } },
        { status: 500, body: { message: 'boom' } },
        { status: 200, body: OK_BODY },
      ],
    });
    // First attempt: hits the API, fails loudly with the named error.
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.tokens.status()).toBe('failed');
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('token refresh failed: HTTP 500'),
    );

    // Inside the 1_000 ms backoff window: fail FAST, no new fetch.
    h.advance(999);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    // Past the window: retries (fails again → backoff doubles to 2_000 ms).
    h.advance(2);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);

    // Past the second window: retries and SUCCEEDS → status back to ok.
    h.advance(2_001);
    await expect(h.tokens.getAccessToken()).resolves.toBe('at-1');
    expect(h.tokens.status()).toBe('ok');
  });

  it('200 with a non-JSON body fails LOUD: named error, status failed, backoff, recovery', async () => {
    // Suppress the module's intentional fail-LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      script: [
        { status: 200, rawBody: '<html><body>proxy interstitial</body></html>' },
        { status: 200, body: OK_BODY },
      ],
    });
    // A 200 whose body is not JSON must behave exactly like an HTTP 500.
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.tokens.status()).toBe('failed');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('token refresh failed: invalid response body'),
    );

    // Inside the 1_000 ms backoff window: fail FAST, no new fetch.
    h.advance(999);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    // Past the window: retries and SUCCEEDS → status back to ok.
    h.advance(1);
    await expect(h.tokens.getAccessToken()).resolves.toBe('at-1');
    expect(h.tokens.status()).toBe('ok');
  });

  it('200 with malformed JSON (missing fields) fails LOUD: named error, status failed, backoff, recovery', async () => {
    // Suppress the module's intentional fail-LOUD stderr, and verify it fires.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      script: [
        { status: 200, body: { token_type: 'Bearer' } }, // no access_token / expires_in
        { status: 200, body: OK_BODY },
      ],
    });
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.tokens.status()).toBe('failed');
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('token refresh failed: malformed response body'),
    );

    // Inside the backoff window: fail FAST, no new fetch.
    h.advance(999);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(1);

    // Past the window: retries and SUCCEEDS → status back to ok.
    h.advance(1);
    await expect(h.tokens.getAccessToken()).resolves.toBe('at-1');
    expect(h.tokens.status()).toBe('ok');
  });

  it('200 with a non-string refresh_token fails LOUD; nothing persisted', async () => {
    // Suppress the module's intentional fail-LOUD stderr for this failure-path test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({
      script: [{ status: 200, body: { access_token: 'at-x', expires_in: 3600, refresh_token: 42 } }],
    });
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.tokens.status()).toBe('failed');
    expect(getServiceRefreshToken(h.db)?.refreshToken).toBeUndefined();
  });

  it('backoff delay is capped at maxDelayMs', async () => {
    // Suppress the module's intentional fail-LOUD stderr for this failure-path test.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness({ script: [{ status: 500, body: {} }] });
    // Delays: 1000, 2000, 4000, then capped at 4000.
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError); // fetch 1
    h.advance(1_000);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError); // fetch 2
    h.advance(2_000);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError); // fetch 3
    h.advance(4_000);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError); // fetch 4
    // Capped: 4th failure schedules +4000 again (not 8000).
    h.advance(3_999);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(4); // fail-fast, no 5th fetch yet
    h.advance(1);
    await expect(h.tokens.getAccessToken()).rejects.toBeInstanceOf(WebexTokenRefreshError);
    expect(h.fetchImpl).toHaveBeenCalledTimes(5);
  });
});
