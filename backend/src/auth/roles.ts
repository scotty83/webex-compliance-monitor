import type { Role } from '../domain/types.js';

/**
 * Resolve an officer's role from the allowlists. Admins are a privileged subset
 * (they also pass officer gates). Returns null when the email is on neither list
 * — callers must fail closed (no token issued).
 */
export function resolveOfficerRole(email: string, officers: string[], admins: string[]): Role | null {
  const e = email.toLowerCase();
  if (admins.map((a) => a.toLowerCase()).includes(e)) return 'admin';
  if (officers.map((o) => o.toLowerCase()).includes(e)) return 'officer';
  return null;
}
