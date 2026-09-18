export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string;
}

export function buildAuthorizeUrl(cfg: OAuthConfig, state: string, webexApiBase: string): string {
  const u = new URL(`${webexApiBase}/authorize`);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', cfg.redirectUri);
  u.searchParams.set('scope', cfg.scopes);
  u.searchParams.set('state', state);
  return u.toString();
}

export async function exchangeCode(
  cfg: OAuthConfig,
  code: string,
  deps: { fetch?: typeof fetch; webexApiBase: string },
): Promise<{ accessToken: string }> {
  const doFetch = deps.fetch ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
    redirect_uri: cfg.redirectUri,
  });
  const res = await doFetch(`${deps.webexApiBase}/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('oauth code exchange failed');
  const json = (await res.json()) as { access_token: string };
  return { accessToken: json.access_token };
}

export async function fetchMe(
  accessToken: string,
  deps: { fetch?: typeof fetch; webexApiBase: string },
): Promise<{ id: string; emails: string[] }> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(`${deps.webexApiBase}/people/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error('people/me failed');
  const json = (await res.json()) as { id: string; emails?: string[] };
  return { id: json.id, emails: json.emails ?? [] };
}

/** OAuth `state`. `nonce` binds the round trip to the browser that started it:
 *  the same value is set as an HttpOnly cookie at /auth/login and must match on
 *  the callback (see authRouter). Without it, an attacker's code+state delivered
 *  to a victim would log them in AS THE ATTACKER, corrupting the audit trail. */
export interface OAuthState {
  next: string;
  nonce: string;
}

export function encodeState(s: OAuthState): string {
  return Buffer.from(JSON.stringify(s)).toString('base64url');
}

/** Throws on anything that is not a well-formed, nonce-bearing state — including
 *  a legacy nonce-less state, which must never be honored. */
export function decodeState(raw: string): OAuthState {
  const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  const s = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<OAuthState>;
  if (typeof s.next !== 'string' || typeof s.nonce !== 'string' || s.nonce === '') {
    throw new Error('oauth state is missing next/nonce');
  }
  return { next: s.next, nonce: s.nonce };
}
