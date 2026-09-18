import type { Meeting } from '../types'

/** How long a fresh-failed/disconnected bot stays in Active (fail-LOUD grace window).
 *  15 min (product decision: a fresh compliance gap must stay visible). */
export const FAILURE_GRACE_MS = 15 * 60 * 1_000

/**
 * Split a flat meetings list into Active (live/pending/fresh-fail) and
 * Past (terminal + grace-cleared). Client-side only — no API needed.
 *
 * Rules (spec § "Active vs Past split + auto-clear"):
 *  - ended      → past immediately (clean end, no active gap)
 *  - failed | disconnected, endedAt within FAILURE_GRACE_MS → active (fail-LOUD)
 *  - failed | disconnected, grace elapsed OR endedAt undefined → past
 *  - idle | dialing | connected → active always
 *
 * Past list is sorted most-recent-first (descending endedAt).
 */
export function partitionMeetings(
  meetings: Meeting[],
  now: number,
): { active: Meeting[]; past: Meeting[] } {
  const active: Meeting[] = []
  const past: Meeting[] = []

  for (const m of meetings) {
    if (m.botState === 'ended') {
      past.push(m)
    } else if (m.botState === 'failed' || m.botState === 'disconnected') {
      const age = now - (m.endedAt ?? 0)
      if (age < FAILURE_GRACE_MS) {
        active.push(m) // still within grace — keep LOUD in Active
      } else {
        past.push(m)
      }
    } else {
      // idle | dialing | connected — always Active
      active.push(m)
    }
  }

  past.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
  return { active, past }
}
