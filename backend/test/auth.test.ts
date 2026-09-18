import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { buildAuthorizeUrl, encodeState, decodeState } from '../src/auth/webexOauth.js';
import { signAppSession, verifyAppSession } from '../src/auth/appToken.js';
import { resolveOfficerRole } from '../src/auth/roles.js';
import { makeRequireRole } from '../src/auth/middleware.js';
import { authRouter } from '../src/auth/routes.js';

const SECRET = 'test-secret';
const oauth = { clientId: 'cid', clientSecret: 'csec', redirectUri: 'http://localhost:4000/auth/callback', scopes: 'spark:people_read' };

describe('oauth + state', () => {
  it('builds an authorize url and round-trips state', () => {
    const url = new URL(buildAuthorizeUrl(oauth, 'STATE', 'https://webexapis.com/v1'));
    expect(url.origin + url.pathname).toBe('https://webexapis.com/v1/authorize');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(decodeState(encodeState({ next: '/meetings', nonce: 'n1' })))
      .toEqual({ next: '/meetings', nonce: 'n1' });
  });

  it('decodeState rejects a state with no nonce (legacy or forged)', () => {
    const legacy = Buffer.from(JSON.stringify({ next: '/' })).toString('base64url');
    expect(() => decodeState(legacy)).toThrow();
  });
});

describe('app-session JWT', () => {
  it('signs and verifies an officer session', () => {
    const t = signAppSession({ email: 'o@x.com', role: 'officer' }, SECRET);
    expect(verifyAppSession(t, SECRET)).toEqual({ email: 'o@x.com', role: 'officer' });
  });
  it('returns null for a token signed with the wrong secret', () => {
    const t = signAppSession({ email: 'o@x.com', role: 'officer' }, 'wrong-secret');
    expect(verifyAppSession(t, SECRET)).toBeNull();
  });
  it('returns null for a tampered token', () => {
    const t = signAppSession({ email: 'o@x.com', role: 'officer' }, SECRET);
    const tampered = t.slice(0, -4) + 'xxxx';
    expect(verifyAppSession(tampered, SECRET)).toBeNull();
  });
  it('returns null for a malformed string', () => {
    expect(verifyAppSession('not.a.jwt', SECRET)).toBeNull();
  });
  it('returns null for a token with an invalid role', () => {
    const t = signAppSession({ email: 'o@x.com', role: 'nonsense' as any }, SECRET);
    expect(verifyAppSession(t, SECRET)).toBeNull();
  });
});

describe('resolveOfficerRole', () => {
  it('returns admin, officer, or null per allowlists', () => {
    expect(resolveOfficerRole('a@x.com', ['o@x.com'], ['a@x.com'])).toBe('admin');
    expect(resolveOfficerRole('o@x.com', ['o@x.com'], ['a@x.com'])).toBe('officer');
    expect(resolveOfficerRole('nobody@x.com', ['o@x.com'], ['a@x.com'])).toBeNull();
  });
});

describe('requireRole middleware', () => {
  function app(role: 'officer' | 'admin') {
    const a = express();
    const requireRole = makeRequireRole(SECRET);
    a.get('/protected', requireRole(role), (_req, res) => res.json({ ok: true, who: res.locals.auth.email }));
    return a;
  }
  it('401 without a token', async () => {
    expect((await request(app('officer')).get('/protected')).status).toBe(401);
  });
  it('admin token passes an officer gate (admin satisfies officer)', async () => {
    const t = signAppSession({ email: 'a@x.com', role: 'admin' }, SECRET);
    const res = await request(app('officer')).get('/protected').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(200);
    expect(res.body.who).toBe('a@x.com');
  });
  it('officer token is rejected by an admin gate (403)', async () => {
    const t = signAppSession({ email: 'o@x.com', role: 'officer' }, SECRET);
    const res = await request(app('admin')).get('/protected').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(403);
  });
});

function authApp(fetchImpl: any, webexApiBase = 'https://webexapis.com/v1') {
  const a = express();
  a.use(authRouter({
    appSecret: SECRET, oauth, appBaseUrl: 'http://localhost:5173',
    officerEmails: ['off@corp.com'], adminEmails: ['admin@corp.com'], fetchImpl,
    webexApiBase,
  }));
  return a;
}
/** Same app, but on an https redirect URI — exercises the prod cookie flags
 *  (Secure + the __Host- prefix) that plain-http dev deliberately skips. */
function httpsAuthApp(fetchImpl: any) {
  const a = express();
  a.use(authRouter({
    appSecret: SECRET,
    oauth: { ...oauth, redirectUri: 'https://monitor.example/auth/callback' },
    appBaseUrl: 'https://monitor.example',
    officerEmails: ['off@corp.com'], adminEmails: ['admin@corp.com'],
    fetchImpl, webexApiBase: 'https://webexapis.com/v1',
  }));
  return a;
}
function oauthFetch(emails: string[]) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/access_token')) return { ok: true, json: async () => ({ access_token: 'USER_AT' }) } as any;
    if (String(url).endsWith('/people/me')) return { ok: true, json: async () => ({ id: 'PID', emails }) } as any;
    throw new Error(`unexpected url ${url}`);
  });
}

