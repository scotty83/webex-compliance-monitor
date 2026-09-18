import { Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type OAuthConfig, type OAuthState,
  buildAuthorizeUrl, exchangeCode, fetchMe, encodeState, decodeState,
} from './webexOauth.js';
import { signAppSession } from './appToken.js';
import { resolveOfficerRole } from './roles.js';

/** One-shot cookie holding the OAuth state nonce for the in-flight login.
 *  Over https we use the `__Host-` prefix, which browsers accept ONLY with
 *  Secure, no Domain, and Path=/ — that combination is what makes the cookie
 *  unshadowable by a sibling subdomain (see readCookie). The prefix is invalid
 *  over http, so plain-http dev falls back to the bare name. */
const STATE_COOKIE_BASE = 'wcms_oauth_state';
const STATE_COOKIE_HOST = `__Host-${STATE_COOKIE_BASE}`;
/** `__Host-` mandates Path=/; using it for both variants keeps the two paths
 *  identical so nothing depends on which name is in play. */
const STATE_COOKIE_PATH = '/';
/** A login round trip is seconds; 10 min is generous and bounds the window. */
const STATE_TTL_MS = 10 * 60 * 1000;

/** Read exactly one cookie from the raw header. Express only *writes* cookies
 *  natively, and reading one value does not justify a cookie-parser dependency.
 *
 *  Returns undefined if the name appears MORE THAN ONCE. Cookies are not
 *  origin-scoped: anything able to write on the parent domain (a dangling CNAME
 *  on a retired subdomain, a third-party SaaS subdomain, a compromised sibling
 *  app) can plant `…=attacker; Domain=<parent>` and, being older, have it sent
 *  first — silently shadowing ours and defeating the CSRF gate. Duplicates are
 *  therefore treated as an attack and fail CLOSED. (`__Host-` already prevents
 *  this in prod; this keeps the http-dev name and any future path change safe.) */
function readCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined;
  let found: string | undefined;
  let seen = 0;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    seen += 1;
    if (seen > 1) return undefined; // shadowed — refuse to guess
    let raw = part.slice(eq + 1).trim();
    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1);
    try {
      found = decodeURIComponent(raw);
    } catch {
      return undefined; // malformed percent-encoding — treat as absent
    }
  }
  return found;
}

/** Constant-time compare; length-guarded because timingSafeEqual throws on a
 *  length mismatch (and the length itself is not a secret here). */
