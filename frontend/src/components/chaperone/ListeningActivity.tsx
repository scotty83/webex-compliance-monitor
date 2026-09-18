import { Clock } from 'lucide-react'
import type { ListeningEntry } from '../../listening/log'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime } from '../../lib/time'

// ── Props ─────────────────────────────────────────────────────────────────────
// Entries arrive newest-first as a PROP (session-local log today).
// TODO(audit-endpoint): swap the source to officer-scoped GET /audit when the
// backend allows it — this component won't change.

interface ListeningActivityProps {
  entries: readonly ListeningEntry[]
}

const MAX_VISIBLE = 10

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Right-column session log: the officer's own listen start/stop events,
 * newest-first, capped at 10 visible rows. Green dot = started, hollow
 * ring = stopped; mono wall-clock time honours the 12/24h setting.
 */
export function ListeningActivity({ entries }: ListeningActivityProps) {
  const { format } = useTimeFormat()
  const visible = entries.slice(0, MAX_VISIBLE)

  return (
    <section
      aria-labelledby="listening-activity-heading"
      style={{
        background: 'var(--s1)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius-lg)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '14px 18px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <Clock size={16} aria-hidden="true" style={{ color: 'var(--tx2)', flexShrink: 0 }} />
        <h2
          id="listening-activity-heading"
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '14.5px',
            fontWeight: 800,
            color: 'var(--tx1)',
            margin: 0,
          }}
        >
          Listening activity
        </h2>
      </div>

      {/* Entries */}
      {visible.length === 0 ? (
        <p
          style={{
            fontFamily: 'var(--font-ui)',
            fontSize: '12px',
            color: 'var(--tx2)',
            margin: 0,
            padding: '14px 18px',
          }}
        >
          No listening activity yet — join a meeting to listen for the record.
        </p>
      ) : (
        <ul style={{ margin: 0, padding: '6px 0' }}>
          {visible.map((e, i) => {
            const started = e.action === 'listen_start'
            return (
              <li
                key={`${e.at}-${e.action}-${e.meetingId}`}
                data-testid={`listening-entry-${i}`}
                style={{
                  listStyle: 'none',
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '10px',
                  padding: '8px 18px',
                }}
              >
                {/* Status dot: solid green = started, hollow ring = stopped */}
                <span
                  aria-hidden="true"
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    flexShrink: 0,
                    marginTop: '4px',
                    ...(started
                      ? { background: 'var(--green)' }
                      : { border: '2px solid var(--s3)' }),
                  }}
                />

                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '2px',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: '12.5px',
                      fontWeight: 700,
                      color: 'var(--tx1)',
                    }}
                  >
                    {started ? 'Started listening' : 'Stopped listening'}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--font-ui)',
                      fontSize: '11.5px',
                      color: 'var(--tx2)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {e.title}
                  </span>
                </span>

                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    color: 'var(--tx2)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatStartTime(e.at, format)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