/** Drive the REAL browser flow: /auth/login (sets the state cookie) → /auth/callback
 *  carrying that cookie. supertest's agent persists cookies between the two hops. */
async function loginThenCallback(a: express.Express, opts: { next?: string; code?: string } = {}) {
  const agent = request.agent(a);
  const loginRes = await agent.get(`/auth/login?next=${encodeURIComponent(opts.next ?? '/meetings')}`);
  const state = new URL(String(loginRes.headers.location)).searchParams.get('state') ?? '';
  const res = await agent.get(`/auth/callback?code=${opts.code ?? 'abc'}&state=${encodeURIComponent(state)}`);
  return { loginRes, state, res };
}

describe('GET /auth/login + /auth/callback', () => {
  it('login redirects to Webex authorize', async () => {
    const res = await request(authApp(oauthFetch([]))).get('/auth/login?next=/meetings');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('https://webexapis.com/v1/authorize');
  });
  it('callback mints a JWT in the fragment for an allowlisted admin', async () => {
    const { res } = await loginThenCallback(authApp(oauthFetch(['admin@corp.com'])));
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('http://localhost:5173/meetings#token=');
    const token = decodeURIComponent(res.headers.location.split('#token=')[1]);
    expect(verifyAppSession(token, SECRET)?.role).toBe('admin');
  });
  it('callback 403s an email on neither allowlist (no token issued)', async () => {
    const { res } = await loginThenCallback(authApp(oauthFetch(['stranger@corp.com'])), { next: '/' });
    expect(res.status).toBe(403);
    expect(res.headers.location).toBeUndefined();
  });
});

