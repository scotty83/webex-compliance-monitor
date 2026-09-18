import { CalendarClock } from 'lucide-react'
import { useUpcomingMeetings } from '../../hooks/useUpcomingMeetings'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime } from '../../lib/time'

// ─── Pure countdown helper ────────────────────────────────────────────────────

/**
 * Countdown to a scheduled start: "in 10m" / "in 2h 30m" / "starting now".
 * Never negative — a meeting past its scheduledStart that is not yet in the
 * tracked list shows "starting now". Sub-minute remainders round up.
 */
export function formatCountdown(now: number, scheduledStart: number): string {
  const ms = scheduledStart - now
  if (ms <= 0) return 'starting now'
  const totalMin = Math.ceil(ms / 60_000)
  if (totalMin < 60) return `in ${totalMin}m`
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`
}

// ─── Component ────────────────────────────────────────────────────────────────

interface UpcomingMeetingsProps {
  /** App 1 s tick — drives the countdown chips. */
  now: number
}

/**
 * Upcoming (not yet started) meetings on the single Webex account — an
 * informational secondary surface below the active-meetings grid.
 * Renders NOTHING when there is nothing to show: empty, first load, or error
 * without data (the hook keeps last-good rows on poll errors). No skeleton,
 * no join/register affordance.
 */
export function UpcomingMeetings({ now }: UpcomingMeetingsProps) {
  const { meetings } = useUpcomingMeetings()
  const { format } = useTimeFormat()

  // Covers empty, loading (no data yet), and error-with-no-data alike.
  if (meetings.length === 0) return null

  const sorted = [...meetings].sort((a, b) => a.scheduledStart - b.scheduledStart)

  return (
    <section aria-labelledby="upcoming-meetings-heading" style={{ marginTop: '28px' }}>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          marginBottom: '12px',
        }}
      >
        <CalendarClock size={16} color="var(--tx2)" aria-hidden="true" />
        <h2
          id="upcoming-meetings-heading"
          style={{
            fontFamily: 'var(--font-ui)',
            fontWeight: 800,
            fontSize: '15px',
            color: 'var(--tx1)',
            margin: 0,
          }}
        >
          Upcoming meetings
        </h2>
      </div>

      {/* Panel */}
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          background: 'var(--s1)',
          border: '1px solid var(--line)',
          borderRadius: '14px',
          overflow: 'hidden',
        }}
      >
        {sorted.map((m, i) => (
          <li
            key={m.meetingId}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '16px',
              padding: '12px 16px',
              borderTop: i === 0 ? 'none' : '1px solid var(--line)',
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-ui)',
                fontWeight: 700,
                fontSize: '13px',
                color: 'var(--tx1)',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {m.title}
            </span>

            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '10px',
                flexShrink: 0,
              }}
            >
              {/* Scheduled wall-clock time (12/24h per settings) */}
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: '11.5px',
                  color: 'var(--tx2)',
                }}
              >
                {formatStartTime(m.scheduledStart, format)}
              </span>

              {/* Countdown chip — real text for AT users */}
              <span
                style={{
                  fontFamily: 'var(--font-ui)',
                  fontSize: '11px',
                  fontWeight: 700,
                  color: 'var(--tx2)',
                  background: 'var(--s3)',
                  borderRadius: '999px',
                  padding: '2px 10px',
                  whiteSpace: 'nowrap',
                }}
              >
                {formatCountdown(now, m.scheduledStart)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