function nonceMatches(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function authRouter(opts: {
  appSecret: string;
  oauth: OAuthConfig;
  appBaseUrl: string;
  officerEmails: string[];
  adminEmails: string[];
  fetchImpl?: typeof fetch;
  webexApiBase: string;
}): Router {
  const router = Router();

  // Secure only over https: setting it on an http dev origin makes the browser
  // drop the cookie outright, which would break login locally. Derived from the
  // redirect URI rather than req.secure because TLS is terminated upstream (the
  // Node process sees plain http) and the app sets no 'trust proxy'.
  const secureCookie = opts.oauth.redirectUri.startsWith('https:');
  const stateCookie = secureCookie ? STATE_COOKIE_HOST : STATE_COOKIE_BASE;

  /** Dead-end guard: a cookie-less callback is a NORMAL event (login left open
   *  past the TTL, cookies cleared, a deploy mid-flight), so it must land the
   *  human on something with a way back — never a raw JSON blob. Deliberately a
   *  link, not an auto-redirect: if the browser truly refuses the cookie, a
   *  redirect to /auth/login would loop forever. */
  const loginDeadEnd = (res: import('express').Response, message: string) =>
    res.status(400).type('html').send(
      `<h1>Sign-in could not be completed.</h1><p>${message}</p><p><a href="/auth/login">Sign in again</a></p>`,
    );

  router.get('/auth/login', (req, res) => {
    const next = String(req.query.next ?? '/');
    // A cached 302 would hand every user the same nonce and silently void the
    // whole property — logins would still succeed, so it would go unnoticed.
    res.set('Cache-Control', 'no-store');
    // Bind this login to THIS browser: the nonce goes to Webex inside `state`
    // and, simultaneously, into an HttpOnly cookie the attacker cannot read or
    // set. The callback redeems a code only when the two match.
    const nonce = randomBytes(32).toString('base64url');
    res.cookie(stateCookie, nonce, {
      httpOnly: true,
      // Lax, NOT Strict: the callback is a top-level cross-site GET back from
      // Webex. Strict withholds the cookie there and every login would fail.
      sameSite: 'lax',
      secure: secureCookie,
      path: STATE_COOKIE_PATH,
      maxAge: STATE_TTL_MS,
    });
    return res.redirect(buildAuthorizeUrl(opts.oauth, encodeState({ next, nonce }), opts.webexApiBase));
  });

  router.get('/auth/callback', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.query.error) return res.status(400).json({ error: String(req.query.error) });
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    if (!code || !state) return res.status(400).json({ error: 'code and state required' });

    // One-shot: drop the cookie whatever happens, so a nonce cannot be replayed.
    const cookieNonce = readCookie(req.headers.cookie, stateCookie);
    res.clearCookie(stateCookie, { path: STATE_COOKIE_PATH, sameSite: 'lax', secure: secureCookie });

    let decoded: OAuthState;
    try {
      decoded = decodeState(state); // throws on a legacy, nonce-less state
    } catch {
      return loginDeadEnd(res, 'This sign-in link is no longer valid.');
    }

    // CSRF gate — BEFORE redeeming the code. An unbound callback (no cookie, or a
    // nonce that is not this browser's) means the login was not started here:
    // honoring it would sign the victim in under the attacker's identity and
    // corrupt every audit_log.officer_email that follows.
    if (cookieNonce === undefined || !nonceMatches(cookieNonce, decoded.nonce)) {
      // Distinguish the two causes: "absent" is usually benign (expired/cleared),
      // "mismatch" is the signature of an actual CSRF attempt. No secrets logged.
      const cause = cookieNonce === undefined ? 'no state cookie' : 'state/cookie nonce mismatch';
      console.error(`[auth] LOUD: rejected OAuth callback not bound to this browser (${cause})`);
      return loginDeadEnd(res, 'Your sign-in session expired or was not started in this browser.');
    }

    try {
      const { accessToken } = await exchangeCode(opts.oauth, code, { fetch: opts.fetchImpl, webexApiBase: opts.webexApiBase });
      const me = await fetchMe(accessToken, { fetch: opts.fetchImpl, webexApiBase: opts.webexApiBase });
      const email = (me.emails[0] ?? '').toLowerCase();
      const role = resolveOfficerRole(email, opts.officerEmails, opts.adminEmails);
      // Fail closed: an identity on neither allowlist may never receive a token.
      if (!role) {
        return res
          .status(403)
          .type('html')
          .send('<h1>Not authorized.</h1><p>Your account is not on the officer or admin roster.</p>');
      }
      const token = signAppSession({ email, role }, opts.appSecret);
      const base = opts.appBaseUrl.replace(/\/$/, '');
      // Guard against open redirect AND fragment injection: a single leading
      // slash (not `//` or `/\`, which browsers read as protocol-relative), and
      // no `#`. A `next` of "/#" would otherwise produce `…/##token=<JWT>`,
      // which the console's `#token=` parser ignores — leaving a live session
      // token sitting in the address bar and synced browser history.
      const safeNext = /^\/(?![/\\])[^#]*$/.test(decoded.next) ? decoded.next : '/';
      return res.redirect(`${base}${safeNext}#token=${encodeURIComponent(token)}`);
    } catch (e) {
      console.error('oauth callback error:', e);
      return res.status(502).json({ error: 'oauth callback failed' });
    }
  });

  return router;
}
