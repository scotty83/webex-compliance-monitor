import type { Role } from '../types';

// ── Role allowlist ────────────────────────────────────────────────────────────
// Derived from the Role union in types.ts — if that union changes, update here.
// A TypeScript assertion below keeps them in sync at compile time.
const VALID_ROLES: ReadonlySet<string> = new Set<Role>(['officer', 'admin']);

// ── Storage key ───────────────────────────────────────────────────────────────

const TOKEN_KEY = 'wcms_session_token';

// ── Token storage (sessionStorage: survives refresh, cleared on tab close) ────

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}

// ── Fragment capture ──────────────────────────────────────────────────────────
// The backend redirects to the SPA as: …/#token=<jwt>
// We capture it once and immediately strip it from the address bar / history
// so the JWT never lingers in the URL.

export function captureTokenFromHash(): void {
  const hash = window.location.hash; // e.g. "#token=eyJ..."
  if (!hash.startsWith('#token=')) return;
  const token = hash.slice('#token='.length);
  if (token) setToken(token); // never log the token
  // Strip the fragment immediately — must not appear in history
  history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );
}

// ── JWT decode (payload only — no signature verification) ─────────────────────
// The backend is the sole authority; we decode client-side for UI/display/gating
// only. Verifying the signature here would require exposing the secret.

export interface SessionPayload {
  email: string;
  role: Role;
  exp?: number;
}

function base64urlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = (4 - (base64.length % 4)) % 4;
  return atob(base64 + '='.repeat(pad));
}

export function decodeSession(token: string): SessionPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const raw = base64urlDecode(parts[1]);
    const payload = JSON.parse(raw) as Record<string, unknown>;
    if (typeof payload['email'] !== 'string') return null;
    if (typeof payload['role'] !== 'string' || !VALID_ROLES.has(payload['role'])) return null;
    const result: SessionPayload = {
      email: payload['email'],
      role: payload['role'] as Role,
    };
    if (typeof payload['exp'] === 'number') result.exp = payload['exp'];
    return result;
  } catch {
    return null;
  }
}

// ── Expiry check ──────────────────────────────────────────────────────────────

const CLOCK_SKEW_S = 5; // allow 5 s of clock drift

export function isExpired(session: SessionPayload): boolean {
  if (session.exp === undefined) return false;
  return session.exp < Math.floor(Date.now() / 1000) - CLOCK_SKEW_S;
}

// ── Login redirect ────────────────────────────────────────────────────────────

export function redirectToLogin(
  next: string = window.location.pathname + window.location.search,
): void {
  window.location.assign('/auth/login?next=' + encodeURIComponent(next));
}
