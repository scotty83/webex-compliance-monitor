import { useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BotState, Meeting } from '../../types'
import { BotStatusIndicator } from '../BotStatusIndicator'
import { formatElapsed } from '../../lib/time'

// ── Props ─────────────────────────────────────────────────────────────────────

interface OtherMeetingsProps {
  meetings: Meeting[]
  activeMeetingId: string
  now: number
  onOpenMeeting: (id: string) => void
}

// ── Ordering ──────────────────────────────────────────────────────────────────
// Connected (hoppable) first, then dialing/idle/ended, fail-loud states last so
// broken coverage sits together and stays visible.

const FAIL_LOUD_STATES: ReadonlySet<BotState> = new Set(['disconnected', 'failed'])

function orderRank(state: BotState): number {
  if (state === 'connected') return 0
  if (FAIL_LOUD_STATES.has(state)) return 2
  return 1 // dialing / idle / ended
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface MeetingRowProps {
  meeting: Meeting
  now: number
  onOpenMeeting: (id: string) => void
}

const ROW_LAYOUT: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  width: '100%',
  padding: '10px 18px',
}

function MeetingRow({ meeting, now, onOpenMeeting }: MeetingRowProps) {
  const [hovered, setHovered] = useState(false)

  const isConnected = meeting.botState === 'connected'
  const isFailLoud = FAIL_LOUD_STATES.has(meeting.botState)
  const onCallCount = meeting.attendees.filter((a) => a.leftAt === null).length

  const content: ReactNode = (
    <>
      {/* Fail-loud rows render the label so the coverage gap is visible in the
          list; healthy rows keep it sr-only (glyph stays non-color-reliant). */}
      <BotStatusIndicator state={meeting.botState} size="sm" showLabel={isFailLoud} />

      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '13px',
            fontWeight: 700,
            color: isFailLoud ? 'var(--tx2)' : 'var(--tx1)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {meeting.title}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '11.5px',
            color: 'var(--tx2)',
          }}
        >
          {onCallCount} on call · {formatElapsed(now, meeting.startedAt)}
        </span>
      </span>

      {/* Hop affordance — omitted on fail-loud rows (nothing to hop to) */}
      {!isFailLoud && (
        <ChevronRight
          size={16}
          aria-hidden="true"
          style={{ color: 'var(--tx3)', flexShrink: 0 }}
        />
      )}
    </>
  )

  if (isConnected) {
    return (
      <li style={{ listStyle: 'none' }}>
        <button
          className="icon-btn"
          data-testid={`other-meeting-${meeting.id}`}
          onClick={() => onOpenMeeting(meeting.id)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          style={{
            ...ROW_LAYOUT,
            background: hovered ? 'var(--s2)' : 'transparent',
            border: 'none',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'var(--font-ui)',
            transition: 'background 150ms ease',
          }}
        >
          {content}
        </button>
      </li>
    )
  }

  return (
    <li data-testid={`other-meeting-${meeting.id}`} style={{ ...ROW_LAYOUT, listStyle: 'none' }}>
      {content}
    </li>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

/**
 * Right-column hop-to-listen list: every tracked meeting except the active one.
 * Connected rows are full-row buttons that switch the chaperone via
 * onOpenMeeting(id); fail-loud rows are inert with a visible status label.
 */
export function OtherMeetings({ meetings, activeMeetingId, now, onOpenMeeting }: OtherMeetingsProps) {
  const others = meetings
    .filter((m) => m.id !== activeMeetingId)
    .sort((a, b) => orderRank(a.botState) - orderRank(b.botState))

  return (
    <section
      aria-labelledby="other-meetings-heading"
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* Header */}
      <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)' }}>
        <h2
          id="other-meetings-heading"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '14.5px',
            fontWeight: 800,
            color: 'var(--tx1)',
            margin: 0,
          }}
        >
          Other active meetings
        </h2>
        <p
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '11.5px',
            color: 'var(--tx2)', // handoff --tx3 fails AA at this size — bumped
            margin: '2px 0 0',
          }}
        >
          Hop between calls to listen in
        </p>
      </div>

      {/* Rows */}
      {others.length === 0 ? (
        <p
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            color: 'var(--tx2)',
            margin: 0,
            padding: '14px 18px',
          }}
        >
          No other meetings tracked
        </p>
      ) : (
        <ul style={{ margin: 0, padding: '6px 0' }}>
          {others.map((m) => (
            <MeetingRow key={m.id} meeting={m} now={now} onOpenMeeting={onOpenMeeting} />
          ))}
        </ul>
      )}
    </section>
  )
}
