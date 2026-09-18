import { AlertTriangle } from 'lucide-react'
import type { Meeting } from '../../types'
import { partitionMeetings } from '../../lib/partitionMeetings'

interface IssuesBadgeProps {
  meetings: Meeting[]
  /** Same tick that drives the Active/Past split, so the badge clears at exactly
   *  the moment the loud card leaves Active. */
  now: number
}

export function IssuesBadge({ meetings, now }: IssuesBadgeProps) {
  // Count ONLY bots still LOUD in Active. partitionMeetings demotes a
  // failed/disconnected bot to Past once its grace window elapses; counting the
  // raw list left the badge lit forever for a meeting with no actionable card —
  // permanent alert fatigue that a non-admin officer could never clear.
  const { active } = partitionMeetings(meetings, now)
  const count = active.filter(
    (m) => m.botState === 'failed' || m.botState === 'disconnected'
  ).length

  if (count === 0) return null

  const label =
    count === 1 ? '1 bot needs attention' : `${count} bots need attention`

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: 'var(--red-bg)',
        color: 'var(--red)',
        border: '1px solid rgba(255,91,82,.25)',
        borderRadius: 'var(--radius-pill)',
        padding: '4px 12px',
        fontSize: 13,
        fontWeight: 600,
      }}
    >
      <AlertTriangle aria-hidden="true" size={13} strokeWidth={2.5} />
      {label}
    </div>
  )
}
