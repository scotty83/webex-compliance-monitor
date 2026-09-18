import type { ParticipantRole, Attendee } from '../types'

// ── Shared participant presentation helpers ───────────────────────────────────
// Single source of truth for AvatarStack (overview), AttendeesPanel and
// PresenceTimeline (chaperone). PresenceTimeline additionally neutralises
// departed lanes — that variant is local logic there, layered on top of these.

/**
 * Handoff avatar treatment: translucent role tint + role-colored initials.
 * (Solid role-color discs put white initials at ~2.5:1 — fails AA.)
 */
export const ROLE_COLOR: Record<ParticipantRole, { bg: string; text: string }> = {
  analyst: { bg: 'var(--blue-bg)',   text: 'var(--blue)'   },
  fo:      { bg: 'var(--violet-bg)', text: 'var(--violet)' },
  bot:     { bg: 'var(--red-bg)',    text: 'var(--red)'    },
  other:   { bg: 'var(--s3)',        text: 'var(--tx2)'    },
}

/** Display form of a PSTN caller id: NANP numbers grouped for readability, everything
 *  else (international, SIP addresses, masked strings) passed through untouched.
 *  Ported verbatim from sibling project Option A commit b466d89. */
export function formatCallerId(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

/** Human label for an attendee: formatted caller ID when PSTN + phone is
 *  available; the attendee's name otherwise. */
export function attendeeLabel(a: Attendee): string {
  return a.pstn && a.phone ? formatCallerId(a.phone) : a.name;
}

/** Initials for an avatar disc: first letter of the first two words, uppercased. */
export function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
}