// Login CSRF: without binding `state` to the browser that started the login, an
// attacker can deliver their own code+state to a victim, who then silently acts
// under the ATTACKER's identity — corrupting audit_log.officer_email for every
// subsequent action. For a compliance tool the audit trail is the product.
describe('OAuth state is bound to the browser (CSRF)', () => {
  it('login sets a one-shot HttpOnly, SameSite=Lax state cookie whose nonce is echoed in state', async () => {
    const loginRes = await request(authApp(oauthFetch([]))).get('/auth/login?next=/');
    const setCookie = String([loginRes.headers['set-cookie']].flat().join('; '));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i); // Strict would block the cross-site callback
    // The nonce in `state` must be the cookie's value, not a constant.
    const state = new URL(String(loginRes.headers.location)).searchParams.get('state') ?? '';
    const { nonce } = decodeState(state);
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    expect(setCookie).toContain(nonce);
  });

  it('two logins mint different nonces', async () => {
    const a = authApp(oauthFetch([]));
    const one = await request(a).get('/auth/login?next=/');
    const two = await request(a).get('/auth/login?next=/');
    const nonceOf = (r: request.Response) =>
      decodeState(new URL(String(r.headers.location)).searchParams.get('state') ?? '').nonce;
    expect(nonceOf(one)).not.toBe(nonceOf(two));
  });

  it('rejects a callback with NO state cookie (the CSRF case) without exchanging the code', async () => {
    const fetchImpl = oauthFetch(['admin@corp.com']);
    // Attacker-supplied state, victim never hit /auth/login → no cookie.
    const state = encodeState({ next: '/', nonce: 'attacker-nonce' });
    const res = await request(authApp(fetchImpl))
      .get(`/auth/callback?code=attacker-code&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(res.headers.location).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled(); // never redeem an unbound code
  });

  it('rejects a callback whose state nonce does not match the cookie', async () => {
    const fetchImpl = oauthFetch(['admin@corp.com']);
    const a = authApp(fetchImpl);
    const agent = request.agent(a);
    await agent.get('/auth/login?next=/'); // real cookie for THIS browser
    const forged = encodeState({ next: '/', nonce: 'not-the-cookie-nonce' });
    const res = await agent.get(`/auth/callback?code=abc&state=${encodeURIComponent(forged)}`);
    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a legacy state with no nonce at all', async () => {
    const a = authApp(oauthFetch(['admin@corp.com']));
    const agent = request.agent(a);
    await agent.get('/auth/login?next=/');
    const legacy = Buffer.from(JSON.stringify({ next: '/' })).toString('base64url');
    const res = await agent.get(`/auth/callback?code=abc&state=${encodeURIComponent(legacy)}`);
    expect(res.status).toBe(400);
  });

  it('clears the cookie on success so the same nonce cannot be replayed', async () => {
    const a = authApp(oauthFetch(['admin@corp.com']));
    const { res, state } = await loginThenCallback(a);
    expect(res.status).toBe(302);
    const cleared = String([res.headers['set-cookie']].flat().join('; '));
    expect(cleared).toMatch(/wcms_oauth_state=;|Expires=Thu, 01 Jan 1970/i);
    // Replaying the same state on a fresh browser (no cookie) must fail.
    const replay = await request(a).get(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(replay.status).toBe(400);
  });

  it('marks the cookie Secure when the redirect URI is https, and not on http dev', async () => {
    const secureRes = await request(httpsAuthApp(oauthFetch([]))).get('/auth/login?next=/');
    expect(String([secureRes.headers['set-cookie']].flat().join('; '))).toMatch(/Secure/i);

    // http dev must NOT set Secure, or the browser drops the cookie and login breaks.
    const devRes = await request(authApp(oauthFetch([]))).get('/auth/login?next=/');
    expect(String([devRes.headers['set-cookie']].flat().join('; '))).not.toMatch(/Secure/i);
  });

  // Cookies are not origin-scoped: any sibling subdomain that can write on the
  // parent domain could otherwise plant `wcms_oauth_state=<attacker>` and, being
  // older, have it sent first — shadowing ours and defeating the whole gate.
  it('over https uses the __Host- prefix (browser-enforced: Secure, no Domain, Path=/)', async () => {
    const res = await request(httpsAuthApp(oauthFetch([]))).get('/auth/login?next=/');
    const setCookie = String([res.headers['set-cookie']].flat().join('; '));
    expect(setCookie).toMatch(/^__Host-wcms_oauth_state=/);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  it('fails CLOSED when the state cookie name appears twice (shadowing attempt)', async () => {
    const fetchImpl = oauthFetch(['admin@corp.com']);
    const a = authApp(fetchImpl);
    const loginRes = await request(a).get('/auth/login?next=/');
    const state = new URL(String(loginRes.headers.location)).searchParams.get('state') ?? '';
    const real = decodeState(state).nonce;

    // Attacker's value planted first (as a parent-domain cookie would be), ours second.
    const res = await request(a)
      .get(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`)
      .set('Cookie', `wcms_oauth_state=attacker; wcms_oauth_state=${real}`);

    expect(res.status).toBe(400);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a rejected callback returns HTML with a way back, not a JSON dead end', async () => {
    const state = encodeState({ next: '/', nonce: 'unbound' });
    const res = await request(authApp(oauthFetch([])))
      .get(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('/auth/login'); // a link back, so the user is not stranded
  });

  it('never caches the login redirect (a cached nonce would void the gate for everyone)', async () => {
    const res = await request(authApp(oauthFetch([]))).get('/auth/login?next=/');
    expect(String(res.headers['cache-control'])).toMatch(/no-store/);
  });

  // `next` is attacker-suppliable. "/#" would yield `…/##token=<JWT>`, which the
  // console's `#token=` parser ignores — stranding a live session token in the
  // address bar and synced history.
  it.each(['/#', '//evil.example', '/\\evil.example', 'https://evil.example'])(
    'falls back to "/" for an unsafe next (%s), never leaking the token into the URL bar',
    async (bad) => {
      const a = authApp(oauthFetch(['admin@corp.com']));
      const agent = request.agent(a);
      const loginRes = await agent.get(`/auth/login?next=${encodeURIComponent(bad)}`);
      const state = new URL(String(loginRes.headers.location)).searchParams.get('state') ?? '';
      const res = await agent.get(`/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        `http://localhost:5173/#token=${encodeURIComponent(res.headers.location.split('#token=')[1])}`,
      );
      expect(res.headers.location).not.toContain('evil.example');
      expect(res.headers.location).not.toContain('##');
    },
  );
});

describe('custom webexApiBase', () => {
  it('uses the injected base for authorize, token, and people/me', async () => {
    const customBase = 'https://example.test/v1';
    const capturedUrls: string[] = [];
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      capturedUrls.push(String(url));
      if (String(url).endsWith('/access_token')) return { ok: true, json: async () => ({ access_token: 'AT' }) } as any;
      if (String(url).endsWith('/people/me')) return { ok: true, json: async () => ({ id: 'PID', emails: ['off@corp.com'] }) } as any;
      throw new Error(`unexpected url ${url}`);
    });

    const a = express();
    a.use(authRouter({
      appSecret: SECRET, oauth, appBaseUrl: 'http://localhost:5173',
      officerEmails: ['off@corp.com'], adminEmails: ['admin@corp.com'],
      fetchImpl: mockFetch,
      webexApiBase: customBase,
    }));

    // authorize redirect must target the custom base
    const loginRes = await request(a).get('/auth/login?next=/');
    expect(loginRes.headers.location).toContain(`${customBase}/authorize`);

    // token exchange and people/me must target the custom base. Drive the real
    // flow so the callback carries the state cookie minted by /auth/login.
    const agent = request.agent(a);
    const loginForState = await agent.get('/auth/login?next=/');
    const state = new URL(String(loginForState.headers.location)).searchParams.get('state') ?? '';
    await agent.get(`/auth/callback?code=xyz&state=${encodeURIComponent(state)}`);
    expect(capturedUrls[0]).toContain(`${customBase}/access_token`);
    expect(capturedUrls[1]).toContain(`${customBase}/people/me`);
  });
});
