import { useEffect, useRef } from 'react'
import type { Meeting } from '../../types'
import { useLiveAudio } from '../../hooks/useLiveAudio'
import { recordListening, useListeningLog } from '../../listening/log'
import { MeetingBar } from './MeetingBar'
import { AttendeesPanel } from './AttendeesPanel'
import { PresenceTimeline } from './PresenceTimeline'
import { OtherMeetings } from './OtherMeetings'
import { ListeningActivity } from './ListeningActivity'

// ── Pure helpers ──────────────────────────────────────────────────────────────

/** Frozen clock for read-only history: the episode end when known, else live
 *  now. Without this the timeline bars compress leftward forever as now ticks. */
export function displayNowFor(
  readOnly: boolean,
  endedAt: number | undefined,
  now: number,
): number {
  return readOnly && endedAt !== undefined ? endedAt : now
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface ChaperoneViewProps {
  activeMeeting: Meeting | undefined
  meetings: Meeting[]
  now: number
  onBackToOverview: () => void
  onOpenMeeting: (id: string) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Chaperone view — the live-listen pane for a single meeting.
 *
 * Layout: max-width 1400px, centered.
 *   MeetingBar (full width)
 *   Two-column grid (.chaperone-grid in styles/responsive.css; collapses to
 *   one column below 760px, right rail stacking underneath)
 *     Left:  AttendeesPanel + PresenceTimeline
 *     Right: OtherMeetings + ListeningActivity (.chaperone-side, sticky top:78px)
 *
 * Live-audio wiring: useLiveAudio({ meetingId, active:true }).
 * Unmounting (Back button) → hook cleanup → WS close → backend logs listen_stop.
 * A meeting switch (OtherMeetings row) changes meetingId in place — the hook
 * closes the old WS and opens the new one.
 *
 * Guards: if activeMeeting is undefined (meeting vanished), renders a graceful
 * fallback rather than crashing.
 */
export function ChaperoneView({
  activeMeeting,
  meetings,
  now,
  onBackToOverview,
  onOpenMeeting,
}: ChaperoneViewProps) {
  // READ-ONLY CONTRACT (view-failed-meeting): never open the live-audio WS
  // for a non-connected bot. Derived, not passed in — so a bot recovering to
  // 'connected' (5 s poll) upgrades the view to live audio in place, and a
  // mid-listen failure downgrades it to view-only with a clean WS teardown.
  const readOnly = activeMeeting !== undefined && activeMeeting.botState !== 'connected'

  // Hooks MUST be called unconditionally — active:false when meeting is absent
  const live = useLiveAudio({
    meetingId: activeMeeting?.id ?? '',
    active: activeMeeting !== undefined && !readOnly,
  })

  const logEntries = useListeningLog()

  // Latest meeting for the recording effect. The effect body reads this ref at
  // *start* time and closes over that snapshot, so the matching stop is always
  // attributed to the meeting we actually listened to — even across a switch,
  // where a render with the NEW meeting still carries the OLD 'listening'
  // status until useLiveAudio tears down.
  const meetingRef = useRef(activeMeeting)
  meetingRef.current = activeMeeting

  // Session listening log (officer-facing view; the backend audits the same
  // events server-side from the WS lifecycle). Entering 'listening' records a
  // start; the cleanup records the matching stop on pause, error, meeting
  // switch, or unmount.
  useEffect(() => {
    if (live.status !== 'listening') return
    const m = meetingRef.current
    if (!m) return
    recordListening({ action: 'listen_start', meetingId: m.id, title: m.title, at: Date.now() })
    return () => {
      recordListening({ action: 'listen_stop', meetingId: m.id, title: m.title, at: Date.now() })
    }
  }, [live.status])

  // Frozen clock: ended meetings stay pinned at endedAt so bars/durations don't
  // grow forever as the live `now` keeps ticking after the meeting closed.
  const displayNow = displayNowFor(readOnly, activeMeeting?.endedAt, now)

  // ── Graceful fallback ──────────────────────────────────────────────────────

  if (!activeMeeting) {
    return (
      <div
        style={{
          padding: '48px 24px',
          textAlign: 'center',
          maxWidth: '480px',
          margin: '0 auto',
        }}
      >
        <p style={{ color: 'var(--tx2)', marginBottom: '20px', fontSize: '15px' }}>
          This meeting is no longer available.
        </p>
        <button
          className="icon-btn"
          onClick={onBackToOverview}
          aria-label="Back to overview"
          style={{
            background: 'var(--s2)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 18px',
            cursor: 'pointer',
            color: 'var(--tx1)',
            fontSize: '14px',
            fontFamily: 'var(--font-ui)',
          }}
        >
          Back to Overview
        </button>
      </div>
    )
  }

  // ── Main view ──────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        maxWidth: '1400px',
        margin: '0 auto',
        padding: '16px',
      }}
    >
      {/* MeetingBar: Back, title, sub-line, audio controls */}
      <MeetingBar
        meeting={activeMeeting}
        now={now}
        live={live}
        onBack={onBackToOverview}
        readOnly={readOnly}
      />

      {/* Two-column content grid — layout lives in styles/responsive.css
          (.chaperone-grid) so the ≤760px media query can collapse it */}
      <div className="chaperone-grid">
        {/* ── Left column ── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Fail-loud roster failure (peek asked, nothing served) */}
          {activeMeeting.rosterError !== undefined && (
            <div
              role="alert"
              style={{
                background: 'var(--s1)',
                border: '1px solid var(--red)',
                borderRadius: 'var(--radius-lg)',
                padding: '14px 18px',
                color: 'var(--red)',
                fontFamily: 'var(--font-ui)',
                fontSize: '13.5px',
              }}
            >
              Roster unavailable — {activeMeeting.rosterError}
            </div>
          )}

          <AttendeesPanel attendees={activeMeeting.attendees} now={displayNow} />

          {/* A peek is a history-less snapshot: rendering the timeline would
              draw lying zero-width bars, so say so honestly instead. */}
          {activeMeeting.rosterSource === 'peek' ? (
            <p
              data-testid="peek-note"
              style={{
                color: 'var(--tx2)',
                fontSize: '12.5px',
                fontFamily: 'var(--font-ui)',
                margin: 0,
              }}
            >
              Roster is a live snapshot from Webex — join/leave history is unavailable while the
              bot is not in the call.
            </p>
          ) : (
            <PresenceTimeline
              attendees={activeMeeting.attendees}
              startedAt={activeMeeting.startedAt}
              now={displayNow}
            />
          )}
        </div>

        {/* ── Right column — sticky rail (styles/responsive.css .chaperone-side;
            sticky is released when the grid stacks below 760px) ── */}
        <div className="chaperone-side">
          <OtherMeetings
            meetings={meetings}
            activeMeetingId={activeMeeting.id}
            now={now}
            onOpenMeeting={onOpenMeeting}
          />

          {/* Session-local log — TODO(audit-endpoint): feed from GET /audit */}
          <ListeningActivity entries={logEntries} />
        </div>
      </div>
    </div>
  )
}
