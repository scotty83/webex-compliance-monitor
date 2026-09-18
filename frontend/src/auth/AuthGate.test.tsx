import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGate, useOfficer } from './AuthGate';
import { clearToken, setToken } from './session';

// ── Test JWT factory ──────────────────────────────────────────────────────────

function makeJwt(payload: object): string {
  const b64url = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fakesig`;
}

const NOW_S = Math.floor(Date.now() / 1000);
const FUTURE_EXP = NOW_S + 3600;
const PAST_EXP = NOW_S - 3600;

const VALID_JWT = makeJwt({ email: 'alice@compliance.example', role: 'officer', exp: FUTURE_EXP });
const EXPIRED_JWT = makeJwt({ email: 'alice@compliance.example', role: 'officer', exp: PAST_EXP });

// ── Location stub helper ──────────────────────────────────────────────────────
// jsdom's window.location.assign is non-configurable; we replace the whole
// location object by defining an own property on the window instance.

let assignMock: ReturnType<typeof vi.fn>;

function stubLocation(hash = '') {
  assignMock = vi.fn();
  Object.defineProperty(window, 'location', {
    value: {
      hash,
      pathname: '/',
      search: '',
      href: 'http://localhost/' + (hash ? '#' + hash : ''),
      origin: 'http://localhost',
      host: 'localhost',
      hostname: 'localhost',
      port: '',
      protocol: 'http:',
      assign: assignMock,
      replace: vi.fn(),
      reload: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
}

function restoreLocation() {
  // Remove the own property; the jsdom prototype getter takes over again.
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (window as unknown as Record<string, unknown>)['location'];
}

// ── AuthGate ──────────────────────────────────────────────────────────────────

describe('AuthGate', () => {
  beforeEach(() => {
    clearToken();
    stubLocation();
    vi.spyOn(history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreLocation();
    clearToken();
  });

  it('shows placeholder and redirects when there is no token', () => {
    render(
      <AuthGate>
        <div>Protected content</div>
      </AuthGate>,
    );

    expect(screen.getByText('Redirecting to sign-in…')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(assignMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login?next='),
    );
  });

  it('shows placeholder and redirects when token is expired', () => {
    setToken(EXPIRED_JWT);

    render(
      <AuthGate>
        <div>Protected content</div>
      </AuthGate>,
    );

    expect(screen.getByText('Redirecting to sign-in…')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
    expect(assignMock).toHaveBeenCalledWith(
      expect.stringContaining('/auth/login?next='),
    );
  });

  it('renders children when token is valid — no redirect', () => {
    setToken(VALID_JWT);

    render(
      <AuthGate>
        <div>Protected content</div>
      </AuthGate>,
    );

    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Redirecting to sign-in…')).not.toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it('captures a #token= fragment from the URL and renders children (OAuth callback flow)', () => {
    // Simulate the backend OAuth callback redirect: …/#token=<jwt>
    // stubLocation() with no hash — we set window.location.hash directly below
    // because captureTokenFromHash reads window.location.hash at call time.
    stubLocation();
    window.location.hash = `#token=${VALID_JWT}`;

    render(
      <AuthGate>
        <div>Protected content</div>
      </AuthGate>,
    );

    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(assignMock).not.toHaveBeenCalled();
    // The hash strip (replaceState) must have been called
    expect(history.replaceState).toHaveBeenCalledWith(
      null,
      '',
      expect.not.stringContaining('#'),
    );
  });
});

// ── useOfficer ────────────────────────────────────────────────────────────────

describe('useOfficer', () => {
  beforeEach(() => {
    stubLocation();
    vi.spyOn(history, 'replaceState').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreLocation();
    clearToken();
  });

  it('provides the officer profile to children via context', () => {
    setToken(VALID_JWT);

    function Inspector() {
      const officer = useOfficer();
      return <span data-testid="email">{officer?.email ?? 'none'}</span>;
    }

    render(
      <AuthGate>
        <Inspector />
      </AuthGate>,
    );

    expect(screen.getByTestId('email').textContent).toBe('alice@compliance.example');
  });
});
