import { Phone, Users } from 'lucide-react'
import type { Attendee, ParticipantRole } from '../../types'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime, formatElapsed } from '../../lib/time'
import { ROLE_COLOR, getInitials, attendeeLabel } from '../../lib/participants'

// Display labels. Type keys stay analyst/fo (backend classification by email
// domain) — only the human-facing strings changed (user request 2026-07-10):
// internal (fo) = "Internal Analyst", external (analyst) = "External Expert".
const ROLE_LABEL: Record<ParticipantRole, string> = {
  analyst: 'External Expert',
  fo:      'Internal Analyst',
  bot:     'Compliance bot',
  other:   'Other',
}

/** An attendee who has left — leftAt is known non-null. */
type DepartedAttendee = Attendee & { leftAt: number }

// ── Sort: active first (joinedAt asc), then departed (leftAt desc) ────────────
// Exported: PresenceTimeline must render lanes in exactly this order.

export function sortAttendees(attendees: Attendee[]): Attendee[] {
  const active = attendees
    .filter((a) => a.leftAt === null)
    .sort((a, b) => a.joinedAt - b.joinedAt)
  const departed = attendees
    .filter((a): a is DepartedAttendee => a.leftAt !== null)
    .sort((a, b) => b.leftAt - a.leftAt)
  return [...active, ...departed]
}

// ── Row ───────────────────────────────────────────────────────────────────────

interface AttendeeRowProps {
  attendee: Attendee
  now: number
  format: '12h' | '24h'
  isFirst: boolean
}

function AttendeeRow({ attendee: a, now, format, isFirst }: AttendeeRowProps) {
  // Destructured local so `leftAt !== null` narrows to number (no casts)
  const { leftAt } = a
  const hasLeft = leftAt !== null
  const { bg, text } = ROLE_COLOR[a.role]

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '12px 18px',
        borderTop: isFirst ? 'none' : '1px solid var(--line)',
      }}
    >
      {/* Avatar — decorative; the name text below is the accessible label.
          Departed rows dim the avatar only (never the text, which must hold AA). */}
      <span
        aria-hidden="true"
        style={{
          position: 'relative',
          flexShrink: 0,
          opacity: hasLeft ? 0.55 : 1,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 34,
            height: 34,
            borderRadius: '50%',
            background: bg,
            color: text,
            fontSize: '12px',
            fontWeight: 800,
            fontFamily: 'var(--font-ui)',
            letterSpacing: '0.02em',
          }}
        >
          {a.pstn
            ? <Phone size={14} strokeWidth={2.5} aria-hidden="true" />
            : getInitials(a.name)}
        </span>
        {/* Presence dot — reinforcement only; the sub-line text is the signal */}
        {!hasLeft && (
          <span
            style={{
              position: 'absolute',
              bottom: '-1px',
              left: '-1px',
              width: '9px',
              height: '9px',
              borderRadius: '50%',
              background: 'var(--green)',
              border: '2px solid var(--s1)',
            }}
          />
        )}
      </span>

      {/* Name block */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
          <span
            style={{
              color: hasLeft ? 'var(--tx2)' : 'var(--tx1)',
              fontWeight: 700,
              fontSize: '13.5px',
              fontFamily: 'var(--font-ui)',
            }}
          >
            {attendeeLabel(a)}
          </span>
          <span
            style={{
              background: bg,
              color: text,
              fontSize: '10.5px',
              fontWeight: 700,
              borderRadius: '5px',
              padding: '2px 8px',
              fontFamily: 'var(--font-ui)',
              whiteSpace: 'nowrap',
            }}
          >
            {ROLE_LABEL[a.role]}
          </span>
          {a.isHost && (
            <span
              style={{
                color: 'var(--amber)',
                fontSize: '10px',
                fontWeight: 800,
                letterSpacing: '0.06em',
                fontFamily: 'var(--font-ui)',
              }}
            >
              HOST
            </span>
          )}
        </div>

        {/* Presence sub-line — the PRIMARY presence signal (never color-only) */}
        <span style={{ fontSize: '12px', color: 'var(--tx2)', fontFamily: 'var(--font-ui)' }}>
          {leftAt !== null
            ? `Left the call · was on for ${formatElapsed(leftAt, a.joinedAt)}`
            : `On call · ${formatElapsed(now, a.joinedAt)}`}
        </span>
      </div>

      {/* Times column */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: '2px',
          flexShrink: 0,
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span style={{ fontSize: '10px', color: 'var(--tx2)' }}>
          {'Joined '}
          <time dateTime={new Date(a.joinedAt).toISOString()} style={{ fontSize: '10.5px' }}>
            {formatStartTime(a.joinedAt, format)}
          </time>
        </span>
        {leftAt !== null && (
          <span style={{ fontSize: '10px', color: 'var(--tx2)' }}>
            <span style={{ color: 'var(--red)', fontWeight: 700 }}>Left</span>
            {' '}
            <time dateTime={new Date(leftAt).toISOString()} style={{ fontSize: '10.5px' }}>
              {formatStartTime(leftAt, format)}
            </time>
          </span>
        )}
      </div>
    </li>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface AttendeesPanelProps {
  attendees: Attendee[]
  now: number
}

/**
 * Chaperone attendee roster: header with on-call/left count chips, then one row
 * per attendee — avatar + presence dot, name + role chip (+ HOST), presence
 * sub-line, and mono join/leave times honoring the officer's time format.
 */
export function AttendeesPanel({ attendees, now }: AttendeesPanelProps) {
  const { format } = useTimeFormat()

  const sorted = sortAttendees(attendees)
  const onCallCount = attendees.filter((a) => a.leftAt === null).length
  const leftCount = attendees.length - onCallCount

  return (
    <section
      aria-labelledby="attendees-heading"
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
        padding: 0,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '14px 18px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Users size={16} aria-hidden="true" style={{ color: 'var(--tx2)', flexShrink: 0 }} />
          <h2
            id="attendees-heading"
            style={{
              fontSize: '15px',
              fontWeight: 800,
              color: 'var(--tx1)',
              fontFamily: 'var(--font-ui)',
              margin: 0,
            }}
          >
            Attendees
          </h2>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: 'var(--green-bg)',
              color: 'var(--green)',
              fontSize: '11.5px',
              fontWeight: 700,
              borderRadius: 'var(--radius-pill)',
              padding: '3px 10px',
              fontFamily: 'var(--font-ui)',
              whiteSpace: 'nowrap',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: 'var(--green)',
                flexShrink: 0,
              }}
            />
            {onCallCount} on call
          </span>
          {leftCount > 0 && (
            <span
              style={{
                background: 'var(--s3)',
                color: 'var(--tx2)',
                fontSize: '11.5px',
                fontWeight: 700,
                borderRadius: 'var(--radius-pill)',
                padding: '3px 10px',
                fontFamily: 'var(--font-ui)',
                whiteSpace: 'nowrap',
              }}
            >
              {leftCount} left
            </span>
          )}
        </div>
      </div>

      {/* Rows */}
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted.map((a, i) => (
          <AttendeeRow key={a.id} attendee={a} now={now} format={format} isFirst={i === 0} />
        ))}
      </ul>
    </section>
  )
}
