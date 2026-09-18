import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Officer } from '../types';
import {
  captureTokenFromHash,
  decodeSession,
  getToken,
  isExpired,
  redirectToLogin,
} from './session';

// ── Officer context ───────────────────────────────────────────────────────────

const OfficerContext = createContext<Officer | null>(null);

/** Returns the authenticated officer from context, or null if called outside AuthGate. */
export function useOfficer(): Officer | null {
  return useContext(OfficerContext);
}

// ── AuthGate ──────────────────────────────────────────────────────────────────

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Wraps the app. On mount it:
 *   1. Captures any #token= fragment from the URL (and strips it immediately).
 *   2. Validates the session (present + not expired).
 *   3. If invalid → redirects to /auth/login and renders a minimal placeholder.
 *   4. If valid → renders children inside the OfficerContext provider.
 *
 * The gate decision is made synchronously inside the useState lazy initializer so
 * protected content is never flashed before the redirect is issued.
 */
export function AuthGate({ children }: AuthGateProps) {
  // Synchronous: capture + validate before first render to avoid flashing children.
  const [officer] = useState<Officer | null>(() => {
    captureTokenFromHash();
    const token = getToken();
    if (!token) return null;
    const payload = decodeSession(token);
    if (!payload || isExpired(payload)) return null;
    return { email: payload.email, role: payload.role };
  });

  // Redirect is a side-effect; defer to useEffect so React stays happy.
  useEffect(() => {
    if (!officer) {
      redirectToLogin();
    }
  }, [officer]);

  if (!officer) {
    // Shown while the browser processes the redirect — never the protected app.
    return <div aria-live="polite">Redirecting to sign-in…</div>;
  }

  return (
    <OfficerContext.Provider value={officer}>
      {children}
    </OfficerContext.Provider>
  );
}
