import { useEffect, useState } from 'react'
import { LineChart, Phone } from 'lucide-react'
import type { Attendee } from '../../types'
import { useTimeFormat } from '../../settings/timeFormat'
import { formatStartTime } from '../../lib/time'
import { ROLE_COLOR, getInitials, attendeeLabel } from '../../lib/participants'
import { sortAttendees } from './AttendeesPanel'

// ── Pure timeline math (exported for direct unit tests) ───────────────────────

export interface TimelineWindow {
  windowStart: number
  windowEnd: number
}

const MINUTE_MS = 60_000

/** Bars shorter than this render at the minimum so a blip is still visible. */
export const MIN_BAR_WIDTH_PCT = 0.5

/** Window: earliest of startedAt / any joinedAt, through now (handoff spec). */
export function computeWindow(
  startedAt: number,
  attendees: readonly Attendee[],
  now: number,
): TimelineWindow {
  const windowStart = attendees.reduce((min, a) => Math.min(min, a.joinedAt), startedAt)
  return { windowStart, windowEnd: now }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

/** Map an epoch-ms timestamp to a 0–100 position within the window. */
export function positionPct(ts: number, win: TimelineWindow): number {
  const span = win.windowEnd - win.windowStart
  if (span <= 0) return 0
  return clamp01((ts - win.windowStart) / span) * 100
}

/**
 * Bar left/width as percentages of the track. Active bars (leftAt null) run to
 * windowEnd. Both edges clamp to the window; widths never drop below
 * MIN_BAR_WIDTH_PCT, and left shifts if needed so left + width ≤ 100.
 */
export function barGeometry(
  joinedAt: number,
  leftAt: number | null,
  win: TimelineWindow,
): { leftPct: number; widthPct: number } {
  const span = win.windowEnd - win.windowStart
  if (span <= 0) return { leftPct: 0, widthPct: MIN_BAR_WIDTH_PCT }
  const startFrac = clamp01((joinedAt - win.windowStart) / span)
  const endFrac = clamp01(((leftAt ?? win.windowEnd) - win.windowStart) / span)
  const widthPct = Math.max((endFrac - startFrac) * 100, MIN_BAR_WIDTH_PCT)
  const leftPct = Math.min(startFrac * 100, 100 - widthPct)
  return { leftPct, widthPct }
}

/** Plan-mandated tick step: span ≤16m → 4m; ≤40m → 8m; else 15m. */
export function tickStepMs(spanMs: number): number {
  if (spanMs <= 16 * MINUTE_MS) return 4 * MINUTE_MS
  if (spanMs <= 40 * MINUTE_MS) return 8 * MINUTE_MS
  return 15 * MINUTE_MS
}

/**
 * Axis tick timestamps: first tick at the first step-multiple ≥ windowStart
 * (steps are whole minutes, so ticks land on whole minutes), then every step
 * up to and including windowEnd.
 */
export function tickTimes(win: TimelineWindow): number[] {
  const span = win.windowEnd - win.windowStart
  if (span <= 0) return []
  const step = tickStepMs(span)
  const ticks: number[] = []
  for (let t = Math.ceil(win.windowStart / step) * step; t <= win.windowEnd; t += step) {
    ticks.push(t)
  }
  return ticks
}

// ── Layout constants ──────────────────────────────────────────────────────────

const GUTTER_PX = 150 // avatar + name column (handoff: ~150px)

// ── Lane ──────────────────────────────────────────────────────────────────────

interface LaneProps {
  attendee: Attendee
  win: TimelineWindow
  reducedMotion: boolean
}

function Lane({ attendee: a, win, reducedMotion }: LaneProps) {
  const isActive = a.leftAt === null
  const { bg, text } = ROLE_COLOR[a.role]
  const { leftPct, widthPct } = barGeometry(a.joinedAt, a.leftAt, win)

  return (
    <div data-lane={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {/* Gutter: mini avatar + name (name is the real text; avatar decorative) */}
      <div
        style={{
          width: GUTTER_PX,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
        }}
      >
        <span
          aria-hidden="true"
          data-avatar
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 22,
            height: 22,
            flexShrink: 0,
            borderRadius: '50%',
            background: isActive ? bg : 'rgba(255,255,255,0.04)',
            color: isActive ? text : 'var(--tx3)',
            fontSize: '9.5px',
            fontWeight: 800,
            fontFamily: 'var(--font-ui)',
            letterSpacing: '0.02em',
          }}
        >
          {a.pstn
            ? <Phone size={10} strokeWidth={2.5} aria-hidden="true" />
            : getInitials(a.name)}
        </span>
        <span
          style={{
            color: 'var(--tx2)',
            fontSize: '12px',
            fontWeight: 600,
            fontFamily: 'var(--font-ui)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {attendeeLabel(a)}
        </span>
      </div>

      {/* Track + presence bar */}
      <div
        style={{
          flex: 1,
          position: 'relative',
          height: '12px',
          borderRadius: 'var(--radius-pill)',
          background: 'rgba(255,255,255,0.04)',
        }}
      >
        <span
          aria-hidden="true"
          data-bar={isActive ? 'active' : 'departed'}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            borderRadius: 'var(--radius-pill)',
            // departed = --tx3 (a mid gray): --s3 was near-invisible on the
            // track (both very dark), so "left" bars couldn't be read.
            background: isActive ? 'var(--green)' : 'var(--tx3)',
            opacity: isActive ? 0.75 : 1,
          }}
        />
        {/* Terminal dot at the now end — sibling of the bar so it stays solid
            (a child would inherit the bar's 0.75 opacity). */}
        {isActive && (
          <span
            aria-hidden="true"
            data-dot
            style={{
              position: 'absolute',
              top: '50%',
              left: `${leftPct + widthPct}%`,
              transform: 'translate(-50%, -50%)',
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: 'var(--green)',
              animation: reducedMotion ? 'none' : 'presence-pulse 1.6s ease-in-out infinite',
            }}
          />
        )}
      </div>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface PresenceTimelineProps {
  attendees: Attendee[]
  startedAt: number
  now: number
}

/**
 * Per-attendee presence bars over a shared time axis: active bars run
 * joinedAt → now (green, pulsing terminal dot), departed bars joinedAt → leftAt
 * (muted), with a now-line and clock ticks. Supplementary to AttendeesPanel's
 * text, so the chart body is a single role="img" with a summary label.
 */
export function PresenceTimeline({ attendees, startedAt, now }: PresenceTimelineProps) {
  const { format } = useTimeFormat()

  // Reactive reduced-motion — same pattern as BotStatusIndicator
  const [reducedMotion, setReducedMotion] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)')
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [])

  const win = computeWindow(startedAt, attendees, now)
  const windowMinutes = Math.round((win.windowEnd - win.windowStart) / MINUTE_MS)
  const sorted = sortAttendees(attendees)
  const onCallCount = attendees.filter((a) => a.leftAt === null).length
  const leftCount = attendees.length - onCallCount
  const ticks = tickTimes(win)

  return (
    <section
      aria-labelledby="presence-timeline-heading"
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
          <LineChart size={16} aria-hidden="true" style={{ color: 'var(--tx2)', flexShrink: 0 }} />
          <h2
            id="presence-timeline-heading"
            style={{
              fontSize: '15px',
              fontWeight: 800,
              color: 'var(--tx1)',
              fontFamily: 'var(--font-ui)',
              margin: 0,
            }}
          >
            Presence timeline
          </h2>
        </div>
        {/* Handoff uses --tx3 here — fails AA at this size, bumped to --tx2 */}
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '11px',
            color: 'var(--tx2)',
            whiteSpace: 'nowrap',
          }}
        >
          {windowMinutes}m window
        </span>
      </div>

      {/* Chart body — one image for AT; AttendeesPanel carries the full text */}
      <div
        role="img"
        aria-label={`Presence timeline: ${onCallCount} on call, ${leftCount} left`}
        style={{ padding: '14px 18px' }}
      >
        {/* Lanes + now-line (line spans all lanes at the x of `now` = 100%) */}
        <div
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {sorted.map((a) => (
            <Lane key={a.id} attendee={a} win={win} reducedMotion={reducedMotion} />
          ))}
          <span
            aria-hidden="true"
            data-now-line
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              right: '-1px',
              width: '2px',
              borderRadius: '1px',
              background: 'var(--green)',
            }}
          />
        </div>

        {/* Axis: mono clock ticks positioned by the same % math as the bars */}
        {ticks.length > 0 && (
          <div style={{ display: 'flex', marginTop: '8px' }}>
            <span style={{ width: GUTTER_PX, flexShrink: 0 }} aria-hidden="true" />
            <div style={{ flex: 1, position: 'relative', height: '14px', marginLeft: '10px' }}>
              {ticks.map((t) => (
                <span
                  key={t}
                  data-tick
                  style={{
                    position: 'absolute',
                    left: `${positionPct(t, win)}%`,
                    transform: 'translateX(-50%)',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '10.5px',
                    color: 'var(--tx2)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatStartTime(t, format)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
