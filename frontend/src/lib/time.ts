// ─── Pure time-formatting helpers ─────────────────────────────────────────────
// Shared by overview/MeetingCard, chaperone/MeetingBar, and chaperone/AttendeesPanel.

/** Format an epoch-ms timestamp as a wall-clock time ("14:05" / "2:05 PM"). */
export function formatStartTime(ts: number, format: '12h' | '24h'): string {
  const d = new Date(ts)
  if (format === '24h') {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}

/** Human duration between two epoch-ms timestamps ("< 1m", "30m", "2h", "1h 30m"). */
export function formatElapsed(now: number, startedAt: number): string {
  const ms = now - startedAt
  if (ms < 0) return '0m'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return '< 1m'
  if (totalMin < 60) return `${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
