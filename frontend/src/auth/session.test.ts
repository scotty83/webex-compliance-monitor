import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  captureTokenFromHash,
  decodeSession,
  isExpired,
  redirectToLogin,
  clearToken,
  getToken,
  setToken,
} from './session';
import type { SessionPayload } from './session';

// ── Test JWT factory ──────────────────────────────────────────────────────────
// Builds a structurally valid JWT without a real signature.  We never verify
// signatures client-side, so a fake sig is the correct test surface.

function makeJwt(payload: object, sig = 'fakesig'): string {
  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.${sig}`;
}

const NOW_S = Math.floor(Date.now() / 1000);
const FUTURE_EXP = NOW_S + 3600;
const PAST_EXP = NOW_S - 3600;

const VALID_PAYLOAD = { email: 'alice@compliance.example', role: 'officer' as const, exp: FUTURE_EXP };

// ── Helper: replace window.location with a controllable stub ─────────────────
// jsdom's window.location.assign is non-configurable, so vi.spyOn fails.
// Defining an own property on the window instance shadows the prototype getter.

function stubLocation(overrides: Partial<typeof window.location> & { assign?: ReturnType<typeof vi.fn> }) {
  Object.defineProperty(window, 'location', {
    value: {
      hash: '',
      pathname: '/',
      search: '',
      href: 'http://localhost/',
      origin: 'http://localhost',
      host: 'localhost',
      hostname: 'localhost',
      port: '',
      protocol: 'http:',
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
      ...overrides,
    },
    writable: true,
    configurable: true,
  });
}

function restoreLocation() {
  // Remove the own property we added; the jsdom prototype getter takes over again.
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (window as unknown as Record<string, unknown>)['location'];
}

// ── captureTokenFromHash ──────────────────────────────────────────────────────

describe('captureTokenFromHash', () => {
  let replaceStateSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    clearToken();
    replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // jsdom restores the real location hash between tests
    if (window.location.hash) window.location.hash = '';
  });

  it('stores the token when #token=<jwt> is in the hash', () => {
    const jwt = makeJwt(VALID_PAYLOAD);
    window.location.hash = `token=${jwt}`;

    captureTokenFromHash();

    expect(getToken()).toBe(jwt);
  });

  it('strips the hash from the URL immediately after capture', () => {
    const jwt = makeJwt(VALID_PAYLOAD);
    window.location.hash = `token=${jwt}`;

    captureTokenFromHash();

    expect(replaceStateSpy).toHaveBeenCalledWith(
      null,
      '',
      expect.not.stringContaining('#'),
    );
  });

  it('does nothing when hash is absent', () => {
    window.location.hash = '';
    captureTokenFromHash();
    expect(getToken()).toBeNull();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });

  it('does nothing when hash does not start with #token=', () => {
    window.location.hash = 'other=stuff';
    captureTokenFromHash();
    expect(getToken()).toBeNull();
    expect(replaceStateSpy).not.toHaveBeenCalled();
  });
});

// ── decodeSession ─────────────────────────────────────────────────────────────

describe('decodeSession', () => {
  it('decodes a valid officer JWT payload', () => {
    const jwt = makeJwt(VALID_PAYLOAD);
    expect(decodeSession(jwt)).toEqual({
      email: 'alice@compliance.example',
      role: 'officer',
      exp: FUTURE_EXP,
    });
  });

  it('decodes an admin role', () => {
    const jwt = makeJwt({ email: 'bob@compliance.example', role: 'admin', exp: FUTURE_EXP });
    expect(decodeSession(jwt)?.role).toBe('admin');
  });

  it('omits exp when the payload has no exp field', () => {
    const jwt = makeJwt({ email: 'c@compliance.example', role: 'officer' });
    const result = decodeSession(jwt);
    expect(result?.email).toBe('c@compliance.example');
    expect(result?.exp).toBeUndefined();
  });

  it('returns null for a string that is not three dot-separated parts', () => {
    expect(decodeSession('notajwt')).toBeNull();
    expect(decodeSession('a.b')).toBeNull();
  });

  it('returns null when payload is not valid JSON', () => {
    // hand-craft a JWT whose middle segment decodes to non-JSON
    const bad = `eyJhbGciOiJIUzI1NiJ9.${btoa('not-json')}.sig`;
    expect(decodeSession(bad)).toBeNull();
  });

  it('returns null when email field is missing', () => {
    const jwt = makeJwt({ role: 'officer' });
    expect(decodeSession(jwt)).toBeNull();
  });

  it('returns null when role field is missing', () => {
    const jwt = makeJwt({ email: 'x@compliance.example' });
    expect(decodeSession(jwt)).toBeNull();
  });

  it('returns null when role is a string not in the Role union (e.g. "superadmin")', () => {
    const jwt = makeJwt({ email: 'x@compliance.example', role: 'superadmin' });
    expect(decodeSession(jwt)).toBeNull();
  });

  it('returns null when role is "unknown"', () => {
    const jwt = makeJwt({ email: 'x@compliance.example', role: 'unknown' });
    expect(decodeSession(jwt)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(decodeSession('')).toBeNull();
  });
});

// ── isExpired ─────────────────────────────────────────────────────────────────

describe('isExpired', () => {
  it('returns true when exp is in the past', () => {
    const session: SessionPayload = { email: 'x@compliance.example', role: 'officer', exp: PAST_EXP };
    expect(isExpired(session)).toBe(true);
  });

  it('returns false when exp is in the future', () => {
    const session: SessionPayload = { email: 'x@compliance.example', role: 'officer', exp: FUTURE_EXP };
    expect(isExpired(session)).toBe(false);
  });

  it('returns false when exp is absent (no expiry enforced client-side)', () => {
    const session: SessionPayload = { email: 'x@compliance.example', role: 'officer' };
    expect(isExpired(session)).toBe(false);
  });
});

// ── redirectToLogin ───────────────────────────────────────────────────────────

describe('redirectToLogin', () => {
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    assignMock = vi.fn();
    // jsdom's Location.assign is non-configurable; replace the whole location object.
    stubLocation({ assign: assignMock });
  });

  afterEach(() => {
    restoreLocation();
  });

  it('calls location.assign with /auth/login?next=<encoded-path>', () => {
    redirectToLogin('/console/meetings');
    expect(assignMock).toHaveBeenCalledWith(
      '/auth/login?next=' + encodeURIComponent('/console/meetings'),
    );
  });

  it('uses current pathname+search when no argument is supplied', () => {
    redirectToLogin();
    const called = (assignMock.mock.calls[0] as [string])[0];
    expect(called).toMatch(/^\/auth\/login\?next=/);
  });
});

// ── token storage round-trip ──────────────────────────────────────────────────

describe('token storage', () => {
  beforeEach(() => clearToken());
  afterEach(() => clearToken());

  it('stores and retrieves a token', () => {
    const jwt = makeJwt(VALID_PAYLOAD);
    setToken(jwt);
    expect(getToken()).toBe(jwt);
  });

  it('returns null after clearToken', () => {
    setToken(makeJwt(VALID_PAYLOAD));
    clearToken();
    expect(getToken()).toBeNull();
  });
});
