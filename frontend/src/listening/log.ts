import { useSyncExternalStore } from 'react'

// ─── Session-local listening log ──────────────────────────────────────────────
// The officer-facing record of listen_start / listen_stop events for THIS
// browser session. The backend audits the same events server-side from the WS
// lifecycle; this store only feeds the ListeningActivity panel.
//
// TODO(audit-endpoint): replace with officer-scoped GET /audit when backend
// allows it — ListeningActivity takes `entries` as a prop so the swap is
// UI-invisible.

export interface ListeningEntry {
  action: 'listen_start' | 'listen_stop'
  meetingId: string
  title: string
  at: number
}

const MAX_ENTRIES = 50

// Newest-first, immutable snapshot (replaced wholesale on every record so
// useSyncExternalStore change detection works by reference).
let entries: readonly ListeningEntry[] = []

const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((listener) => listener())
}

/** Current log, newest-first. */
export function getListeningEntries(): readonly ListeningEntry[] {
  return entries
}

/** Prepend an entry; the log keeps at most the newest 50. */
export function recordListening(entry: ListeningEntry): void {
  entries = [entry, ...entries].slice(0, MAX_ENTRIES)
  notify()
}

/** Subscribe to log changes. Returns an unsubscribe function. */
export function subscribeListeningLog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Reset the log (tests / session teardown). */
export function clearListeningLog(): void {
  entries = []
  notify()
}

/** React hook — re-renders the consumer whenever the log changes. */
export function useListeningLog(): readonly ListeningEntry[] {
  return useSyncExternalStore(subscribeListeningLog, getListeningEntries)
}
