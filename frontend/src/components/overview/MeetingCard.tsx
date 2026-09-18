import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { Meeting } from '../../types'
import { BotStatusIndicator } from '../BotStatusIndicator'
import { AvatarStack } from './AvatarStack'
import { JoinButton } from './JoinButton'
import { useOfficer } from '../../auth/AuthGate'
import { deleteMeeting } from '../../api/client'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime, formatElapsed } from '../../lib/time'

// Re-exported so existing consumers/tests can keep importing from MeetingCard.
export { formatStartTime, formatElapsed }

// Armed remove auto-disarms after this long — an accidental first click
// must not leave a live "Confirm remove" trap on the card indefinitely.
const REMOVE_DISARM_MS = 4_000

// ─── Component ────────────────────────────────────────────────────────────────

interface MeetingCardProps {
  meeting: Meeting
  now: number
  onOpenMeeting: (id: string) => void
  /** Called after a successful DELETE so the owner refetches immediately
   *  instead of waiting out the 5 s poll. */
  onRemoved?: () => void
}

export function MeetingCard({ meeting: m, now, onOpenMeeting, onRemoved }: MeetingCardProps) {
  const { format } = useTimeFormat()
  const officer = useOfficer()
  const [hovered, setHovered] = useState(false)
  const [removePhase, setRemovePhase] = useState<'idle' | 'armed' | 'removing'>('idle')
  const [removeError, setRemoveError] = useState<string | null>(null)
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    },
    [],
  )

  // Admin-only, and never on a live bot — deleting deregisters the meeting,
  // which would hang the bot up mid-monitoring. Live hang-ups belong to the
  // officer/solitude flows, not a card-level delete.
  const canRemove = officer?.role === 'admin' && m.botState !== 'connected'

  function armRemove() {
    setRemovePhase('armed')
    setRemoveError(null)
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    disarmTimer.current = setTimeout(() => setRemovePhase('idle'), REMOVE_DISARM_MS)
  }

  function confirmRemove() {
    if (disarmTimer.current !== null) clearTimeout(disarmTimer.current)
    setRemovePhase('removing')
    deleteMeeting(m.id)
      .then(() => onRemoved?.()) // card disappears on the owner's refetch
      .catch((err: unknown) => {
        // Fail LOUD on the card; the meeting is still there.
        setRemovePhase('idle')
        setRemoveError(err instanceof Error ? err.message : 'Remove failed — try again')
      })
  }

  const startTime = formatStartTime(m.startedAt, format)
  const elapsed   = formatElapsed(now, m.startedAt)

  return (
    <article
      data-testid={`meeting-card-${m.id}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: 'var(--s1)',
        borderRadius: 'var(--radius-lg)',
        border: `1px solid ${hovered ? 'var(--line2)' : 'var(--line)'}`,
        padding: '18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        transition: 'border-color 200ms ease',
      }}
    >
      {/* 1. Title row — NO REC badge; admin remove control on the right */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '8px',
        }}
      >
        <h2
          style={{
            fontFamily: 'var(--font-ui)',
            fontWeight: 700,
            fontSize: '16.5px',
            color: 'var(--tx1)',
            lineHeight: 1.3,
            margin: 0,
          }}
        >
          {m.title}
        </h2>
        {canRemove &&
          (removePhase === 'idle' ? (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Remove ${m.title}`}
              onClick={armRemove}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 26,
                height: 26,
                flexShrink: 0,
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                background: 'transparent',
                color: 'var(--tx2)',
                cursor: 'pointer',
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="icon-btn"
              aria-label={`Confirm remove ${m.title}`}
              onClick={confirmRemove}
              disabled={removePhase === 'removing'}
              style={{
                flexShrink: 0,
                padding: '3px 8px',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid rgba(229,72,77,.4)',
                background: 'rgba(229,72,77,.12)',
                color: 'var(--red, #e5484d)',
                fontFamily: 'var(--font-ui)',
                fontSize: '12px',
                fontWeight: 600,
                whiteSpace: 'nowrap',
                cursor: removePhase === 'removing' ? 'wait' : 'pointer',
                opacity: removePhase === 'removing' ? 0.6 : 1,
              }}
            >
              {removePhase === 'removing' ? 'Removing…' : 'Confirm remove'}
            </button>
          ))}
      </div>

      {removeError !== null && (
        <p
          role="alert"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            color: 'var(--red, #e5484d)',
            margin: 0,
          }}
        >
          {removeError}
        </p>
      )}

      {/* 2. Org + SIP */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <span
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '13px',
            color: 'var(--tx2)',
          }}
        >
          {m.org}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            color: 'var(--tx2)', // tx3 is 3.9:1 on --s1 — below AA for 12px text
          }}
        >
          {m.sipUri}
        </span>
      </div>

      {/* 3. Hairline divider */}
      <hr
        style={{
          border: 'none',
          borderTop: '1px solid var(--line)',
          margin: 0,
        }}
      />

      {/* 4. Status row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '8px',
          flexWrap: 'wrap',
        }}
      >
        <BotStatusIndicator state={m.botState} prefix="Bot " size="sm" variant="pill" />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            color: 'var(--tx2)',
            whiteSpace: 'nowrap',
          }}
        >
          {m.botState === 'ended' && m.endedAt !== undefined
            ? `Ended ${formatStartTime(m.endedAt, format)} · ran ${formatElapsed(m.endedAt, m.startedAt)}`
            : `Started ${startTime} · ${elapsed}`}
        </span>
      </div>

      {/* 5. Attendees row */}
      <AvatarStack attendees={m.attendees} />

      {/* 6. Join button */}
      <JoinButton meetingId={m.id} botState={m.botState} onOpenMeeting={onOpenMeeting} />
    </article>
  )
}
