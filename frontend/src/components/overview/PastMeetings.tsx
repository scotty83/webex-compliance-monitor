import { History } from 'lucide-react'
import { MeetingCard } from './MeetingCard'
import type { Meeting } from '../../types'

interface PastMeetingsProps {
  /** Terminal meetings past the fail-LOUD grace window — pre-sorted most-recent-first
   *  by partitionMeetings. */
  meetings: Meeting[]
  now: number
  onOpenMeeting: (id: string) => void
  /** Threaded to each card's admin remove control (refetch after DELETE). */
  onRemoved?: () => void
}

/**
 * "Past meetings" section — terminal meetings that have cleared the fail-LOUD
 * grace window (or are cleanly ended). Self-hides when empty (same contract as
 * UpcomingMeetings). List is pre-sorted most-recent-first by partitionMeetings.
 */
export function PastMeetings({ meetings, now, onOpenMeeting, onRemoved }: PastMeetingsProps) {
  if (meetings.length === 0) return null

  return (
    <section aria-labelledby="past-meetings-heading" style={{ marginTop: '28px' }}>
      {/* Section header — mirrors UpcomingMeetings header pattern */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '12px',
        }}
      >
        <History size={16} color="var(--tx2)" aria-hidden="true" />
        <h2
          id="past-meetings-heading"
          style={{
            fontFamily: 'var(--font-ui)',
            fontWeight: 800,
            fontSize: '15px',
            color: 'var(--tx1)',
            margin: 0,
          }}
        >
          Past meetings
        </h2>
      </div>

      {/* Panel — stacked MeetingCards, most-recent first. Full MeetingCard so
          "View history" (Task 6) is immediately available per row. */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
        }}
      >
        {meetings.map((m) => (
          <MeetingCard
            key={m.id}
            meeting={m}
            now={now}
            onOpenMeeting={onOpenMeeting}
            onRemoved={onRemoved}
          />
        ))}
      </div>
    </section>
  )
}
