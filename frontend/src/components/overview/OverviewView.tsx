import type { Meeting } from '../../types'
import { BOT_STATUS_MAP } from '../botStatus'
import { MeetingCard } from './MeetingCard'
import { UpcomingMeetings } from './UpcomingMeetings'
import { ScheduleMeeting } from './ScheduleMeeting'
import { Loading } from '../states/Loading'
import { Empty } from '../states/Empty'
import { ErrorState } from '../states/Error'
import { partitionMeetings } from '../../lib/partitionMeetings'
import { PastMeetings } from './PastMeetings'

// ─── Legend ───────────────────────────────────────────────────────────────────

type LegendState = 'connected' | 'dialing' | 'disconnected'
const LEGEND_ITEMS: { state: LegendState; label: string }[] = [
  { state: 'connected',    label: 'Connected'    },
  { state: 'dialing',     label: 'Dialing'      },
  { state: 'disconnected', label: 'Disconnected' },
]

function LegendItem({ state, label }: { state: LegendState; label: string }) {
  const { colorVar } = BOT_STATUS_MAP[state]
  return (
    <span role="listitem" style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: `var(${colorVar})`,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily: 'var(--font-ui)',
          fontSize: '12px',
          color: 'var(--tx2)',
        }}
      >
        {label}
      </span>
    </span>
  )
}

// ─── OverviewView ─────────────────────────────────────────────────────────────

interface OverviewViewProps {
  meetings: Meeting[]
  now: number
  loading: boolean
  error: Error | null
  onRetry: () => void
  onOpenMeeting: (id: string) => void
}

export function OverviewView({
  meetings,
  now,
  loading,
  error,
  onRetry,
  onOpenMeeting,
}: OverviewViewProps) {
  // First load — no data yet: show skeleton grid
  // (.view-container in styles/responsive.css: max-width 1320px, centered,
  //  32/24px padding that tightens below 760px)
  if (loading && meetings.length === 0) {
    return (
      <div className="view-container">
        <Loading />
      </div>
    )
  }

  // Error with no cached data: show full error banner (no grid)
  const showErrorBanner = error !== null && meetings.length === 0

  const { active, past } = partitionMeetings(meetings, now)

  return (
    <div className="view-container">

      {/* Header block */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '16px',
          marginBottom: '24px',
          flexWrap: 'wrap',
        }}
      >
        {/* Title + subtitle */}
        <div>
          <h1
            style={{
              fontFamily: 'var(--font-ui)',
              fontWeight: 800,
              fontSize: '23px',
              color: 'var(--tx1)',
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            Active meetings
          </h1>
          <p
            style={{
              fontFamily: 'var(--font-ui)',
              fontSize: '13px',
              color: 'var(--tx2)',
              marginTop: '5px',
              marginBottom: 0,
            }}
          >
            Calls currently chaperoned by the compliance bot. Select one to listen in.
          </p>
        </div>

        {/* Legend */}
        <div
          role="list"
          style={{
            display: 'flex',
            gap: '16px',
            alignItems: 'center',
            flexShrink: 0,
          }}
        >
          {LEGEND_ITEMS.map(({ state, label }) => (
            <LegendItem key={state} state={state} label={label} />
          ))}
        </div>

        {/* Admin-only: schedule a Webex meeting without leaving the console.
            Self-gating — renders null for officers (useOfficer role check). */}
        <ScheduleMeeting />
      </div>

      {/* Error banner (no cached data) */}
      {showErrorBanner && <ErrorState error={error} onRetry={onRetry} />}

      {/* Subtle inline reconnecting indicator (poll error but data exists) */}
      {error !== null && meetings.length > 0 && (
        <p
          aria-live="polite"
          style={{
            fontSize: '12px',
            color: 'var(--tx3)',
            marginBottom: '12px',
          }}
        >
          Reconnecting…
        </p>
      )}

      {/* Empty state — only when BOTH active and past are empty */}
      {!showErrorBanner && active.length === 0 && past.length === 0 && <Empty />}

      {/* Active meetings grid — idle/dialing/connected + fresh-failed/disconnected.
          failed/disconnected stay here until FAILURE_GRACE_MS expires (fail-LOUD). */}
      {active.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(360px, 100%), 1fr))',
            gap: '16px',
          }}
        >
          {active.map((m) => (
            <MeetingCard
              key={m.id}
              meeting={m}
              now={now}
              onOpenMeeting={onOpenMeeting}
              onRemoved={onRetry}
            />
          ))}
        </div>
      )}

      {/* Upcoming (not yet started) meetings — served by GET /meetings/upcoming
          (calendar sync cache); the section self-hides when empty */}
      <UpcomingMeetings now={now} />

      {/* Past meetings — cleanly ended + grace-cleared failures, most-recent first.
          Self-hides when empty. "View history" per card via Task 6. */}
      <PastMeetings meetings={past} now={now} onOpenMeeting={onOpenMeeting} onRemoved={onRetry} />
    </div>
  )
}
